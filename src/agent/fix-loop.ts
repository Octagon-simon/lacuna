import { readFile, writeFile, mkdir, unlink, readdir } from 'fs/promises'
import { join, dirname, basename, extname, isAbsolute } from 'path'
import { access, stat } from 'fs/promises'
import chalk from 'chalk'
import type { LacunaConfig } from '../lib/config.js'
import type { DetectedEnvironment } from '../lib/detector.js'
import { fileTestCommand, multiFileTestCommand, scopedTestCommand, envForRunner } from '../lib/detector.js'
import { isWithinDir } from '../lib/coverage/index.js'
import { formatFile } from '../lib/format.js'
import { ensurePlaywrightForRun, loadPlaywrightConfig, playwrightTestCommand, parsePlaywrightResults, readPlaywrightErrorContext, runPlaywrightJson } from '../lib/playwright.js'
import { snapshotRoutes, type RouteSnapshot } from '../lib/flows/snapshot.js'
import { collectSpecHelpers, splitSpecAndHelpers, type SpecHelperFile } from '../lib/flows/spec-helpers.js'
import { buildE2ESystemPrompt, buildE2EFixPrompt } from './prompts/e2e.js'
import { runCommand } from '../lib/runner.js'
import { startCoverageSpinner } from '../lib/coverage-spinner.js'
import { WorkerDisplay } from '../lib/worker-display.js'
import type { WorkerState } from '../lib/worker-display.js'
import { buildFixFileContext, computeRelativeImport, collectTypeDefinitions, collectLocalImportPaths, detectReactMajorVersion, findFileByName } from './context.js'
import { TestGenerator, TruncatedOutputError, OscillationError, ModelStallError, TRUNCATION_RETRY_MESSAGE, OSCILLATION_ESCAPE_MESSAGE } from './generator.js'
import { processGap } from './loop.js'
import type { CoverageGap } from '../lib/coverage/types.js'
import { ProjectMemory } from './project-memory.js'
import { getActiveTips, createTipRotator, formatTip } from '../lib/tips.js'
import { typeCheckFile, findTestFilesWithTypeErrors, TYPECHECK_INCONCLUSIVE } from '../lib/typecheck.js'
import { hasTestFunctions, hasPlaceholderBodies, enrichNoTestsError, isZeroTestsOutput, parsePassCount, parseFailCount, countTestFunctions, buildStructureBrokenMessage, buildRegressionMessage, buildUnhandledErrorMessage, sanitizeMocksContent, stripLeadingProse, mergeMocksContent, deduplicateViMocks, typeImportOriginalCalls, ensureMockedImports, dedupeImports, dedupeTestBlocks, tryApplyPatch, tryApplyMocksPatch } from '../lib/validate.js'
import { extractTestFailure } from '../lib/extract-error.js'
import { StreamingFileViewer } from '../lib/streaming-viewer.js'

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
  e2e?: boolean     // repair failing Playwright end-to-end specs instead of unit tests
  log: (msg: string) => void
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
      const m = clean.match(new RegExp(`^FAIL\\s+(${TEST_FILE_RE.source})`))
      if (m) { failFiles.add(m[1]) }
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

// ─── Find the source file that a test file is testing ────────────────────────

async function findSourceFile(testFilePath: string, cwd: string, configSourceDirs: string | string[] = 'src'): Promise<string | null> {
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

// Build the failure summary the model sees from a Playwright run, parsing the JSON reporter
// into "title (file)\nmessage" blocks. Falls back to the generic extractor when the output
// isn't parseable JSON (e.g. the run crashed before the reporter emitted anything), mirroring
// how the unit path degrades on an unrecognised runner.
function extractE2EFailure(output: string, timedOut = false): string {
  const parsed = parsePlaywrightResults(output)
  if (parsed && parsed.failures.length > 0) {
    return parsed.failures
      .map((f) => `${f.title} (${f.file})\n${f.message}`)
      .join('\n\n')
      .slice(0, 4000)
  }
  // No parseable Playwright failure. Do NOT run it through extractTestFailure — that's the unit
  // extractor and it strips Playwright/timeout output down to nothing, leaving the model to
  // repair blind. Surface the raw tail (and call out a timeout) so there's always real signal.
  const raw = output.replace(/\x1B\[[0-9;]*m/g, '').trim()
  const tail = raw.slice(-3000)
  if (timedOut) {
    return `The spec run TIMED OUT before finishing — the flow likely exceeds the run timeout or is hanging on a step (a missing/changed selector that never resolves, a stuck navigation, or slow setup). Make the failing step resolve quickly or fix the selector it's waiting on.${tail ? `\n\nLast output before the timeout:\n${tail}` : ''}`
  }
  return tail || 'The spec failed but produced no readable Playwright output. It most likely errored in setup (beforeAll/beforeEach) or a helper — check the imported helpers and any external setup (login, seeded data) the spec depends on.'
}

// Best-effort: the route a spec exercises, from its first page.goto(...). Used to capture a fresh
// snapshot for E2E repair. Returns the pathname (origin stripped) or null when no goto is found.
function extractRouteFromSpec(specCode: string): string | null {
  const m = specCode.match(/\.goto\(\s*[`'"]([^`'"]+)[`'"]/)
  if (!m) return null
  let route = m[1]
  try { route = new URL(route).pathname } catch { /* relative path — keep as written */ }
  if (!route.startsWith('/')) route = '/' + route
  return route
}

async function fixFile(
  testFilePath: string,
  options: FixOptions,
  generator: TestGenerator,
  onStatus?: (state: WorkerState) => void,
  projectMemory?: string | null,
): Promise<{ success: boolean; skipped?: boolean; error?: string; typeOnly?: boolean; baselinePassCount?: number }> {
  const { config, env, cwd, dryRun, verbose, log } = options
  const shortPath = testFilePath.replace(cwd + '/', '')
  const absTestPath = testFilePath.startsWith('/') ? testFilePath : join(cwd, testFilePath)

  if (!onStatus) log(chalk.bold(`\n  Fixing: ${chalk.cyan(shortPath)}`))
  onStatus?.({ phase: 'running', file: shortPath })

  // Run just this test file to get focused error output. E2E flows (login + setup + multi-step)
  // routinely exceed the unit-test 60s cap; use the configured coverage timeout (default 300s) so
  // the run actually finishes and produces a real failure instead of being killed mid-run.
  const fileRunTimeoutMs = options.e2e ? config.coverageTimeout * 1000 : 60_000
  const firstRun = await runCommand(fileTestCommand(env, absTestPath), cwd, fileRunTimeoutMs)
  let typeErrorsAtStart: string | null = null
  if (firstRun.success) {
    // Tests pass. In targeted (--file) or --types mode, a green file may still have
    // TypeScript errors the runner ignores (it transpiles, doesn't type-check) — repair
    // those rather than skip, otherwise generate's "run lacuna fix --file …" hand-off and
    // `lacuna fix --types` are dead ends. Default full-suite mode keeps skipping so
    // pollution-victim accounting is untouched.
    typeErrorsAtStart = (options.targetFile || options.types) ? await typeCheckFile(absTestPath, cwd, env) : null
    if (!typeErrorsAtStart) {
      if (!onStatus) log(chalk.dim('  Already passing — skipping.'))
      onStatus?.({ phase: 'passed', file: shortPath })
      return { success: true, skipped: true }
    }
    if (!onStatus) log(chalk.yellow('  Tests pass but type errors found — repairing types.'))
  }

  let errorOutput = typeErrorsAtStart
    ? `Tests pass but the test file has TypeScript type errors:\n${typeErrorsAtStart}\n\nFix ALL type errors without changing test behavior. Do not use 'as any' or '@ts-ignore'.`
    : options.e2e
      ? extractE2EFailure(firstRun.stdout + '\n' + firstRun.stderr, firstRun.timedOut)
      : extractTestFailure(firstRun.stdout + '\n' + firstRun.stderr)

  // E2E: enrich the failure with Playwright's per-failure error-context.md — it carries the REAL
  // error and the exact failing line, and is written the instant the test fails (so it survives a
  // killed/timed-out run where the JSON reporter produced nothing). It also pinpoints the failing
  // STEP/page in a multi-step flow, not just the first route. This is the precise signal that lets
  // the model fix on the first attempt instead of burning iterations guessing.
  let e2eFailurePageState: string | null = null
  if (options.e2e) {
    const allContexts = await readPlaywrightErrorContext(cwd).catch(() => [])
    const targetBase = basename(absTestPath)
    const target = allContexts.filter((c) => c.specPath && basename(c.specPath) === targetBase)
    const upstream = allContexts.filter((c) => c.specPath && basename(c.specPath) !== targetBase)

    // The target produced no failure of its own but another spec did — with Playwright project
    // dependencies, the target was almost certainly SKIPPED because a setup/dependency spec failed.
    // Repairing the target can't help; point at the real one instead of burning every attempt.
    if (target.length === 0 && upstream.length > 0) {
      const u = upstream[0]
      const upSpec = u.specPath ?? 'a setup/dependency spec'
      const msg =
        `"${shortPath}" did not fail on its own — Playwright skipped it because a dependency/setup spec failed first:\n\n` +
        `  ${upSpec}\n  ${u.errorDetails.split('\n').slice(0, 4).join('\n  ')}\n\n` +
        `Fix that spec first (e.g. lacuna fix --e2e --file ${upSpec}). Repairing ${shortPath} cannot help until its setup passes.`
      if (!onStatus) log(chalk.yellow(`\n  ⚠ ${shortPath} is blocked by a failing dependency — ${upSpec}`))
      onStatus?.({ phase: 'failed', file: shortPath })
      return { success: false, error: msg }
    }

    const contexts = target.length > 0 ? target : allContexts   // target's own failures, else whatever we found
    if (contexts.length > 0) {
      const ctxText = contexts
        .map((c) => [c.test?.split('\n').find((l) => l.includes('Location:'))?.trim() ?? c.test?.split('\n')[0], c.errorDetails].filter(Boolean).join('\n'))
        .join('\n\n')
        .trim()
      if (ctxText) {
        const wasPlaceholder = /TIMED OUT before finishing|no readable Playwright output/.test(errorOutput)
        errorOutput = wasPlaceholder ? ctxText : `${ctxText}\n\n--- additional run output ---\n${errorOutput}`
      }
      e2eFailurePageState = contexts.find((c) => c.pageSnapshot)?.pageSnapshot ?? null
    }
  }

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

  // Find and read the source file being tested. Skipped for E2E: a Playwright spec drives the
  // running app through the browser and imports no single source module, so there is nothing to
  // resolve — passing a misleading "source under test" would only pollute the prompt.
  const sourceFilePath = options.e2e ? null : await findSourceFile(testFilePath, cwd, config.sourceDir)
  let sourceCode: string | null = null
  if (sourceFilePath) {
    sourceCode = await readFile(sourceFilePath, 'utf-8').catch(() => null)
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
  // Unit-test context (mocks file, source-under-test, type defs) is only consumed by the unit
  // `generator.fix()` path. E2E repair uses `fixE2E` (spec + route snapshot + helpers) and never reads
  // ctx, so skip it for e2e — otherwise we'd needlessly read the unit mock file for a Playwright spec.
  const ctx = options.e2e ? null : await buildFixFileContext(absTestPath, cwd, config).catch(() => null)

  // E2E repair context: capture a FRESH snapshot of the spec's route once (best-effort) so the
  // repair prompt can fix selector drift against the page's current state — the dominant cause
  // of E2E breakage. Skipped silently if the route can't be parsed or the snapshot fails.
  let e2eRoute: string | null = null
  let e2eBaseURL: string | null = null
  let e2eSnapshot: RouteSnapshot | null = null
  let e2eHelpers: SpecHelperFile[] = []   // the spec's imported selectors/helpers/config (read for context)
  const helperBackups = new Map<string, string>()   // original content of any helper file we overwrite (multi-file fix)
  if (options.e2e) {
    e2eRoute = extractRouteFromSpec(testCode)
    e2eHelpers = await collectSpecHelpers(testCode, absTestPath, cwd).catch(() => [])
    const pw = await loadPlaywrightConfig(cwd).catch(() => null)
    e2eBaseURL = pw?.baseURL ?? null
    if (e2eRoute && pw) {
      if (!onStatus) log(chalk.dim('  Capturing the current page state...'))
      const snap = await snapshotRoutes([e2eRoute], cwd, pw, 90_000).catch(() => null)
      e2eSnapshot = snap?.snapshots?.[0] ?? null
    }
  }

  let stallRetries = 0
  const MAX_STALL_RETRIES = 2

  // Keep-best across retries: a failing run can still be a net improvement over the
  // original (e.g. attempt 1 fixes 2 of 3 broken tests). Retries sometimes regress
  // below that high-water mark, so on exhaustion we must restore the BEST attempt —
  // not the last one and not blindly the original. bestCode/bestPassCount start at
  // the original so, absent any improvement, behaviour is unchanged (restore original).
  let bestCode = testCode
  let bestPassCount = baselinePassCount
  // Coverage floor: the spec being repaired must not come back with FEWER test cases. A model can
  // "fix" failures by deleting the failing tests — which goes green while silently shrinking coverage,
  // and the pass-count regression check below can't see it (removing a FAILING test leaves the pass
  // count unchanged). This is a repair tool, so we never accept a green achieved by dropping the
  // user's tests; if the model can only pass by deleting, the loop exhausts and restores the best
  // (non-shrunk) attempt.
  const baselineTestCount = countTestFunctions(testCode)

  for (let attempt = 1; attempt <= config.maxIterations; attempt++) {
    if (attempt > 1) {
      if (!onStatus) log(chalk.yellow(`\n  Retry ${attempt}/${config.maxIterations}...`))
    }

    // Show waiting phase before the model call; transition to generating/retrying on first token
    onStatus?.({ phase: 'waiting', file: shortPath, since: Date.now() })
    const currentAttempt = attempt
    generator.setFirstTokenCallback(() => {
      onStatus?.({
        phase: currentAttempt === 1 ? 'generating' : 'retrying',
        file: shortPath,
        ...(currentAttempt > 1 ? { attempt: currentAttempt, max: config.maxIterations } : {}),
      } as WorkerState)
    })
    if (!onStatus) log(chalk.dim(`  ⌛ Waiting for model response...`))

    let viewer: StreamingFileViewer | undefined
    if (verbose && !onStatus) {
      viewer = new StreamingFileViewer(shortPath)
      generator.setTokenCallback(t => viewer!.append(t))
      viewer.start()
    }

    let fixed: string
    try {
      fixed = attempt === 1
        ? options.e2e
          ? await generator.fixE2E(
              buildE2ESystemPrompt(),
              buildE2EFixPrompt({
                specFilePath: shortPath,
                specCode: testCode,
                failureOutput: errorOutput,
                route: e2eRoute,
                baseURL: e2eBaseURL,
                snapshot: e2eSnapshot,
                helpers: e2eHelpers,
                failurePageState: e2eFailurePageState,
              }),
              shortPath.split('/').pop() ?? shortPath,
            )
          : await generator.fix({
              testFile: shortPath,
              testCode,
              sourceFile: sourceFilePath?.replace(cwd + '/', '') ?? null,
              sourceCode,
              sourceImportPath,
              errorOutput,
              env,
              mocksCode: ctx?.mocksCode ?? null,
              mocksImportPath: ctx?.mocksImportPath ?? null,
              setupFileCode: ctx?.setupFileCode ?? null,
              packageDeps: ctx?.packageDeps ?? null,
              tsconfigPaths: ctx?.tsconfigPaths ?? null,
              typeDefinitions,
              localImportPaths,
              reactMajorVersion,
              projectMemory,
              existingTestLineCount: testCode.split('\n').length,
            })
        : await generator.retry(errorOutput)
    } catch (err) {
      viewer?.stop()
      generator.setTokenCallback(undefined)
      generator.setFirstTokenCallback(undefined)
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
      if (err instanceof TruncatedOutputError) {
        errorOutput = TRUNCATION_RETRY_MESSAGE
        if (!onStatus) log(chalk.yellow(`\n  Output truncated — retrying with shorter output request...`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
        continue
      }
      if (err instanceof OscillationError) {
        if (attempt < config.maxIterations) {
          // Iterations remain — give one escape-hatch attempt with fresh oscillation state
          // and an explicit "completely different approach" message instead of stopping.
          if (!onStatus) log(chalk.yellow(`\n  ⚠ Agent loop detected — retrying with different strategy...`))
          onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
          generator.resetOscillationState()
          errorOutput = OSCILLATION_ESCAPE_MESSAGE
          continue
        }
        if (!onStatus) log(chalk.red(`\n  ⚠ Agent loop detected — output identical to a previous attempt. Stopping early.`))
        onStatus?.({ phase: 'failed', file: shortPath })
        // Keep the best attempt (original if nothing beat it) rather than the looped output.
        await writeFile(absTestPath, bestCode, 'utf-8').catch(() => {})
        for (const [abs, orig] of helperBackups) await writeFile(abs, orig, 'utf-8').catch(() => {})
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
      if (patched === null) {
        const onDisk = await readFile(absTestPath, 'utf-8').catch(() => null)
        if (onDisk && onDisk !== testCode) patched = tryApplyPatch(onDisk, fixed)
      }
      if (patched !== null) {
        fixed = patched
      } else {
        // Anchor(s) not found — do NOT write raw patch markers to disk
        errorOutput =
          'PATCH APPLICATION FAILED: one or more anchor strings in your patch were not found in the test file.\n' +
          'Anchors must be copied character-for-character (including quote style) from the CURRENT TEST FILE shown above.\n' +
          'Checklist:\n' +
          '  • REPLACE_TEST / DELETE_TEST anchor = exact it/test name already in the file\n' +
          '  • ADD_AFTER_DESCRIBE anchor = exact describe() name already in the file\n' +
          '  • For a brand-new test, use ADD_AFTER_DESCRIBE with the enclosing describe name\n' +
          'Re-read the test file, find the exact anchor names, and rewrite your patch.'
        if (!onStatus) log(chalk.yellow(`  Patch anchors not found — retrying...`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
        continue
      }
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

    if (options.e2e) {
      // E2E multi-file fix: the model may fix a stale selector at its source by appending
      // // ---HELPER_FILE: <path>--- sections. Only the spec's own resolved imports are writable;
      // back up each before overwriting so a failed run can be fully reverted.
      const { spec, helpers: emitted } = splitSpecAndHelpers(fixed, e2eHelpers.map((h) => h.path))
      testFileContent = spec
      for (const h of emitted) {
        const abs = h.path.startsWith('/') ? h.path : join(cwd, h.path)
        if (!helperBackups.has(abs)) {
          const orig = await readFile(abs, 'utf-8').catch(() => null)
          if (orig !== null) helperBackups.set(abs, orig)
        }
        await writeFile(abs, h.content, 'utf-8').catch(() => {})
        if (!onStatus) log(chalk.dim(`  Updated helper: ${h.path}`))
      }
    } else if (fixed.includes(MOCKS_PATCH_SEPARATOR) && config.mocksFile) {
      // Surgical patch mode: model only emits the changed sections
      const [newTestCode, patchContent] = fixed.split(MOCKS_PATCH_SEPARATOR)
      testFileContent = newTestCode.trim()
      if (patchContent?.trim()) {
        const absoluteMocksFile = join(cwd, config.mocksFile)
        let existing = ''
        try { existing = await readFile(absoluteMocksFile, 'utf-8') } catch { /* new file — patch can't apply */ }
        if (existing) {
          const applied = tryApplyMocksPatch(existing, patchContent.trim())
          if (applied) {
            if (applied.failedOps.length > 0) {
              const anchors = applied.failedOps.map(op => `"${op.oldText.slice(0, 60).replace(/\n/g, '↵')}"`).join(', ')
              errorOutput = `MOCKS PATCH FAILED: the following REPLACE anchor(s) were not found in the mock file:\n${anchors}\nAnchors must be copied character-for-character from the SHARED MOCK FILE shown above. Re-read it and rewrite your ---MOCKS_PATCH--- block.`
              if (!onStatus) log(chalk.yellow(`  ⚠ Mock patch anchors not found — retrying...`))
              continue
            }
            await writeFile(absoluteMocksFile, applied.result, 'utf-8')
            if (!onStatus) log(chalk.dim(`  Patched mocks file: ${config.mocksFile}`))
          }
        }
      }
    } else if (fixed.includes(MOCKS_SEPARATOR) && config.mocksFile) {
      const [newTestCode, newMocksCode] = fixed.split(MOCKS_SEPARATOR)
      testFileContent = newTestCode.trim()
      if (newMocksCode?.trim()) {
        const { code: safeMocks, stripped } = sanitizeMocksContent(newMocksCode.trim())
        if (stripped && !onStatus) log(chalk.yellow(`  ⚠ Mocks file contained test blocks — stripped before writing`))
        if (safeMocks) {
          const absoluteMocksFile = join(cwd, config.mocksFile)
          await mkdir(dirname(absoluteMocksFile), { recursive: true })
          let existing = ''
          try { existing = await readFile(absoluteMocksFile, 'utf-8') } catch { /* new file */ }
          const merged = existing ? mergeMocksContent(existing, safeMocks) : safeMocks
          await writeFile(absoluteMocksFile, merged, 'utf-8')
          if (!onStatus) log(chalk.dim(`  Updated mocks file: ${config.mocksFile}`))
        }
      }
    }

    testFileContent = deduplicateViMocks(testFileContent)
    testFileContent = typeImportOriginalCalls(testFileContent)
    testFileContent = ensureMockedImports(testFileContent)
    testFileContent = dedupeImports(testFileContent)
    testFileContent = dedupeTestBlocks(testFileContent)

    // Catch empty test files before writing
    if (!hasTestFunctions(testFileContent)) {
      errorOutput =
        'ERROR: The code you returned contains NO test functions (no it() or test() calls).\n' +
        'Do not write a file with only imports, types, describe() blocks, or helpers.\n' +
        'Every test file must contain at least one: it(\'description\', () => { expect(...).toBe(...) })\n' +
        'Rewrite the file and include real test cases.'
      if (!onStatus) log(chalk.yellow(`  Generated file has no tests — retrying...`))
      onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
      continue
    }

    onStatus?.({ phase: 'writing', file: shortPath })
    await writeFile(absTestPath, testFileContent, 'utf-8')

    if (!onStatus) log(chalk.dim('  Written. Running tests...'))
    onStatus?.({ phase: 'running', file: shortPath })

    const result = await runCommand(fileTestCommand(env, absTestPath), cwd, fileRunTimeoutMs)

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
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
        continue
      }
      // Coverage guard: a green run achieved by DELETING test cases is not a repair. Reject it and
      // require the dropped tests back. (Pass-count regression can't catch this — see baselineTestCount.)
      const fixedTestCount = countTestFunctions(testFileContent)
      if (fixedTestCount < baselineTestCount) {
        errorOutput = `The run is green but you DELETED ${baselineTestCount - fixedTestCount} test case(s) (the spec had ${baselineTestCount}, this version has ${fixedTestCount}). Removing, skipping, or commenting out a failing test is NOT a fix. Restore ALL ${baselineTestCount} tests and make the failing one(s) genuinely pass.`
        if (!onStatus) log(chalk.yellow(`  Green but dropped ${baselineTestCount - fixedTestCount} test(s) — requiring restore (attempt ${attempt}/${config.maxIterations}).`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
        continue
      }
      if (options.e2e) {
        // E2E success is a green, complete Playwright run — there is no type-gate to apply.
        if (!onStatus) log(chalk.green('  Fixed.'))
        onStatus?.({ phase: 'passed', file: shortPath })
        return { success: true }
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
      if (typeErrors && typeErrorsAtStart !== null) {
        // Type-cleanup mode: the file's tests already passed at start (generate→fix handoff or
        // --types), so type errors ARE the goal — keep retrying to clear them.
        errorOutput = `Tests passed but TypeScript type errors were found:\n${typeErrors}\n\nFix ALL type errors. Do not use 'as any' or '@ts-ignore'.`
        if (!onStatus) log(chalk.yellow('  Tests pass but type errors found — retrying...'))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
        continue
      }
      if (typeErrors) {
        // Test-repair mode: the failing test(s) now PASS — that IS the fix. Residual type
        // errors (often just implicit-any in mocks) must not make us burn retries or revert to
        // the broken original. Keep the passing fix; surface the types as a follow-up.
        if (!onStatus) log(chalk.yellow(`  ⚠ Tests now pass — keeping the fix. Type errors remain; run \`lacuna fix --file ${shortPath}\` to clean them up.`))
        onStatus?.({ phase: 'passed', file: shortPath })
        return { success: true }
      }
      if (!onStatus) log(chalk.green('  Fixed.'))
      onStatus?.({ phase: 'passed', file: shortPath })
      return { success: true }
    }

    const rawRunOutput = result.stdout + '\n' + result.stderr
    // E2E: the pass-count / zero-tests heuristics below key off unit-runner output ("Tests: N
    // passed"), which Playwright doesn't print, so just feed back the parsed Playwright failure
    // and skip the regression/structure-broken accounting (none of it is meaningful for specs).
    if (options.e2e) {
      errorOutput = extractE2EFailure(rawRunOutput, result.timedOut)
      if (!onStatus) log(chalk.red(`  Still failing (attempt ${attempt}/${config.maxIterations})`))
      if (!onStatus && verbose) log(chalk.dim(errorOutput.split('\n').slice(0, 20).join('\n')))
      continue
    }
    const rawExtracted = extractTestFailure(rawRunOutput)
    const structureBroken = isZeroTestsOutput(rawRunOutput)
    const currentPassCount = structureBroken ? 0 : parsePassCount(rawRunOutput)
    const currentFailCount = structureBroken ? 0 : parseFailCount(rawRunOutput)
    // enrichNoTestsError adds guidance for genuinely missing test functions;
    // in the structure-broken path the issue is always a broken import, so use
    // rawExtracted there so the actual module error isn't buried in boilerplate.
    const extracted = enrichNoTestsError(rawExtracted, rawRunOutput)

    // Track the high-water mark — the attempt with the most passing tests so far.
    // Only collecting runs qualify (structureBroken === 0 tests is never "best").
    if (!structureBroken && currentPassCount > bestPassCount) {
      bestCode = testFileContent
      bestPassCount = currentPassCount
    }

    if (structureBroken) {
      errorOutput = buildStructureBrokenMessage(initialErrorOutput, rawExtracted)
      if (!onStatus) log(chalk.red(`  Fix broke file structure — 0 tests collected (attempt ${attempt}/${config.maxIterations})`))
    } else if (currentPassCount < baselinePassCount) {
      errorOutput = buildRegressionMessage(initialErrorOutput, extracted, baselinePassCount, currentPassCount)
      if (!onStatus) log(chalk.red(`  Fix caused regression: ${baselinePassCount} → ${currentPassCount} passing (attempt ${attempt}/${config.maxIterations})`))
    } else if (currentFailCount === 0 && currentPassCount > 0) {
      // Every collected test PASSES, yet the run failed — vitest flagged an unhandled error
      // (an unhandled promise rejection or a suite-level error outside any test). Without this
      // branch the model just sees "still failing" with no failing assertion and flails. Name it.
      errorOutput = buildUnhandledErrorMessage(extracted, currentPassCount)
      if (!onStatus) log(chalk.red(`  All ${currentPassCount} tests pass but the run failed on unhandled errors (attempt ${attempt}/${config.maxIterations})`))
    } else {
      errorOutput = extracted
      if (!onStatus) log(chalk.red(`  Still failing (attempt ${attempt}/${config.maxIterations})`))
    }
    if (!onStatus && verbose) log(chalk.dim(errorOutput.split('\n').slice(0, 20).join('\n')))
  }

  // Leave the BEST attempt on disk — not the last one. bestCode is the original
  // unless some attempt collected strictly more passing tests, so a pure failure still
  // restores the original (don't leave broken AI code on disk), while a partial win
  // (e.g. attempt 1 fixed 2 of 3 tests but later retries regressed) is preserved.
  // For a type-only repair this is the original passing (but type-erroring) file,
  // which is strictly better than a regenerated guess — the caller must NOT regenerate it.
  await writeFile(absTestPath, bestCode, 'utf-8').catch(() => {})
  // Also restore any helper/config files the E2E multi-file fix overwrote — never leave a
  // half-applied selector change behind when the repair ultimately failed.
  for (const [abs, orig] of helperBackups) await writeFile(abs, orig, 'utf-8').catch(() => {})
  if (!onStatus && bestPassCount > baselinePassCount) {
    log(chalk.yellow(`  Kept best attempt: ${baselinePassCount} → ${bestPassCount} passing (couldn't reach all-green).`))
  }
  onStatus?.({ phase: 'failed', file: shortPath })
  const typeOnly = firstRun.success
  return {
    // Report what's actually on disk now, so the regen fallback compares against the
    // kept improvement and never replaces it with a worse from-scratch rewrite.
    baselinePassCount: bestPassCount,
    success: false,
    typeOnly,
    error: `${typeOnly ? 'Type errors remain' : 'Still failing'} after ${config.maxIterations} attempts. Last error:\n${errorOutput.slice(0, 1500)}`,
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
  const result = await runCommand(multiFileTestCommand(env, [...subset, victim]), cwd, 120_000)
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

  const generator = new TestGenerator({ config, env })
  let pollutersFixed = 0
  let victimsRegenerated = 0
  const seenPolluters = new Set<string>()
  const unresolvedVictims: string[] = []

  for (const victim of victimFiles) {
    const shortVictim = victim.replace(cwd + '/', '')
    log(chalk.dim(`\n  Bisecting for: ${chalk.cyan(shortVictim)}`))

    const candidates = allTestFiles.filter(f => f !== victim)

    // Probe: verify the pollution reproduces before spending O(log N) bisect runs.
    // If it doesn't reproduce here, the pollution requires vitest's default multi-worker
    // config to manifest and can't be found by this approach.
    log(chalk.dim(`  Probing (${candidates.length} files + victim)...`))
    const reproduced = await victimFailsWithSubset(victim, candidates, env, cwd)
    if (!reproduced) {
      log(chalk.yellow(`  Pollution did not reproduce in sequential mode — this is concurrency-based globalThis contamination.`))
      log(chalk.dim(`  A vi.spyOn(global, ...) spy from another file is persisting in the shared worker thread.`))
      log(chalk.dim(`  Fix: add restoreMocks: true and clearMocks: true to the test: {} block in vitest.config.ts`))
      log(chalk.dim(`  Also add beforeEach(() => vi.restoreAllMocks()) to your test setup file.`))
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
    const errorRun = await runCommand(multiFileTestCommand(env, [polluter, victim]), cwd, 60_000)
    const victimError = extractTestFailure(errorRun.stdout + '\n' + errorRun.stderr)

    const pollutorCode = await readFile(polluter, 'utf-8').catch(() => null)
    const victimCode = await readFile(victim, 'utf-8').catch(() => null)
    if (!pollutorCode || !victimCode) {
      log(chalk.red(`  Could not read files — skipping ${shortPolluter}`))
      unresolvedVictims.push(victim)
      continue
    }

    log(chalk.dim(`  Sending to ${config.model} for cleanup...`))
    let fixed: string
    try {
      fixed = await generator.fixPollution({
        pollutorFile: shortPolluter,
        pollutorCode,
        victimFile: shortVictim,
        victimCode,
        victimError,
        env,
      })
    } catch (err) {
      log(chalk.red(`  AI error: ${err instanceof Error ? err.message : String(err)}`))
      unresolvedVictims.push(victim)
      continue
    }

    await writeFile(polluter, fixed, 'utf-8')
    const verifyRun = await runCommand(multiFileTestCommand(env, [polluter, victim]), cwd, 60_000)
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

  // Find the source file so processGap gets the right starting point.
  // processGap expects gap.filePath to be the SOURCE file, not the test file.
  const sourceFile = await findSourceFile(absTestFile, options.cwd, options.config.sourceDir)
  if (!sourceFile) {
    return { success: false, error: `Could not find source file for ${absTestFile}` }
  }

  // Back up the current content so a failed regeneration never leaves the file deleted or
  // filled with a broken last attempt — on failure we restore exactly what was here.
  let originalContent: string | null = null
  try { originalContent = await readFile(absTestFile, 'utf-8') } catch { /* already gone */ }

  // Delete the broken test file before regenerating. If it stays on disk,
  // buildFileContext reads it as existingTestCode and the generate prompt says
  // "preserve all existing tests" — locking the AI into the same broken structure.
  await unlink(absTestFile).catch(() => {})

  const gap: CoverageGap = { filePath: sourceFile, uncoveredLines: [], uncoveredFunctions: [] }
  const generator = new TestGenerator({ config: options.config, env: options.env })

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

  const result = await processGap(gap, options, generator, true, regenOnStatus, projectMemory, absTestFile)

  if (result.success) {
    // Never-regress: a "green" regen with fewer tests than the original is still a net loss
    // (e.g. 50 passing replacing 477). Re-run the regenerated file and keep it only if it has
    // at least as many passing tests as the original — otherwise restore the original.
    const regenRun = await runCommand(fileTestCommand(options.env, absTestFile), options.cwd, 60_000)
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
      const generator = new TestGenerator({ config: options.config, env: options.env })
      while (true) {
        const file = queue.shift()
        if (!file) break
        const onStatus = (state: WorkerState) => display.update(wi, state)
        const absFile = file.startsWith('/') ? file : join(options.cwd, file)
        const workerOptions = { ...options, log: () => {}, verbose: false }
        const result = await fixFile(absFile, workerOptions, generator, onStatus, projectMemory)
        filesProcessed++
        if (result.success) {
          if (result.skipped) { filesAlreadyPassing++; victimFiles.push(absFile) }
          else filesFixed++
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
            if (!options.dryRun) await formatFile(absFile, options.cwd, { enabled: options.config.format, env: options.env })
          } else {
            stillFailingFiles.push(file)
            if (regenResult.error) errors.push(regenResult.error)
          }
        } else {
          stillFailingFiles.push(file)
          if (result.error) errors.push(result.error)
        }
      }
    }),
  )

  display.finish()
  return { filesProcessed, filesFixed, filesAlreadyPassing, errors, stillFailingFiles, victimFiles }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runFixLoop(options: FixOptions): Promise<FixResult> {
  // E2E mode swaps in the Playwright environment for the whole run (selection, per-file runs,
  // and the commands fixFile issues) by normalising options up front, so everything downstream
  // — including fixFile, which reads options.env — sees the Playwright runner.
  if (options.e2e) {
    if (!(await ensurePlaywrightForRun(options.cwd, { log: options.log, offerInstall: !options.dryRun }))) {
      return { filesProcessed: 0, filesFixed: 0, filesAlreadyPassing: 0, pollutersFixed: 0, victimsRegenerated: 0, errors: [] }
    }
    options = { ...options, env: envForRunner('playwright') }
  }

  const { config, env, cwd, log } = options
  const workerCount = Math.max(1, Math.min(options.workers ?? 1, 10))
  const parallel = workerCount > 1

  // Scope (`lacuna fix <dir>`): restrict selection + the discovery run to a subtree.
  const scopeDir = options.scopeDir
  const scopeRel = scopeDir ? scopeDir.replace(cwd + '/', '').replace(/\/+$/, '') : undefined
  const inScope = (f: string) => !scopeDir || isWithinDir(f.startsWith('/') ? f : join(cwd, f), scopeDir)

  let failingFiles: string[]

  if (options.e2e && !options.targetFile) {
    // E2E selection: run the whole Playwright suite once and take the spec files that failed,
    // parsed from the JSON reporter. We delegate app start/stop to Playwright's own webServer
    // config rather than orchestrating it here.
    const spinner = startCoverageSpinner(chalk.dim('  Running Playwright suite to find failing specs...'), env.testRunner)
    // JSON to a file (runPlaywrightJson) so dev-server logs can't corrupt it.
    const { run: suiteResult, parsed } = await runPlaywrightJson(playwrightTestCommand(), cwd, config.coverageTimeout * 1000, spinner.onLine)
    spinner.stop()

    if (suiteResult.timedOut) {
      throw new Error(
        `Playwright suite timed out after ${config.coverageTimeout}s.\n` +
        `Increase it in .lacuna.json: { "coverageTimeout": ${config.coverageTimeout * 2} }`,
      )
    }

    if (suiteResult.success) {
      log(chalk.green('\n  All Playwright specs are passing — nothing to fix.'))
      return { filesProcessed: 0, filesFixed: 0, filesAlreadyPassing: 0, pollutersFixed: 0, victimsRegenerated: 0, errors: [] }
    }

    const failed = parsed ? [...new Set(parsed.failures.map((f) => f.file))] : []
    failingFiles = failed.filter((f) => {
      const abs = f.startsWith('/') ? f : join(cwd, f)
      return abs.startsWith(cwd) && !abs.includes('node_modules')
    })

    if (failingFiles.length === 0) {
      log(chalk.yellow('\n  Could not identify any failing spec files from the Playwright output.'))
      log(chalk.dim(`  Try running ${playwrightTestCommand()} directly to inspect the output.`))
      return { filesProcessed: 0, filesFixed: 0, filesAlreadyPassing: 0, pollutersFixed: 0, victimsRegenerated: 0, errors: [] }
    }
  } else if (options.types && !options.targetFile) {
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
    const fileResult = await runCommand(fileTestCommand(env, absTarget), cwd, 60_000, spinner.onLine)
    spinner.stop()

    if (fileResult.success && options.e2e) {
      // E2E: a green Playwright run is the whole pass — no type-gate.
      log(chalk.green('\n  Spec is passing — nothing to fix.'))
      return { filesProcessed: 0, filesFixed: 0, filesAlreadyPassing: 0, pollutersFixed: 0, victimsRegenerated: 0, errors: [] }
    }

    if (fileResult.success) {
      // Tests pass — but the runner only transpiles, it doesn't type-check. A green file
      // can still have TypeScript errors (the exact case `generate` hands off here). Only
      // declare victory if the file is also type-clean; otherwise fall through and repair.
      const typeErrors = await typeCheckFile(absTarget, cwd, env)
      if (!typeErrors) {
        log(chalk.green('\n  All tests are passing — nothing to fix.'))
        return { filesProcessed: 0, filesFixed: 0, filesAlreadyPassing: 0, pollutersFixed: 0, victimsRegenerated: 0, errors: [] }
      }
      log(chalk.yellow('\n  Tests pass but TypeScript type errors remain — repairing types.'))
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
      const runCmd = (scopeRel && scopedTestCommand(env, scopeRel)) || env.testCommand
      const label = scopeRel ? `  Running tests under ${scopeRel} to find failures...` : '  Running test suite to find failures...'
      const spinner = startCoverageSpinner(chalk.dim(label), env.testRunner)
      const suiteResult = await runCommand(runCmd, cwd, config.coverageTimeout * 1000, spinner.onLine)
      spinner.stop()

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

      failingFiles = parseFailingTestFiles(suiteResult.stdout + suiteResult.stderr, env.testRunner)
      failingFiles = failingFiles.filter((f) => {
        const abs = f.startsWith('/') ? f : join(cwd, f)
        return abs.startsWith(cwd) && !abs.includes('node_modules') && inScope(f)
      })

      if (failingFiles.length === 0) {
        const where = scopeRel ? ` under ${scopeRel}` : ''
        log(chalk.yellow(`\n  Could not identify any failing test files${where} from the output.`))
        log(chalk.dim(`  Try running ${runCmd} directly to inspect the output.`))
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
    const generator = new TestGenerator({ config, env })
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
      const tip = nextTip()
      if (tip) log(formatTip(tip))
      const absFile = file.startsWith('/') ? file : join(cwd, file)
      const result = await fixFile(absFile, options, generator, undefined, memory.toPromptSection())
      filesProcessed++
      if (result.success) {
        if (result.skipped) { filesAlreadyPassing++; victimFiles.push(absFile) }
        else filesFixed++
      } else if (options.regenerateOnFailure && !options.types && !result.typeOnly && (result.baselinePassCount ?? Infinity) < REGEN_MAX_BASELINE_PASS) {
        // Regenerate only for mostly-broken files (few passing tests) — see runFixWorkers.
        // A substantial passing suite is left restored by fixFile, never nuked + rebuilt.
        log(chalk.yellow(`  Fix exhausted — falling back to full regeneration...`))
        const regenResult = await regenerateFile(absFile, options, undefined, memory.toPromptSection(), result.baselinePassCount ?? 0)
        if (regenResult.success) {
          filesFixed++
          if (!options.dryRun) await formatFile(absFile, cwd, { enabled: config.format, env })
        } else {
          stillFailingFiles.push(file)
          if (regenResult.error) errors.push(regenResult.error)
        }
      } else {
        stillFailingFiles.push(file)
        if (result.error) errors.push(result.error)
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
  if (options.fixPolluters && !options.e2e && victimFiles.length > 0) {
    log(chalk.bold(`\n  Scanning for test polluters (${victimFiles.length} victim file(s) pass alone but fail in suite)...`))
    const polluterResult = await findAndFixPolluters(victimFiles, options, memorySnapshot)
    pollutersFixed = polluterResult.pollutersFixed
    victimsRegenerated = polluterResult.victimsRegenerated
  }

  return { filesProcessed, filesFixed, filesAlreadyPassing, pollutersFixed, victimsRegenerated, errors }
}
