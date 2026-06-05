import type { CoverageReport, CoverageGap } from './types.js';
export declare function extractGaps(report: CoverageReport, threshold: number): CoverageGap[];
export declare function filterTestableGaps(gaps: CoverageGap[], userIgnore?: string[]): Promise<CoverageGap[]>;
export declare function findUncoveredFiles(report: CoverageReport, sourceDir: string | string[], cwd: string, userIgnore?: string[]): Promise<CoverageGap[]>;
export declare function formatCoverageSummary(report: CoverageReport): string;
export declare function findTestFiles(cwd: string, _env: {
    sourceDir?: string;
}, config: {
    sourceDir: string | string[];
    ignore: string[];
}): Promise<string[]>;
//# sourceMappingURL=gaps.d.ts.map