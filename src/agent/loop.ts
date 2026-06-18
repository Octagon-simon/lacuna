import { writeFile, mkdir, readFile, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import chalk from 'chalk'
import type { LacunaConfig } from '../lib/config.js'
import type { DetectedEnvironment } from '../lib/detector.js'
import { fileTestCommand } from '../lib/detector.js'
import { runCommand } from '../lib/runner.js'
import { loadCoverage, coverageAgeSeconds, extractGaps, filterTestableGaps, findUncoveredFiles, findTestFiles } from '../lib/coverage/index.js'
import type { CoverageGap, CoverageReport } from '../lib/coverage/types.js'
import { WorkerDisplay } from '../lib/worker-display.js'
import type { WorkerState } from '../lib/worker-display.js'
import { startCoverageSpinner } from '../lib/coverage-spinner.js'
import { buildFileContext } from './context.js'
import { TestGenerator, TruncatedOutputError, OscillationError, ModelStallError, TRUNCATION_RETRY_MESSAGE, OSCILLATION_ESCAPE_MESSAGE } from './generator.js'
import { ProjectMemory } from './project-memory.js'
import { getActiveTips, createTipRotator, formatTip } from '../lib/tips.js'
import { typeCheckFile } from '../lib/typecheck.js'
import { hasTestFunctions, hasPlaceholderBodies, enrichNoTestsError, isZeroTestsOutput, parsePassCount, buildStructureBrokenMessage, buildRegressionMessage, sanitizeMocksContent, stripLeadingProse, mergeMocksContent, deduplicateViMocks, tryApplyPatchWithDiag, tryApplyMocksPatch } from '../lib/validate.js'
import { extractTestFailure } from '../lib/extract-error.js'
import { StreamingFileViewer } from '../lib/streaming-viewer.js'

export interface LoopOptions {
  config: LacunaConfig
  env: DetectedEnvironment
  cwd: string
  dryRun: boolean
  verbose: boolean
  targetFile?: string
  workers?: number
  fresh?: boolean
  log: (msg: string) => void
}

export interface LoopResult {
  filesProcessed: number
  testsWritten: number
  coverageBefore: number
  coverageAfter: number
  hasCoverage: boolean   // false in single-file mode (no suite run, no coverage data)
  errors: string[]
}

async function getCoverageRate(config: LacunaConfig, cwd: string): Promise<number> {
  try {
    const report: CoverageReport = await loadCoverage(config, cwd)
    return report.totalLineRate * 100
  } catch {
    return 0
  }
}

export async function processGap(
  gap: CoverageGap,
  options: LoopOptions,
  generator: TestGenerator,
  parallel: boolean,
  onStatus?: (state: WorkerState) => void,
  projectMemory?: string | null,
  overrideTestFile?: string,
): Promise<{ success: boolean; error?: string; testCode?: string }> {
  const { config, env, cwd, dryRun, verbose, log } = options

  const shortPath = gap.filePath.replace(cwd + '/', '')

  if (!onStatus) {
    log(chalk.bold(`\n  Processing: ${chalk.cyan(shortPath)}`))
    if (gap.uncoveredFunctions.length > 0) {
      log(chalk.dim(`  Uncovered functions: ${gap.uncoveredFunctions.join(', ')}`))
    }
  }

  let context
  try {
    context = await buildFileContext(gap.filePath.replace(cwd + '/', ''), cwd, env, config)
  } catch {
    const msg = `Could not read source file: ${gap.filePath}`
    if (!onStatus) log(chalk.red(`  ${msg}`))
    onStatus?.({ phase: 'failed', file: shortPath })
    return { success: false, error: msg }
  }

  // When called from regenerateFile the original test was deleted so inferTestFilePath
  // mirrors the source path (including any extra segments like lib/) instead of using
  // the real test location. The caller passes the original path to pin the write target.
  if (overrideTestFile) {
    context.suggestedTestFile = overrideTestFile
    context.existingTestCode = null
    context.existingTestFile = null
  }

  if (!onStatus) {
    log(chalk.dim(`  ${context.existingTestFile ? 'Updating' : 'Creating'}: ${context.suggestedTestFile.replace(cwd + '/', '')}`))
  }

  // parallel: run only this test file so workers don't race on the full suite
  const testCmd = parallel
    ? fileTestCommand(env, context.suggestedTestFile)
    : env.testCommand

  // Capture pre-existing test file so we can restore on failure
  let originalTestContent: string | null = null
  if (!dryRun) {
    try { originalTestContent = await readFile(context.suggestedTestFile, 'utf-8') } catch { /* new file */ }
  }

  let generatedCode: string | null = null
  let lastError: string | null = null
  let firstError: string | null = null      // error from attempt 1, kept as anchor for regressions
  let firstPassCount = 0                    // passing tests on attempt 1
  let stallRetries = 0
  const MAX_STALL_RETRIES = 2
  let consecutivePatchFailures = 0

  // Best collecting attempt seen so far — used on failure to keep a net-improving partial
  // result (which `lacuna fix` can finish) instead of discarding work. Only attempts that
  // actually collected tests qualify, so a fence-broken / 0-test file is never kept.
  let bestCode: string | null = null
  let bestPassCount = -1

  // Running base for patch-mode application. Starts as the original test file and is updated
  // to the written content after each attempt, so a retry that patches a test ADDED by an
  // earlier attempt anchors against the current file — not the frozen original (which would
  // fail with "anchor not found").
  let patchBase = context.existingTestCode

  for (let attempt = 1; attempt <= config.maxIterations; attempt++) {
    if (!onStatus) {
      if (attempt > 1) {
        log(chalk.yellow(`\n  Retry ${attempt}/${config.maxIterations} — fixing failures...`))
      }
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
    if (!onStatus) log(chalk.dim(`\n  ⌛ Waiting for model response...`))

    let viewer: StreamingFileViewer | undefined
    if (verbose && !onStatus) {
      viewer = new StreamingFileViewer(shortPath)
      generator.setTokenCallback(t => viewer!.append(t))
      viewer.start()
    }

    try {
      generatedCode = attempt === 1
        ? await generator.generate(context, gap, projectMemory)
        : await generator.retry(lastError ?? '')
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
        lastError = TRUNCATION_RETRY_MESSAGE
        if (!onStatus) log(chalk.yellow(`\n  Output truncated — retrying with shorter output request...`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
        continue
      }
      if (err instanceof OscillationError) {
        if (attempt < config.maxIterations) {
          if (!onStatus) log(chalk.yellow(`\n  ⚠ Agent loop detected — retrying with different strategy...`))
          onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
          generator.resetOscillationState()
          lastError = OSCILLATION_ESCAPE_MESSAGE
          continue
        }
        if (!onStatus) log(chalk.red(`\n  ⚠ Agent loop detected — output identical to a previous attempt. Stopping early.`))
        onStatus?.({ phase: 'failed', file: shortPath })
        await restoreTestFile(context.suggestedTestFile, originalTestContent)
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
        log(chalk.dim(generatedCode.split('\n').slice(0, 10).map((l) => `    ${l}`).join('\n')))
        if (generatedCode.split('\n').length > 10) log(chalk.dim('    …'))
      }
      onStatus?.({ phase: 'passed', file: shortPath })
      return { success: true, testCode: generatedCode }
    }

    // Patch mode: model returned surgical edits — apply them to get the complete file
    if (generator.isPatch && patchBase) {
      const patchResult = tryApplyPatchWithDiag(patchBase, generatedCode)
      if (patchResult.ok) {
        generatedCode = patchResult.result
        consecutivePatchFailures = 0
      } else {
        consecutivePatchFailures++

        if (consecutivePatchFailures >= 2) {
          // Escape hatch: after 2 failed patches the model can't anchor correctly.
          // Force a full-file rewrite on the next attempt so it bypasses patch matching entirely.
          lastError =
            `PATCH ANCHORS FAILED ${consecutivePatchFailures} TIMES — SWITCH TO FULL REWRITE MODE.\n` +
            `Your patch is not matching the file. On this attempt you MUST use <code_output> (NOT <code_patch>) and output the COMPLETE test file.\n` +
            `Include every existing test verbatim and add the new ones you need.\n` +
            `Do NOT use <code_patch> this time.`
        } else {
          // Give the model the exact anchor text that failed so it can correct it
          const failedOp = patchResult.failedOp
          const anchorBlock = failedOp
            ? `\nFailed operation: ${failedOp.type}\nAnchor that was NOT found in the file:\n"""\n${failedOp.anchor.slice(0, 600)}\n"""`
            : ''
          lastError =
            `PATCH APPLICATION FAILED: an anchor string in your patch was not found in the test file.${anchorBlock}\n\n` +
            `The anchor must be character-for-character identical to the text in the EXISTING TEST FILE shown in the original prompt.\n` +
            `Checklist:\n` +
            `  • REPLACE_TEST / DELETE_TEST anchor = exact it/test name string (without quotes)\n` +
            `  • ADD_AFTER_DESCRIBE anchor = exact describe() name string\n` +
            `  • REPLACE anchor = entire text block copied verbatim from the test file\n` +
            `Re-read the test file in the original prompt, locate the exact text, and rewrite your patch.`
        }

        if (!onStatus) log(chalk.yellow(`  Patch anchors not found — retrying...`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations } as WorkerState)
        continue
      }
    } else if (!generator.isPatch) {
      // Model switched to (or stayed in) full-file mode — reset patch failure counter
      consecutivePatchFailures = 0
    }

    // Strip thinking/prose that leaked before the first real code line.
    // Happens under retry pressure when the model bleeds reasoning into <code_output>.
    const { code: cleanCode, stripped: bleedText } = stripLeadingProse(generatedCode)
    if (bleedText !== null) {
      if (!onStatus) log(chalk.yellow(`  ⚠ Thinking bleed detected — stripped: "${bleedText.slice(0, 80)}…"`))
      generatedCode = cleanCode
    }

    const MOCKS_SEPARATOR = '// ---MOCKS_FILE---'
    const MOCKS_PATCH_SEPARATOR = '// ---MOCKS_PATCH---'
    let testCode = generatedCode

    if (generatedCode.includes(MOCKS_PATCH_SEPARATOR) && config.mocksFile) {
      // Surgical patch mode: model only emits the changed sections
      const [newTestCode, patchContent] = generatedCode.split(MOCKS_PATCH_SEPARATOR)
      testCode = newTestCode.trim()
      if (patchContent?.trim()) {
        const absoluteMocksFile = join(cwd, config.mocksFile)
        let existing = ''
        try { existing = await readFile(absoluteMocksFile, 'utf-8') } catch { /* new file — patch can't apply */ }
        if (existing) {
          const applied = tryApplyMocksPatch(existing, patchContent.trim())
          if (applied) {
            if (applied.failedOps.length > 0) {
              const anchors = applied.failedOps.map(op => `"${op.oldText.slice(0, 60).replace(/\n/g, '↵')}"`).join(', ')
              lastError = `MOCKS PATCH FAILED: the following REPLACE anchor(s) were not found in the mock file:\n${anchors}\nAnchors must be copied character-for-character from the SHARED MOCK FILE shown above. Re-read it and rewrite your ---MOCKS_PATCH--- block.`
              if (!onStatus) log(chalk.yellow(`  ⚠ Mock patch anchors not found — retrying...`))
              onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations } as WorkerState)
              continue
            }
            await writeFile(absoluteMocksFile, applied.result, 'utf-8')
            if (!onStatus) log(chalk.dim(`  Patched mocks file: ${config.mocksFile}`))
          }
        }
      }
    } else if (generatedCode.includes(MOCKS_SEPARATOR) && config.mocksFile) {
      // Full-rewrite mode (new mock file or explicit full replacement)
      const [newTestCode, newMocksCode] = generatedCode.split(MOCKS_SEPARATOR)
      testCode = newTestCode.trim()
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

    testCode = deduplicateViMocks(testCode)

    // Catch empty test files before writing — no point running a file with no tests
    if (!hasTestFunctions(testCode)) {
      lastError =
        'ERROR: The code you wrote contains NO test functions (no it() or test() calls).\n' +
        'Do not write a file with only imports, types, describe() blocks, or helper functions.\n' +
        'Every test file must contain at least one: it(\'description\', () => { expect(...).toBe(...) })\n' +
        'Rewrite the file and include real test cases.'
      if (!onStatus) log(chalk.yellow(`  Generated file has no tests — retrying...`))
      onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations } as WorkerState)
      continue
    }

    onStatus?.({ phase: 'writing', file: shortPath })
    await mkdir(dirname(context.suggestedTestFile), { recursive: true })
    await writeFile(context.suggestedTestFile, testCode, 'utf-8')
    // Next patch-mode retry anchors against what's actually on disk now (including tests this
    // attempt added/changed), not the frozen original.
    patchBase = testCode

    if (!onStatus) log(chalk.dim(`  Written. Running tests...`))
    onStatus?.({ phase: 'running', file: shortPath })

    const runResult = await runCommand(testCmd, cwd)

    if (runResult.success) {
      // Reject placeholder test bodies — `{ // body }` passes vitest (no assertions)
      // but produces zero coverage value. Force a retry with an explicit error.
      if (hasPlaceholderBodies(testCode)) {
        lastError =
          'ERROR: One or more test bodies contain placeholder comments (e.g. `// body`, `// TODO`) with no real assertions.\n' +
          'Every test must have complete, working expectations:\n' +
          '  it(\'description\', async () => {\n' +
          '    const result = await subject.doThing(...);\n' +
          '    expect(result).toEqual(expectedValue);\n' +
          '  })\n' +
          'Replace every `// body` placeholder with real arrange-act-assert code.'
        if (!onStatus) log(chalk.yellow(`  Placeholder test bodies detected — retrying...`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations } as WorkerState)
        continue
      }
      const typeErrors = await typeCheckFile(context.suggestedTestFile, cwd, env)
      if (typeErrors) {
        if (attempt < config.maxIterations) {
          lastError = `Tests passed but TypeScript type errors were found in the generated file:\n${typeErrors}\n\nFix ALL type errors. Do not use 'as any' or '@ts-ignore'.`
          if (!onStatus) log(chalk.yellow(`  Type errors found — retrying...`))
          onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations } as WorkerState)
          continue
        }
        // Last attempt — tests pass even though type errors remain.
        // Report as passed rather than discarding a working test file.
        const relTest = context.suggestedTestFile.replace(cwd + '/', '')
        if (!onStatus) log(chalk.yellow(`  ⚠ Type errors remain — tests pass. Run \`lacuna fix --file ${relTest}\` to clean up types.`))
      } else {
        if (!onStatus) log(chalk.green(`  Tests passed.`))
      }
      onStatus?.({ phase: 'passed', file: shortPath })
      return { success: true, testCode }
    }

    const rawRunOutput = runResult.stdout + '\n' + runResult.stderr
    const rawExtracted = extractTestFailure(rawRunOutput)
    const extracted = enrichNoTestsError(rawExtracted, rawRunOutput)
    const passCount = parsePassCount(rawRunOutput)

    if (!isZeroTestsOutput(rawRunOutput) && passCount > bestPassCount) {
      bestPassCount = passCount
      bestCode = testCode
    }

    if (attempt === 1) {
      firstError = extracted
      firstPassCount = passCount
      lastError = extracted
      if (!onStatus) log(chalk.red(`  Tests failed (attempt ${attempt}/${config.maxIterations})`))
    } else if (isZeroTestsOutput(rawRunOutput)) {
      lastError = buildStructureBrokenMessage(firstError!, rawExtracted)
      if (!onStatus) log(chalk.red(`  Fix broke file structure — 0 tests collected (attempt ${attempt}/${config.maxIterations})`))
    } else if (passCount < firstPassCount) {
      lastError = buildRegressionMessage(firstError!, extracted, firstPassCount, passCount)
      if (!onStatus) log(chalk.red(`  Fix caused regression: ${firstPassCount} → ${passCount} passing (attempt ${attempt}/${config.maxIterations})`))
    } else {
      lastError = extracted
      if (!onStatus) log(chalk.red(`  Tests failed (attempt ${attempt}/${config.maxIterations})`))
    }
    if (!onStatus && verbose) log(chalk.dim(lastError.split('\n').slice(0, 20).join('\n')))
  }

  onStatus?.({ phase: 'failed', file: shortPath })
  const rel = context.suggestedTestFile.replace(cwd + '/', '')
  const keepHint = () => {
    if (!onStatus) log(chalk.yellow(`\n  Kept ${bestPassCount} passing test(s) at ${rel} — run ${chalk.cyan(`lacuna fix --file ${rel}`)} to repair the remaining failures`))
  }

  if (originalTestContent === null) {
    // New file — keep the best collecting attempt so `lacuna fix` can repair it.
    if (bestCode !== null) { await writeFile(context.suggestedTestFile, bestCode, 'utf-8'); keepHint() }
    else if (!onStatus) log(chalk.yellow(`\n  Last attempt kept at ${rel} — run ${chalk.cyan(`lacuna fix --file ${rel}`)} to repair it`))
  } else if (parallel && bestCode !== null) {
    // Existing file with a clean, collecting attempt. Keep it ONLY if it adds net-new passing
    // tests vs the original — otherwise the generated tests broke the suite or added no value,
    // so restore the original. parallel ⇒ testCmd is file-scoped, so parsePassCount reflects
    // this file and the comparison is sound. Measure the baseline lazily (only here on failure).
    await writeFile(context.suggestedTestFile, originalTestContent, 'utf-8')
    const baseRun = await runCommand(testCmd, cwd)
    const baselinePassCount = parsePassCount(baseRun.stdout + '\n' + baseRun.stderr)
    if (bestPassCount > baselinePassCount) {
      await writeFile(context.suggestedTestFile, bestCode, 'utf-8')
      keepHint()
    } else if (!onStatus) {
      log(chalk.dim(`\n  Generated tests didn't improve on the existing file (${baselinePassCount} passing) — restored the original.`))
    }
  } else {
    // Existing file under a full-suite run (per-file pass count not measurable) or no clean
    // attempt — restore the original so the workspace stays coherent.
    await restoreTestFile(context.suggestedTestFile, originalTestContent)
  }

  return {
    success: false,
    error: `Tests still failing after ${config.maxIterations} attempts. Last error:\n${lastError?.slice(0, 1500)}`,
  }
}

async function restoreTestFile(testPath: string, original: string | null): Promise<void> {
  try {
    if (original !== null) {
      await writeFile(testPath, original, 'utf-8')
    } else {
      await unlink(testPath)
    }
  } catch { /* best-effort */ }
}

async function runWorkerPool(
  gaps: CoverageGap[],
  options: LoopOptions,
  workerCount: number,
  projectMemory: string | null,
): Promise<{ filesProcessed: number; testsWritten: number; errors: string[] }> {
  const tips = getActiveTips({
    workers: workerCount,
    targetFile: options.targetFile,
    verbose: options.verbose,
    dryRun: options.dryRun,
    fresh: options.fresh,
    model: options.config.model,
    threshold: options.config.threshold,
    mocksFile: options.config.mocksFile,
    ignore: options.config.ignore,
    command: 'generate',
  })
  const display = new WorkerDisplay(workerCount, gaps.length, tips)
  const queue = [...gaps]
  let filesProcessed = 0
  let testsWritten = 0
  const errors: string[] = []

  display.start()

  const workers = Array.from({ length: workerCount }, async (_, wi) => {
    const generator = new TestGenerator({
      config: options.config,
      env: options.env,
      // suppress token streaming in parallel mode — display is the UI
    })

    while (true) {
      const gap = queue.shift()
      if (!gap) break

      const onStatus = (state: WorkerState) => display.update(wi, state)
      const result = await processGap(
        gap,
        { ...options, log: () => {}, verbose: false },
        generator,
        true,
        onStatus,
        projectMemory,
      )

      filesProcessed++
      if (result.success) testsWritten++
      else if (result.error) errors.push(result.error)
    }
  })

  await Promise.all(workers)
  display.finish()

  return { filesProcessed, testsWritten, errors }
}

// Coverage report is considered fresh for 10 minutes — lets `analyze` then `generate` share one run.
const COVERAGE_CACHE_TTL_S = 600

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const { config, env, cwd, log } = options
  const workerCount = Math.max(1, Math.min(options.workers ?? 1, 10))
  const parallel = workerCount > 1

  // ─── Single-file fast path ────────────────────────────────────────────────────
  // Skip the coverage suite entirely. Build a synthetic gap that treats the whole
  // file as uncovered — the AI reads the source and writes comprehensive tests.
  // Uses fileTestCommand (not the full suite) to verify the generated tests pass.
  if (options.targetFile) {
    const abs = options.targetFile.startsWith('/')
      ? options.targetFile
      : join(cwd, options.targetFile)

    // Fail fast if the user passed a test file instead of a source file.
    const isTestPath = /\.(test|spec)\.[jt]sx?$/.test(abs)
      || abs.includes('__tests__/')
      || /\/test_[^/]+\.[jt]sx?$/.test(abs)
      || abs.endsWith('_test.go')
    if (isTestPath) {
      throw new Error(
        `"${options.targetFile}" looks like a test file, not a source file.\n` +
        `Pass the source file you want tests generated for.\n` +
        `Example: lacuna generate --file ${options.targetFile.replace(/__tests__\//, '').replace(/\.(test|spec)(\.[jt]sx?)$/, '$2')}`,
      )
    }

    const gap: CoverageGap = {
      filePath: abs,
      uncoveredLines: [],
      uncoveredFunctions: [],
    }

    const memory = new ProjectMemory()
    await memory.initialize(cwd, env, config)

    const generator = new TestGenerator({ config, env })
    const result = await processGap(gap, options, generator, true, undefined, memory.toPromptSection())

    return {
      filesProcessed: 1,
      testsWritten: result.success ? 1 : 0,
      coverageBefore: 0,
      coverageAfter: 0,
      hasCoverage: false,
      errors: result.error ? [result.error] : [],
    }
  }

  // ─── Full suite path ──────────────────────────────────────────────────────────

  const existingTests = await findTestFiles(cwd, {}, config)
  let hasTests = existingTests.length > 0

  let report: CoverageReport = { files: [], totalLineRate: 0, totalFunctionRate: 0 }
  if (!hasTests) {
    log(chalk.dim('  No test files yet — scanning source files for coverage gaps.'))
  } else {
    const ageSeconds = await coverageAgeSeconds(config, cwd)
    const useCached = !options.fresh && ageSeconds !== null && ageSeconds < COVERAGE_CACHE_TTL_S

    if (useCached) {
      log(chalk.dim(`  Using cached coverage report (${Math.round(ageSeconds)}s old). Pass --fresh to re-run the suite.`))
    } else {
      const spinner = startCoverageSpinner(chalk.dim('  Running test suite to collect coverage...'), env.testRunner)
      const coverageResult = await runCommand(env.coverageCommand, cwd, config.coverageTimeout * 1000, spinner.onLine)
      spinner.stop()

      if (coverageResult.timedOut) {
        throw new Error(
          `Test suite timed out after ${config.coverageTimeout}s.\n\n` +
          `This usually means a test has an open handle (unclosed server, timer, or connection).\n` +
          `Try running: ${env.testCommand} --reporter=verbose\n` +
          `Or increase the timeout in .lacuna.json: { "coverageTimeout": ${config.coverageTimeout * 2} }`,
        )
      }

      const coverageOutput = coverageResult.stdout + coverageResult.stderr

      if (/Tests:\s+0 total/i.test(coverageOutput)) {
        throw new Error(
          `Your test suites are failing before any tests run.\n\n` +
          `This usually means a missing environment variable, broken import, or setup file error.\n` +
          `Run: ${env.testCommand} 2>&1 | head -80\nto see the actual error.`,
        )
      }

      // When ALL tests are failing (0 passed), the lcov data is unreliable —
      // failing tests still execute source lines, inflating coverage to 50–100%.
      // Fall back to source-file scanning so gaps are found correctly.
      // The user should run `lacuna fix` to repair failing tests afterward.
      if (parsePassCount(coverageOutput) === 0) {
        hasTests = false
      }
    }

    if (hasTests) {
      try {
        report = await loadCoverage(config, cwd)
      } catch {
        throw new Error(`Could not read coverage report from ./${config.coverageDir}/`)
      }
    }
  }

  const coverageBefore = report.totalLineRate * 100

  const gaps = await filterTestableGaps(extractGaps(report, config.threshold), config.ignore)
  const untouchedFiles = await findUncoveredFiles(report, config.sourceDir, cwd, config.ignore)
  const existingPaths = new Set(gaps.map((g) => g.filePath))
  for (const g of untouchedFiles) {
    if (!existingPaths.has(g.filePath)) gaps.push(g)
  }

  if (gaps.length === 0) {
    if (coverageBefore < config.threshold) {
      log(chalk.yellow(`\n⚠ Coverage is ${coverageBefore.toFixed(1)}% — below the ${config.threshold}% threshold.`))
      log(chalk.dim('  Every source file already has a test file, so there is nothing new to generate.'))
      log(chalk.dim('  Run `lacuna fix` to repair the failing tests and raise coverage.'))
    } else {
      log(chalk.green(`\nAll files already meet the ${config.threshold}% threshold.`))
    }
    return { filesProcessed: 0, testsWritten: 0, coverageBefore, coverageAfter: coverageBefore, hasCoverage: true, errors: [] }
  }

  log(chalk.bold(`\nFound ${gaps.length} file(s) below ${config.threshold}% threshold.`))
  log(chalk.dim(`Coverage before: ${coverageBefore.toFixed(1)}%`))
  if (parallel) {
    if (options.verbose) log(chalk.dim(`  (--verbose is not shown in parallel mode — use --workers 1 to see the live code panel)`))
    log(chalk.dim(`\nWorkers: ${workerCount}\n`))
  }

  // Build project memory once — shared snapshot for all files in this run
  const memory = new ProjectMemory()
  await memory.initialize(cwd, env, config)
  const memorySnapshot = memory.toPromptSection()

  let filesProcessed: number
  let testsWritten: number
  let errors: string[]

  if (parallel) {
    ;({ filesProcessed, testsWritten, errors } = await runWorkerPool(gaps, options, workerCount, memorySnapshot))

    if (!options.dryRun && testsWritten > 0) {
      const finalSpinner = startCoverageSpinner(chalk.dim('\n  Running full suite for final coverage measurement...'), env.testRunner)
      await runCommand(env.coverageCommand, cwd, config.coverageTimeout * 1000, finalSpinner.onLine)
      finalSpinner.stop()
    }
  } else {
    filesProcessed = 0
    testsWritten = 0
    errors = []

    const generator = new TestGenerator({ config, env })

    const tips = getActiveTips({
      workers: 1,
      targetFile: options.targetFile,
      verbose: options.verbose,
      dryRun: options.dryRun,
      fresh: options.fresh,
      model: config.model,
      threshold: config.threshold,
      mocksFile: config.mocksFile,
      ignore: config.ignore,
      command: 'generate',
    })
    const nextTip = createTipRotator(tips)

    for (const gap of gaps) {
      const tip = nextTip()
      if (tip) log(formatTip(tip))
      const result = await processGap(gap, options, generator, false, undefined, memory.toPromptSection())
      filesProcessed++
      if (result.success) {
        testsWritten++
        // Update memory so subsequent files learn from patterns in this one
        if (result.testCode) {
          memory.recordSuccess(gap.filePath.replace(cwd + '/', ''), result.testCode)
        }
      } else if (result.error) errors.push(result.error)
    }
  }

  // Only measure coverage after if at least one test was written — otherwise the failing
  // generated files execute source code and report misleading 100% coverage.
  const coverageAfter = (options.dryRun || testsWritten === 0) ? coverageBefore : await getCoverageRate(config, cwd)

  return { filesProcessed, testsWritten, coverageBefore, coverageAfter, hasCoverage: true, errors }
}
