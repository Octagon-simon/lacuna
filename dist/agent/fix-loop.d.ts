import type { LacunaConfig } from '../lib/config.js';
import type { DetectedEnvironment } from '../lib/detector.js';
export interface FixOptions {
    config: LacunaConfig;
    env: DetectedEnvironment;
    cwd: string;
    dryRun: boolean;
    verbose: boolean;
    targetFile?: string;
    workers?: number;
    fresh?: boolean;
    regenerateOnFailure?: boolean;
    fixPolluters?: boolean;
    log: (msg: string) => void;
}
export interface FixResult {
    filesProcessed: number;
    filesFixed: number;
    filesAlreadyPassing: number;
    pollutersFixed: number;
    victimsRegenerated: number;
    errors: string[];
}
export declare function runFixLoop(options: FixOptions): Promise<FixResult>;
//# sourceMappingURL=fix-loop.d.ts.map