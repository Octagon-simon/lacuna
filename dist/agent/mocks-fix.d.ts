import type { LacunaConfig } from '../lib/config.js';
import type { DetectedEnvironment } from '../lib/detector.js';
export declare function findDownstreamMockSymptoms(cwd: string, env: Pick<DetectedEnvironment, 'language'>, mocksFiles: string[]): Promise<Map<string, string[]>>;
export interface MocksFixResult {
    checked: string[];
    fixed: string[];
    stillBroken: string[];
}
export declare function fixMocksFilesUpfront(config: LacunaConfig, env: Pick<DetectedEnvironment, 'language' | 'testRunner'>, cwd: string, options?: {
    dryRun?: boolean;
    log?: (msg: string) => void;
}): Promise<MocksFixResult>;
//# sourceMappingURL=mocks-fix.d.ts.map