import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { join, dirname, basename, extname } from 'path'
import { access, stat } from 'fs/promises'
import chalk from 'chalk'
import type { LacunaConfig } from '../lib/config.js'
import type { DetectedEnvironment } from '../lib/detector.js'
import { fileTestCommand } from '../lib/detector.js'
import { runCommand } from '../lib/runner.js'
import { startCoverageSpinner } from '../lib/coverage-spinner.js'
import { WorkerDisplay } from '../lib/worker-display.js'
import type { WorkerState } from '../lib/worker-display.js'
import { buildFixFileContext, computeRelativeImport, collectTypeDefinitions, collectLocalImportPaths, detectReactMajorVersion } from './context.js'
import { TestGenerator, TruncatedOutputError, OscillationError, TRUNCATION_RETRY_MESSAGE } from './generator.js'
import { ProjectMemory } from './project-memory.js'
import { getActiveTips, createTipRotator, formatTip } from '../lib/tips.js'
import { typeCheckFile } from '../lib/typecheck.js'
import { hasTestFunctions, enrichNoTestsError, isZeroTestsOutput, parsePassCount, buildStructureBrokenMessage, buildRegressionMessage } from '../lib/validate.js'
import { extractTestFailure } from '../lib/extract-error.js'
import { StreamingFileViewer } from '../lib/streaming-viewer.js'

export interface FixOptions {
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

// ─── Failing-files cache ──────────────────────────────────────────────────────

const FIX_CACHE_TTL_S = 1800 // 30 minutes

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
  errors: string[]
}

// ─── Parse failing test files from runner output ──────────────────────────────

const TEST_FILE_RE = /[\w./\\@-]+\.(?:test|spec)\.(?:tsx|mts|ts|jsx|js)/

function parseFailingTestFiles(output: string, runner: string): string[] {
  const files = new Set<string>()
  const lines = output.split('\n')

  for (const line of lines) {
    const clean = line.replace(/\x1B\[[0-9;]*m/g, '').trim()

    // Vitest: cross character followed by file path (covers multiple cross symbols across versions)
    if (runner === 'vitest' || runner === 'unknown') {
      const m = clean.match(new RegExp(`^[×✗✕✖✘❌]\\s+(${TEST_FILE_RE.source})`))
      if (m) { files.add(m[1]); continue }
    }

    // "FAIL <path>" — used by Jest and some Vitest reporters/configurations
    if (runner === 'jest' || runner === 'vitest' || runner === 'unknown') {
      const m = clean.match(new RegExp(`^FAIL\\s+(${TEST_FILE_RE.source})`))
      if (m) { files.add(m[1]); continue }
    }
  }

  // Fallback: if no files matched via primary patterns, extract test file paths from
  // stack traces. A path in a stack trace always belongs to a file that ran and failed.
  // Over-inclusive is fine — fixFile re-runs each file first and skips it if already passing.
  if (files.size === 0) {
    for (const line of lines) {
      const clean = line.replace(/\x1B\[[0-9;]*m/g, '').trim()
      // stack trace: at ... (src/foo.test.tsx:42:5) or at src/foo.test.tsx:42
      const m = clean.match(new RegExp(`\\(?(${TEST_FILE_RE.source}):\\d+`))
      if (m) files.add(m[1])
    }
  }

  return [...files]
}

// ─── Find the source file that a test file is testing ────────────────────────

async function findSourceFile(testFilePath: string, cwd: string): Promise<string | null> {
  const ext = extname(testFilePath)
  const base = basename(testFilePath, ext)
  const dir = dirname(testFilePath)

  // strip test suffix: Button.test → Button, Button.spec → Button
  const sourceBase = base.replace(/\.(test|spec)$/, '').replace(/^test_/, '').replace(/_test$/, '')
  // if inside __tests__ dir, source is in parent
  const sourceDir = basename(dir) === '__tests__' ? dirname(dir) : dir

  const exts = [ext, '.ts', '.tsx', '.js', '.jsx']
  for (const e of exts) {
    const candidate = join(cwd, sourceDir, `${sourceBase}${e}`)
    try { await access(candidate); return candidate } catch { /* try next */ }
  }
  return null
}

// ─── Fix a single test file ───────────────────────────────────────────────────

async function fixFile(
  testFilePath: string,
  options: FixOptions,
  generator: TestGenerator,
  onStatus?: (state: WorkerState) => void,
  projectMemory?: string | null,
): Promise<{ success: boolean; error?: string }> {
  const { config, env, cwd, dryRun, verbose, log } = options
  const shortPath = testFilePath.replace(cwd + '/', '')
  const absTestPath = testFilePath.startsWith('/') ? testFilePath : join(cwd, testFilePath)

  if (!onStatus) log(chalk.bold(`\n  Fixing: ${chalk.cyan(shortPath)}`))
  onStatus?.({ phase: 'running', file: shortPath })

  // Run just this test file to get focused error output
  const firstRun = await runCommand(fileTestCommand(env, absTestPath), cwd, 60_000)
  if (firstRun.success) {
    if (!onStatus) log(chalk.green('  Already passing — skipping.'))
    onStatus?.({ phase: 'passed', file: shortPath })
    return { success: true }
  }

  let errorOutput = extractTestFailure(firstRun.stdout + '\n' + firstRun.stderr)
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

  // Find and read the source file being tested
  const sourceFilePath = await findSourceFile(testFilePath, cwd)
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
  const ctx = await buildFixFileContext(absTestPath, cwd, config).catch(() => null)

  if (!onStatus) log(chalk.dim(`  Sending to ${config.model} for repair...`))
  onStatus?.({ phase: 'generating', file: shortPath })

  for (let attempt = 1; attempt <= config.maxIterations; attempt++) {
    if (attempt > 1) {
      if (!onStatus) log(chalk.yellow(`\n  Retry ${attempt}/${config.maxIterations}...`))
      onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
    }

    let viewer: StreamingFileViewer | undefined
    if (verbose && !onStatus) {
      viewer = new StreamingFileViewer(shortPath)
      generator.setTokenCallback(t => viewer!.append(t))
      viewer.start()
    }

    let fixed: string
    try {
      fixed = attempt === 1
        ? await generator.fix({
            testFile: shortPath,
            testCode,
            sourceFile: sourceFilePath?.replace(cwd + '/', '') ?? null,
            sourceCode,
            sourceImportPath,
            errorOutput,
            mocksCode: ctx?.mocksCode ?? null,
            mocksImportPath: ctx?.mocksImportPath ?? null,
            setupFileCode: ctx?.setupFileCode ?? null,
            packageDeps: ctx?.packageDeps ?? null,
            tsconfigPaths: ctx?.tsconfigPaths ?? null,
            typeDefinitions,
            localImportPaths,
            reactMajorVersion,
            projectMemory,
          })
        : await generator.retry(errorOutput)
    } catch (err) {
      viewer?.stop()
      generator.setTokenCallback(undefined)
      if (err instanceof TruncatedOutputError) {
        errorOutput = TRUNCATION_RETRY_MESSAGE
        if (!onStatus) log(chalk.yellow(`\n  Output truncated — retrying with shorter output request...`))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
        continue
      }
      if (err instanceof OscillationError) {
        if (!onStatus) log(chalk.red(`\n  ⚠ Agent loop detected — output identical to a previous attempt. Stopping early.`))
        onStatus?.({ phase: 'failed', file: shortPath })
        await writeFile(absTestPath, testCode, 'utf-8').catch(() => {})
        return { success: false, error: err.message }
      }
      const msg = err instanceof Error ? err.message : String(err)
      if (!onStatus) log(chalk.red(`\n  API error: ${msg}`))
      onStatus?.({ phase: 'failed', file: shortPath })
      return { success: false, error: msg }
    }

    viewer?.stop()
    generator.setTokenCallback(undefined)

    if (dryRun) {
      if (!onStatus) {
        log(chalk.yellow('\n  [dry-run] Would write:'))
        log(chalk.dim(fixed.split('\n').slice(0, 10).map((l) => `    ${l}`).join('\n')))
      }
      onStatus?.({ phase: 'passed', file: shortPath })
      return { success: true }
    }

    // Split out mocks file if AI returned one
    const MOCKS_SEPARATOR = '// ---MOCKS_FILE---'
    let testFileContent = fixed
    if (fixed.includes(MOCKS_SEPARATOR) && config.mocksFile) {
      const [newTestCode, newMocksCode] = fixed.split(MOCKS_SEPARATOR)
      testFileContent = newTestCode.trim()
      if (newMocksCode?.trim()) {
        const absoluteMocksFile = join(cwd, config.mocksFile)
        await mkdir(dirname(absoluteMocksFile), { recursive: true })
        await writeFile(absoluteMocksFile, newMocksCode.trim(), 'utf-8')
        if (!onStatus) log(chalk.dim(`  Updated mocks file: ${config.mocksFile}`))
      }
    }

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

    const result = await runCommand(fileTestCommand(env, absTestPath), cwd, 60_000)

    if (result.success) {
      const typeErrors = await typeCheckFile(absTestPath, cwd, env)
      if (typeErrors) {
        errorOutput = `Tests passed but TypeScript type errors were found:\n${typeErrors}\n\nFix ALL type errors. Do not use 'as any' or '@ts-ignore'.`
        if (!onStatus) log(chalk.yellow('  Type errors found — retrying...'))
        onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: config.maxIterations })
        continue
      }
      if (!onStatus) log(chalk.green('  Fixed.'))
      onStatus?.({ phase: 'passed', file: shortPath })
      return { success: true }
    }

    const rawRunOutput = result.stdout + '\n' + result.stderr
    const extracted = enrichNoTestsError(extractTestFailure(rawRunOutput))
    const structureBroken = isZeroTestsOutput(rawRunOutput)
    const currentPassCount = structureBroken ? 0 : parsePassCount(rawRunOutput)

    if (structureBroken) {
      errorOutput = buildStructureBrokenMessage(initialErrorOutput, extracted)
      if (!onStatus) log(chalk.red(`  Fix broke file structure — 0 tests collected (attempt ${attempt}/${config.maxIterations})`))
    } else if (currentPassCount < baselinePassCount) {
      errorOutput = buildRegressionMessage(initialErrorOutput, extracted, baselinePassCount, currentPassCount)
      if (!onStatus) log(chalk.red(`  Fix caused regression: ${baselinePassCount} → ${currentPassCount} passing (attempt ${attempt}/${config.maxIterations})`))
    } else {
      errorOutput = extracted
      if (!onStatus) log(chalk.red(`  Still failing (attempt ${attempt}/${config.maxIterations})`))
    }
    if (!onStatus && verbose) log(chalk.dim(errorOutput.split('\n').slice(0, 20).join('\n')))
  }

  // Restore original test file — don't leave broken AI code on disk
  await writeFile(absTestPath, testCode, 'utf-8').catch(() => {})
  onStatus?.({ phase: 'failed', file: shortPath })
  return {
    success: false,
    error: `Still failing after ${config.maxIterations} attempts. Last error:\n${errorOutput.slice(0, 1500)}`,
  }
}

// ─── Worker pool ──────────────────────────────────────────────────────────────

async function runFixWorkers(
  testFiles: string[],
  options: FixOptions,
  workerCount: number,
  projectMemory: string | null,
): Promise<{ filesProcessed: number; filesFixed: number; errors: string[]; stillFailingFiles: string[] }> {
  const queue = [...testFiles]
  let filesProcessed = 0
  let filesFixed = 0
  const errors: string[] = []
  const stillFailingFiles: string[] = []

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
        const result = await fixFile(file, { ...options, log: () => {}, verbose: false }, generator, onStatus, projectMemory)
        filesProcessed++
        if (result.success) filesFixed++
        else {
          stillFailingFiles.push(file)
          if (result.error) errors.push(result.error)
        }
      }
    }),
  )

  display.finish()
  return { filesProcessed, filesFixed, errors, stillFailingFiles }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runFixLoop(options: FixOptions): Promise<FixResult> {
  const { config, env, cwd, log } = options
  const workerCount = Math.max(1, Math.min(options.workers ?? 1, 10))
  const parallel = workerCount > 1

  let failingFiles: string[]

  if (options.targetFile) {
    // Single-file mode: skip the full suite run, go straight to the target file
    const absTarget = options.targetFile.startsWith('/')
      ? options.targetFile
      : join(cwd, options.targetFile)
    const spinner = startCoverageSpinner(chalk.dim(`  Checking ${options.targetFile}...`), env.testRunner)
    const fileResult = await runCommand(fileTestCommand(env, absTarget), cwd, 60_000, spinner.onLine)
    spinner.stop()

    if (fileResult.success) {
      log(chalk.green('\n  All tests are passing — nothing to fix.'))
      return { filesProcessed: 0, filesFixed: 0, errors: [] }
    }

    failingFiles = [absTarget]
  } else {
    // Full-suite mode: check cache before running the suite
    const cache = options.fresh ? null : await loadFixCache(cwd)
    const useCached = cache !== null && cache.ageSeconds < FIX_CACHE_TTL_S

    if (useCached) {
      log(chalk.dim(`  Resuming from last run (${Math.round(cache!.ageSeconds)}s ago, ${cache!.files.length} file(s) still failing). Pass --fresh to re-scan the full suite.`))
      failingFiles = cache!.files
    } else {
      const spinner = startCoverageSpinner(chalk.dim('  Running test suite to find failures...'), env.testRunner)
      const suiteResult = await runCommand(env.testCommand, cwd, config.coverageTimeout * 1000, spinner.onLine)
      spinner.stop()

      if (suiteResult.timedOut) {
        throw new Error(
          `Test suite timed out after ${config.coverageTimeout}s.\n` +
          `Increase it in .lacuna.json: { "coverageTimeout": ${config.coverageTimeout * 2} }`,
        )
      }

      if (suiteResult.success) {
        log(chalk.green('\n  All tests are passing — nothing to fix.'))
        return { filesProcessed: 0, filesFixed: 0, errors: [] }
      }

      failingFiles = parseFailingTestFiles(suiteResult.stdout + suiteResult.stderr, env.testRunner)
      failingFiles = failingFiles.filter((f) => {
        const abs = f.startsWith('/') ? f : join(cwd, f)
        return abs.startsWith(cwd) && !abs.includes('node_modules')
      })

      if (failingFiles.length === 0) {
        log(chalk.yellow('\n  Could not identify any failing test files from the output.'))
        log(chalk.dim(`  Try running ${env.testCommand} directly to inspect the output.`))
        const lastLines = (suiteResult.stdout + suiteResult.stderr)
          .split('\n')
          .filter((l) => l.trim())
          .slice(-20)
          .join('\n')
        if (lastLines) log(chalk.dim('\n  Last output lines:\n' + lastLines.split('\n').map((l) => `    ${l}`).join('\n')))
        return { filesProcessed: 0, filesFixed: 0, errors: [] }
      }

      await saveFixCache(cwd, failingFiles)
    }
  }

  log(chalk.bold(`\n  Found ${failingFiles.length} failing test file(s).`))
  if (parallel) {
    if (options.verbose) log(chalk.dim(`  (--verbose is not shown in parallel mode — use --workers 1 to see the live code panel)`))
    log(chalk.dim(`\n  Workers: ${workerCount}\n`))
  }

  const memory = new ProjectMemory()
  await memory.initialize(cwd, env, config)
  const memorySnapshot = memory.toPromptSection()

  let filesProcessed: number
  let filesFixed: number
  let errors: string[]
  let stillFailingFiles: string[]

  if (parallel) {
    ;({ filesProcessed, filesFixed, errors, stillFailingFiles } = await runFixWorkers(failingFiles, options, workerCount, memorySnapshot))
  } else {
    filesProcessed = 0
    filesFixed = 0
    errors = []
    stillFailingFiles = []
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
      if (result.success) filesFixed++
      else {
        stillFailingFiles.push(file)
        if (result.error) errors.push(result.error)
      }
    }
  }

  // Update cache with only the files that are still failing.
  // This means the next `lacuna fix` run skips the full suite and picks up exactly
  // where we left off. If everything was fixed, delete the cache so the next run
  // does a clean suite scan to confirm.
  if (!options.targetFile) {
    if (stillFailingFiles.length > 0) await saveFixCache(cwd, stillFailingFiles)
    else await clearFixCache(cwd)
  }

  return { filesProcessed, filesFixed, errors }
}
