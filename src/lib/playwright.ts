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

import { readFile } from 'fs/promises'
import { join, isAbsolute } from 'path'
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
