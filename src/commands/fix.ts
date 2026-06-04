import { Command, Flags } from '@oclif/core'
import chalk from 'chalk'
import { loadConfig, applyModelOverride } from '../lib/config.js'
import { detectEnvironment } from '../lib/detector.js'
import { runFixLoop } from '../agent/fix-loop.js'

export default class Fix extends Command {
  static description = 'Find and fix failing tests using AI — preserves existing tests, only repairs what is broken'

  static examples = [
    '$ lacuna fix',
    '$ lacuna fix --workers 4',
    '$ lacuna fix --file src/utils/math.test.ts',
    '$ lacuna fix --dry-run',
    '$ lacuna fix --regenerate-on-failure',
    '$ lacuna fix --fix-polluters',
  ]

  static flags = {
    'dry-run': Flags.boolean({
      description: 'Show what would be changed without writing files',
      default: false,
    }),
    file: Flags.string({
      char: 'f',
      description: 'Target a specific test file instead of all failing tests',
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
    workers: Flags.integer({
      char: 'w',
      description: 'Number of parallel workers (each handles one file at a time)',
      default: 1,
    }),
    fresh: Flags.boolean({
      description: 'Re-run the full test suite even if a recent failing-files cache exists',
      default: false,
    }),
    'regenerate-on-failure': Flags.boolean({
      description: 'If fix exhausts all retries, delete the test and regenerate it from scratch (default: on). Use --no-regenerate-on-failure to disable.',
      default: true,
      allowNo: true,
    }),
    'fix-polluters': Flags.boolean({
      description: 'After fixing, bisect the test suite to identify files that corrupt shared state, then use AI to add cleanup',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Fix)

    const config = await loadConfig()
    if (flags.model) applyModelOverride(config, flags.model)

    const env = await detectEnvironment(process.cwd(), config.testRunner)

    this.log(chalk.bold('\nlacuna fix\n'))
    this.log(`${chalk.dim('Model:')}   ${chalk.cyan(config.model)}`)
    this.log(`${chalk.dim('Runner:')}  ${chalk.cyan(env.testRunner)}`)
    if (flags.workers > 1) this.log(`${chalk.dim('Workers:')} ${flags.workers}`)
    if (flags['dry-run']) this.log(chalk.yellow('  [dry-run — no files will be written]'))
    if (flags.file) this.log(`${chalk.dim('Target:')}  ${flags.file}`)

    if (env.testRunner === 'unknown') {
      this.warn('Could not detect test runner. Run `lacuna init` to configure.')
      this.exit(2)
    }

    let result
    try {
      result = await runFixLoop({
        config,
        env,
        cwd: process.cwd(),
        dryRun: flags['dry-run'],
        verbose: flags.verbose,
        targetFile: flags.file,
        workers: flags.workers,
        fresh: flags.fresh,
        regenerateOnFailure: flags['regenerate-on-failure'],
        fixPolluters: flags['fix-polluters'],
        log: (msg) => this.log(msg),
      })
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err))
    }

    this.log('')
    this.log(chalk.bold('Results'))
    this.log(`  ${chalk.dim('Files processed:')} ${result.filesProcessed}`)
    this.log(`  ${chalk.dim('Files fixed:')}     ${chalk.green(String(result.filesFixed))}`)

    if (result.filesAlreadyPassing > 0) {
      this.log(`  ${chalk.dim('Already passing:')} ${chalk.dim(String(result.filesAlreadyPassing))}`)
    }
    if (result.pollutersFixed > 0) {
      this.log(`  ${chalk.dim('Polluters fixed:')} ${chalk.green(String(result.pollutersFixed))}`)
    }
    if (result.victimsRegenerated > 0) {
      this.log(`  ${chalk.dim('Victims regen:')}   ${chalk.green(String(result.victimsRegenerated))}`)
    }

    const stillFailing = result.filesProcessed - result.filesFixed - result.filesAlreadyPassing
    if (stillFailing > 0) {
      this.log(`  ${chalk.dim('Still failing:')}  ${chalk.red(String(stillFailing))}`)
    }

    if (result.filesAlreadyPassing > 0 && !flags['fix-polluters']) {
      this.log(chalk.dim(`\n  ${result.filesAlreadyPassing} file(s) passed in isolation but fail in the suite. Use --fix-polluters to bisect + regenerate them.`))
    }

    if (result.errors.length > 0) {
      this.log(chalk.red(`\n  ${result.errors.length} error(s):`))
      for (const err of result.errors) {
        const lines = err.split('\n').slice(0, 8)
        this.log(chalk.dim('  ' + lines.join('\n  ')))
      }
    }

    if (result.filesProcessed === 0) {
      this.exit(0)
    } else if (stillFailing === 0) {
      if (result.filesAlreadyPassing > 0 && result.filesFixed === 0) {
        this.log(chalk.yellow(`\n  No tests were repaired — all skipped as already passing. Run lacuna fix --fresh to re-scan.`))
        this.exit(1)
      }
      this.log(chalk.green('\n  All failing tests fixed.'))
      this.exit(0)
    } else {
      this.log(chalk.yellow(`\n  ${stillFailing} file(s) still failing. Re-run lacuna fix or check errors above.`))
      this.exit(1)
    }
  }
}
