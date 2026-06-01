import type { LacunaConfig } from '../lib/config.js';
import type { DetectedEnvironment } from '../lib/detector.js';
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
export declare function runAgentLoop(options: LoopOptions): Promise<LoopResult>;
//# sourceMappingURL=loop.d.ts.map