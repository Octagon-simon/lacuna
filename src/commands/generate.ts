import { Command, Flags, Args } from '@oclif/core'
import { writeFile, stat } from 'fs/promises'
import { resolve } from 'path'
import chalk from 'chalk'
import { loadConfig, applyModelOverride } from '../lib/config.js'
import { detectEnvironment } from '../lib/detector.js'
import { runAgentLoop } from '../agent/loop.js'
import { resolveDiffScope, countChangedLines, scopeDiffToDir, GitDiffError } from '../lib/git-diff.js'
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
    '$ lacuna generate @diff packages/api',
    '$ lacuna generate --dry-run',
    '$ lacuna generate --file src/utils/math.ts',
    '$ lacuna generate --improve',
    '$ lacuna generate --format json --output report.json',
  ]

  // Optional positionals, order-independent: a source file (single-file mode), a directory
  // (scoped create+improve), and/or @diff[:<ref>] (patch-coverage mode — target only the lines
  // changed vs the base ref). Subsumes --file. Combining @diff with a directory —
  // `generate @diff packages/api` — targets only the changed lines inside that folder.
  static args = {
    path: Args.string({
      description: 'Source file, directory (scoped create + improve), or @diff[:<ref>] (cover only changed lines)',
      required: false,
    }),
    scope: Args.string({
      description: 'Directory to scope @diff to, when the first arg is @diff (e.g. `generate @diff packages/api`)',
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

    const env = await detectEnvironment(process.cwd(), config.testRunner)
    if (config.testCommand) env.testCommand = config.testCommand

    // Resolve the two optional positionals in either order: the @diff[:<ref>] token enters
    // patch-coverage mode (it is NOT a filesystem path — no stat); a plain path is a source file
    // (single-file mode, like --file) or a directory (scopes discovery + the coverage run). A
    // directory alongside @diff narrows the diff to that folder's changed lines (handled in the
    // loop); a file alongside @diff narrows it to that file's changed lines.
    const isDiffToken = (s?: string) => s === '@diff' || (s?.startsWith('@diff:') ?? false)
    let diffToken: string | undefined
    let pathArg: string | undefined
    for (const a of [args.path, args.scope]) {
      if (!a) continue
      if (isDiffToken(a)) {
        if (diffToken) this.error('Pass @diff only once.')
        diffToken = a
      } else {
        if (pathArg) this.error(`Unexpected extra argument: ${a}`)
        pathArg = a
      }
    }

    let targetFile = flags.file
    let scopeDir: string | undefined
    let diffRef: string | undefined
    if (diffToken) {
      diffRef = diffToken === '@diff' ? '' : diffToken.slice('@diff:'.length)
    }
    if (pathArg) {
      const abs = resolve(process.cwd(), pathArg)
      let isDir = false
      try {
        isDir = (await stat(abs)).isDirectory()
      } catch {
        this.error(`Path not found: ${pathArg}`)
      }
      if (isDir) scopeDir = abs
      else targetFile = pathArg
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
        } else if (scopeDir) {
          const inDir = scopeDiffToDir(scope, scopeDir)
          const rel = scopeDir.replace(process.cwd() + '/', '')
          diffHeader = `diff vs ${scope.baseRef} under ${rel} (${inDir.changed.size} changed file(s), ${countChangedLines(inDir.changed)} line(s))`
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
}
