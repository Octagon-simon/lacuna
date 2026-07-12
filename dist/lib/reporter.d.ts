import type { LoopResult } from '../agent/loop.js';
import type { CoverageGap } from './coverage/types.js';
export interface AnalyzeResult {
    testRunner: string;
    language: string;
    threshold: number;
    coveragePct: number;
    functionCoveragePct: number;
    gaps: CoverageGap[];
    untouchedCount: number;
    passed: boolean;
    scope?: string;
    patchCoveragePct?: number;
    diffBase?: string;
}
export interface ReportInput {
    type: 'analyze' | 'generate';
    threshold: number;
    analyze?: AnalyzeResult;
    generate?: LoopResult;
    timestamp?: string;
    untouchedCount: number;
}
export declare function reportTerminal(input: ReportInput): void;
export interface JsonReport {
    lacuna: string;
    timestamp: string;
    type: 'analyze' | 'generate';
    threshold: number;
    passed: boolean;
    coverage: {
        before?: number;
        after?: number;
        lines?: number;
        functions?: number;
    };
    patchCoverage?: {
        before: number;
        after: number;
        base?: string;
    };
    filesProcessed?: number;
    testsWritten?: number;
    gaps?: Array<{
        file: string;
        uncoveredFunctions: string[];
        uncoveredLines: number[];
    }>;
    errors?: string[];
}
export declare function buildJsonReport(input: ReportInput): JsonReport;
export declare function buildMarkdownReport(input: ReportInput): string;
export declare const EXIT: {
    readonly OK: 0;
    readonly BELOW_THRESHOLD: 1;
    readonly ERROR: 2;
};
export declare function getExitCode(input: ReportInput): number;
//# sourceMappingURL=reporter.d.ts.map