import type { LacunaConfig } from '../config.js';
import type { CoverageReport } from './types.js';
export declare function loadCoverage(config: LacunaConfig, cwd?: string): Promise<CoverageReport>;
export declare function coverageAgeSeconds(config: LacunaConfig, cwd?: string): Promise<number | null>;
export { parseLcov } from './lcov.js';
export { extractGaps, filterTestableGaps, findUncoveredFiles, formatCoverageSummary, findTestFiles, isWithinDir, narrowGapsToDiff, computePatchCoverage, missingChangedFileGaps, alignReportToChanged } from './gaps.js';
export type { FilterGapsOptions, PatchCoverage } from './gaps.js';
export type { CoverageReport, CoverageGap, FileCoverage } from './types.js';
//# sourceMappingURL=index.d.ts.map