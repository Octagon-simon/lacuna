import type { DetectedEnvironment } from './detector.js';
export declare function typeCheckFile(absTestPath: string, cwd: string, env: Pick<DetectedEnvironment, 'language'>): Promise<string | null>;
export declare function findTestFilesWithTypeErrors(testFiles: string[], cwd: string, env: Pick<DetectedEnvironment, 'language'>): Promise<string[]>;
//# sourceMappingURL=typecheck.d.ts.map