import type { DetectedEnvironment } from '../lib/detector.js';
import type { LacunaConfig } from '../lib/config.js';
export declare class ProjectMemory {
    private samples;
    private observations;
    initialize(cwd: string, _env: DetectedEnvironment, config: LacunaConfig): Promise<void>;
    recordSuccess(testFile: string, testCode: string): void;
    toPromptSection(): string | null;
}
//# sourceMappingURL=project-memory.d.ts.map