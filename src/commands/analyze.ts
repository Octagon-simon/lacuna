import { Command, Flags } from '@oclif/core'
import { writeFile } from 'fs/promises'
import chalk from 'chalk'
import { loadConfig } from '../lib/config.js'
import { detectEnvironment } from '../lib/detector.js'
import { runCommand } from '../lib/runner.js'
import { startCoverageSpinner } from '../lib/coverage-spinner.js'
import { loadCoverage, extractGaps, filterTestableGaps, findUncoveredFiles } from '../lib/coverage/index.js'
import { reportTerminal, buildJsonReport, buildMarkdownReport, getExitCode } from '../lib/reporter.js'
import type { ReportInput } from '../lib/reporter.js'

export default class Analyze extends Command {
  static description = 'Analyze test coverage and show gaps — no files are changed'

  static examples = [
    '$ lacuna analyze',
    '$ lacuna analyze --threshold 90',
    '$ lacuna analyze --format json',
    '$ lacuna analyze --format markdown',
  ]

  static flags = {
    threshold: Flags.integer({
      char: 't',
      description: 'Minimum coverage percentage',
    }),
    format: Flags.string({
      char: 'F',
      description: 'Output format',
      options: ['terminal', 'json', 'markdown'],
      default: 'terminal',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Write report to file instead of stdout',
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show uncovered line numbers per file',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Analyze)
    const config = await loadConfig()
    const env = await detectEnvironment(process.cwd(), config.testRunner)
    const threshold = flags.threshold ?? config.threshold

    if (flags.format === 'terminal') {
      this.log(chalk.bold('\nlacuna analyze\n'))
    }

    if (env.testRunner === 'unknown') {
      this.warn('Could not detect test runner. Run `lacuna init` to configure.')
      this.exit(2)
    }

    if (flags.format === 'terminal') {
      this.log(`${chalk.dim('Detected:')}  ${chalk.cyan(env.testRunner)} (${env.language})`)
      this.log(`${chalk.dim('Threshold:')} ${threshold}%\n`)
    }

    const spinner = startCoverageSpinner(chalk.dim(`  Running: ${env.coverageCommand}`), env.testRunner)
    const result = await runCommand(env.coverageCommand, process.cwd(), config.coverageTimeout * 1000, spinner.onLine)
    spinner.stop()

    if (result.timedOut) {
      this.log(chalk.red(`\nTest suite timed out after ${config.coverageTimeout}s.`))
      this.log(chalk.yellow('\nThis usually means a test has an open handle (unclosed server, timer, or connection).'))
      this.log(chalk.dim(`\nIncrease the timeout in .lacuna.json: { "coverageTimeout": ${config.coverageTimeout * 2} }`))
      this.exit(2)
    }

    // only bail if literally zero tests ran (suites crashed on load)
    const zeroTests = /Tests:\s+0 total|no tests found/i.test(result.stdout + result.stderr)
    if (zeroTests) {
      this.log(chalk.red('\nYour test suites are failing before any tests run.'))
      this.log(chalk.yellow('\nThis usually means:'))
      this.log('  • A missing environment variable (check .env / .env.test)')
      this.log('  • A broken import or missing module')
      this.log('  • A setup file failing (DB connection, mock config, etc.)\n')
      this.log(chalk.dim('Run this to see the actual error:'))
      this.log(chalk.cyan(`  ${env.testCommand} 2>&1 | head -80`))
      this.exit(2)
    }
    // partial failures are fine — coverage is still collected for passing tests

    let report
    try {
      report = await loadCoverage(config)
    } catch {
      this.log(chalk.red(`Could not read coverage report from ./${config.coverageDir}/\n`))
      this.log(chalk.yellow('Make sure your vitest config has coverage enabled:'))
      this.log(chalk.dim('  // vitest.config.ts'))
      this.log(chalk.dim('  test: { coverage: { reporter: ["lcov", "text-summary"] } }'))
      this.exit(2)
    }

    const gaps = await filterTestableGaps(extractGaps(report, threshold), config.ignore)

    // append files that never appeared in the coverage report (never imported by any test)
    const untouchedFiles = await findUncoveredFiles(report, config.sourceDir, process.cwd(), config.ignore)
    const existingPaths = new Set(gaps.map((g) => g.filePath))
    let untouchedCount = 0
    for (const g of untouchedFiles) {
      if (!existingPaths.has(g.filePath)) {
        gaps.push(g)
        untouchedCount++
      }
    }

    const coveragePct = report.totalLineRate * 100
    const functionCoveragePct = report.totalFunctionRate * 100
    const passed = coveragePct >= threshold

    const input: ReportInput = {
      type: 'analyze',
      threshold,
      untouchedCount,
      analyze: {
        testRunner: env.testRunner,
        language: env.language,
        threshold,
        coveragePct,
        functionCoveragePct,
        gaps,
        untouchedCount,
        passed,
      },
    }

    if (flags.format === 'json') {
      const out = JSON.stringify(buildJsonReport(input), null, 2)
      if (flags.output) {
        await writeFile(flags.output, out, 'utf-8')
        this.log(`Report written to ${flags.output}`)
      } else {
        this.log(out)
      }
    } else if (flags.format === 'markdown') {
      const out = buildMarkdownReport(input)
      if (flags.output) {
        await writeFile(flags.output, out, 'utf-8')
        this.log(`Report written to ${flags.output}`)
      } else {
        this.log(out)
      }
    } else {
      reportTerminal(input)
      if (flags.verbose && gaps.length > 0) {
        for (const gap of gaps) {
          if (gap.uncoveredLines.length > 0) {
            const short = gap.filePath.replace(process.cwd() + '/', '')
            this.log(chalk.dim(`  ${short} lines: ${gap.uncoveredLines.slice(0, 20).join(', ')}${gap.uncoveredLines.length > 20 ? '…' : ''}`))
          }
        }
      }
    }

    this.exit(getExitCode(input))
  }
}
