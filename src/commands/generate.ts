import { Command, Flags } from '@oclif/core'
import { writeFile } from 'fs/promises'
import chalk from 'chalk'
import { loadConfig } from '../lib/config.js'
import { detectEnvironment } from '../lib/detector.js'
import { runAgentLoop } from '../agent/loop.js'
import { reportTerminal, buildJsonReport, buildMarkdownReport, getExitCode } from '../lib/reporter.js'
import type { ReportInput } from '../lib/reporter.js'
import { uploadReport } from '../lib/report-upload.js'

export default class Generate extends Command {
  static description = 'Run the full agent loop: analyze gaps, generate tests, verify they pass'

  static examples = [
    '$ lacuna generate',
    '$ lacuna generate --dry-run',
    '$ lacuna generate --file src/utils/math.ts',
    '$ lacuna generate --format json --output report.json',
  ]

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
    'report-to': Flags.string({
      description: 'Upload results to a lacuna server (e.g. https://app.lacuna.dev)',
      env: 'LACUNA_SERVER_URL',
    }),
    'api-key': Flags.string({
      description: 'API key for the lacuna server',
      env: 'LACUNA_API_KEY',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Generate)

    const config = await loadConfig()
    if (flags.model) config.model = flags.model
    if (flags.threshold) config.threshold = flags.threshold

    const env = await detectEnvironment(process.cwd(), config.testRunner)

    this.log(chalk.bold('\nlacuna generate\n'))
    this.log(`${chalk.dim('Model:')}      ${chalk.cyan(config.model)}`)
    this.log(`${chalk.dim('Runner:')}     ${chalk.cyan(env.testRunner)}`)
    this.log(`${chalk.dim('Threshold:')}  ${config.threshold}%`)
    if (flags.workers > 1) this.log(`${chalk.dim('Workers:')}    ${flags.workers}`)
    if (flags['dry-run']) this.log(chalk.yellow('  [dry-run — no files will be written]'))
    if (flags.file) this.log(`${chalk.dim('Target:')}     ${flags.file}`)

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
        targetFile: flags.file,
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

    if (flags['report-to']) {
      const apiKey = flags['api-key'] ?? process.env.LACUNA_API_KEY ?? ''
      if (!apiKey) {
        this.warn('--report-to requires --api-key (or LACUNA_API_KEY env var)')
      } else {
        try {
          await uploadReport(flags['report-to'], buildJsonReport(input), apiKey)
          this.log(chalk.dim(`\nReport uploaded to ${flags['report-to']}`))
        } catch (err) {
          this.warn(`Could not upload report: ${err instanceof Error ? err.message : err}`)
        }
      }
    }

    this.exit(getExitCode(input))
  }
}
