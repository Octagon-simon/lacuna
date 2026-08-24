import { readFile, writeFile, mkdir, unlink, readdir } from 'fs/promises'
import { join, dirname, basename, extname, isAbsolute, relative } from 'path'
import { access, stat } from 'fs/promises'
import chalk from 'chalk'
import type { LacunaConfig } from '../lib/config.js'
import { mocksFileList, iterationCeiling } from '../lib/config.js'
import type { DetectedEnvironment } from '../lib/detector.js'
import { resolveFileTestRun, resolveScopeTestRun, resolveMultiFileTestRun, resolveEnvForFile } from '../lib/test-run.js'
import { isWithinDir } from '../lib/coverage/index.js'
import { formatFile } from '../lib/format.js'
import { runCommand } from '../lib/runner.js'
import type { RunResult } from '../lib/runner.js'
import { startCoverageSpinner } from '../lib/coverage-spinner.js'
import { WorkerDisplay } from '../lib/worker-display.js'
import type { WorkerState } from '../lib/worker-display.js'
import type { LacunaEventHandler } from '../lib/events.js'
import { buildFixFileContext, computeRelativeImport, collectTypeDefinitions, collectLocalImportPaths, detectReactMajorVersion, findFileByName, resolveToFile } from './context.js'
import { TestGenerator, TruncatedOutputError, OscillationError, ModelStallError, ModelRateLimitError, ModelCancelledError, ReasoningBudgetExhaustedError, TRUNCATION_RETRY_MESSAGE, OSCILLATION_ESCAPE_MESSAGE, resolveDebugBase, perFileDebugPath, debugWrite } from './generator.js'
import { processGap } from './loop.js'
import { fixMocksFilesUpfront } from './mocks-fix.js'
import type { CoverageGap } from '../lib/coverage/types.js'
import { ProjectMemory } from './project-memory.js'
import { getActiveTips, createTipRotator, formatTip } from '../lib/tips.js'
import { typeCheckFile, findTestFilesWithTypeErrors, TYPECHECK_INCONCLUSIVE } from '../lib/typecheck.js'
import { hasTestFunctions, hasPlaceholderBodies, enrichNoTestsError, isZeroTestsOutput, parsePassCount, parseFailCount, buildStructureBrokenMessage, buildRegressionMessage, buildUnhandledErrorMessage, processExitLeakGuidance, sanitizeMocksContent, detectUnbalancedMocksSyntax, stripLeadingProse, mergeMocksContent, dedupeMockExports, countTestCases, countDistinctErrors, withMocksLock, detectMocksFileError, deduplicateViMocks, typeImportOriginalCalls, ensureMockedImports, fixNeverTypedAsyncMocks, dedupeImports, dedupeTestBlocks, replaceUnsafeFunctionType, tryApplyPatch, tryApplyMocksPatch, detectProcessCrash, buildProcessCrashMessage, detectUnrelatedFileCrash, buildPatchEscalationMessage, buildFailingTestChecklist, detectStrayPatchMarkers, detectOpenHandleLeak, buildOpenHandleLeakMessage, detectJestConfigConflict, detectJestValidationError, subjectFromTestPath, referencesSubject, leakLooksTestFixable, detectEnvironmentLimitation } from '../lib/validate.js'
import { extractTestFailure } from '../lib/extract-error.js'
import { StreamingFileViewer } from '../lib/streaming-viewer.js'
import { buildFixMemoryHint, recordFixOutcome, recordTagMatchOutcome, normalizeErrorSignature, errorSignatureHash } from '../lib/memory/index.js'

// Format a file we just reported as fixed/passing, then RE-VERIFY. formatFile runs the repo's
// eslint --fix + prettier, and eslint --fix is not guaranteed behavior-preserving (it can drop an
// import it deems unused, apply an autofix that changes a matcher, etc.). Without re-verifying, a
// format that breaks the file leaves it failing on disk even though the loop reported success — the
// exact "panel said passed but the file fails" bug. Re-run the file's tests; if they no longer pass,
// restore the exact pre-format content we verified. Best-effort: if we can't run the verify, keep
// the formatted file (no worse than before this guard existed).
async function formatFileVerified(absFile: string, cwd: string, config: LacunaConfig, env: DetectedEnvironment): Promise<void> {
  if (!config.format) return  // formatFile would no-op; skip the whole (costly) verify
  const green = await readFile(absFile, 'utf-8').catch(() => null)
  await formatFile(absFile, cwd, { enabled: config.format, env })
  if (green === null) return
  try {
    const fileEnv = await resolveEnvForFile(env, absFile, cwd)
    const run = await resolveFileTestRun(fileEnv, absFile, cwd)
    const res = await runCommand(run.command, run.cwd, config.coverageTimeout * 1000)
    if (!res.success) await writeFile(absFile, green, 'utf-8')
  } catch { /* verify is best-effort */ }
}

export interface FixOptions {
  config: LacunaConfig
  env: DetectedEnvironment
  cwd: string
  dryRun: boolean
  verbose: boolean
  targetFile?: string
  // Absolute path to a directory the run is scoped to (`lacuna fix <dir>`). Only failing/erroring
  // test files under this subtree are selected, and the discovery run is scoped to it too.
  scopeDir?: string
  workers?: number
  fresh?: boolean
  regenerateOnFailure?: boolean
  fixPolluters?: boolean
  types?: boolean   // select files by type errors (not test failures); repair type-only issues
  log: (msg: string) => void
  // Structured per-worker phase stream (WorkerState) and non-phase event stream (memory usage,
  // future cost). Both unset by the CLI (which renders its own WorkerDisplay / verbose log); an
  // embedding host (VS Code extension) sets them to consume progress as data. onStatus is called
  // in addition to the internal WorkerDisplay, and flips the serial path into structured mode
  // (suppressing `!onStatus` verbose logging). See loop.ts's identical fields and lib/events.ts.
  onStatus?: (state: WorkerState) => void
  onEvent?: LacunaEventHandler
  // Cooperative cancellation checked at each file-iteration boundary — see loop.ts's identical
  // field. Unset by the CLI; an embedding host wires it to a "stop" control.
  shouldContinue?: () => boolean
  // Aborts the in-flight model request for an instant "Stop" (not just between attempts). See loop.ts.
  abortSignal?: AbortSignal
}

// ─── Failing-files cache ──────────────────────────────────────────────────────

const FIX_CACHE_TTL_S = 1800 // 30 minutes

// Regenerate-on-failure only attempts a from-scratch rewrite when the file has FEWER than
// this many passing tests. A file with a substantial passing suite is repaired, never nuked
// and rebuilt — regenerating it from scratch is slow and almost never reproduces the suite.
// (regenerateFile additionally never keeps a regen that reduces the passing count.)
const REGEN_MAX_BASELINE_PASS = 10

function fixCachePath(cwd: string): string {
  return join(cwd, '.lacuna-fix-cache.json')
}

async function loadFixCache(cwd: string): Promise<{ files: string[]; ageSeconds: number } | null> {
  try {
    const cachePath = fixCachePath(cwd)
    const [raw, fileStat] = await Promise.all([readFile(cachePath, 'utf-8'), stat(cachePath)])
    const { files } = JSON.parse(raw) as { files: string[] }
    const ageSeconds = (Date.now() - fileStat.mtimeMs) / 1000
    return { files, ageSeconds }
  } catch {
    return null
  }
}

async function saveFixCache(cwd: string, files: string[]): Promise<void> {
  try {
    await writeFile(fixCachePath(cwd), JSON.stringify({ files }), 'utf-8')
  } catch {
    // non-fatal — cache is best-effort
  }
}

async function clearFixCache(cwd: string): Promise<void> {
  try {
    await unlink(fixCachePath(cwd))
  } catch { /* already gone — fine */ }
}

export interface FixResult {
  filesProcessed: number
  filesFixed: number
  filesAlreadyPassing: number
  pollutersFixed: number
  victimsRegenerated: number
  errors: string[]
}

// ─── Parse failing test files from runner output ──────────────────────────────

const TEST_FILE_RE = /[\w./\\@\[\]()-]+\.(?:test|spec)\.(?:tsx|mts|ts|jsx|js)/

function stripAnsi(s: string): string {
  // Strip all CSI sequences (ESC [ ... letter), OSC sequences, carriage returns
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x1B]*/g, '').replace(/\r/g, '')
}

function parseFailingTestFiles(output: string, runner: string): string[] {
  const lines = output.split('\n')

  // Two separate sets — cross/tick pattern (per-file summary) vs FAIL pattern (per-test details)
  const crossFiles = new Set<string>()
  const failFiles = new Set<string>()

  for (const line of lines) {
    const clean = stripAnsi(line).trim()

    if (runner === 'vitest' || runner === 'unknown') {
      const m = clean.match(new RegExp(`^[×✗✕✖✘❌]\\s+(${TEST_FILE_RE.source})`))
      if (m) { crossFiles.add(m[1]); continue }
    }

    if (runner === 'jest' || runner === 'vitest' || runner === 'unknown') {
      // `FAIL <path>` (jest / plain vitest) OR `FAIL <project> <path>` (vitest workspace &
      // monorepo mode, where the package label — e.g. `@acme/admin` — sits between FAIL and the
      // path). Match the first test-file token anywhere on a FAIL-prefixed line rather than
      // requiring it immediately after FAIL, so the workspace label can't hide the file.
      if (/^FAIL\b/.test(clean)) {
        const m = clean.match(new RegExp(`(${TEST_FILE_RE.source})`))
        if (m) failFiles.add(m[1])
      }
    }
  }

  // Parse the expected failing file count from the runner summary line
  let expectedCount: number | null = null
  for (const line of lines) {
    const clean = stripAnsi(line).trim()
    const mv = clean.match(/Test Files\s+(\d+)\s+failed/)
    if (mv) { expectedCount = parseInt(mv[1], 10); break }
    const mj = clean.match(/Test Suites:\s+(\d+)\s+failed/)
    if (mj) { expectedCount = parseInt(mj[1], 10); break }
  }

  const combined = new Set([...crossFiles, ...failFiles])

  if (expectedCount !== null && combined.size > expectedCount) {
    // Over-detected: prune false positives by preferring files confirmed by both patterns,
    // then FAIL-only (strong signal — comes from the detailed failures section),
    // then cross-only last (more likely to include false positives).
    const pruned = new Set<string>()
    for (const f of crossFiles) { if (failFiles.has(f)) pruned.add(f) }
    for (const f of failFiles) { if (pruned.size < expectedCount) pruned.add(f) }
    for (const f of crossFiles) { if (pruned.size < expectedCount) pruned.add(f) }
    return [...pruned]
  }

  // Supplement with stack traces only when primary patterns under-detected
  const needsSupplement = expectedCount !== null ? combined.size < expectedCount : combined.size === 0
  if (needsSupplement) {
    let inTrace = false
    for (const line of lines) {
      const clean = stripAnsi(line).trim()
      if (!clean || clean.startsWith('●') || clean.startsWith('FAIL') || /^[×✗✕✖✘❌]/.test(clean)) {
        inTrace = false
      }
      const m = clean.match(new RegExp(`\\(?(${TEST_FILE_RE.source}):\\d+`))
      if (m && !combined.has(m[1]) && !inTrace) {
        combined.add(m[1])
        inTrace = true
      }
    }
  }

  return [...combined]
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

// Collect every file under `root` whose basename equals `name` (skips node_modules and dot dirs).
async function findAllByBasename(root: string, name: string, depth = 0, maxDepth = 12): Promise<string[]> {
  if (depth > maxDepth) return []
  let entries: import('fs').Dirent<string>[]
  try { entries = await readdir(root, { withFileTypes: true, encoding: 'utf-8' }) } catch { return [] }
  const out: string[] = []
  for (const e of entries) {
    const full = join(root, e.name)
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      out.push(...await findAllByBasename(full, name, depth + 1, maxDepth))
    } else if (e.name === name) {
      out.push(full)
    }
  }
  return out
}

// vitest workspace / monorepo runs print test paths RELATIVE TO THE PACKAGE ROOT — e.g.
// `src/screens/…/X.test.tsx` for a package living at `packages/admin` — not relative to cwd
// (the monorepo root). Such a path doesn't exist at `cwd/<path>`, so both the existence check and
// the scope filter reject it and the file is silently dropped ("could not identify any failing
// test files"). Map the reported path to the real file: use the literal path when it exists, else
// find a file under `searchRoot` whose path ENDS WITH the reported (package-relative) suffix.
// Returns an absolute path, or null when unresolved/ambiguous (never guesses between duplicates).
async function resolveReportedTestPath(f: string, cwd: string, searchRoot: string): Promise<string | null> {
  const norm = f.replace(/\\/g, '/').replace(/^\.\//, '')
  const direct = isAbsolute(norm) ? norm : join(cwd, norm)
  if (await pathExists(direct)) return direct
  const matches = await findAllByBasename(searchRoot, basename(norm))
  if (matches.length === 0) return null
  const suffix = '/' + norm
  const bySuffix = matches.filter((m) => m.replace(/\\/g, '/').endsWith(suffix))
  if (bySuffix.length === 1) return bySuffix[0]
  if (bySuffix.length > 1) return null // ambiguous suffix — don't guess
  return matches.length === 1 ? matches[0] : null
}

// ─── Failing-test discovery (public, for embedders) ──────────────────────────

export class DiscoverFailingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscoverFailingError'
  }
}

/**
 * Discover the failing/erroring test files under an optional scope directory — the SAME suite run
 * and parsing `runFixLoop` does internally. An embedder (the VS Code extension) uses this to show
 * an accurate confirmation ("N failing test file(s)") BEFORE starting a folder-fix, and to skip
 * cleanly when nothing is failing. `allPassing` is true when the suite is green (failing is empty).
 * Returns absolute paths, filtered to the scope. Throws DiscoverFailingError on a config/validation
 * failure or timeout (the suite couldn't tell us what's failing).
 */
export async function discoverFailingTests(
  config: LacunaConfig,
  env: DetectedEnvironment,
  cwd: string,
  scopeDir?: string,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ failing: string[]; allPassing: boolean }> {
  const scopeRun = scopeDir ? await resolveScopeTestRun(env, scopeDir, cwd) : { command: env.testCommand, cwd }
  const result = await runCommand(scopeRun.command, scopeRun.cwd, config.coverageTimeout * 1000, onLine, signal)

  if (result.timedOut) {
    throw new DiscoverFailingError(
      `Test suite timed out after ${config.coverageTimeout}s — raise coverageTimeout in .lacuna.json.`,
    )
  }
  if (result.success) return { failing: [], allPassing: true }

  const raw = result.stdout + result.stderr
  const configConflict = detectJestConfigConflict(raw)
  if (configConflict) throw new DiscoverFailingError(`Jest never ran any tests — nothing was discovered to fix.\n\n${configConflict}`)
  const validationError = detectJestValidationError(raw)
  if (validationError) throw new DiscoverFailingError(validationError)

  const searchRoot = scopeDir ?? cwd
  const resolved = new Set<string>()
  for (const f of parseFailingTestFiles(raw, env.testRunner)) {
    const abs = await resolveReportedTestPath(f, cwd, searchRoot)
    if (!abs || !abs.startsWith(cwd) || abs.includes('node_modules')) continue
    if (scopeDir && !isWithinDir(abs, scopeDir)) continue
    resolved.add(abs)
  }
  return { failing: [...resolved], allPassing: false }
}

// ─── Find the source file that a test file is testing ────────────────────────

// A test's own relative import is ground truth for what it's testing — unlike filename
// matching, it works regardless of naming convention (e.g. `__tests__/FooResendGuard.test.tsx`
// covering a sibling `index.tsx`, not a file named FooResendGuard.tsx). Only relative specifiers
// ('./x', '../x') are considered: they resolve without needing tsconfig aliases, which covers the
// common colocated-test case this function otherwise misses entirely.
export function extractRelativeImportSpecifiers(testCode: string): string[] {
  const specifiers: string[] = []
  const re = /import\s+(?:[\w*\s{},]+)\s+from\s+['"](\.[^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(testCode))) specifiers.push(m[1])
  return specifiers
}

export async function findSourceFile(testFilePath: string, cwd: string, configSourceDirs: string | string[] = 'src', testCode?: string): Promise<string | null> {
  const ext = extname(testFilePath)
  const base = basename(testFilePath, ext)
  const dir = dirname(testFilePath)

  const sourceBase = base.replace(/\.(test|spec)$/, '').replace(/^test_/, '').replace(/_test$/, '')
  const exts = [ext, '.ts', '.tsx', '.js', '.jsx']
  const srcDirs = Array.isArray(configSourceDirs) ? configSourceDirs : [configSourceDirs]

  async function tryCandidates(targetDir: string): Promise<string | null> {
    const resolved = isAbsolute(targetDir) ? targetDir : join(cwd, targetDir)
    for (const e of exts) {
      try { await access(join(resolved, `${sourceBase}${e}`)); return join(resolved, `${sourceBase}${e}`) } catch { /* next */ }
    }
    return null
  }

  // Attempt 0: resolve the test file's own relative imports first — more reliable than the
  // filename-matching attempts below, and catches the colocated `__tests__/*.test.tsx` → sibling
  // `index.tsx` pattern they miss. Skips test/mock files so a fixture import doesn't win.
  if (testCode) {
    const absDir = isAbsolute(dir) ? dir : join(cwd, dir)
    for (const spec of extractRelativeImportSpecifiers(testCode)) {
      const basePath = join(absDir, spec)
      const resolved = await resolveToFile(basePath)
      if (resolved && !/[\\/]__(tests|mocks)__[\\/]/.test(resolved) && !/\.(test|spec)\.[tj]sx?$/i.test(resolved)) {
        return resolved
      }
    }
  }

  // Attempt 1: same directory as test file, or parent of __tests__
  const sameDir = basename(dir) === '__tests__' ? dirname(dir) : dir
  const attempt1 = await tryCandidates(sameDir)
  if (attempt1) return attempt1

  // Attempt 2: replace test directory segment with sourceDir
  // Handles monorepo layouts like:  packages/server/test/unit/adapters/Foo.test.ts
  //                              →  packages/server/src/adapters/Foo.ts
  const TEST_SEGMENT_RE = /^(.*[/\\])(?:tests?|specs?)[/\\](?:(?:unit|integration|e2e|functional|features?)[/\\])?(.*)$/i
  const match = dir.match(TEST_SEGMENT_RE)
  if (match) {
    const [, prefix, suffix] = match
    for (const srcDir of srcDirs) {
      // Strategy A: relative srcDir appended to the test root prefix
      // Works when sourceDir is short ("src") and test is nested under same package root
      const a = await tryCandidates(join(prefix, srcDir, suffix))
      if (a) return a
      // Strategy B: absolute resolved srcDir + relative suffix
      // Works when sourceDir is explicit ("packages/server/src")
      const absSrc = isAbsolute(srcDir) ? srcDir : join(cwd, srcDir)
      const b = await tryCandidates(join(absSrc, suffix))
      if (b) return b
    }
  }

  // Attempt 3: recursive filename search.
  // Handles extra segments between src/ and the file (e.g. test/unit/interactors/Foo.test.ts
  // → src/lib/interactors/Foo.ts — the "lib" is invisible to the mirror logic above).
  // Search roots: (a) package prefix + srcDir (most targeted, e.g. packages/server/src/),
  // then (b) absolute srcDir from config (for flat repos).
  const searchRoots: string[] = []
  if (match) {
    const [, prefix] = match
    for (const srcDir of srcDirs) {
      searchRoots.push(join(prefix, srcDir))
    }
  }
  for (const srcDir of srcDirs) {
    const abs = isAbsolute(srcDir) ? srcDir : join(cwd, srcDir)
    if (!searchRoots.includes(abs)) searchRoots.push(abs)
  }
  for (const e of exts) {
    const filename = `${sourceBase}${e}`
    for (const root of searchRoots) {
      const found = await findFileByName(root, filename)
      if (found) return found
    }
  }

  return null
}

// ─── Fix a single test file ───────────────────────────────────────────────────

export async function fixFile(
  testFilePath: string,
  options: FixOptions,
  generator: TestGenerator,
  onStatus?: (state: WorkerState) => void,
  projectMemory?: string | null,
  // A caller that JUST ran this exact file (e.g. generate's fixOnFailure handoff, seconds ago,
  // against the exact content currently on disk) can pass that result here to skip re-running
  // the test from scratch purely to re-derive the same error — a real, avoidable duplicate test
  // execution on every handoff (pure wall-clock waste, worse at `-w N` scale). Only safe when the
  // caller guarantees the result corresponds EXACTLY to what's currently on disk; every other
  // caller (a standalone `lacuna fix` discovering already-on-disk failing files) omits this and
  // gets the original re-run-from-scratch behavior.
  precomputedFirstRun?: RunResult,
): Promise<{ success: boolean; skipped?: boolean; error?: string; typeOnly?: boolean; baselinePassCount?: number; environmentLimited?: boolean }> {
  const { config, env, cwd, dryRun, verbose, log } = options
  const shortPath = testFilePath.replace(cwd + '/', '')
  const absTestPath = testFilePath.startsWith('/') ? testFilePath : join(cwd, testFilePath)
  // Per-file verify runs must honor the configurable timeout, not a hardcoded 60s. A slow
  // integration suite (real DB, heavy transform/import) can take 60–120s+ to finish, so a 60s
  // cap KILLS the run mid-stream: the captured output ends after a few passing tests with no
  // summary line, which the gate misreads as "tests failing" and the model — shown only passes —
  // "fixes" by looping forever, then deleting tests. coverageTimeout defaults to 300s.
  const runTimeout = config.coverageTimeout * 1000
  // Run under the file's OWN package config (monorepo setupFiles/cleanup/env), not bare from root.
  const fileRun = await resolveFileTestRun(env, absTestPath, cwd)
  // A monorepo can mix runners per package — resolve THIS file's actual runner so prompt-building
  // (mock API choice, etc.) matches whatever will really execute it, not the repo-wide default.
  const fileEnv = await resolveEnvForFile(env, absTestPath, cwd)
  generator.setEnv(fileEnv)
  // Forward the embedder "Stop" signal so an in-flight fix generation is aborted instantly.
  generator.setAbortSignal(options.abortSignal)

  if (!onStatus) log(chalk.bold(`\n  Fixing: ${chalk.cyan(shortPath)}`))
  onStatus?.({ phase: 'running', file: shortPath })

  // Run just this test file to get focused error output — unless the caller already has a fresh
  // result for the EXACT content currently on disk (see precomputedFirstRun's own doc comment).
  const firstRun = precomputedFirstRun ?? await runCommand(fileRun.command, fileRun.cwd, runTimeout, undefined, options.abortSignal)
  // Stop pressed while the suite was running — the run was killed, not failed. Bail immediately
  // instead of feeding empty output into a "fix" the user just cancelled.
  if (firstRun.aborted || options.abortSignal?.aborted) {
    onStatus?.({ phase: 'failed', file: shortPath })
    return { success: false, error: 'Cancelled.' }
  }
  // A killed run is NOT a test failure — editing tests can't fix a timeout, and the partial,
  // summary-less output would send the fix loop chasing a phantom failure. Surface it instead.
  if (firstRun.timedOut) {
    if (!onStatus) log(chalk.red(`  ⚠ ${shortPath} did not finish within ${config.coverageTimeout}s — the suite was killed before completing, not failing.`))
    if (!onStatus) log(chalk.yellow(`    Raise the limit in .lacuna.json: { "coverageTimeout": ${config.coverageTimeout * 2} }`))
    onStatus?.({ phase: 'failed', file: shortPath })
    return { success: false, error: `Test run timed out after ${config.coverageTimeout}s (suite killed before completing — raise coverageTimeout).` }
  }
  // Un-patchable environment/setup failure: a globalSetup / vitest.config / config-level GUARD that
  // throws before this test file (and its mocks) is even loaded, or a required backing service the
  // run can't provide. No edit to the test file can fix it — bail BEFORE spending any model
  // iterations (or even building context/retrieving memory) on a file that was never the problem.
  // (Live: a DB-integration test hit the same "Refusing to run against a non-local Mongo host"
  // globalSetup guard on all 3 attempts, each burning the full budget mock-padding it.)
  if (!firstRun.success) {
    const envLimit = detectEnvironmentLimitation(firstRun.stdout + '\n' + firstRun.stderr)
    if (envLimit) {
      if (!onStatus) {
        log(chalk.yellow(`\n  ⚠ ${shortPath} — environment limitation; no test-file edit can fix this, skipping:`))
        log(chalk.dim('    ' + envLimit.split('\n').join('\n    ')))
        log(chalk.dim('    Provide the missing service/env var (e.g. MONGO_URL → a LOCAL instance) in .lacuna.json "testEnv", or add this file to "ignore".'))
      }
      onStatus?.({ phase: 'failed', file: shortPath })
      return { success: false, environmentLimited: true, error: `Environment limitation (not a test bug): ${envLimit.split('\n')[0].trim()}` }
    }
  }
  let typeErrorsAtStart: string | null = null
  if (firstRun.success) {
    // Tests pass. In targeted (--file) or --types mode, a green file may still have
    // TypeScript errors the runner ignores (it transpiles, doesn't type-check) — repair
    // those rather than skip, otherwise generate's "run lacuna fix --file …" hand-off and
    // `lacuna fix --types` are dead ends. Default full-suite mode keeps skipping so
    // pollution-victim accounting is untouched.
    typeErrorsAtStart = (options.targetFile || options.types) ? await typeCheckFile(absTestPath, cwd, env) : null
    if (typeErrorsAtStart === TYPECHECK_INCONCLUSIVE) {
      // Couldn't verify the starting state (tsc timed out/crashed). Don't skip it as "passing"
      // (that's the false-green bug) and don't feed the sentinel to the model as the error to fix.
      if (!onStatus) log(chalk.red(`  ⚠ Could not type-check ${shortPath} (tsc did not complete) — leaving as unresolved.`))
      onStatus?.({ phase: 'failed', file: shortPath })
      return { success: false, typeOnly: true, error: TYPECHECK_INCONCLUSIVE }
    }
    if (!typeErrorsAtStart) {
      // Tests pass and types are clean. If Jest force-exited on a leaked handle AND that leak is
      // plausibly fixable by editing this test (the test/source actually creates a timer/interval/
      // subscription), enter the repair loop to add cleanup — the user relies on lacuna for test
      // hygiene, and keep-best guarantees a cleanup edit can't drop a passing test. But if the leak
      // is NOT test-fixable (it comes from the RN/jest/firebase/expo environment or a mocked
      // dependency — no handle-creating call in the test/source), no edit can clear it, so DON'T
      // chase it: that would treat a passing file as failing and burn iterations. Accept green + note.
      const leaked = detectOpenHandleLeak(firstRun.stdout + '\n' + firstRun.stderr)
      const leakCheckTestCode = await readFile(absTestPath, 'utf-8').catch(() => '')
      const fixable = leaked && leakLooksTestFixable(
        leakCheckTestCode,
        await readFile((await findSourceFile(testFilePath, cwd, config.sourceDir, leakCheckTestCode)) ?? '', 'utf-8').catch(() => null),
      )
      if (!fixable) {
        if (!onStatus) log(chalk.dim(leaked
          ? '  Already passing — a handle leaked but it originates outside this test (environment/dependency); kept as-is.'
          : '  Already passing — skipping.'))
        onStatus?.({ phase: 'passed', file: shortPath })
        return { success: true, skipped: true }
      }
      if (!onStatus) log(chalk.yellow('  Tests pass but a timer/handle leaked — adding cleanup.'))
    } else {
      if (!onStatus) log(chalk.yellow('  Tests pass but type errors found — repairing types.'))
    }
  }

  let errorOutput = typeErrorsAtStart
    ? `Tests pass but the test file has TypeScript type errors:\n${typeErrorsAtStart}\n\nFix ALL type errors without changing test behavior. Do not use 'as any' or '@ts-ignore'.`
    // firstRun.success here (with no type errors) can only mean the passing-but-leaked case above —
    // feed the cleanup guidance as the problem to solve.
    : firstRun.success
    ? buildOpenHandleLeakMessage()
    : extractTestFailure(firstRun.stdout + '\n' + firstRun.stderr)
  const initialErrorOutput = errorOutput
  const baselinePassCount = parsePassCount(firstRun.stdout + '\n' + firstRun.stderr)

  // Read existing test file
  let testCode: string
  try {
    testCode = await readFile(absTestPath, 'utf-8')
  } catch {
    const msg = `Could not read test file: ${shortPath}`
    if (!onStatus) log(chalk.red(`  ${msg}`))
    onStatus?.({ phase: 'failed', file: shortPath })
    return { success: false, error: msg }
  }

  // Subject-integrity guard: the identifier this test is named for. If the ORIGINAL test referenced
  // it (the normal case), every fixed version MUST keep referencing it — a rewrite that drops the
  // subject entirely is testing a DIFFERENT module (e.g. an easy imported util) and must be rejected
  // no matter how many of its trivial tests pass, or keep-best silently keeps it. Undefined when the
  // subject is a generic/aggregate name where the check would false-positive.
  const subject = subjectFromTestPath(absTestPath)
  const originalTestsSubject = !!subject && referencesSubject(testCode, subject)

  // Find and read the source file being tested
  const sourceFilePath = await findSourceFile(testFilePath, cwd, config.sourceDir, testCode)
  let sourceCode: string | null = null
  if (sourceFilePath) {
    sourceCode = await readFile(sourceFilePath, 'utf-8').catch(() => null)
  }

  // Real, live-observed bug: the classification that later retries get (crash / unrelated-file
  // attribution) was NEVER applied to this FIRST prompt — errorOutput above is a bare
  // extractTestFailure() with no enrichment at all. Confirmed on an RN-Expo project: 18+
  // files all crashed identically inside node_modules/expo/src/winter/fetch/... (an
  // expo-runtime polyfill issue, nothing to do with any individual test file), and the model
  // spent its ENTIRE first attempt (and often the second) trying to fix it by editing the test
  // file anyway — the "UNRELATED FILE" banner didn't appear until retry 2 or later, by which
  // point 1-2 full attempts (each several minutes of real model time) were already wasted on a
  // crash no test-file edit could ever fix. Apply the identical classification the retry loop
  // already does, up front, so attempt 1 gets the SAME signal instead of flying blind.
  const firstRawOutput = firstRun.stdout + '\n' + firstRun.stderr
  const firstCrashSignature = !typeErrorsAtStart ? detectProcessCrash(firstRawOutput) : null
  const firstUnrelatedFileNote = (!typeErrorsAtStart && !firstCrashSignature && isZeroTestsOutput(firstRawOutput))
    ? detectUnrelatedFileCrash(errorOutput, shortPath, sourceFilePath, mocksFileList(config))
    : null
  if (firstCrashSignature) {
    errorOutput = buildProcessCrashMessage(firstCrashSignature, errorOutput)
  } else if (firstUnrelatedFileNote) {
    errorOutput = errorOutput + firstUnrelatedFileNote
  }

  const sourceImportPath = sourceFilePath ? computeRelativeImport(absTestPath, sourceFilePath) : null

  // Collect type definitions, local import paths, and React version in parallel
  const [typeDefinitions, localImportPaths, reactMajorVersion] = await Promise.all([
    sourceCode && sourceFilePath
      ? collectTypeDefinitions(sourceCode, sourceFilePath, cwd).catch(() => null)
      : Promise.resolve(null),
    sourceCode && sourceFilePath
      ? collectLocalImportPaths(sourceCode, sourceFilePath, absTestPath, cwd).catch(() => null)
      : Promise.resolve(null),
    detectReactMajorVersion(cwd).catch(() => null),
  ])

  // Build mocks/setup context relative to the actual test file path
  const ctx = await buildFixFileContext(absTestPath, cwd, config, fileEnv.testRunner).catch(() => null)

  // Surface the learned rules this fix's prompt was enriched with (see loop.ts's identical
  // emit). Inert for the CLI (options.onEvent unset); no-op when memory retrieved nothing.
  if (ctx?.memoryEntries && ctx.memoryEntries.length > 0) {
    options.onEvent?.({ type: 'memory-used', file: shortPath, entries: ctx.memoryEntries.map((e) => e.id) })
  }

  // Retrieved memory for THIS failure, computed ONCE from the initial error and reused verbatim
  // on every retry — recomputing per-attempt would key retrieval off whatever the errorOutput
  // has drifted to by attempt 3 (e.g. "PATCH APPLICATION FAILED...", not a real test failure).
  // Appended into promptErrorOutput below, the same way mocksFileBanner already is — memory
  // hints have no dedicated prompt-builder slot; they follow the existing "enrich the error
  // string" pattern rather than inventing a parallel one.
  const fixMemoryResult = config.memory.enabled
    ? await buildFixMemoryHint(config, initialErrorOutput, {
        testRunner: fileEnv.testRunner,
        dependencies: reactMajorVersion !== null ? ['react'] : [],
      }).catch(() => ({ text: null, coveredPatterns: [] as string[] }))
    : { text: null, coveredPatterns: [] as string[] }
  const fixMemoryHint = fixMemoryResult.text
  const coveredPatterns = fixMemoryResult.coveredPatterns
  const fixMemoryTags = [fileEnv.testRunner, ...(reactMajorVersion !== null ? ['react'] : [])]
  // Write-back is a no-op when memory is disabled, or a harmless no-op on failure when no
  // matching entry exists yet (recordFixOutcome only creates NEW entries on success). Also
  // bumps/decays the tag-matched (mocks/frameworks) entries shown via ctx.memoryEntries — see
  // loop.ts's identical rationale.
  const recordFixMemory = async (outcome: 'success' | 'failure', finalCode: string): Promise<void> => {
    await Promise.all([
      recordFixOutcome(config, {
        errorSignature: initialErrorOutput,
        tags: fixMemoryTags,
        outcome,
        diffBefore: testCode,
        diffAfter: finalCode,
      }).catch(() => {}),
      ctx?.memoryEntries && ctx.memoryEntries.length > 0
        ? recordTagMatchOutcome(config, ctx.memoryEntries, initialErrorOutput, outcome === 'success' ? null : errorOutput).catch(() => {})
        : Promise.resolve(),
    ])
  }

  let stallRetries = 0
  const MAX_STALL_RETRIES = 2
  let rateLimitRetries = 0
  const MAX_RATE_LIMIT_RETRIES = 4
  // Widen the budget exactly once per file — this is a one-time structural correction (the
  // generator now permanently skips the line-count scale-down for the rest of its life, see
  // markAsReasoningModel), not a transient condition to keep waiting out. If it STILL happens
  // after the widen, that's a genuinely verbose reasoner exhausting even the full configured
  // ceiling — fall through to ordinary retry handling instead of looping forever.
  let reasoningBudgetWidened = false
  // Mirrors loop.ts's identical counter (previously only that file had one) — tracks 3 distinct
  // ways patch mode can fail to make progress on THIS file: an anchor not found, a patch that
  // nets test deletions instead of a real fix, or a patch that applies cleanly but still leaves
  // the file at 0 tests collected. Escalates to a forced full-file rewrite after 2 in a row,
  // regardless of which of the three caused it — see each trigger point below.
  let consecutivePatchFailures = 0
  // One-shot: a leaked timer/handle still lets tests pass (invisible to pass/fail classification)
  // but makes Jest force-exit — nudge the model to add cleanup once, then accept-with-warning.
  let openHandleNudged = false
  // Tests reached all-green on some attempt (the failing tests are repaired). Once true, residual
  // TypeScript errors are worth clearing too — but the file is never again reported as "failing":
  // on exhaustion we keep the green fix as a SUCCESS with a type warning, so trying to clean types
  // can never downgrade a genuinely-fixed file. Lets test-repair mode pursue a type-clean result
  // like --types/type-cleanup mode does, instead of stopping at "green but type errors remain".
  let reachedGreen = false

  // Keep-best across retries: a failing run can still be a net improvement over the
  // original (e.g. attempt 1 fixes 2 of 3 broken tests). Retries sometimes regress
  // below that high-water mark, so on exhaustion we must restore the BEST attempt —
  // not the last one and not blindly the original. bestCode/bestPassCount start at
  // the original so, absent any improvement, behaviour is unchanged (restore original).
  let bestCode = testCode
  let bestPassCount = baselinePassCount
  // Layer-aware tracking for STRUCTURE-BROKEN attempts (0 tests collected — a compile error or
  // require-time crash) — see countDistinctErrors's comment for the full rationale. Only ever
  // consulted while bestPassCount is still at baseline (no genuinely collecting attempt found
  // yet); once one exists it's always kept over any non-collecting state regardless of this.
  const baselineStructureErrorCount = countDistinctErrors(initialErrorOutput)
  let bestStructureErrorCount = baselineStructureErrorCount
  // Early-exit guard: an "unrelated file" crash (the stack trace never touches the test/source/
  // mocks being edited — e.g. a node_modules/expo polyfill failure) CANNOT be fixed by editing
  // the test file, by definition. If it's still there on a SECOND attempt (proving the model's
  // edit had no effect, as it never could), burning the REMAINING budget re-editing the same file
  // is pure waste — live-observed on an RN-Expo project: 18+ files each spent their FULL
  // budget on the identical node_modules/expo/src/winter/fetch crash before giving up anyway.
  let consecutiveUnrelatedFileCrashes = firstUnrelatedFileNote ? 1 : 0

  // Convergence-based iteration budget. The base cap is config.maxIterations; but a file with
  // LAYERED defects (act warning → leaked handle → type error → …) burns one attempt per distinct
  // problem, and a flat cap cuts it off mid-progress — the final, correct attempt never runs (seen
  // repeatedly on real RNTL hook suites). So: while each attempt resolves its problem and surfaces
  // a GENUINELY NEW one (a new normalized error signature — not a repeat / oscillation), extend the
  // budget one attempt at a time, up to ITERATION_CEILING. The moment an error REPEATS (stuck /
  // oscillating), the budget stops growing and the flat behavior resumes — so this only ever spends
  // extra model calls on files that are demonstrably still making forward progress.
  let effectiveMax = config.maxIterations
  const ITERATION_CEILING = iterationCeiling(config.maxIterations)
  const seenErrorSigs = new Set<string>()
  for (let attempt = 1; attempt <= effectiveMax; attempt++) {
    // Cancellation (embedder "Stop"): checked before every attempt so a stop lands within the
    // current file's retry loop, not only between files — see loop.ts's identical guard.
    if (options.shouldContinue && !options.shouldContinue()) {
      onStatus?.({ phase: 'failed', file: shortPath })
      return { success: false, error: 'Stopped by user.' }
    }
    // Progress check: `errorOutput` here is the problem THIS attempt will fix (the previous
    // attempt's result). If it's a new signature, the last attempt made forward progress — keep the
    // budget one ahead of the current attempt (never below the base cap, never above the ceiling).
    if (attempt > 1) {
      const sig = errorSignatureHash(normalizeErrorSignature(errorOutput))
      if (!seenErrorSigs.has(sig)) {
        seenErrorSigs.add(sig)
        if (effectiveMax < ITERATION_CEILING) {
          const extended = Math.min(ITERATION_CEILING, Math.max(effectiveMax, attempt + 1))
          if (extended > effectiveMax && !onStatus) {
            log(chalk.dim(`  Still making progress (new issue each pass) — extending to attempt ${extended}/${ITERATION_CEILING}.`))
          }
          effectiveMax = extended
        }
      }
    }
    if (attempt > 1) {
      if (!onStatus) log(chalk.yellow(`\n  Retry ${attempt}/${effectiveMax}...`))
    }

    // Show waiting phase before the model call; transition to generating/retrying on first token
    onStatus?.({ phase: 'waiting', file: shortPath, since: Date.now() })
    const currentAttempt = attempt
    generator.setFirstTokenCallback(() => {
      onStatus?.({
        phase: currentAttempt === 1 ? 'generating' : 'retrying',
        file: shortPath,
        ...(currentAttempt > 1 ? { attempt: currentAttempt, max: effectiveMax } : {}),
      } as WorkerState)
    })
    if (!onStatus) log(chalk.dim(`  ⌛ Waiting for model response...`))

    let viewer: StreamingFileViewer | undefined
    if (verbose && !onStatus) {
      viewer = new StreamingFileViewer(shortPath)
      generator.setTokenCallback(t => viewer!.append(t))
      viewer.start()
    }

    // If the diagnostic actually points at the shared mocks file rather than this test file,
    // rewriting the test file can never fix it — say so explicitly rather than let the model
    // burn every retry re-editing a file that was never broken. Kept separate from `errorOutput`
    // itself (only used for the two model-facing calls below) so downstream string-matching on
    // the raw error (buildStructureBrokenMessage, buildRegressionMessage, etc.) isn't affected.
    const mocksFileBanner = detectMocksFileError(errorOutput, mocksFileList(config))
    const promptErrorOutput = [errorOutput, mocksFileBanner, fixMemoryHint ? `\n\n${fixMemoryHint}` : null].filter(Boolean).join('')

    let fixed: string
    try {
      fixed = attempt === 1
        ? await generator.fix({
            testFile: shortPath,
            testCode,
            sourceFile: sourceFilePath?.replace(cwd + '/', '') ?? null,
            sourceCode,
            sourceImportPath,
            errorOutput: promptErrorOutput,
            env: fileEnv,
            mocksCode: ctx?.mocksCode ?? null,
            mocksImportPath: ctx?.mocksImportPath ?? null,
            extraMocks: ctx?.extraMocks ?? null,
            setupFileCode: ctx?.setupFileCode ?? null,
            packageDeps: ctx?.packageDeps ?? null,
            tsconfigPaths: ctx?.tsconfigPaths ?? null,
            typeDefinitions,
            localImportPaths,
            reactMajorVersion,
            projectMemory,
            memoryContext: ctx?.memoryContext ?? null,
            existingTestLineCount: testCode.split('\n').length,
            coveredPatterns,
          })
        : await generator.retry(promptErrorOutput, errorOutput)
    } catch (err) {
      viewer?.stop()
      generator.setTokenCallback(undefined)
      generator.setFirstTokenCallback(undefined)
      // User pressed Stop mid-generation — abort immediately, no retry.
      if (err instanceof ModelCancelledError) {
        onStatus?.({ phase: 'failed', file: shortPath })
        return { success: false, error: 'Stopped by user.' }
      }
      if (err instanceof ModelStallError) {
        if (stallRetries < MAX_STALL_RETRIES) {
          stallRetries++
          if (!onStatus) log(chalk.yellow(`\n  ⌛ Model stalled — reconnecting (${stallRetries}/${MAX_STALL_RETRIES})...`))
          onStatus?.({ phase: 'waiting', file: shortPath, since: Date.now() })
          await new Promise(r => setTimeout(r, 3000))
          attempt--   // don't consume an AI iteration for a connection stall
          continue
        }
      }
      // Provider is rejecting requests for capacity reasons (429 quota, or a 5xx/"overloaded"
      // rejection under high concurrency) rather than because anything about this file/test is
      // wrong. Back off with jitter and retry a few times before giving up — under N parallel
      // workers, other in-flight requests finishing frees up capacity within seconds, so an
      // immediate hard failure here wastes a worker slot for the rest of the run. Exponential
      // backoff (2s, 4s, 8s, 16s + up to 1s jitter) spreads retries out instead of every
      // rejected worker hammering the provider again at the same instant.
      if (err instanceof ModelRateLimitError) {
        if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          rateLimitRetries++
          const delayMs = 2000 * 2 ** (rateLimitRetries - 1) + Math.floor(Math.random() * 1000)
          if (!onStatus) log(chalk.yellow(`\n  ⌛ Provider is rate-limited/overloaded — backing off ${Math.round(delayMs / 1000)}s (${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})...`))
          onStatus?.({ phase: 'waiting', file: shortPath, since: Date.now() })
          await new Promise(r => setTimeout(r, delayMs))
          attempt--   // don't consume an AI iteration for a capacity rejection
          continue
        }
      }
      // A model whose name doesn't match the reasoning-model allowlist (e.g. a provider-specific
      // alias lacuna has never seen) just proved at runtime that it IS one: it spent the whole
      // max_tokens budget on reasoning_content and never reached real content, which otherwise
      // looks identical to a plain empty response with no error, forever re-sent at the same
      // too-small budget. Widen it once and retry without burning a real attempt.
      if (err instanceof ReasoningBudgetExhaustedError && !reasoningBudgetWidened) {
        reasoningBudgetWidened = true
        generator.markAsReasoningModel()
        if (!onStatus) log(chalk.yellow(`\n  ⌛ ${err.model} spent its full token budget on reasoning — retrying with the full configured budget...`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
        attempt--   // don't consume an AI iteration for a misdetected budget, not a genuine failure
        continue
      }
      if (err instanceof TruncatedOutputError || err instanceof ReasoningBudgetExhaustedError) {
        errorOutput = TRUNCATION_RETRY_MESSAGE
        if (!onStatus) log(chalk.yellow(`\n  Output truncated — retrying with shorter output request...`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
        continue
      }
      if (err instanceof OscillationError) {
        if (attempt < effectiveMax) {
          // Iterations remain — give one escape-hatch attempt with fresh oscillation state
          // and an explicit "completely different approach" message instead of stopping.
          if (!onStatus) log(chalk.yellow(`\n  ⚠ Agent loop detected — retrying with different strategy...`))
          onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
          generator.resetOscillationState()
          errorOutput = OSCILLATION_ESCAPE_MESSAGE
          continue
        }
        if (!onStatus) log(chalk.red(`\n  ⚠ Agent loop detected — output identical to a previous attempt. Stopping early.`))
        onStatus?.({ phase: 'failed', file: shortPath })
        // Keep the best attempt (original if nothing beat it) rather than the looped output.
        await writeFile(absTestPath, bestCode, 'utf-8').catch(() => {})
        return { success: false, error: err.message }
      }
      const msg = err instanceof Error ? err.message : String(err)
      if (!onStatus) log(chalk.red(`\n  API error: ${msg}`))
      onStatus?.({ phase: 'failed', file: shortPath })
      return { success: false, error: msg }
    }

    viewer?.stop()
    generator.setTokenCallback(undefined)
    generator.setFirstTokenCallback(undefined)

    if (dryRun) {
      if (!onStatus) {
        log(chalk.yellow('\n  [dry-run] Would write:'))
        log(chalk.dim(fixed.split('\n').slice(0, 10).map((l) => `    ${l}`).join('\n')))
      }
      onStatus?.({ phase: 'passed', file: shortPath })
      return { success: true }
    }

    // Patch mode: apply surgical edits against the ORIGINAL file the model was shown
    // (history[0] in the generator), NOT whatever a prior failed/regressing attempt left on
    // disk. A regression isn't reverted until the loop ends, so the on-disk file drifts away
    // from what the model anchors to — making every retry's anchors "not found". Anchor to
    // testCode first; fall back to disk only when the model genuinely built on its own prior
    // (still-applied) edit.
    if (generator.isPatch) {
      let patched = tryApplyPatch(testCode, fixed)
      let patchBaseUsed = testCode
      if (patched === null) {
        const onDisk = await readFile(absTestPath, 'utf-8').catch(() => null)
        if (onDisk && onDisk !== testCode) {
          patched = tryApplyPatch(onDisk, fixed)
          if (patched !== null) patchBaseUsed = onDisk
        }
      }
      if (patched !== null) {
        const baseTestCount = countTestCases(patchBaseUsed)
        const resultTestCount = countTestCases(patched)
        if (resultTestCount < baseTestCount) {
          // The patch applied cleanly but net-deletes tests — DELETE_TEST is for genuinely
          // obsolete tests, not an anchor-mismatch escape hatch (observed: a model stuck on
          // repeated "anchor not found" reaching for DELETE_TEST on ~18 valid tests just to get
          // SOME op in its patch to succeed). Reject and retry instead of silently shipping a
          // file with fewer tests than it started with.
          consecutivePatchFailures++
          if (consecutivePatchFailures >= 2) {
            errorOutput = buildPatchEscalationMessage(consecutivePatchFailures, 'repeatedly deleting tests instead of fixing the anchor')
            generator.setPatchMode(false)
          } else {
            errorOutput =
              `PATCH REJECTED: this patch removes ${baseTestCount - resultTestCount} test case(s) (${baseTestCount} → ${resultTestCount}) without adding replacements.\n` +
              `DELETE_TEST is only for tests that are genuinely obsolete — never use it to work around a REPLACE/anchor mismatch.\n` +
              `Re-read the test file and fix the actual anchor problem, or add new tests covering what you removed.`
          }
          if (!onStatus) log(chalk.yellow(`  ⚠ Patch deletes ${baseTestCount - resultTestCount} test(s) — rejecting and retrying...`))
          onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
          continue
        }
        // NOT reset here — a clean anchor application only means the patch STRUCTURALLY applied,
        // not that the resulting code actually compiles or collects tests. Reset happens below,
        // in the post-run classification, only once the test run confirms the file is
        // structurally intact (not 0-tests-collected) — see loop.ts's identical reasoning.
        fixed = patched
      } else {
        // Anchor(s) not found — do NOT write raw patch markers to disk
        consecutivePatchFailures++
        if (consecutivePatchFailures >= 2) {
          errorOutput = buildPatchEscalationMessage(consecutivePatchFailures, 'the anchor keeps not matching the file')
          generator.setPatchMode(false)
        } else {
          errorOutput =
            'PATCH APPLICATION FAILED: one or more anchor strings in your patch were not found in the test file.\n' +
            'Anchors must be copied character-for-character (including quote style) from the CURRENT TEST FILE shown above.\n' +
            'Checklist:\n' +
            '  • REPLACE_TEST / DELETE_TEST anchor = exact it/test name already in the file\n' +
            '  • ADD_AFTER_DESCRIBE anchor = exact describe() name already in the file\n' +
            '  • For a brand-new test, use ADD_AFTER_DESCRIBE with the enclosing describe name\n' +
            'Re-read the test file, find the exact anchor names, and rewrite your patch.'
        }
        if (!onStatus) log(chalk.yellow(`  Patch anchors not found — retrying...`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
        continue
      }
    } else {
      // A full <code_output> rewrite should never contain lacuna's OWN internal <code_patch>
      // delimiter syntax — found leaking into a real full-file response (the model's own prior
      // patch attempt, still sitting in conversation history, got copied verbatim into a later
      // full rewrite). Reject and retry rather than silently write corrupted content to disk.
      if (detectStrayPatchMarkers(fixed)) {
        consecutivePatchFailures++
        errorOutput =
          'STRAY PATCH-FORMAT MARKERS DETECTED in your full-file output — this response contains literal "// @@@ REPLACE:"/"// @@@ WITH:"/"// @@@ END" text, which is lacuna\'s internal <code_patch> syntax, not valid code.\n' +
          'Do NOT copy patch-format text from an earlier attempt into a full <code_output> rewrite — write ONLY real, complete TypeScript, with no "// @@@" markers anywhere.'
        if (!onStatus) log(chalk.yellow(`  ⚠ Stray patch-format markers found in full-file output — rejecting and retrying...`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
        continue
      }
      // Model switched to (or stayed in) full-file mode — reset patch failure counter
      consecutivePatchFailures = 0
    }

    // Strip thinking/prose that leaked before the first real code line.
    const { code: cleanFixed, stripped: bleedText } = stripLeadingProse(fixed)
    if (bleedText !== null) {
      if (!onStatus) log(chalk.yellow(`  ⚠ Thinking bleed detected — stripped: "${bleedText.slice(0, 80)}…"`))
      fixed = cleanFixed
    }

    // Split out mocks file if AI returned one
    const MOCKS_SEPARATOR = '// ---MOCKS_FILE---'
    const MOCKS_PATCH_SEPARATOR = '// ---MOCKS_PATCH---'
    let testFileContent = fixed

    // Set when a mocks patch fails to apply — appended to whatever errorOutput the test-file
    // run itself produces below, rather than short-circuiting the whole attempt. The test-file
    // fix and the mocks-file patch are logically INDEPENDENT changes bundled into one response;
    // discarding a genuinely correct test-file fix just because an unrelated (and sometimes
    // unrequested) mocks patch failed to apply throws away real progress before it ever gets a
    // chance to be written, run, and scored by the keep-best tracking below. Observed live under
    // `-w N` parallel workers: a worker's mocks-patch anchor is built from an earlier read of the
    // shared file, but by the time its response comes back other workers have already written to
    // it, so the anchor is stale — a race, not a mistake in the test-file fix sitting right next
    // to it in the same response.
    let mocksPatchFailureNote: string | null = null

    const primaryMocksFile = mocksFileList(config)[0]
    if (fixed.includes(MOCKS_PATCH_SEPARATOR) && primaryMocksFile) {
      // Surgical patch mode: model only emits the changed sections
      const [newTestCode, patchContent] = fixed.split(MOCKS_PATCH_SEPARATOR)
      testFileContent = newTestCode.trim()
      if (patchContent?.trim()) {
        const absoluteMocksFile = join(cwd, primaryMocksFile)
        // Read + apply + write must be one atomic section under parallel workers (`fix -w N`)
        // — see withMocksLock.
        const applied = await withMocksLock(async () => {
          let existing = ''
          try { existing = await readFile(absoluteMocksFile, 'utf-8') } catch { /* new file — patch can't apply */ }
          if (!existing) return null
          const result = tryApplyMocksPatch(existing, patchContent.trim())
          if (result && result.failedOps.length === 0) {
            if (detectUnbalancedMocksSyntax(result.result)) return { ...result, unbalanced: true }
            await writeFile(absoluteMocksFile, result.result, 'utf-8')
          }
          return result
        })
        if (applied) {
          if ('unbalanced' in applied && applied.unbalanced) {
            mocksPatchFailureNote = `MOCKS PATCH REJECTED: applying it left the shared mock file with unbalanced braces/parens/brackets — it was NOT written to disk (this would have broken every test that imports it). Your patch content is likely truncated or incomplete. Re-emit the full, complete ---MOCKS_PATCH--- (or ---MOCKS_FILE--- for a full rewrite) with matching braces.`
            if (!onStatus) log(chalk.red(`  ⚠ Mock patch would leave the shared file unbalanced — rejected, not written.`))
          } else if (applied.failedOps.length > 0) {
            const anchors = applied.failedOps.map(op => `"${op.oldText.slice(0, 60).replace(/\n/g, '↵')}"`).join(', ')
            mocksPatchFailureNote = `MOCKS PATCH FAILED: the following REPLACE anchor(s) were not found in the mock file:\n${anchors}\nAnchors must be copied character-for-character from the SHARED MOCK FILE shown above (re-read it — under parallel workers it may have changed since you last saw it). Re-read it and rewrite your ---MOCKS_PATCH--- block.`
            if (!onStatus) log(chalk.yellow(`  ⚠ Mock patch anchors not found — proceeding with the test-file fix alone, will retry the mocks patch...`))
          } else {
            if (!onStatus) log(chalk.dim(`  Patched mocks file: ${primaryMocksFile}`))
          }
        }
      }
    } else if (fixed.includes(MOCKS_SEPARATOR) && primaryMocksFile) {
      const [newTestCode, newMocksCode] = fixed.split(MOCKS_SEPARATOR)
      testFileContent = newTestCode.trim()
      if (newMocksCode?.trim()) {
        const { code: safeMocks, stripped } = sanitizeMocksContent(newMocksCode.trim())
        if (stripped && !onStatus) log(chalk.yellow(`  ⚠ Mocks file contained test blocks — stripped before writing`))
        if (safeMocks) {
          const absoluteMocksFile = join(cwd, primaryMocksFile)
          await mkdir(dirname(absoluteMocksFile), { recursive: true })
          // Read + merge + dedupe + write as one atomic section — under parallel workers, two
          // workers reading the same pre-write content would otherwise each compute their own
          // merge and the second writer would silently discard the first worker's addition.
          const wasUnbalanced = await withMocksLock(async () => {
            let existing = ''
            try { existing = await readFile(absoluteMocksFile, 'utf-8') } catch { /* new file */ }
            const merged = dedupeMockExports(existing ? mergeMocksContent(existing, safeMocks) : safeMocks)
            if (detectUnbalancedMocksSyntax(merged)) return true
            await writeFile(absoluteMocksFile, merged, 'utf-8')
            return false
          })
          if (wasUnbalanced) {
            mocksPatchFailureNote = `MOCKS FILE REJECTED: the rewritten mock file has unbalanced braces/parens/brackets — it was NOT written to disk (this would have broken every test that imports it). Your response is likely truncated (hit a length limit mid-function) or incomplete. Re-emit the complete mock file with every function body closed, or use ---MOCKS_PATCH--- for a smaller, surgical change instead of a full rewrite.`
            if (!onStatus) log(chalk.red(`  ⚠ Mocks file rewrite would leave it unbalanced — rejected, not written.`))
          } else {
            if (!onStatus) log(chalk.dim(`  Updated mocks file: ${primaryMocksFile}`))
          }
        }
      }
    }

    testFileContent = deduplicateViMocks(testFileContent)
    testFileContent = typeImportOriginalCalls(testFileContent)
    testFileContent = ensureMockedImports(testFileContent)
    testFileContent = fixNeverTypedAsyncMocks(testFileContent)
    testFileContent = dedupeImports(testFileContent)
    testFileContent = dedupeTestBlocks(testFileContent)
    testFileContent = replaceUnsafeFunctionType(testFileContent)

    // Catch empty test files before writing
    if (!hasTestFunctions(testFileContent)) {
      errorOutput =
        'ERROR: The code you returned contains NO test functions (no it() or test() calls).\n' +
        'Do not write a file with only imports, types, describe() blocks, or helpers.\n' +
        'Every test file must contain at least one: it(\'description\', () => { expect(...).toBe(...) })\n' +
        'Rewrite the file and include real test cases.'
      if (!onStatus) log(chalk.yellow(`  Generated file has no tests — retrying...`))
      onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
      continue
    }

    // Subject-integrity: never let the fix drift to testing a DIFFERENT module. Rejected BEFORE
    // writing/verifying, so a wrong-subject rewrite (however many trivial tests it passes) can never
    // win keep-best. This is the exact failure that turned a hook's test into tests for an imported util.
    if (originalTestsSubject && subject && !referencesSubject(testFileContent, subject)) {
      errorOutput =
        `ERROR: This test file is \`${subject}\`'s — it must test \`${subject}\`. Your rewrite no longer ` +
        `imports or references \`${subject}\` at all; you have replaced the tests with tests for a DIFFERENT ` +
        `module. Do NOT abandon the subject under test to make things pass. Keep testing \`${subject}\` (import ` +
        `it and exercise it); fix the mocks/setup that were failing instead of testing something else.`
      if (!onStatus) log(chalk.red(`  ⚠ Rewrite abandoned the subject (${subject}) — rejected, retrying...`))
      onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
      continue
    }

    onStatus?.({ phase: 'writing', file: shortPath })
    await writeFile(absTestPath, testFileContent, 'utf-8')

    if (!onStatus) log(chalk.dim('  Written. Running tests...'))
    onStatus?.({ phase: 'running', file: shortPath })

    const result = await runCommand(fileRun.command, fileRun.cwd, runTimeout, undefined, options.abortSignal)
    if (result.aborted || options.abortSignal?.aborted) {
      onStatus?.({ phase: 'failed', file: shortPath })
      return { success: false, error: 'Cancelled.' }
    }
    const rawRunOutput = result.stdout + '\n' + result.stderr
    if (result.timedOut) {
      if (!onStatus) log(chalk.red(`  ⚠ ${shortPath} did not finish within ${config.coverageTimeout}s — keeping the current file; raise coverageTimeout to verify it.`))
      onStatus?.({ phase: 'failed', file: shortPath })
      return { success: false, error: `Test run timed out after ${config.coverageTimeout}s (raise coverageTimeout).` }
    }

    if (result.success) {
      if (hasPlaceholderBodies(testFileContent)) {
        errorOutput =
          'ERROR: One or more test bodies contain placeholder comments (e.g. `// body`, `// TODO`) with no real assertions.\n' +
          'Every test must have complete, working expectations:\n' +
          '  it(\'description\', async () => {\n' +
          '    const result = await subject.doThing(...);\n' +
          '    expect(result).toEqual(expectedValue);\n' +
          '  })\n' +
          'Replace every `// body` placeholder with real arrange-act-assert code.'
        if (!onStatus) log(chalk.yellow('  Placeholder test bodies detected — retrying...'))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
        continue
      }
      // Tests all pass this attempt (green). CRITICAL: capture it as the best attempt NOW — keep-best
      // is otherwise only updated on the FAILURE path, so a green-but-type-erroring attempt that then
      // gets regressed by a later type-fix would leave bestCode pointing at a FAILING version. On
      // exhaustion (reachedGreen) we write bestCode, so without this the file lacuna reports as
      // "passing" is actually a failing one on disk — the exact "lacuna says passed, npm test fails"
      // bug. Green = the highest possible pass count, so this makes bestCode the real green version.
      const greenPassCount = parsePassCount(rawRunOutput)
      if (greenPassCount >= bestPassCount) {
        bestPassCount = greenPassCount
        bestCode = testFileContent
      }
      // Tests pass — but Jest had to force-exit on a leaked handle (interval/connection never
      // cleared). Invisible to pass/fail classification (still green), so nudge once, then
      // accept-with-warning rather than loop on a possible false positive.
      const openHandleLeak = detectOpenHandleLeak(rawRunOutput)
      // Only nudge to add cleanup when the leak is plausibly caused by THIS test/source (a real
      // timer/subscription). An environment/dependency leak (no handle-creating call here) can't be
      // cleared by editing the test — nudging just wastes a retry — so fall through to accept-green.
      if (openHandleLeak && !openHandleNudged && attempt < effectiveMax && leakLooksTestFixable(testFileContent, sourceCode)) {
        openHandleNudged = true
        errorOutput = buildOpenHandleLeakMessage()
        if (!onStatus) log(chalk.yellow('  Tests pass but Jest force-exited on a leaked handle — fixing (retrying)...'))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
        continue
      }
      if (openHandleLeak && !onStatus) {
        log(chalk.yellow('  ⚠ Jest had to force-exit due to a leaked timer/handle in this test file — tests pass but consider adding cleanup.'))
      }
      const typeErrors = await typeCheckFile(absTestPath, cwd, env)
      if (typeErrors === TYPECHECK_INCONCLUSIVE) {
        // tsc couldn't actually verify (timeout/crash). Do NOT declare the file fixed on an
        // unverified check — that's the "says passed but type errors remain" bug. Stop cleanly
        // and report it as unresolved; retrying would only re-feed the model a non-error.
        if (!onStatus) log(chalk.red(`  ⚠ Could not verify types (tsc did not complete) — leaving as unresolved.`))
        await writeFile(absTestPath, bestCode, 'utf-8').catch(() => {})
        onStatus?.({ phase: 'failed', file: shortPath })
        return { success: false, typeOnly: firstRun.success, baselinePassCount: bestPassCount, error: TYPECHECK_INCONCLUSIVE }
      }
      if (typeErrors) {
        // Tests pass but the file still has TypeScript errors. Whether it passed at START
        // (--types / generate→fix handoff) or we JUST repaired the failing tests, keep retrying to
        // clear the types — the user relies on lacuna to leave the file both green AND type-clean,
        // and if we can't fully clear them the exhaustion path keeps the green fix as a success
        // (reachedGreen), so this can never lose a real repair or revert to the broken original.
        reachedGreen = reachedGreen || firstRun.success === false
        errorOutput = `Tests passed but TypeScript type errors were found:\n${typeErrors}\n\nFix ALL type errors. Do not use 'as any' or '@ts-ignore'.`
        if (!onStatus) log(chalk.yellow('  Tests pass but type errors found — retrying...'))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax })
        continue
      }
      if (!onStatus) log(chalk.green('  Fixed.'))
      if (mocksPatchFailureNote && !onStatus) {
        log(chalk.yellow(`  ⚠ Note: this file's tests pass without it, but the accompanying mocks-file patch in this response did NOT apply (anchor not found) — ${primaryMocksFile} was left unchanged.`))
      }
      onStatus?.({ phase: 'passed', file: shortPath })
      if (config.memory.enabled) await recordFixMemory('success', testFileContent)
      return { success: true }
    }

    const rawExtracted = extractTestFailure(rawRunOutput)
    const structureBroken = isZeroTestsOutput(rawRunOutput)
    const currentPassCount = structureBroken ? 0 : parsePassCount(rawRunOutput)
    const currentFailCount = structureBroken ? 0 : parseFailCount(rawRunOutput)
    // A hard process crash (OOM/segfault) can otherwise get sorted into either "structure broken"
    // (crash before any test starts) or "regression" (crash partway through, killing the process
    // before a summary line prints — passCount reads 0, satisfying "fewer than before") — checked
    // first so it always gets its own, correct guidance instead of "fix your assertions."
    const crashSignature = detectProcessCrash(rawRunOutput)
    // enrichNoTestsError adds guidance for genuinely missing test functions;
    // in the structure-broken path the issue is always a broken import, so use
    // rawExtracted there so the actual module error isn't buried in boilerplate.
    const leakGuidance = processExitLeakGuidance(rawRunOutput)
    const extracted = leakGuidance
      ? `${leakGuidance}\n\n${enrichNoTestsError(rawExtracted, rawRunOutput, env.testRunner)}`
      : enrichNoTestsError(rawExtracted, rawRunOutput, env.testRunner)

    // Track the high-water mark — the attempt with the most passing tests so far.
    // Only collecting runs qualify (structureBroken === 0 tests is never "best") for THIS metric —
    // see below for the layer-aware fallback that covers structure-broken progress instead.
    if (!structureBroken && currentPassCount > bestPassCount) {
      bestCode = testFileContent
      bestPassCount = currentPassCount
    } else if (structureBroken && bestPassCount <= baselinePassCount) {
      // No collecting attempt has ever been found for this file — a structure-broken attempt
      // with FEWER distinct blocking errors than the best seen so far is still real, verifiable
      // progress even though pass count can't see it (e.g. fixing an invalid-import compile error
      // reveals a separate module-hoisting crash underneath — same "0 tests collected" outcome,
      // but objectively one less thing wrong). Without this, that kind of fix got zero credit and
      // the file reverted to its ORIGINAL broken state on exhaustion, so the next run re-discovers
      // the same first bug from scratch instead of picking up where this one left off.
      const currentErrorCount = countDistinctErrors(rawExtracted)
      if (currentErrorCount < bestStructureErrorCount) {
        bestCode = testFileContent
        bestStructureErrorCount = currentErrorCount
      }
    }

    let unrelatedFileNote: string | null = null
    if (crashSignature) {
      errorOutput = buildProcessCrashMessage(crashSignature, extracted)
      if (!onStatus) log(chalk.red(`  Test process CRASHED (attempt ${attempt}/${effectiveMax})`))
    } else if (structureBroken) {
      unrelatedFileNote = detectUnrelatedFileCrash(rawExtracted, shortPath, sourceFilePath, mocksFileList(config))
      if (generator.isPatch) {
        consecutivePatchFailures++
        if (consecutivePatchFailures >= 2) {
          errorOutput = buildPatchEscalationMessage(consecutivePatchFailures, 'the patch keeps breaking the file structure — 0 tests collected')
          generator.setPatchMode(false)
        } else {
          errorOutput = buildStructureBrokenMessage(initialErrorOutput, rawExtracted) + (unrelatedFileNote ?? '')
        }
      } else {
        errorOutput = buildStructureBrokenMessage(initialErrorOutput, rawExtracted) + (unrelatedFileNote ?? '')
      }
      if (!onStatus) log(chalk.red(`  Fix broke file structure — 0 tests collected (attempt ${attempt}/${effectiveMax})`))
    } else if (currentPassCount < baselinePassCount) {
      // Reached here means the file collected tests fine this attempt — patch mode is
      // structurally working again, regardless of the assertion-level regression itself.
      consecutivePatchFailures = 0
      errorOutput = buildRegressionMessage(initialErrorOutput, extracted, baselinePassCount, currentPassCount) + (buildFailingTestChecklist(rawRunOutput) ?? '')
      if (!onStatus) log(chalk.red(`  Fix caused regression: ${baselinePassCount} → ${currentPassCount} passing (attempt ${attempt}/${effectiveMax})`))
    } else if (currentFailCount === 0 && currentPassCount > 0) {
      // Every collected test PASSES, yet the run failed — vitest flagged an unhandled error
      // (an unhandled promise rejection or a suite-level error outside any test). Without this
      // branch the model just sees "still failing" with no failing assertion and flails. Name it.
      consecutivePatchFailures = 0
      errorOutput = buildUnhandledErrorMessage(extracted, currentPassCount)
      if (!onStatus) log(chalk.red(`  All ${currentPassCount} tests pass but the run failed on unhandled errors (attempt ${attempt}/${effectiveMax})`))
    } else {
      consecutivePatchFailures = 0
      errorOutput = extracted + (buildFailingTestChecklist(rawRunOutput) ?? '')
      if (!onStatus) log(chalk.red(`  Still failing (attempt ${attempt}/${effectiveMax})`))
    }
    // Surface the mocks-patch failure alongside whatever the test run itself reported, so the
    // next retry gets both signals — it may need to re-anchor the mocks patch even if the
    // test-file fix on its own is otherwise fine (or the test failure IS a downstream symptom of
    // the mocks file never getting updated).
    if (mocksPatchFailureNote) errorOutput = `${errorOutput}\n\n${mocksPatchFailureNote}`
    if (!onStatus && verbose) log(chalk.dim(errorOutput.split('\n').slice(0, 20).join('\n')))

    consecutiveUnrelatedFileCrashes = unrelatedFileNote ? consecutiveUnrelatedFileCrashes + 1 : 0
    if (consecutiveUnrelatedFileCrashes >= 2 && attempt < effectiveMax) {
      if (!onStatus) {
        log(chalk.red(`  ⚠ Same unrelated-file crash on ${consecutiveUnrelatedFileCrashes} attempts in a row — no test-file edit can fix this. Stopping early instead of burning the remaining budget.`))
      }
      break
    }
  }

  // Leave the BEST attempt on disk — not the last one. bestCode is the original
  // unless some attempt collected strictly more passing tests, so a pure failure still
  // restores the original (don't leave broken AI code on disk), while a partial win
  // (e.g. attempt 1 fixed 2 of 3 tests but later retries regressed) is preserved.
  // For a type-only repair this is the original passing (but type-erroring) file,
  // which is strictly better than a regenerated guess — the caller must NOT regenerate it.
  await writeFile(absTestPath, bestCode, 'utf-8').catch(() => {})

  // A test-repair that reached all-green but couldn't fully clear residual type errors within the
  // budget is a SUCCESS — the failing tests ARE fixed (the whole point of the run); the leftover
  // types are a follow-up, never a reason to report the file as still-failing or to regenerate it.
  // We tried to clean them (unlike before, which gave up immediately) and kept the green fix.
  if (reachedGreen && !firstRun.success) {
    if (!onStatus) log(chalk.yellow(`  ⚠ Tests pass — kept the fix. Couldn't auto-clear every type error in ${effectiveMax} attempts; re-run fix to try the rest.`))
    onStatus?.({ phase: 'passed', file: shortPath })
    if (config.memory.enabled) await recordFixMemory('success', bestCode)
    return { success: true, typeOnly: true, baselinePassCount: bestPassCount }
  }

  if (!onStatus && bestPassCount > baselinePassCount) {
    log(chalk.yellow(`  Kept best attempt: ${baselinePassCount} → ${bestPassCount} passing (couldn't reach all-green).`))
  } else if (!onStatus && bestStructureErrorCount < baselineStructureErrorCount) {
    log(chalk.yellow(`  Kept best attempt: ${baselineStructureErrorCount} → ${bestStructureErrorCount} blocking error(s) (still 0 passing, but closer to compiling — picks up here next run).`))
  }
  onStatus?.({ phase: 'failed', file: shortPath })
  if (config.memory.enabled) await recordFixMemory('failure', bestCode)
  const typeOnly = firstRun.success
  return {
    // Report what's actually on disk now, so the regen fallback compares against the
    // kept improvement and never replaces it with a worse from-scratch rewrite.
    baselinePassCount: bestPassCount,
    success: false,
    typeOnly,
    error: `${typeOnly ? 'Type errors remain' : 'Still failing'} after ${effectiveMax} attempts. Last error:\n${errorOutput.slice(0, 1500)}`,
  }
}

// ─── Polluter detection ───────────────────────────────────────────────────────

function buildTestFileRegex(pattern: string): RegExp {
  const filename = pattern.split('/').pop() ?? pattern
  const regexStr = filename
    .replace(/\{([^}]+)\}/g, (_: string, g: string) => `(${g.split(',').map((s: string) => s.trim()).join('|')})`)
    .replace(/\./g, '\\.')
    .replace(/\*+/g, '[^/]+')
  return new RegExp(regexStr + '$')
}

async function discoverTestFiles(cwd: string, env: { testFilePattern: string }, scopeDir?: string): Promise<string[]> {
  const testRe = buildTestFileRegex(env.testFilePattern)
  const files: string[] = []
  const skipDirs = new Set(['node_modules', 'dist', '.git', 'coverage', '.nyc_output', '.lacuna'])

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) await walk(join(dir, e.name))
      } else if (testRe.test(e.name)) {
        files.push(join(dir, e.name))
      }
    }
  }

  await walk(scopeDir ?? cwd)
  return files.sort()
}

function victimInFailing(victim: string, failing: string[], cwd: string): boolean {
  const rel = (p: string) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p)
  const shortVictim = rel(victim)
  return failing.some(f => {
    const shortF = rel(f)
    return shortF === shortVictim || shortVictim.endsWith(shortF) || shortF.endsWith(shortVictim)
  })
}

async function victimFailsWithSubset(
  victim: string,
  subset: string[],
  env: import('../lib/detector.js').DetectedEnvironment,
  cwd: string,
): Promise<boolean> {
  if (subset.length === 0) return false
  const run = await resolveMultiFileTestRun(env, [...subset, victim], cwd)
  const result = await runCommand(run.command, run.cwd, 120_000)
  if (result.success) return false
  const failing = parseFailingTestFiles(result.stdout + '\n' + result.stderr, env.testRunner)
  return victimInFailing(victim, failing, cwd)
}

async function bisectPolluter(
  victim: string,
  candidates: string[],
  env: import('../lib/detector.js').DetectedEnvironment,
  cwd: string,
): Promise<string | null> {
  if (candidates.length === 0) return null

  if (candidates.length === 1) {
    const fails = await victimFailsWithSubset(victim, candidates, env, cwd)
    return fails ? candidates[0] : null
  }

  const mid = Math.floor(candidates.length / 2)
  const left = candidates.slice(0, mid)
  const right = candidates.slice(mid)

  if (await victimFailsWithSubset(victim, left, env, cwd)) return bisectPolluter(victim, left, env, cwd)
  if (await victimFailsWithSubset(victim, right, env, cwd)) return bisectPolluter(victim, right, env, cwd)
  return null
}

async function findAndFixPolluters(
  victimFiles: string[],
  options: FixOptions,
  projectMemory?: string | null,
): Promise<{ pollutersFixed: number; victimsRegenerated: number }> {
  const { config, env, cwd, log } = options

  const allTestFiles = await discoverTestFiles(cwd, env)
  log(chalk.dim(`  Discovered ${allTestFiles.length} test files to search.`))

  const generator = new TestGenerator({ config, env, cwd })
  let pollutersFixed = 0
  let victimsRegenerated = 0
  const seenPolluters = new Set<string>()
  const unresolvedVictims: string[] = []

  for (const victim of victimFiles) {
    const shortVictim = victim.replace(cwd + '/', '')
    log(chalk.dim(`\n  Bisecting for: ${chalk.cyan(shortVictim)}`))

    const candidates = allTestFiles.filter(f => f !== victim)

    // Probe: verify the pollution reproduces before spending O(log N) bisect runs.
    // If it doesn't reproduce here, the pollution requires the runner's default parallel
    // execution to manifest and can't be found by this approach.
    log(chalk.dim(`  Probing (${candidates.length} files + victim)...`))
    const reproduced = await victimFailsWithSubset(victim, candidates, env, cwd)
    if (!reproduced) {
      // vitest's default multi-worker pool can share module/global state within one worker
      // thread, so a spy/mock from another file in the same worker can persist. Jest's per-file
      // vm context isolates globalThis even within one worker PROCESS, so a non-reproducing case
      // there is more likely a REAL shared external resource (a singleton connection, an env var
      // mutation, a leaked timer) than JS-realm contamination — phrase the guidance accordingly.
      if (env.testRunner === 'vitest') {
        log(chalk.yellow(`  Pollution did not reproduce in sequential mode — this is concurrency-based globalThis contamination.`))
        log(chalk.dim(`  A vi.spyOn(global, ...) spy from another file is persisting in the shared worker thread.`))
        log(chalk.dim(`  Fix: add restoreMocks: true and clearMocks: true to the test: {} block in vitest.config.ts`))
        log(chalk.dim(`  Also add beforeEach(() => vi.restoreAllMocks()) to your test setup file.`))
      } else if (env.testRunner === 'jest') {
        log(chalk.yellow(`  Pollution did not reproduce in sequential mode — jest isolates globalThis per file, so this is likely a real shared resource (a singleton connection, a mutated env var, a leaked timer) rather than JS-realm contamination.`))
        log(chalk.dim(`  Fix: add restoreMocks: true and clearMocks: true to the top level of jest.config.js/ts.`))
        log(chalk.dim(`  Also add beforeEach(() => jest.restoreAllMocks()) to your test setup file, and check for a module-level singleton (DB client, cache) that outlives a single test file.`))
      } else {
        log(chalk.yellow(`  Pollution did not reproduce in sequential mode — this likely requires the runner's default parallel execution to manifest.`))
      }
      unresolvedVictims.push(victim)
      continue
    }

    const polluter = await bisectPolluter(victim, candidates, env, cwd)

    if (!polluter) {
      log(chalk.yellow(`  Could not isolate a polluter — file may have an internal spy lifecycle bug.`))
      unresolvedVictims.push(victim)
      continue
    }

    const shortPolluter = polluter.replace(cwd + '/', '')
    log(`  Found polluter: ${chalk.cyan(shortPolluter)}`)

    if (seenPolluters.has(polluter)) {
      log(chalk.dim(`  Already processed ${shortPolluter}.`))
      continue
    }
    seenPolluters.add(polluter)

    // Capture the victim's failure output when run after the polluter
    const pvRun = await resolveMultiFileTestRun(env, [polluter, victim], cwd)
    const errorRun = await runCommand(pvRun.command, pvRun.cwd, 60_000)
    const victimError = extractTestFailure(errorRun.stdout + '\n' + errorRun.stderr)

    const pollutorCode = await readFile(polluter, 'utf-8').catch(() => null)
    const victimCode = await readFile(victim, 'utf-8').catch(() => null)
    if (!pollutorCode || !victimCode) {
      log(chalk.red(`  Could not read files — skipping ${shortPolluter}`))
      unresolvedVictims.push(victim)
      continue
    }

    log(chalk.dim(`  Sending to ${config.model} for cleanup...`))
    // Resolve the polluter's OWN package runner — the file being edited, so its mock API
    // (vi.fn vs jest.fn) must match whatever actually executes it.
    const pollutorEnv = await resolveEnvForFile(env, polluter, cwd)
    generator.setEnv(pollutorEnv)
    let fixed: string
    try {
      fixed = await generator.fixPollution({
        pollutorFile: shortPolluter,
        pollutorCode,
        victimFile: shortVictim,
        victimCode,
        victimError,
        env: pollutorEnv,
      })
    } catch (err) {
      log(chalk.red(`  AI error: ${err instanceof Error ? err.message : String(err)}`))
      unresolvedVictims.push(victim)
      continue
    }

    await writeFile(polluter, fixed, 'utf-8')
    const pvVerify = await resolveMultiFileTestRun(env, [polluter, victim], cwd)
    const verifyRun = await runCommand(pvVerify.command, pvVerify.cwd, 60_000)
    const verifyFailing = parseFailingTestFiles(verifyRun.stdout + '\n' + verifyRun.stderr, env.testRunner)
    const victimResolved = !victimInFailing(victim, verifyFailing, cwd)

    if (victimResolved) {
      log(chalk.green(`  Cleanup applied: ${shortPolluter}`))
      pollutersFixed++
    } else {
      log(chalk.red(`  Cleanup did not resolve the victim — restoring ${shortPolluter}`))
      await writeFile(polluter, pollutorCode, 'utf-8').catch(() => {})
      unresolvedVictims.push(victim)
    }
  }

  // Phase 2: regenerate victims that bisection couldn't resolve.
  // These files pass alone but fail in the suite due to internal bugs
  // (e.g. module-level vi.spyOn, wrong mock structure). A fresh generation
  // produces properly-structured tests with spies inside beforeEach.
  if (unresolvedVictims.length > 0 && options.regenerateOnFailure !== false) {
    log(chalk.bold(`\n  Regenerating ${unresolvedVictims.length} victim file(s) that couldn't be resolved by polluter cleanup...`))
    for (const victim of unresolvedVictims) {
      const shortVictim = victim.replace(cwd + '/', '')
      log(chalk.dim(`\n  Regenerating: ${chalk.cyan(shortVictim)}`))
      const result = await regenerateFile(victim, options, undefined, projectMemory)
      if (result.success) {
        log(chalk.green(`  Regenerated successfully.`))
        victimsRegenerated++
      } else {
        log(chalk.red(`  Regeneration failed: ${result.error?.slice(0, 200) ?? 'unknown error'}`))
      }
    }
  }

  return { pollutersFixed, victimsRegenerated }
}

// ─── Regeneration fallback ────────────────────────────────────────────────────

async function regenerateFile(
  testFilePath: string,
  options: FixOptions,
  onStatus?: (state: WorkerState) => void,
  projectMemory?: string | null,
  baselinePassCount = 0,
): Promise<{ success: boolean; error?: string }> {
  const absTestFile = testFilePath.startsWith('/') ? testFilePath : join(options.cwd, testFilePath)

  // Back up the current content so a failed regeneration never leaves the file deleted or
  // filled with a broken last attempt — on failure we restore exactly what was here. Read
  // upfront (rather than after resolving the source below) so findSourceFile can also use it
  // to resolve the test's own relative imports.
  let originalContent: string | null = null
  try { originalContent = await readFile(absTestFile, 'utf-8') } catch { /* already gone */ }

  // Find the source file so processGap gets the right starting point.
  // processGap expects gap.filePath to be the SOURCE file, not the test file.
  const sourceFile = await findSourceFile(absTestFile, options.cwd, options.config.sourceDir, originalContent ?? undefined)
  if (!sourceFile) {
    return { success: false, error: `Could not find source file for ${absTestFile}` }
  }

  // Delete the broken test file before regenerating. If it stays on disk,
  // buildFileContext reads it as existingTestCode and the generate prompt says
  // "preserve all existing tests" — locking the AI into the same broken structure.
  await unlink(absTestFile).catch(() => {})

  const gap: CoverageGap = { filePath: sourceFile, uncoveredLines: [], uncoveredFunctions: [] }
  const generator = new TestGenerator({ config: options.config, env: options.env, cwd: options.cwd })

  // processGap uses gap.filePath (the source file) as its display identifier, but during
  // regen the worker should stay in 'regenerating' for all intermediate phases and only
  // flip to passed/failed at the end. This prevents the brief flash where 'regenerating'
  // gets overwritten by 'generating' (<80ms) as soon as processGap starts.
  const testShortPath = absTestFile.replace(options.cwd + '/', '')
  const regenOnStatus = onStatus
    ? (state: WorkerState) => {
        if (state.phase === 'passed' || state.phase === 'failed') {
          onStatus('file' in state ? { ...state, file: testShortPath } : state)
        } else {
          onStatus({ phase: 'regenerating', file: testShortPath })
        }
      }
    : undefined

  // Bounded budget: this fires only AFTER fixFile's own full maxIterations already failed to
  // repair this file — a full second maxIterations for the from-scratch rewrite would silently
  // double the worst-case cost of every file that reaches regeneration. Halved (min 1), mirroring
  // the identical treatment on generate's own fixOnFailure handoff (loop.ts) for the same reason.
  // Regeneration is already scoped to weak files only (REGEN_MAX_BASELINE_PASS, checked by the
  // caller before invoking this), so these are typically the simpler files where a rewrite
  // converging in half the budget is plausible — and the never-regress check below means a
  // regen that doesn't converge in time costs nothing beyond the halved attempt itself.
  const cappedOptions: FixOptions = { ...options, config: { ...options.config, maxIterations: Math.max(1, Math.ceil(options.config.maxIterations / 2)) } }
  const result = await processGap(gap, cappedOptions, generator, true, regenOnStatus, projectMemory, absTestFile)

  if (result.success) {
    // Never-regress: a "green" regen with fewer tests than the original is still a net loss
    // (e.g. 50 passing replacing 477). Re-run the regenerated file and keep it only if it has
    // at least as many passing tests as the original — otherwise restore the original.
    const regenFileRun = await resolveFileTestRun(options.env, absTestFile, options.cwd)
    const regenRun = await runCommand(regenFileRun.command, regenFileRun.cwd, options.config.coverageTimeout * 1000, undefined, options.abortSignal)
    // A timed-out OR cancelled re-run parses as 0 passing → would look like a regression vs baseline
    // and restore the original. Don't punish a slow suite or a Stop: keep the regen when killed.
    if (regenRun.timedOut || regenRun.aborted) return { success: true }
    const regenPass = parsePassCount(regenRun.stdout + '\n' + regenRun.stderr)
    if (regenPass < baselinePassCount && originalContent !== null) {
      await writeFile(absTestFile, originalContent, 'utf-8').catch(() => {})
      return { success: false, error: `Regeneration produced fewer passing tests (${regenPass}) than the original (${baselinePassCount}) — restored the original.` }
    }
    return { success: true }
  }

  // Regeneration failed — restore the original so we never leave the workspace worse than we
  // found it (deleted, or holding a truncated/garbage attempt).
  if (originalContent !== null) await writeFile(absTestFile, originalContent, 'utf-8').catch(() => {})
  return { success: result.success, error: result.error }
}

// Prefix a per-file error with its test file path so the summary names which
// file failed — the underlying error (e.g. a patch-anchor mismatch) often doesn't.
function tagError(file: string, cwd: string, error: string): string {
  const rel = isAbsolute(file) ? relative(cwd, file) : file
  return `${rel}\n${error}`
}

// ─── Worker pool ──────────────────────────────────────────────────────────────

async function runFixWorkers(
  testFiles: string[],
  options: FixOptions,
  workerCount: number,
  projectMemory: string | null,
): Promise<{ filesProcessed: number; filesFixed: number; filesAlreadyPassing: number; errors: string[]; stillFailingFiles: string[]; victimFiles: string[] }> {
  const queue = [...testFiles]
  let filesProcessed = 0
  let filesFixed = 0
  let filesAlreadyPassing = 0
  const errors: string[] = []
  const stillFailingFiles: string[] = []
  const victimFiles: string[] = []

  const tips = getActiveTips({
    workers: workerCount,
    targetFile: options.targetFile,
    verbose: options.verbose,
    dryRun: options.dryRun,
    model: options.config.model,
    threshold: options.config.threshold,
    mocksFile: options.config.mocksFile,
    ignore: options.config.ignore,
    command: 'fix',
  })
  const display = new WorkerDisplay(workerCount, testFiles.length, tips, 'fixed')
  display.start()

  await Promise.all(
    Array.from({ length: workerCount }, async (_, wi) => {
      const generator = new TestGenerator({ config: options.config, env: options.env, cwd: options.cwd })
      while (true) {
        if (options.shouldContinue && !options.shouldContinue()) break
        const file = queue.shift()
        if (!file) break
        const onStatus = (state: WorkerState) => { display.update(wi, state); options.onStatus?.(state) }
        const absFile = file.startsWith('/') ? file : join(options.cwd, file)
        const workerOptions = { ...options, log: () => {}, verbose: false }
        const result = await fixFile(absFile, workerOptions, generator, onStatus, projectMemory)
        filesProcessed++
        if (result.success) {
          if (result.skipped) { filesAlreadyPassing++; victimFiles.push(absFile) }
          else if (options.types && result.typeOnly) {
            // --types run: the file's tests pass (kept-green) but type errors REMAIN — the goal of a
            // --types run is a TYPE-CLEAN file, so this is NOT "fixed". Keep the file (tests pass) but
            // report it as still having type errors, else "Files fixed: N / All type errors fixed" lies.
            stillFailingFiles.push(file)
            if (!options.dryRun) await formatFileVerified(absFile, options.cwd, options.config, options.env)
          }
          else { filesFixed++; if (!options.dryRun) await formatFileVerified(absFile, options.cwd, options.config, options.env) }
        } else if (options.regenerateOnFailure && !options.types && !result.typeOnly && (result.baselinePassCount ?? Infinity) < REGEN_MAX_BASELINE_PASS) {
          // Regenerate from scratch only for mostly-broken files (few passing tests) — that's
          // where a fresh take rescues stuck tests. A file with a substantial passing suite is
          // left restored by fixFile, never nuked. Skip too for type-only/--types repairs, and
          // when the baseline is unknown (?? Infinity ⇒ don't risk it). regenerateFile itself
          // also discards any regen that lowers the passing count.
          // Signal 'regenerating' first — this undoes the 'failed' done-count from fixFile
          // so the regen's final phase is the single counted outcome for this file.
          onStatus?.({ phase: 'regenerating', file: absFile.replace(options.cwd + '/', '') })
          const regenResult = await regenerateFile(absFile, workerOptions, onStatus, projectMemory, result.baselinePassCount ?? 0)
          if (regenResult.success) {
            filesFixed++
            if (!options.dryRun) await formatFileVerified(absFile, options.cwd, options.config, options.env)
          } else {
            stillFailingFiles.push(file)
            if (regenResult.error) errors.push(tagError(file, options.cwd, regenResult.error))
          }
        } else {
          stillFailingFiles.push(file)
          if (result.error) errors.push(tagError(file, options.cwd, result.error))
        }
      }
    }),
  )

  display.finish()
  return { filesProcessed, filesFixed, filesAlreadyPassing, errors, stillFailingFiles, victimFiles }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runFixLoop(options: FixOptions): Promise<FixResult> {
  const { config, env, cwd, log } = options
  // Apply the configured test-env vars (e.g. MONGO_URL for a local test DB) into process.env BEFORE
  // any test run — the spawned runner inherits it. This lives HERE (the shared loop) not only in the
  // CLI commands, because the VS Code extension embeds runFixLoop directly and never executes the
  // command layer: without this, a user who set "testEnv" in .lacuna.json saw it silently ignored in
  // the extension, so a DB-integration test kept hitting its globalSetup guard. Idempotent — the CLI
  // path assigning it again is a harmless no-op.
  if (config.testEnv) Object.assign(process.env, config.testEnv)
  const workerCount = Math.max(1, Math.min(options.workers ?? 1, 10))
  const parallel = workerCount > 1

  // Proactively check + fix the shared mocks file(s) BEFORE touching any test file. A broken
  // declaration in a file every test imports otherwise only ever surfaces reactively — one test
  // file at a time, whichever happens to be processed first, burning that file's retry budget on
  // a bug that was never really its own. See mocks-fix.ts for the full rationale.
  await fixMocksFilesUpfront(config, env, cwd, { dryRun: options.dryRun, log })

  // Scope (`lacuna fix <dir>`): restrict selection + the discovery run to a subtree.
  const scopeDir = options.scopeDir
  const scopeRel = scopeDir ? scopeDir.replace(cwd + '/', '').replace(/\/+$/, '') : undefined

  let failingFiles: string[]

  if (options.types && !options.targetFile) {
    // Types mode: select by type errors rather than test failures. One project-wide tsc
    // finds every test file that fails type-checking — including files whose tests pass,
    // which the normal failure-driven selection never sees.
    if (env.language !== 'typescript') {
      log(chalk.yellow('\n  --types only applies to TypeScript projects — nothing to do.'))
      return { filesProcessed: 0, filesFixed: 0, filesAlreadyPassing: 0, pollutersFixed: 0, victimsRegenerated: 0, errors: [] }
    }
    // tsc always checks the whole governing project (no way to partially type-check correctly),
    // but we only select + fix test files under the scope. Label reflects that honestly.
    const tcLabel = scopeRel
      ? `  Type-checking project to find type errors under ${scopeRel}...`
      : '  Type-checking project to find test files with type errors...'
    const spinner = startCoverageSpinner(chalk.dim(tcLabel), env.testRunner)
    const allTestFiles = await discoverTestFiles(cwd, env, scopeDir)
    failingFiles = await findTestFilesWithTypeErrors(allTestFiles, cwd, env)
    spinner.stop()

    if (failingFiles.length === 0) {
      log(chalk.green('\n  All test files are type-clean — nothing to fix.'))
      return { filesProcessed: 0, filesFixed: 0, filesAlreadyPassing: 0, pollutersFixed: 0, victimsRegenerated: 0, errors: [] }
    }
  } else if (options.targetFile) {
    // Single-file mode: skip the full suite run, go straight to the target file
    const absTarget = options.targetFile.startsWith('/')
      ? options.targetFile
      : join(cwd, options.targetFile)
    const spinner = startCoverageSpinner(chalk.dim(`  Checking ${options.targetFile}...`), env.testRunner)
    const targetRun = await resolveFileTestRun(env, absTarget, cwd)
    const fileResult = await runCommand(targetRun.command, targetRun.cwd, config.coverageTimeout * 1000, spinner.onLine, options.abortSignal)
    spinner.stop(fileResult.stdout + fileResult.stderr)

    const targetRawOutput = fileResult.stdout + fileResult.stderr
    const targetConfigConflict = detectJestConfigConflict(targetRawOutput)
    if (targetConfigConflict) {
      throw new Error(`Jest never ran any tests — nothing was checked.\n\n${targetConfigConflict}`)
    }
    const targetValidationError = detectJestValidationError(targetRawOutput)
    if (targetValidationError) {
      throw new Error(targetValidationError)
    }

    if (fileResult.timedOut) {
      log(chalk.red(`\n  ⚠ ${options.targetFile} did not finish within ${config.coverageTimeout}s — the suite was killed before completing, not failing.`))
      log(chalk.yellow(`    Raise the limit in .lacuna.json: { "coverageTimeout": ${config.coverageTimeout * 2} }`))
      return { filesProcessed: 0, filesFixed: 0, filesAlreadyPassing: 0, pollutersFixed: 0, victimsRegenerated: 0, errors: [`${options.targetFile}: test run timed out after ${config.coverageTimeout}s`] }
    }

    if (fileResult.success) {
      // Tests pass — but the runner only transpiles, it doesn't type-check, and it force-exits
      // (rather than fails) on a leaked handle. A green file can still have TypeScript errors (the
      // exact case `generate` hands off here) OR a leaked timer/connection. Declare victory only if
      // it's ALSO type-clean AND handle-clean; otherwise fall through and repair (fixFile handles
      // both, keeping the green tests intact via keep-best).
      const typeErrors = await typeCheckFile(absTarget, cwd, env)
      const leaked = detectOpenHandleLeak(fileResult.stdout + '\n' + fileResult.stderr)
      // A leak only counts as "to fix" when it's plausibly from THIS test/source (see fixFile).
      const leakCheckTargetCode = await readFile(absTarget, 'utf-8').catch(() => '')
      const leakFixable = leaked && leakLooksTestFixable(
        leakCheckTargetCode,
        await readFile((await findSourceFile(absTarget, cwd, config.sourceDir, leakCheckTargetCode)) ?? '', 'utf-8').catch(() => null),
      )
      if (!typeErrors && !leakFixable) {
        log(chalk.green(`\n  All tests are passing${leaked ? ' (a handle leaked, but it originates outside this test — environment/dependency)' : ''} — nothing to fix.`))
        return { filesProcessed: 1, filesFixed: 0, filesAlreadyPassing: 1, pollutersFixed: 0, victimsRegenerated: 0, errors: [] }
      }
      log(chalk.yellow(typeErrors
        ? '\n  Tests pass but TypeScript type errors remain — repairing types.'
        : '\n  Tests pass but a timer/handle leaked — adding cleanup.'))
    }

    failingFiles = [absTarget]
  } else {
    // Full-suite mode: check cache before running the suite. Scoped runs bypass the cache
    // (it holds whole-suite failures) and run only the tests under the scope when the runner
    // supports it (vitest/jest); otherwise the full suite runs and results are post-filtered.
    const cache = (options.fresh || scopeDir) ? null : await loadFixCache(cwd)
    const useCached = cache !== null && cache.ageSeconds < FIX_CACHE_TTL_S

    if (useCached) {
      log(chalk.dim(`  Resuming from last run (${Math.round(cache!.ageSeconds)}s ago, ${cache!.files.length} file(s) still failing). Pass --fresh to re-scan the full suite.`))
      failingFiles = cache!.files
    } else {
      // Run under the scoped package's OWN config (monorepo setupFiles/cleanup/env), so a test
      // that only passes with its package setup isn't reported as a false failure.
      const scopeRun = scopeDir
        ? await resolveScopeTestRun(env, scopeDir, cwd)
        : { command: env.testCommand, cwd }
      const label = scopeRel ? `  Running tests under ${scopeRel} to find failures...` : '  Running test suite to find failures...'
      const spinner = startCoverageSpinner(chalk.dim(label), env.testRunner)
      const suiteResult = await runCommand(scopeRun.command, scopeRun.cwd, config.coverageTimeout * 1000, spinner.onLine, options.abortSignal)
      spinner.stop(suiteResult.stdout + suiteResult.stderr)

      if (suiteResult.timedOut) {
        throw new Error(
          `Test suite timed out after ${config.coverageTimeout}s.\n` +
          `Increase it in .lacuna.json: { "coverageTimeout": ${config.coverageTimeout * 2} }`,
        )
      }

      if (suiteResult.success) {
        const where = scopeRel ? ` under ${scopeRel}` : ''
        log(chalk.green(`\n  All tests${where} are passing — nothing to fix.`))
        return { filesProcessed: 0, filesFixed: 0, filesAlreadyPassing: 0, pollutersFixed: 0, victimsRegenerated: 0, errors: [] }
      }

      const rawDiscoveryOutput = suiteResult.stdout + suiteResult.stderr
      const configConflict = detectJestConfigConflict(rawDiscoveryOutput)
      if (configConflict) {
        throw new Error(`Jest never ran any tests — nothing was discovered to fix.\n\n${configConflict}`)
      }
      const validationError = detectJestValidationError(rawDiscoveryOutput)
      if (validationError) {
        throw new Error(validationError)
      }
      const parsedFiles = parseFailingTestFiles(rawDiscoveryOutput, env.testRunner)
      // Resolve each reported path to a real file (handles vitest workspace/monorepo package-
      // relative paths), then keep those inside cwd, out of node_modules, and within scope.
      const searchRoot = scopeDir ?? cwd
      const resolved = new Set<string>()
      const unresolvedParsed: string[] = []
      for (const f of parsedFiles) {
        const abs = await resolveReportedTestPath(f, cwd, searchRoot)
        if (!abs) { unresolvedParsed.push(f); continue }
        if (!abs.startsWith(cwd) || abs.includes('node_modules')) continue
        if (scopeDir && !isWithinDir(abs, scopeDir)) continue
        resolved.add(abs)
      }
      failingFiles = [...resolved]

      // Sanity-check parseFailingTestFiles's own count against the runner's summary line — a
      // silent safety net, not routine noise: if the runner ever reports MORE failing suites
      // than we could name by path (the root cause behind an earlier "11 failed but only 6
      // found" investigation turned out to be a display-only double-count bug elsewhere, now
      // fixed — but this check stays as a guard against a REAL future undercount, e.g. a runner
      // output format parseFailingTestFiles's TEST_FILE_RE doesn't handle), warn loudly and dump
      // the raw output for diagnosis instead of silently dropping failures from the fix queue.
      const expectedFailedMatch = stripAnsi(rawDiscoveryOutput).match(/Test Suites:\s+(\d+)\s+failed/)
      const expectedFailedCount = expectedFailedMatch ? parseInt(expectedFailedMatch[1], 10) : null
      if (expectedFailedCount !== null && failingFiles.length < expectedFailedCount) {
        const debugBase = resolveDebugBase(config.debug)
        const debugFile = perFileDebugPath(debugBase, 'discovery-undercount')
        await debugWrite(
          debugFile,
          'DISCOVERY UNDERCOUNT',
          `parsedFiles (${parsedFiles.length}): ${JSON.stringify(parsedFiles)}\n` +
          `unresolvedParsed (${unresolvedParsed.length}): ${JSON.stringify(unresolvedParsed)}\n` +
          `resolved (${resolved.size}): ${JSON.stringify([...resolved])}\n\n` +
          `RAW OUTPUT:\n${rawDiscoveryOutput}`,
          true,
        )
        log(chalk.red(
          `\n  ⚠ The test runner reports ${expectedFailedCount} failing test suite(s), but only ${failingFiles.length} could be identified by name — ` +
          `${expectedFailedCount - failingFiles.length} failing suite(s) will NOT be queued for fixing this run.` +
          (debugFile ? `\n    Raw discovery output saved to ${debugFile} for diagnosis.` : '\n    Enable "debug": true in .lacuna.json to save the raw output for diagnosis.'),
        ))
      } else if (expectedFailedCount === null) {
        log(chalk.yellow(`  ⚠ Could not parse a "Test Suites: N failed" summary line from the runner output — can't sanity-check the failing-file count.`))
      }

      if (failingFiles.length === 0) {
        const where = scopeRel ? ` under ${scopeRel}` : ''
        log(chalk.yellow(`\n  Could not identify any failing test files${where} from the output.`))
        log(chalk.dim(`  Try running ${scopeRun.command} directly (in ${scopeRun.cwd}) to inspect the output.`))
        const lastLines = (suiteResult.stdout + suiteResult.stderr)
          .split('\n')
          .filter((l) => l.trim())
          .slice(-20)
          .join('\n')
        if (lastLines) log(chalk.dim('\n  Last output lines:\n' + lastLines.split('\n').map((l) => `    ${l}`).join('\n')))
        return { filesProcessed: 0, filesFixed: 0, filesAlreadyPassing: 0, pollutersFixed: 0, victimsRegenerated: 0, errors: [] }
      }

      // Don't persist a scoped failure list as the whole-suite cache (an unscoped fix would
      // then resume from a partial set). Only full-suite runs populate the cache.
      if (!scopeDir) await saveFixCache(cwd, failingFiles)
    }
  }

  const scopeNote = scopeRel ? ` under ${scopeRel}` : ''
  log(chalk.bold(`\n  Found ${failingFiles.length}${scopeNote} ${options.types ? 'test file(s) with type errors' : 'failing test file(s)'}.`))
  if (parallel) {
    if (options.verbose) log(chalk.dim(`  (--verbose is not shown in parallel mode — use --workers 1 to see the live code panel)`))
    log(chalk.dim(`\n  Workers: ${workerCount}\n`))
  }

  const memory = new ProjectMemory()
  await memory.initialize(cwd, env, config)
  const memorySnapshot = memory.toPromptSection()

  let filesProcessed: number
  let filesFixed: number
  let filesAlreadyPassing: number
  let errors: string[]
  let stillFailingFiles: string[]
  let victimFiles: string[]

  if (parallel) {
    ;({ filesProcessed, filesFixed, filesAlreadyPassing, errors, stillFailingFiles, victimFiles } = await runFixWorkers(failingFiles, options, workerCount, memorySnapshot))
  } else {
    filesProcessed = 0
    filesFixed = 0
    filesAlreadyPassing = 0
    errors = []
    stillFailingFiles = []
    victimFiles = []
    const generator = new TestGenerator({ config, env, cwd })
    const tips = getActiveTips({
      workers: 1,
      targetFile: options.targetFile,
      verbose: options.verbose,
      dryRun: options.dryRun,
      model: config.model,
      threshold: config.threshold,
      mocksFile: config.mocksFile,
      ignore: config.ignore,
      command: 'fix',
    })
    const nextTip = createTipRotator(tips)
    for (const file of failingFiles) {
      if (options.shouldContinue && !options.shouldContinue()) break
      const tip = nextTip()
      if (tip) log(formatTip(tip))
      const absFile = file.startsWith('/') ? file : join(cwd, file)
      const result = await fixFile(absFile, options, generator, options.onStatus, memory.toPromptSection())
      filesProcessed++
      if (result.success) {
        if (result.skipped) { filesAlreadyPassing++; victimFiles.push(absFile) }
        else if (options.types && result.typeOnly) {
          // --types run: tests pass (kept-green) but type errors REMAIN — not a type-fix success.
          // Keep the file, but report it as still having type errors (see runFixWorkers).
          stillFailingFiles.push(file)
          if (!options.dryRun) await formatFileVerified(absFile, cwd, config, env)
        }
        else { filesFixed++; if (!options.dryRun) await formatFileVerified(absFile, cwd, config, env) }
      } else if (options.regenerateOnFailure && !options.types && !result.typeOnly && (result.baselinePassCount ?? Infinity) < REGEN_MAX_BASELINE_PASS) {
        // Regenerate only for mostly-broken files (few passing tests) — see runFixWorkers.
        // A substantial passing suite is left restored by fixFile, never nuked + rebuilt.
        log(chalk.yellow(`  Fix exhausted — falling back to full regeneration...`))
        const regenResult = await regenerateFile(absFile, options, options.onStatus, memory.toPromptSection(), result.baselinePassCount ?? 0)
        if (regenResult.success) {
          filesFixed++
          if (!options.dryRun) await formatFileVerified(absFile, cwd, config, env)
        } else {
          stillFailingFiles.push(file)
          if (regenResult.error) errors.push(tagError(file, cwd, regenResult.error))
        }
      } else {
        stillFailingFiles.push(file)
        if (result.error) errors.push(tagError(file, cwd, result.error))
      }
    }
  }

  // Update cache with only the files that are still failing.
  // This means the next `lacuna fix` run skips the full suite and picks up exactly
  // where we left off. If everything was fixed, delete the cache so the next run
  // does a clean suite scan to confirm.
  // Skip in --types mode: it selects by type errors, not the suite-failure axis the
  // cache represents, so it must not overwrite the failing-files cache.
  // Skip when scoped: stillFailingFiles is only the scope's subset — persisting it (or clearing
  // it on scope-success) would corrupt the whole-suite cache an unscoped fix relies on.
  if (!options.targetFile && !options.types && !options.scopeDir) {
    if (stillFailingFiles.length > 0) await saveFixCache(cwd, stillFailingFiles)
    else await clearFixCache(cwd)
  }

  let pollutersFixed = 0
  let victimsRegenerated = 0
  if (options.fixPolluters && victimFiles.length > 0) {
    log(chalk.bold(`\n  Scanning for test polluters (${victimFiles.length} victim file(s) pass alone but fail in suite)...`))
    const polluterResult = await findAndFixPolluters(victimFiles, options, memorySnapshot)
    pollutersFixed = polluterResult.pollutersFixed
    victimsRegenerated = polluterResult.victimsRegenerated
  }

  return { filesProcessed, filesFixed, filesAlreadyPassing, pollutersFixed, victimsRegenerated, errors }
}
