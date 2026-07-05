import { Command, Flags, Args } from '@oclif/core'
import { writeFile, stat } from 'fs/promises'
import { resolve } from 'path'
import chalk from 'chalk'
import { loadConfig, applyModelOverride } from '../lib/config.js'
import { detectEnvironment } from '../lib/detector.js'
import { runAgentLoop } from '../agent/loop.js'
import { runE2ELoop } from '../agent/e2e-loop.js'
import { resolveDiffScope, countChangedLines, GitDiffError } from '../lib/git-diff.js'
import { debugLogPattern } from '../agent/generator.js'
import { reportTerminal, buildJsonReport, buildMarkdownReport, getExitCode } from '../lib/reporter.js'
import type { ReportInput } from '../lib/reporter.js'
import { showOutcomeNudge } from '../lib/feedback.js'

export default class Generate extends Command {
  static description = 'Run the full agent loop: analyze gaps, generate tests, verify they pass'

  static examples = [
    '$ lacuna generate',
    '$ lacuna generate src/payments',
    '$ lacuna generate @diff:origin/main',
    '$ lacuna generate --dry-run',
    '$ lacuna generate --file src/utils/math.ts',
    '$ lacuna generate --improve',
    '$ lacuna generate --format json --output report.json',
    '$ lacuna generate --e2e',
    '$ lacuna generate --e2e --route /login',
  ]

  // Optional positional: a source file (single-file mode), a directory (scoped create+improve),
  // or @diff[:<ref>] (patch-coverage mode — target only the lines changed vs the base ref).
  // Subsumes --file; a directory scopes discovery + the coverage run to that subtree.
  static args = {
    path: Args.string({
      description: 'Source file, directory (scoped create + improve), or @diff[:<ref>] (cover only changed lines)',
      required: false,
    }),
  }

  static flags = {
    'dry-run': Flags.boolean({
      description: 'Print what would be written without touching the filesystem',
      default: false,
    }),
    file: Flags.string({
      char: 'f',
      description: 'Target a specific source file instead of the whole project',
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show model output and full test runner logs',
      default: false,
    }),
    model: Flags.string({
      char: 'm',
      description: 'Model to use (overrides .lacuna.json)',
    }),
    threshold: Flags.integer({
      char: 't',
      description: 'Override coverage threshold',
    }),
    format: Flags.string({
      char: 'F',
      description: 'Output format for the final report',
      options: ['terminal', 'json', 'markdown'],
      default: 'terminal',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Write report to file instead of stdout',
    }),
    workers: Flags.integer({
      char: 'w',
      description: 'Number of parallel workers (each handles one file at a time)',
      default: 1,
    }),
    fresh: Flags.boolean({
      description: 'Force a fresh coverage run even if a recent report already exists',
      default: false,
    }),
    e2e: Flags.boolean({
      description: 'Generate Playwright end-to-end specs from discovered routes (DOM-aware), instead of unit tests (requires @playwright/test)',
      default: false,
    }),
    route: Flags.string({
      description: 'With --e2e: generate a spec for a single route only (e.g. /login)',
    }),
    'max-routes': Flags.integer({
      description: 'With --e2e: limit how many routes to generate specs for in one run (default: all; re-run to do the rest)',
    }),
    'inject-testids': Flags.boolean({
      description: 'With --e2e: add data-testid attributes to page SOURCE files for stabler selectors (the only flag that edits your source; each injection is verified against a re-snapshot and reverted if it does not reach the DOM)',
      default: false,
    }),
    deep: Flags.boolean({
      description: 'With --e2e: deeply explore multi-step flows — fills and SUBMITS forms to walk wizards step by step and generate full user-journey specs. This drives real actions (creates records, can trigger payments), so use a TEST/STAGING environment.',
      default: false,
    }),
    improve: Flags.boolean({
      description: 'Also extend existing below-threshold tests (not just create tests for untested files)',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Generate)

    const config = await loadConfig()
    if (flags.model) applyModelOverride(config, flags.model)
    if (flags.threshold) config.threshold = flags.threshold
    if (config.testEnv) Object.assign(process.env, config.testEnv)

    // E2E generation is a separate flow: route-driven, no coverage, no unit test runner. Branch
    // before the unit-path setup (and its "unknown runner" guard) since a Playwright-only repo
    // legitimately has no unit runner.
    if (flags.e2e) {
      // --file targets a source file in the unit path; E2E is route-driven, so it has no effect
      // here. Warn rather than silently ignore it, and point at the right flag.
      if (flags.file) this.warn(`--file is ignored with --e2e (E2E generation is route-driven). Use --route ${flags.file.startsWith('/') ? flags.file : '<path>'} to target a single route.`)
      await this.runE2E(config, flags)
      return
    }

    const env = await detectEnvironment(process.cwd(), config.testRunner)
    if (config.testCommand) env.testCommand = config.testCommand

    // Resolve the optional positional path: a file routes to single-file mode (like --file),
    // a directory scopes the whole run (discovery + coverage) to that subtree, and the
    // @diff[:<ref>] token enters patch-coverage mode (it is NOT a filesystem path — no stat).
    let targetFile = flags.file
    let scopeDir: string | undefined
    let diffRef: string | undefined
    if (args.path === '@diff' || args.path?.startsWith('@diff:')) {
      // `--file` alongside @diff narrows the diff scope to that one file's changed lines
      // (handled in the loop) — it does NOT enter the single-file fast path.
      diffRef = args.path === '@diff' ? '' : args.path.slice('@diff:'.length)
    } else if (args.path) {
      const abs = resolve(process.cwd(), args.path)
      let isDir = false
      try {
        isDir = (await stat(abs)).isDirectory()
      } catch {
        this.error(`Path not found: ${args.path}`)
      }
      if (isDir) scopeDir = abs
      else targetFile = args.path
    }
    const improve = flags.improve || !!scopeDir || diffRef !== undefined

    // Resolve the diff scope up front for the header (and to fail fast on a bad base ref —
    // exit 2 with the actionable hint rather than after a long coverage run).
    let diffHeader: string | undefined
    if (diffRef !== undefined) {
      try {
        const scope = await resolveDiffScope(process.cwd(), diffRef || undefined)
        if (targetFile) {
          const absTarget = resolve(process.cwd(), targetFile)
          const lines = scope.changed.get(absTarget)
          diffHeader = `diff vs ${scope.baseRef} ∩ ${targetFile} (${lines ? lines.size : 0} changed line(s))`
        } else {
          diffHeader = `diff vs ${scope.baseRef} (${scope.changed.size} changed file(s), ${countChangedLines(scope.changed)} line(s))`
        }
      } catch (err) {
        this.error(err instanceof GitDiffError ? err.message : String(err))
      }
    }

    this.log(chalk.bold('\nlacuna generate\n'))
    this.log(`${chalk.dim('Model:')}      ${chalk.cyan(config.model)}`)
    this.log(`${chalk.dim('Runner:')}     ${chalk.cyan(env.testRunner)}`)
    this.log(`${chalk.dim('Threshold:')}  ${config.threshold}%`)
    if (flags.workers > 1) this.log(`${chalk.dim('Workers:')}    ${flags.workers}`)
    if (config.mocksFile) this.log(`${chalk.dim('Mocks:')}      ${chalk.cyan(config.mocksFile)}`)
    const debugPattern = debugLogPattern(config.debug)
    if (debugPattern) this.log(`${chalk.dim('Debug:')}      ${chalk.green('on')} ${chalk.dim(`→ ${debugPattern}`)}`)
    if (flags['dry-run']) this.log(chalk.yellow('  [dry-run — no files will be written]'))
    if (diffHeader) this.log(`${chalk.dim('Scope:')}      ${chalk.cyan(diffHeader)}`)
    else if (scopeDir) this.log(`${chalk.dim('Scope:')}      ${args.path} ${chalk.dim('(create + improve)')}`)
    else if (targetFile) this.log(`${chalk.dim('Target:')}     ${targetFile}`)
    else if (improve) this.log(`${chalk.dim('Mode:')}       ${chalk.cyan('improve')} ${chalk.dim('(extend existing below-threshold tests)')}`)

    if (env.testRunner === 'unknown') {
      this.warn('Could not detect test runner. Run `lacuna init` to configure.')
      this.exit(2)
    }

    let loopResult
    try {
      loopResult = await runAgentLoop({
        config,
        env,
        cwd: process.cwd(),
        dryRun: flags['dry-run'],
        verbose: flags.verbose,
        targetFile,
        scopeDir,
        improve,
        diffRef,
        workers: flags.workers,
        fresh: flags.fresh,
        log: (msg) => this.log(msg),
      })
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    const input: ReportInput = {
      type: 'generate',
      threshold: config.threshold,
      untouchedCount: 0,
      generate: loopResult,
    }

    if (flags.format === 'json') {
      const out = JSON.stringify(buildJsonReport(input), null, 2)
      if (flags.output) {
        await writeFile(flags.output, out, 'utf-8')
        this.log(`\nReport written to ${flags.output}`)
      } else {
        this.log('\n' + out)
      }
    } else if (flags.format === 'markdown') {
      const out = buildMarkdownReport(input)
      if (flags.output) {
        await writeFile(flags.output, out, 'utf-8')
        this.log(`\nReport written to ${flags.output}`)
      } else {
        this.log('\n' + out)
      }
    } else {
      reportTerminal(input)
    }

    if (!flags['dry-run'] && flags.format === 'terminal') {
      showOutcomeNudge(loopResult.testsWritten, loopResult.errors.length, 'generate')
    }

    this.exit(getExitCode(input))
  }

  // E2E generation path: discover routes, snapshot the DOM, generate + verify Playwright specs.
  private async runE2E(config: Awaited<ReturnType<typeof loadConfig>>, flags: { 'dry-run': boolean; verbose: boolean; route?: string; 'max-routes'?: number; workers: number; 'inject-testids': boolean; deep: boolean }): Promise<void> {
    this.log(chalk.bold('\nlacuna generate --e2e\n'))
    this.log(`${chalk.dim('Model:')}   ${chalk.cyan(config.model)}`)
    this.log(`${chalk.dim('Mode:')}    ${chalk.cyan('end-to-end')} ${chalk.dim('(Playwright specs from discovered routes)')}`)
    if (flags.route) this.log(`${chalk.dim('Route:')}   ${flags.route}`)
    if (flags.workers > 1) this.log(`${chalk.dim('Workers:')} ${flags.workers}`)
    if (flags['inject-testids']) this.log(`${chalk.dim('Testids:')} ${chalk.yellow('inject')} ${chalk.dim('(edits page source; reverted if a testid does not reach the DOM)')}`)
    if (flags.deep) this.log(`${chalk.dim('Deep:')}    ${chalk.yellow('on')} ${chalk.dim('(walks flows by filling & SUBMITTING forms — use a test/staging environment)')}`)
    const debugPattern = debugLogPattern(config.debug)
    if (debugPattern) this.log(`${chalk.dim('Debug:')}   ${chalk.green('on')} ${chalk.dim(`→ ${debugPattern}`)}`)
    if (flags['dry-run']) this.log(chalk.yellow('  [dry-run — no files will be written]'))

    let result
    try {
      result = await runE2ELoop({
        config,
        cwd: process.cwd(),
        dryRun: flags['dry-run'],
        verbose: flags.verbose,
        targetRoute: flags.route,
        maxRoutes: flags['max-routes'],
        workers: flags.workers,
        injectTestIds: flags['inject-testids'],
        deep: flags.deep,
        log: (msg) => this.log(msg),
      })
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    this.log('')
    this.log(chalk.bold('Results'))
    this.log(`  ${chalk.dim('Routes discovered:')} ${result.flowsDiscovered}`)
    this.log(`  ${chalk.dim('Specs generated:')}   ${chalk.green(String(result.specsGenerated))}`)
    if (result.skipped > 0) this.log(`  ${chalk.dim('Skipped (existing):')} ${chalk.dim(String(result.skipped))}`)
    if (result.specsFailed > 0) this.log(`  ${chalk.dim('Failed:')}            ${chalk.red(String(result.specsFailed))}`)

    if (result.errors.length > 0) {
      this.log(chalk.red(`\n  ${result.errors.length} error(s):`))
      for (const err of result.errors) {
        this.log(chalk.dim('  ' + err.split('\n').slice(0, 8).join('\n  ')))
      }
    }

    // Show at most ONE outcome nudge (star OR issue), same as the unit path — never both, so a
    // partial run (some specs generated, some failed) doesn't read as contradictory.
    if (!flags['dry-run']) showOutcomeNudge(result.specsGenerated, result.specsFailed, 'generate')
    this.exit(result.specsFailed > 0 ? 1 : 0)
  }
}
