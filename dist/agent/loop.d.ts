import type { LacunaConfig } from '../lib/config.js';
import type { DetectedEnvironment } from '../lib/detector.js';
import type { CoverageGap } from '../lib/coverage/types.js';
import type { WorkerState } from '../lib/worker-display.js';
import { TestGenerator } from './generator.js';
export interface LoopOptions {
    config: LacunaConfig;
    env: DetectedEnvironment;
    cwd: string;
    dryRun: boolean;
    verbose: boolean;
    targetFile?: string;
    workers?: number;
    fresh?: boolean;
    log: (msg: string) => void;
}
export interface LoopResult {
    filesProcessed: number;
    testsWritten: number;
    coverageBefore: number;
    coverageAfter: number;
    hasCoverage: boolean;
    errors: string[];
}
export declare function processGap(gap: CoverageGap, options: LoopOptions, generator: TestGenerator, parallel: boolean, onStatus?: (state: WorkerState) => void, projectMemory?: string | null): Promise<{
    success: boolean;
    error?: string;
    testCode?: string;
}>;
export declare function runAgentLoop(options: LoopOptions): Promise<LoopResult>;
//# sourceMappingURL=loop.d.ts.map