import { readFile } from 'fs/promises'
import { join } from 'path'
import type { CoverageReport, FileCoverage } from './types.js'

interface JsonSummaryEntry {
  lines: { total: number; covered: number; pct: number }
  functions: { total: number; covered: number; pct: number }
  statements: { total: number; covered: number; pct: number }
  branches: { total: number; covered: number; pct: number }
}

type JsonSummary = Record<string, JsonSummaryEntry>

function entryToFileCoverage(path: string, entry: JsonSummaryEntry): FileCoverage {
  return {
    path,
    lines: [],
    functions: [],
    lineRate: entry.lines.total ? entry.lines.covered / entry.lines.total : 1,
    functionRate: entry.functions.total ? entry.functions.covered / entry.functions.total : 1,
  }
}

export async function parseJsonSummary(coverageDir: string, cwd: string = process.cwd()): Promise<CoverageReport> {
  const summaryPath = join(cwd, coverageDir, 'coverage-summary.json')
  const raw = await readFile(summaryPath, 'utf-8')
  const summary: JsonSummary = JSON.parse(raw)

  const files: FileCoverage[] = Object.entries(summary)
    .filter(([path]) => path !== 'total')
    .map(([path, entry]) => entryToFileCoverage(path, entry))

  const total = summary['total']
  const totalLineRate = total ? total.lines.pct / 100 : files.reduce((s, f) => s + f.lineRate, 0) / (files.length || 1)
  const totalFunctionRate = total ? total.functions.pct / 100 : files.reduce((s, f) => s + f.functionRate, 0) / (files.length || 1)

  return { files, totalLineRate, totalFunctionRate }
}
