// Playwright (end-to-end) runner support — PHASE 0 SEED.
//
// This module is intentionally self-contained and NOT yet wired into detector.ts /
// fix-loop.ts. It exists so the Playwright integration can be reviewed in isolation before
// we touch the unit-test path. The Phase 0 goal is the smallest useful slice:
//
//   1. Recognise a Playwright project (detectPlaywright).
//   2. Read the bits of playwright.config.ts the agent needs (loadPlaywrightConfig).
//   3. Produce the run commands for `lacuna fix --e2e` (playwrightTestCommand / RunCommand).
//   4. Turn a Playwright run into the structured failure summary the fix loop feeds back to
//      the model (parsePlaywrightResults).
//
// Generation of brand-new specs from discovered "flows" is a LATER phase and deliberately
// not here — Phase 0 only repairs specs that already exist, which lets us reuse the entire
// existing fix loop (retry/oscillation/patch engine) and prove the run+parse plumbing first.
//
// Why Playwright does not fit the unit-test model (see project-map / design notes): there is
// no per-source-file coverage attribution, the app must be running, and "passing" means a
// green, non-flaky browser run rather than executed source lines. Everything below is shaped
// around that reality.

import { readFile, readdir, writeFile, access, mkdir, rm, stat } from 'fs/promises'
import { join, isAbsolute, basename } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import chalk from 'chalk'
import { confirm } from '@inquirer/prompts'
import { runCommand, type RunResult } from './runner.js'
import type { DetectedEnvironment, TestRunner } from './detector.js'

// ---------------------------------------------------------------------------------------------
// Runner defaults
// ---------------------------------------------------------------------------------------------

// Drop-in addition for detector.ts's RUNNER_DEFAULTS once we wire it up. Note: there is no
// meaningful `coverageCommand` for E2E — coverage is not how Playwright suites are scoped — so
// it points at the plain test command. Selection is opt-in (a `--e2e` flag / `lacuna e2e`
// command), NEVER auto-detected over Vitest/Jest, because most repos have both and the unit
// path must keep winning. detectPlaywright() is only consulted when the user asks for E2E.
export const PLAYWRIGHT_DEFAULTS: DetectedEnvironment = {
  testRunner: 'playwright' as TestRunner, // 'playwright' to be added to the TestRunner union
  language: 'typescript',
  // Playwright's own convention; the real testDir comes from playwright.config.ts at runtime.
  testFilePattern: '**/*.{e2e,spec}.{ts,tsx,js,jsx,mjs}',
  coverageCommand: 'npx playwright test',
  testCommand: 'npx playwright test',
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

// True when the project depends on @playwright/test. Kept separate from detector.ts's main
// resolution chain on purpose: Playwright coexists with a unit runner, so this is a capability
// check ("can we do E2E here?"), not a default-runner decision.
export async function detectPlaywright(cwd: string): Promise<boolean> {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {}
  try {
    pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'))
  } catch {
    return false
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  return '@playwright/test' in deps || 'playwright' in deps
}

// The two-step manual install we point users at when we can't (or shouldn't) install for them.
export const PLAYWRIGHT_INSTALL_HINT = 'npm install -D @playwright/test && npx playwright install'

// True only for an interactive terminal that isn't CI — the gate for any blocking prompt or
// heavy install. A `--workers` run checks this BEFORE spawning workers, so prompting is safe.
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI
}

// Installs @playwright/test (devDep) and the browser binaries. Returns true on success.
// Browsers are a separate, heavy download — that's why this is opt-in, never automatic.
export function installPlaywright(cwd: string, log: (s: string) => void): boolean {
  try {
    log(chalk.dim('  Installing @playwright/test...'))
    execSync('npm install -D @playwright/test', { cwd, stdio: 'inherit' })
    // Capture combined output (2>&1) so we can detect the Linux host-validation warning that
    // Playwright prints when the OS is missing the system libs browsers need to launch. We trade
    // the live progress bar for that detection, so warn it may take a minute.
    log(chalk.dim('  Downloading Playwright browsers (one-time, ~300MB — this can take a minute)...'))
    const out = execSync('npx playwright install 2>&1', { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    warnIfHostDepsMissing(out, log)
    return true
  } catch (err) {
    // Even on a non-zero exit, surface the host-deps hint if the captured output mentions it.
    const out = (err as { stdout?: string | Buffer })?.stdout
    if (out) warnIfHostDepsMissing(out.toString(), log)
    log(chalk.red(`  Install failed. Run manually: ${PLAYWRIGHT_INSTALL_HINT}`))
    return false
  }
}

// Playwright downloads the browser binaries fine but still needs OS-level shared libraries to
// LAUNCH them. On Linux it prints a "Host system is missing dependencies" block pointing at
// `playwright install-deps` (which needs sudo, so lacuna can't run it). Surface that clearly —
// otherwise browsers fail to start later with a cryptic error.
function warnIfHostDepsMissing(output: string, log: (s: string) => void): void {
  if (!/missing dependencies|install-deps/i.test(output)) return
  log(chalk.yellow('\n  ⚠ Browsers downloaded, but your OS is missing system libraries to RUN them.'))
  log(chalk.yellow('    Run once (needs sudo, so lacuna can\'t do it for you):'))
  log(chalk.cyan('      sudo npx playwright install-deps'))
  log(chalk.dim('    Without it, browser launches may fail and specs will error at run time.'))
}

// Scaffolds a minimal, framework-aware playwright.config.ts when the project has none. Lacuna's
// E2E loop needs a `webServer` (to boot the app for snapshots/runs) and a `baseURL` (so specs can
// `goto('/x')` and so parallel `--workers` can share one server) — without a config it falls back
// to sequential and can't start the app. Never overwrites an existing config. Returns true if it
// created one.
// Derives the dev-server command + URL from package.json and the lockfile, so the scaffolded
// webServer is right more often without the user editing it. Picks the package manager from the
// lockfile, the `dev` (else `start`) script, and an explicit port from the script (`-p`, `--port`,
// `PORT=`) — falling back to the framework's default port. Host beyond localhost can't be inferred.
async function detectDevServer(cwd: string): Promise<{ command: string; url: string }> {
  const has = async (p: string) => { try { await access(join(cwd, p)); return true } catch { return false } }
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } = {}
  try { pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8')) } catch { /* defaults */ }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const scripts = pkg.scripts ?? {}

  const scriptName = scripts.dev ? 'dev' : scripts.start ? 'start' : 'dev'
  const scriptBody = scripts[scriptName] ?? ''

  // Package manager → run command. yarn/pnpm/bun take a bare script name; npm needs `run`.
  const pm = (await has('pnpm-lock.yaml')) ? 'pnpm'
    : (await has('yarn.lock')) ? 'yarn'
      : (await has('bun.lockb')) ? 'bun'
        : 'npm'
  const command = pm === 'npm' ? `npm run ${scriptName}` : `${pm} ${scriptName}`

  // Explicit port in the script wins; else framework default (Vite 5173, everything else 3000).
  const portMatch = scriptBody.match(/(?:--port[=\s]+|(?:^|\s)-p\s+|PORT[=\s]+)(\d{2,5})/)
  const port = portMatch ? Number(portMatch[1]) : (('vite' in deps && !('next' in deps)) ? 5173 : 3000)
  return { command, url: `http://localhost:${port}` }
}

export async function ensurePlaywrightConfig(cwd: string, log: (s: string) => void): Promise<boolean> {
  const exists = async (p: string) => { try { await access(p); return true } catch { return false } }
  for (const name of ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']) {
    if (await exists(join(cwd, name))) {
      // A config from before the auth-aware layout won't have the `setup`/`authenticated` projects,
      // so authenticated specs can't run. Nudge rather than silently overwrite the user's config.
      const content = await readFile(join(cwd, name), 'utf-8').catch(() => '')
      if (!/name:\s*['"]setup['"]/.test(content)) {
        log(chalk.yellow(`  Note: ${name} has no \`setup\`/\`authenticated\` projects.`))
        log(chalk.dim(`    Delete ${name} and re-run to regenerate the auth-aware config (re-check webServer.command after), or add the projects by hand.`))
      }
      return false
    }
  }

  const { command, url: baseURL } = await detectDevServer(cwd)

  const content = `import { defineConfig, devices } from '@playwright/test'

// Created by \`lacuna\` when setting up end-to-end testing. Adjust webServer.command / url and
// baseURL below to match how YOUR app actually starts (port, dev command, etc.).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: '${baseURL}',
    trace: 'on-first-retry',
  },
  projects: [
    // Logs in once and saves the signed-in storage state (auth.setup.ts). Pinned to the e2e root so
    // the auth helpers live there even if you move specs into a nested testDir (e.g. ./e2e/tests).
    { name: 'setup', testDir: './e2e', testMatch: /.*\\.setup\\.ts/ },
    // Public / unauthenticated specs. The default project lacuna's snapshot + verify runs use.
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /.*\\.(setup\\.ts|auth\\.spec\\.ts)$/,
    },
    // Authenticated specs (name them *.auth.spec.ts). These reuse the saved storage state, so they
    // start already signed in. Requires test-config.ts to be filled with a real test user.
    {
      name: 'authenticated',
      testMatch: /.*\\.auth\\.spec\\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: 'playwright/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: '${command}',
    url: '${baseURL}',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
})
`
  await writeFile(join(cwd, 'playwright.config.ts'), content, 'utf-8')
  log(chalk.green('  ✓ Created playwright.config.ts (testDir ./e2e, webServer + baseURL).'))
  log(chalk.dim(`    Edit webServer.command/url if your dev server isn't \`${command}\` on ${baseURL}.`))
  return true
}

// Scaffolds the auth helpers most Playwright projects keep: a fillable test-user config and a
// `setup` spec that logs in once and saves the signed-in storage state. Created only when missing
// (never overwrites), and gitignores the saved state. Lacuna never invents credentials — the user
// fills test-config.ts with a real seeded test user and adjusts the login selectors. These
// files don't affect lacuna's runs (which target specific specs, not *.setup.ts/*.auth.spec.ts);
// they exist so authenticated coverage CAN be written. Returns true if it created anything.
export async function ensureE2EAuthScaffolding(cwd: string, log: (s: string) => void): Promise<boolean> {
  const exists = async (p: string) => { try { await access(p); return true } catch { return false } }
  // Put the auth helpers at the E2E ROOT (the first segment of testDir — e.g. 'e2e' for both './e2e'
  // and './e2e/tests'), NOT the nested specs dir. The generated config's `setup` project is pinned to
  // this root, so auth.setup.ts is discovered there while your actual specs can live in a nested
  // testDir like e2e/tests. test-config.ts sits beside it (auth.setup imports './test-config').
  const { testDir } = await loadPlaywrightConfig(cwd)
  const dirLabel = testDir.replace(/^\.\//, '').replace(/\/$/, '').split('/')[0] || 'e2e'
  const testsDir = join(cwd, dirLabel)
  await mkdir(testsDir, { recursive: true }).catch(() => {})
  // If the auth helpers already exist anywhere in the e2e tree, don't scaffold placeholders that
  // would shadow the user's filled-in copies.
  if (await exists(join(testsDir, 'auth.setup.ts'))) return false
  let created = false

  const configPath = join(testsDir, 'test-config.ts')
  if (!(await exists(configPath))) {
    await writeFile(configPath, `// E2E test configuration. Fill in a SEEDED test user your app already has.
// Keep real credentials OUT of git — these read env vars so CI can inject them.
export const testUser = {
  email: process.env.E2E_EMAIL ?? 'CHANGE_ME@example.com',
  password: process.env.E2E_PASSWORD ?? 'CHANGE_ME',
}

// Where your login form lives, and where a successful login lands.
export const authRoutes = {
  login: '/login',
  afterLogin: '/',
}
`, 'utf-8')
    created = true
  }

  const setupPath = join(testsDir, 'auth.setup.ts')
  if (!(await exists(setupPath))) {
    await writeFile(setupPath, `import { test as setup, expect } from '@playwright/test'
import { testUser, authRoutes } from './test-config'

// Saved signed-in browser state. The 'authenticated' project in playwright.config.ts reuses it so
// any *.auth.spec.ts spec starts already logged in.
const authFile = 'playwright/.auth/user.json'

setup('authenticate', async ({ page }) => {
  await page.goto(authRoutes.login)
  // Adjust these selectors to match your login form (lacuna can't see it without a real run).
  await page.getByLabel(/email/i).fill(testUser.email)
  await page.getByLabel(/password/i).fill(testUser.password)
  await page.getByRole('button', { name: /sign ?in|log ?in|continue/i }).click()
  // Confirm login succeeded with a real signed-in signal. The password field disappearing works
  // whether your app redirects OR renders the form inline (URL unchanged) — replace with something
  // stronger if you have it (a dashboard heading, an avatar menu, a known testid).
  await expect(page.getByLabel(/password/i)).toBeHidden()
  // indexedDB:true is REQUIRED for auth SDKs that keep the session in IndexedDB (Firebase, some
  // Supabase/Amplify setups). Without it the saved state has no token and protected pages still show
  // the login form. Harmless for cookie/localStorage auth. Needs Playwright >= 1.51.
  await page.context().storageState({ path: authFile, indexedDB: true })
})
`, 'utf-8')
    created = true
  }

  // Never commit the saved session.
  const gitignorePath = join(cwd, '.gitignore')
  const ignoreEntry = 'playwright/.auth/'
  let gitignore = ''
  try { gitignore = await readFile(gitignorePath, 'utf-8') } catch { /* none yet */ }
  if (!gitignore.split('\n').some((l) => l.trim() === ignoreEntry)) {
    await writeFile(gitignorePath, gitignore + (gitignore && !gitignore.endsWith('\n') ? '\n' : '') + ignoreEntry + '\n', 'utf-8')
  }

  if (created) {
    log(chalk.green(`  ✓ Scaffolded auth helpers: ${dirLabel}/test-config.ts + ${dirLabel}/auth.setup.ts.`))
    log(chalk.dim(`    To enable authenticated coverage: fill ${dirLabel}/test-config.ts with a real test user,`))
    log(chalk.dim(`    fix the login route + selectors in ${dirLabel}/auth.setup.ts, then name authed specs *.auth.spec.ts.`))
  }
  return created
}

// Ensures @playwright/test is available before an --e2e run. If it's missing, prints the exact
// remediation and — only when interactive (TTY, not CI) and `offerInstall` (e.g. not --dry-run) —
// offers to install it inline. Returns true when E2E can proceed. The check sits at the top of
// the e2e/fix loops, before any worker pool starts, so the prompt never collides with workers.
export async function ensurePlaywrightForRun(
  cwd: string,
  opts: { log: (s: string) => void; offerInstall: boolean },
): Promise<boolean> {
  const { log, offerInstall } = opts
  if (await detectPlaywright(cwd)) {
    // Installed already — but a missing config is what forces the sequential fallback and stops
    // the app from booting, so scaffold one (and the auth helpers) if absent.
    await ensurePlaywrightConfig(cwd, log)
    await ensureE2EAuthScaffolding(cwd, log)
    return true
  }

  log(chalk.yellow('\n  --e2e needs @playwright/test, but it is not installed in this project.'))
  if (!offerInstall || !isInteractive()) {
    log(chalk.dim(`  Install it with:  ${PLAYWRIGHT_INSTALL_HINT}`))
    log(chalk.dim('  Or run `lacuna init` and choose end-to-end testing.'))
    return false
  }

  const doInstall = await confirm({
    message: 'Install @playwright/test and browser binaries now?',
    default: true,
  })
  if (!doInstall) {
    log(chalk.dim(`  Skipped. Install manually:  ${PLAYWRIGHT_INSTALL_HINT}`))
    return false
  }
  if (!installPlaywright(cwd, log)) return false
  if (!(await detectPlaywright(cwd))) return false
  await ensurePlaywrightConfig(cwd, log)        // complete the setup with a runnable config
  await ensureE2EAuthScaffolding(cwd, log)      // + the auth helpers (test user, login setup)
  return true
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export interface PlaywrightConfig {
  // Base URL the specs navigate against (page.goto('/x') resolves against this). The model
  // needs it to write correct goto() paths and we need it to know the app is reachable.
  baseURL: string | null
  // Directory Playwright loads specs from. Generated/repaired specs must live here, NOT in the
  // co-located location context.ts computes for unit tests (that would fight Playwright).
  testDir: string
  // Command Playwright runs to bring the app up before the suite (config.webServer.command),
  // and the URL it waits on. Null when the project expects an already-running app.
  webServerCommand: string | null
  webServerUrl: string | null
  // Saved auth session path (the `authenticated` project's `storageState`), if the config declares
  // one — so the E2E loop's authenticated dual-pass uses the project's real path, not a hardcoded
  // guess. Null when no storageState is configured.
  storageState: string | null
  // Path to the resolved config file, for diagnostics.
  configPath: string | null
}

const CONFIG_FILENAMES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs']

// Best-effort read of playwright.config.{ts,js,mjs}. The config is executable TS, not JSON, so
// we do NOT try to evaluate it — we extract the handful of fields the agent needs with narrow
// regexes and fall back to Playwright's documented defaults. This is the same pragmatic posture
// typecheck.ts takes with tsconfig (stripJsonc + tolerate failure): good enough to drive the
// flow, never throws. A later phase can shell out to `npx playwright test --list` for an exact,
// fully-resolved view if these heuristics prove too brittle.
export async function loadPlaywrightConfig(cwd: string): Promise<PlaywrightConfig> {
  const fallback: PlaywrightConfig = {
    baseURL: null,
    testDir: 'tests', // Playwright's default when testDir is unset
    webServerCommand: null,
    webServerUrl: null,
    storageState: null,
    configPath: null,
  }

  let raw: string | null = null
  let configPath: string | null = null
  for (const name of CONFIG_FILENAMES) {
    try {
      const p = join(cwd, name)
      raw = await readFile(p, 'utf-8')
      configPath = p
      break
    } catch { /* try next candidate */ }
  }
  if (raw == null) return fallback

  return {
    baseURL: matchStringField(raw, 'baseURL') ?? fallback.baseURL,
    testDir: matchStringField(raw, 'testDir') ?? fallback.testDir,
    webServerCommand: matchWebServerField(raw, 'command'),
    webServerUrl: matchWebServerField(raw, 'url'),
    storageState: matchStringField(raw, 'storageState'),
    configPath,
  }
}

// Matches `key: 'value'` / `key: "value"` / `key: \`value\`` anywhere in the config source.
// Deliberately simple: it accepts the first literal assignment and ignores computed values
// (e.g. baseURL: process.env.BASE_URL) by returning null so the caller uses its fallback.
function matchStringField(src: string, key: string): string | null {
  const re = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`)
  const m = src.match(re)
  return m ? m[2] : null
}

// Pulls a field out of the `webServer: { ... }` block specifically, so we don't accidentally
// grab a `command`/`url` from elsewhere. Returns null if there's no webServer block (the app
// is expected to be already running).
function matchWebServerField(src: string, key: string): string | null {
  const block = src.match(/webServer\s*:\s*\{([\s\S]*?)\}/)
  if (!block) return null
  return matchStringField(block[1], key)
}

// ---------------------------------------------------------------------------------------------
// Run commands
// ---------------------------------------------------------------------------------------------

// Single-file run, the analogue of detector.ts's testFileCommand for the fix loop. Playwright
// takes a path filter as a positional arg. We delegate app start/stop entirely to Playwright's
// own webServer machinery (see design note 2) rather than orchestrating it ourselves.
export function playwrightRunCommand(testFile: string): string {
  // --no-deps: don't run the `setup` (login) project before every verify/repair attempt. The saved
  // storageState already exists (the user ran setup once), and the `authenticated` project loads it
  // regardless of deps — so this skips a slow, flaky re-login on each of lacuna's runs.
  return `npx playwright test ${shellQuote(testFile)} --no-deps --reporter=json`
}

// Whole-suite run (selection phase / verification sweeps).
export function playwrightTestCommand(): string {
  return 'npx playwright test --reporter=json'
}

// Refresh the saved login session by running the `setup` project (auth.setup.ts logs in and writes
// storageState). Needed because token sessions (Firebase/Supabase/JWT) expire ~1h and lacuna runs
// verify with --no-deps, so nothing re-logs-in mid-run — a stale session makes every authed spec
// fail. Succeeds only if setup exits clean AND a NEWER storageState file lands (so a no-op/failed
// login that leaves a stale file in place is reported as failure, not a false success). The dev
// server is already up by the time we call this; the config's reuseExistingServer attaches to it.
// Failure is expected when creds aren't configured (placeholder test-config) — caller falls back.
export async function refreshAuthState(
  cwd: string,
  storageStatePath: string,
  timeoutMs: number,
): Promise<{ refreshed: boolean; reason: string }> {
  const abs = join(cwd, storageStatePath)
  const before = await stat(abs).then((s) => s.mtimeMs).catch(() => 0)
  const run = await runCommand('npx playwright test --project=setup --reporter=line', cwd, timeoutMs)
  const after = await stat(abs).then((s) => s.mtimeMs).catch(() => 0)
  if (run.success && after > before) return { refreshed: true, reason: 'ok' }
  const reason = run.timedOut
    ? 'login timed out'
    : run.exitCode !== 0
      ? 'login/setup failed (likely missing or invalid test credentials — set them in your test-config / env)'
      : 'setup ran but wrote no new session'
  return { refreshed: false, reason }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Runs a Playwright `--reporter=json` command but routes the JSON report to a FILE (via
// PLAYWRIGHT_JSON_OUTPUT_NAME) instead of stdout. The dev-server (`webServer`) prints its own logs
// to the test runner's stdout, which interleave with / surround the JSON and break JSON.parse —
// the reason `parsePlaywrightResults` returned null and callers surfaced raw config-JSON garbage as
// "the error". A file the reporter writes directly is always clean. Falls back to parsing stdout if
// the file wasn't produced (e.g. the run crashed before the reporter ran). Unique filename per call,
// so parallel workers never collide. Returns the RunResult plus the parsed report (or null).
export async function runPlaywrightJson(
  command: string,
  cwd: string,
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<{ run: RunResult; parsed: PlaywrightRunResult | null }> {
  const jsonFile = join(tmpdir(), `lacuna-pw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const run = await runCommand(`PLAYWRIGHT_JSON_OUTPUT_NAME=${shellQuote(jsonFile)} ${command}`, cwd, timeoutMs, onLine)
  let parsed: PlaywrightRunResult | null = null
  try { parsed = parsePlaywrightResults(await readFile(jsonFile, 'utf-8')) } catch { /* file missing/unparseable — fall back */ }
  if (!parsed) parsed = parsePlaywrightResults(run.stdout + '\n' + run.stderr)
  await rm(jsonFile, { force: true }).catch(() => {})
  return { run, parsed }
}

// ---------------------------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------------------------

export interface PlaywrightFailure {
  file: string
  title: string        // full test title path, e.g. "auth › user can log in"
  message: string      // trimmed error message + the failing step/location
  attachments: string[] // trace.zip / screenshot paths, useful in a bug report and to the model
}

export interface PlaywrightRunResult {
  passed: number
  failed: number
  flaky: number
  failures: PlaywrightFailure[]
}

// Parses Playwright's JSON reporter output (`--reporter=json`) into a structured result the fix
// loop can act on. This is the E2E analogue of extract-error.ts: it answers "what failed and
// why" in a form small enough to put in a retry prompt. Returns null when the output isn't
// parseable JSON (e.g. the run crashed before producing a report) so the caller can fall back
// to raw stderr, exactly like the unit path does on an unrecognised runner.
export function parsePlaywrightResults(stdout: string): PlaywrightRunResult | null {
  const json = extractJsonBlob(stdout)
  if (!json) return null

  let report: PlaywrightJsonReport
  try {
    report = JSON.parse(json) as PlaywrightJsonReport
  } catch {
    return null
  }

  const failures: PlaywrightFailure[] = []
  let passed = 0
  let failed = 0
  let flaky = 0

  // Playwright reports spec/suite `file` paths RELATIVE TO config.rootDir (which is the
  // testDir, not the project root), so we must resolve them against rootDir to get a path that
  // actually exists. Resolving against cwd instead drops the testDir segment (e.g. looking for
  // ./dashboard.spec.ts instead of ./e2e/dashboard.spec.ts), which makes the fix loop unable to
  // read the file it was told is failing.
  const rootDir = report.config?.rootDir
  const resolveFile = (f: string | undefined): string => {
    if (!f) return '(unknown)'
    if (isAbsolute(f)) return f
    return rootDir ? join(rootDir, f) : f
  }

  // The JSON report is a tree: suites → (nested suites) → specs → tests → results.
  const walkSuite = (suite: PwSuite, titlePath: string[]): void => {
    const here = suite.title ? [...titlePath, suite.title] : titlePath
    for (const spec of suite.specs ?? []) {
      const specTitle = [...here, spec.title].filter(Boolean).join(' › ')
      for (const test of spec.tests ?? []) {
        const status = test.status ?? worstResultStatus(test.results)
        if (status === 'flaky') flaky++
        else if (spec.ok) passed++
        else failed++

        if (!spec.ok) {
          const errs = (test.results ?? []).flatMap((r) => r.errors ?? [])
          failures.push({
            file: resolveFile(suite.file ?? spec.file),
            title: specTitle,
            message: summariseErrors(errs),
            attachments: collectAttachments(test.results),
          })
        }
      }
    }
    for (const child of suite.suites ?? []) walkSuite(child, here)
  }

  for (const suite of report.suites ?? []) walkSuite(suite, [])

  // Surface top-level errors (a failed `setup`/dependency project, a config/load error, a global
  // hook throw) — these aren't attached to any spec, so without this the run looks like 0 failures
  // and the caller falls back to dumping raw config JSON as "the error".
  if (report.errors && report.errors.length > 0) {
    failures.push({
      file: '(run error)',
      title: 'Playwright run error (setup / config / load — not a test assertion)',
      message: summariseErrors(report.errors),
      attachments: [],
    })
    if (failed === 0) failed = report.errors.length
  }

  return { passed, failed, flaky, failures }
}

export interface FailureContext {
  specPath: string | null     // the spec the failure is in (from the "Location:" line) — may differ
                              //   from the spec being fixed (a failed setup/dependency project)
  test: string | null         // the failing test's name/location, from the "# Test info" section
  errorDetails: string        // the real error (e.g. "page.waitForURL: Timeout … navigation to **/otp**")
  pageSnapshot: string | null // the page's aria snapshot at failure, when Playwright captured one
}

// Read ALL of a run's per-failure `error-context.md` files. Playwright writes these the instant a
// test fails — BEFORE the run finishes — so they survive even when the run is killed by a timeout
// (the case where the JSON reporter produces nothing). Reading ALL of them (not just the target
// spec's) is deliberate: with project dependencies, the failure that blocks a spec is often in a
// SETUP/dependency spec, and Playwright then skips the dependent — so the target's own failure is
// absent and the real cause lives in another file. Each context is tagged with its source spec.
export async function readPlaywrightErrorContext(cwd: string, outputDir = 'test-results'): Promise<FailureContext[]> {
  const resultsDir = isAbsolute(outputDir) ? outputDir : join(cwd, outputDir)
  let entries: string[]
  try { entries = await readdir(resultsDir) } catch { return [] }

  const out: FailureContext[] = []
  for (const dir of entries.slice(0, 30)) {
    const md = await readFile(join(resultsDir, dir, 'error-context.md'), 'utf-8').catch(() => null)
    if (!md) continue
    const info = section(md, 'Test info')
    const locLine = info?.split('\n').find((l) => l.includes('Location:'))
    const specPath = locLine?.match(/Location:\s*([^\s:]+)/)?.[1] ?? null
    out.push({
      specPath,
      test: info?.replace(/^- /gm, '').trim().slice(0, 300) ?? null,
      errorDetails: (codeBlock(section(md, 'Error details')) ?? '').slice(0, 2000),
      pageSnapshot: codeBlock(section(md, 'Page snapshot')),
    })
  }
  return out.filter((c) => c.errorDetails || c.pageSnapshot)
}

// Extract the body of a `# <heading>` section from error-context.md (up to the next `# `).
function section(md: string, heading: string): string | null {
  const re = new RegExp(`(?:^|\\n)#\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n#\\s|$)`)
  const m = md.match(re)
  return m ? m[1].trim() : null
}

// Pull the first fenced code block out of a section body (the snapshot/error is fenced).
function codeBlock(body: string | null): string | null {
  if (!body) return null
  const m = body.match(/```[a-z]*\n([\s\S]*?)```/)
  return m ? m[1].trim() : null
}

// Playwright prints non-JSON lines (webServer logs, the dot reporter) around the JSON blob when
// stdout is noisy. Grab the outermost {...} so JSON.parse has a clean payload.
function extractJsonBlob(stdout: string): string | null {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return stdout.slice(start, end + 1)
}

function worstResultStatus(results: PwResult[] | undefined): string {
  if (!results || results.length === 0) return 'unknown'
  if (results.some((r) => r.status === 'failed' || r.status === 'timedOut')) return 'failed'
  return results[results.length - 1].status ?? 'unknown'
}

function summariseErrors(errors: PwError[]): string {
  if (errors.length === 0) return 'Test failed with no captured error message.'
  // Strip ANSI colour codes Playwright embeds in messages; keep it compact for the prompt.
  return errors
    .map((e) => (e.message ?? '').replace(/\[[0-9;]*m/g, '').trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4000)
}

function collectAttachments(results: PwResult[] | undefined): string[] {
  if (!results) return []
  return results
    .flatMap((r) => r.attachments ?? [])
    .map((a) => a.path)
    .filter((p): p is string => typeof p === 'string')
}

// --- Minimal shape of the Playwright JSON reporter we depend on. Intentionally partial. ------

interface PlaywrightJsonReport {
  suites?: PwSuite[]
  config?: { rootDir?: string }
  errors?: PwError[]   // top-level errors not tied to a test (global/project setup, config, load)
}
interface PwSuite {
  title?: string
  file?: string
  specs?: PwSpec[]
  suites?: PwSuite[]
}
interface PwSpec {
  title: string
  ok: boolean
  file?: string
  tests?: PwTest[]
}
interface PwTest {
  status?: string
  results?: PwResult[]
}
interface PwResult {
  status?: string
  errors?: PwError[]
  attachments?: { name?: string; path?: string }[]
}
interface PwError {
  message?: string
}
