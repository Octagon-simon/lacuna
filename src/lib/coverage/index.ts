import { stat } from 'fs/promises'
import { join } from 'path'
import type { LacunaConfig } from '../config.js'
import { parseLcov } from './lcov.js'
import { parseJsonSummary } from './json.js'
import type { CoverageReport } from './types.js'

export async function loadCoverage(config: LacunaConfig, cwd: string = process.cwd()): Promise<CoverageReport> {
  if (config.coverageFormat === 'json-summary') {
    return parseJsonSummary(config.coverageDir, cwd)
  }
  return parseLcov(config.coverageDir, cwd)
}

export async function coverageAgeSeconds(config: LacunaConfig, cwd: string = process.cwd()): Promise<number | null> {
  const file = config.coverageFormat === 'json-summary'
    ? join(cwd, config.coverageDir, 'coverage-summary.json')
    : join(cwd, config.coverageDir, 'lcov.info')
  try {
    const { mtimeMs } = await stat(file)
    return (Date.now() - mtimeMs) / 1000
  } catch {
    return null
  }
}

export { extractGaps, filterTestableGaps, findUncoveredFiles, formatCoverageSummary, findTestFiles, isWithinDir, narrowGapsToDiff, computePatchCoverage, missingChangedFileGaps } from './gaps.js'
export type { FilterGapsOptions, PatchCoverage } from './gaps.js'
export type { CoverageReport, CoverageGap, FileCoverage } from './types.js'
