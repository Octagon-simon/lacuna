import type { LacunaConfig } from '../lib/config.js';
import type { DetectedEnvironment } from '../lib/detector.js';
import type { CoverageGap } from '../lib/coverage/types.js';
import type { WorkerState } from '../lib/worker-display.js';
import type { LacunaEventHandler } from '../lib/events.js';
import { TestGenerator } from './generator.js';
export interface LoopOptions {
    config: LacunaConfig;
    env: DetectedEnvironment;
    cwd: string;
    dryRun: boolean;
    verbose: boolean;
    targetFile?: string;
    scopeDir?: string;
    improve?: boolean;
    diffRef?: string;
    workers?: number;
    fresh?: boolean;
    fixOnFailure?: boolean;
    log: (msg: string) => void;
    onStatus?: (state: WorkerState) => void;
    onEvent?: LacunaEventHandler;
    shouldContinue?: () => boolean;
    abortSignal?: AbortSignal;
}
export interface LoopResult {
    filesProcessed: number;
    testsWritten: number;
    coverageBefore: number;
    coverageAfter: number;
    hasCoverage: boolean;
    patchCoverageBefore?: number;
    patchCoverageAfter?: number;
    diffBase?: string;
    errors: string[];
    fixHandoffs?: number;
    fixHandoffRecovered?: number;
}
export declare function processGap(gap: CoverageGap, options: LoopOptions, generator: TestGenerator, parallel: boolean, onStatus?: (state: WorkerState) => void, projectMemory?: string | null, overrideTestFile?: string): Promise<{
    success: boolean;
    error?: string;
    testCode?: string;
    fixHandoffAttempted?: boolean;
}>;
export declare function runAgentLoop(options: LoopOptions): Promise<LoopResult>;
//# sourceMappingURL=loop.d.ts.map