import type { CoverageReport, CoverageGap } from './types.js';
export declare function extractGaps(report: CoverageReport, threshold: number): CoverageGap[];
export interface FilterGapsOptions {
    includeExisting?: boolean;
}
export declare function filterTestableGaps(gaps: CoverageGap[], userIgnore?: string[], opts?: FilterGapsOptions): Promise<CoverageGap[]>;
export declare function isWithinDir(absPath: string, absDir: string): boolean;
export declare function findUncoveredFiles(report: CoverageReport, sourceDir: string | string[], cwd: string, userIgnore?: string[], scopeDir?: string): Promise<CoverageGap[]>;
export declare function narrowGapsToDiff(gaps: CoverageGap[], changed: Map<string, Set<number>>, report: CoverageReport, cwd: string): CoverageGap[];
export declare function missingChangedFileGaps(changed: Map<string, Set<number>>, report: CoverageReport, existingGaps: CoverageGap[], cwd: string, userIgnore?: string[]): Promise<CoverageGap[]>;
export interface PatchCoverage {
    covered: number;
    total: number;
    pct: number;
}
export declare function computePatchCoverage(report: CoverageReport, changed: Map<string, Set<number>>, cwd: string, assumeUncovered?: Set<string>): PatchCoverage;
export declare function formatCoverageSummary(report: CoverageReport): string;
export declare function findTestFiles(cwd: string, _env: {
    sourceDir?: string;
}, config: {
    sourceDir: string | string[];
    ignore: string[];
}, scopeDir?: string): Promise<string[]>;
//# sourceMappingURL=gaps.d.ts.map