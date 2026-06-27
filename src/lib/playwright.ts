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

import { readFile, readdir } from 'fs/promises'
import { join, isAbsolute, basename } from 'path'
import { execSync } from 'child_process'
import chalk from 'chalk'
import { confirm } from '@inquirer/prompts'
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
    log(chalk.dim('  Downloading Playwright browsers (npx playwright install)...'))
    execSync('npx playwright install', { cwd, stdio: 'inherit' })
    return true
  } catch {
    log(chalk.red(`  Install failed. Run manually: ${PLAYWRIGHT_INSTALL_HINT}`))
    return false
  }
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
  if (await detectPlaywright(cwd)) return true

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
  return detectPlaywright(cwd)
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
  return `npx playwright test ${shellQuote(testFile)} --reporter=json`
}

// Whole-suite run (selection phase / verification sweeps).
export function playwrightTestCommand(): string {
  return 'npx playwright test --reporter=json'
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
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
