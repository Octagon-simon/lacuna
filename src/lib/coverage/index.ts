import { stat } from 'fs/promises'
import { join } from 'path'
import type { LacunaConfig } from '../config.js'
import { parseLcov, resolveLcovPath } from './lcov.js'
import { parseJsonSummary } from './json.js'
import { parseCoverageFinal, coverageFinalPath } from './istanbul.js'
import type { CoverageReport } from './types.js'

export async function loadCoverage(config: LacunaConfig, cwd: string = process.cwd()): Promise<CoverageReport> {
  if (config.coverageFormat === 'json-summary') {
    return parseJsonSummary(config.coverageDir, cwd)
  }
  // Default path is lcov. If lcov.info isn't there, fall back to istanbul's coverage-final.json
  // (part of vitest's/jest's DEFAULT reporters) before giving up — so a project whose reporter list
  // never included 'lcov' still works instead of hard-failing on a missing file.
  try {
    return await parseLcov(config.coverageDir, cwd)
  } catch (lcovErr) {
    const final = await parseCoverageFinal(config.coverageDir, cwd).catch(() => null)
    if (final) return final
    throw lcovErr
  }
}

export async function coverageAgeSeconds(config: LacunaConfig, cwd: string = process.cwd()): Promise<number | null> {
  const candidates = config.coverageFormat === 'json-summary'
    ? [join(cwd, config.coverageDir, 'coverage-summary.json')]
    // Match loadCoverage's fallback order so freshness is judged on whichever file we'll actually read.
    : [await resolveLcovPath(config.coverageDir, cwd), coverageFinalPath(config.coverageDir, cwd)]
  for (const file of candidates) {
    try {
      const { mtimeMs } = await stat(file)
      return (Date.now() - mtimeMs) / 1000
    } catch { /* try the next candidate */ }
  }
  return null
}

export { parseLcov, resolveLcovPath } from './lcov.js'
export { extractGaps, filterTestableGaps, findUncoveredFiles, formatCoverageSummary, findTestFiles, isWithinDir, narrowGapsToDiff, computePatchCoverage, missingChangedFileGaps, alignReportToChanged } from './gaps.js'
export type { FilterGapsOptions, PatchCoverage } from './gaps.js'
export type { CoverageReport, CoverageGap, FileCoverage } from './types.js'
