import chalk from 'chalk'
import type { LoopResult } from '../agent/loop.js'
import type { CoverageGap } from './coverage/types.js'

export interface AnalyzeResult {
  testRunner: string
  language: string
  threshold: number
  coveragePct: number
  functionCoveragePct: number
  gaps: CoverageGap[]
  untouchedCount: number   // files in sourceDir with no tests at all
  passed: boolean
}

export interface ReportInput {
  type: 'analyze' | 'generate'
  threshold: number
  analyze?: AnalyzeResult
  generate?: LoopResult
  timestamp?: string
  untouchedCount: number   // files in sourceDir with no tests at all
}

// ─── Terminal ────────────────────────────────────────────────────────────────

export function reportTerminal(input: ReportInput): void {
  const { threshold } = input

  if (input.type === 'analyze' && input.analyze) {
    const r = input.analyze
    const lineColor = r.passed ? chalk.green : chalk.red
    const status = r.passed ? chalk.green('PASS') : chalk.red('FAIL')

    console.log(chalk.bold('\nCoverage Summary'))
    console.log(
      `  Lines:     ${lineColor(r.coveragePct.toFixed(1) + '%')}   Functions: ${lineColor(r.functionCoveragePct.toFixed(1) + '%')}`,
    )
    console.log(`  Threshold: ${threshold}%   Status: ${status}\n`)

    if (r.gaps.length === 0) {
      if (r.passed) {
        console.log(chalk.green('  All files meet the threshold.'))
      } else {
        // Overall coverage is below threshold even though no per-file gaps were found.
        // This happens when many source files are never imported by any test — they
        // don't appear in the LCOV report individually but pull down the overall rate.
        console.log(chalk.yellow(`  Overall coverage is ${r.coveragePct.toFixed(1)}% — below the ${r.threshold}% threshold.`))
        console.log(chalk.dim(`  No per-file gaps were found in the coverage report.`))
        console.log(chalk.dim(`  Try running ${chalk.cyan('lacuna generate')} to find and cover untested source files.\n`))
      }
      return
    }

    const belowThreshold = r.gaps.length - r.untouchedCount
    const parts: string[] = []
    if (belowThreshold > 0) parts.push(`${belowThreshold} below ${r.threshold}%`)
    if (r.untouchedCount > 0) parts.push(`${r.untouchedCount} with no tests yet`)
    console.log(chalk.yellow(`  ${r.gaps.length} testable file(s) need attention — ${parts.join(', ')}:\n`))

    for (const gap of r.gaps) {
      const short = gap.filePath.replace(process.cwd() + '/', '')
      console.log(`  ${chalk.cyan(short)}`)
      if (gap.uncoveredFunctions.length > 0) {
        console.log(chalk.dim(`    functions: ${gap.uncoveredFunctions.join(', ')}`))
      }
    }
    console.log(`\n  Run ${chalk.cyan('lacuna generate')} to write tests for ${r.gaps.length} file(s).\n`)
    return
  }

  if (input.type === 'generate' && input.generate) {
    const r = input.generate

    console.log(chalk.bold('\n─── Results ───────────────────────────────'))
    console.log(`  Files processed : ${r.filesProcessed}`)
    console.log(`  Tests written   : ${r.testsWritten}`)

    if (r.hasCoverage) {
      const delta = r.coverageAfter - r.coverageBefore
      const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%'
      const afterColor = r.coverageAfter >= threshold ? chalk.green : chalk.yellow
      console.log(
        `  Coverage        : ${chalk.dim(r.coverageBefore.toFixed(1) + '%')} → ${afterColor(r.coverageAfter.toFixed(1) + '%')} (${delta >= 0 ? chalk.green(deltaStr) : chalk.red(deltaStr)})`,
      )
      console.log(
        `  Threshold       : ${threshold}%  ${r.coverageAfter >= threshold ? chalk.green('PASS') : chalk.red('FAIL')}`,
      )
    } else {
      const allPassed = r.testsWritten === r.filesProcessed && r.errors.length === 0
      console.log(`  Coverage        : ${chalk.dim('n/a')} (single-file mode — no suite run)`)
      console.log(`  Status          : ${allPassed ? chalk.green('PASS') : chalk.red('FAIL')}`)
    }

    if (r.errors.length > 0) {
      console.log(chalk.red(`\n  ${r.errors.length} file(s) could not be fixed:`))
      for (const err of r.errors) {
        const lines = err.split('\n').filter(Boolean).slice(0, 8)
        for (const line of lines) {
          console.log(chalk.dim(`    ${line}`))
        }
        console.log('')
      }
    }
    console.log('')
  }
}

// ─── JSON ────────────────────────────────────────────────────────────────────

export interface JsonReport {
  lacuna: string
  timestamp: string
  type: 'analyze' | 'generate'
  threshold: number
  passed: boolean
  coverage: {
    before?: number
    after?: number
    lines?: number
    functions?: number
  }
  filesProcessed?: number
  testsWritten?: number
  gaps?: Array<{ file: string; uncoveredFunctions: string[]; uncoveredLines: number[] }>
  errors?: string[]
}

export function buildJsonReport(input: ReportInput): JsonReport {
  const timestamp = input.timestamp ?? new Date().toISOString()

  if (input.type === 'analyze' && input.analyze) {
    const r = input.analyze
    return {
      lacuna: '0.1.0',
      timestamp,
      type: 'analyze',
      threshold: input.threshold,
      passed: r.passed,
      coverage: { lines: r.coveragePct, functions: r.functionCoveragePct },
      gaps: r.gaps.map((g) => ({
        file: g.filePath,
        uncoveredFunctions: g.uncoveredFunctions,
        uncoveredLines: g.uncoveredLines,
      })),
      errors: [],
    }
  }

  const r = input.generate!
  const passed = r.hasCoverage
    ? r.coverageAfter >= input.threshold
    : r.testsWritten === r.filesProcessed && r.errors.length === 0
  return {
    lacuna: '0.1.0',
    timestamp,
    type: 'generate',
    threshold: input.threshold,
    passed,
    coverage: r.hasCoverage ? { before: r.coverageBefore, after: r.coverageAfter } : {},
    filesProcessed: r.filesProcessed,
    testsWritten: r.testsWritten,
    errors: r.errors,
  }
}

// ─── Markdown ────────────────────────────────────────────────────────────────

export function buildMarkdownReport(input: ReportInput): string {
  const lines: string[] = []
  const { threshold } = input

  lines.push('## lacuna Coverage Report')
  lines.push('')

  if (input.type === 'analyze' && input.analyze) {
    const r = input.analyze
    const status = r.passed ? '✅ Pass' : '❌ Fail'
    lines.push(`| Metric | Value |`)
    lines.push(`|--------|-------|`)
    lines.push(`| Line coverage | ${r.coveragePct.toFixed(1)}% |`)
    lines.push(`| Function coverage | ${r.functionCoveragePct.toFixed(1)}% |`)
    lines.push(`| Threshold | ${threshold}% |`)
    lines.push(`| Status | ${status} |`)

    if (r.gaps.length > 0) {
      lines.push('')
      lines.push('### Files below threshold')
      for (const gap of r.gaps) {
        const short = gap.filePath.replace(process.cwd() + '/', '')
        lines.push(`- \`${short}\` — uncovered: ${gap.uncoveredFunctions.join(', ') || `${gap.uncoveredLines.length} lines`}`)
      }
    }
  }

  if (input.type === 'generate' && input.generate) {
    const r = input.generate
    const delta = r.coverageAfter - r.coverageBefore
    const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%'
    const status = r.coverageAfter >= threshold ? '✅ Pass' : '❌ Below threshold'

    lines.push(`| Metric | Value |`)
    lines.push(`|--------|-------|`)
    lines.push(`| Coverage before | ${r.coverageBefore.toFixed(1)}% |`)
    lines.push(`| Coverage after | ${r.coverageAfter.toFixed(1)}% |`)
    lines.push(`| Delta | ${deltaStr} |`)
    lines.push(`| Threshold | ${threshold}% |`)
    lines.push(`| Files processed | ${r.filesProcessed} |`)
    lines.push(`| Tests written | ${r.testsWritten} |`)
    lines.push(`| Status | ${status} |`)

    if (r.errors.length > 0) {
      lines.push('')
      lines.push('### Errors')
      for (const err of r.errors) {
        const summary = err.split('\n').filter(Boolean).slice(0, 3).join(' | ')
        lines.push(`- ${summary}`)
      }
    }
  }

  lines.push('')
  lines.push(`> Generated by [lacuna](https://github.com/lacuna-dev/lacuna)`)

  return lines.join('\n')
}

// ─── Exit codes ──────────────────────────────────────────────────────────────

export const EXIT = {
  OK: 0,
  BELOW_THRESHOLD: 1,
  ERROR: 2,
} as const

export function getExitCode(input: ReportInput): number {
  if (input.type === 'analyze') {
    return input.analyze?.passed ? EXIT.OK : EXIT.BELOW_THRESHOLD
  }
  if (input.type === 'generate') {
    const r = input.generate
    if (!r) return EXIT.ERROR
    // Hard error only when nothing was generated at all — partial success (some files
    // failed, others passed) is BELOW_THRESHOLD so downstream steps (e.g. commit) still run.
    if (r.errors.length > 0 && r.testsWritten === 0) return EXIT.ERROR
    if (!r.hasCoverage) {
      return r.testsWritten === r.filesProcessed && r.errors.length === 0 ? EXIT.OK : EXIT.BELOW_THRESHOLD
    }
    return r.coverageAfter >= input.threshold ? EXIT.OK : EXIT.BELOW_THRESHOLD
  }
  return EXIT.ERROR
}
