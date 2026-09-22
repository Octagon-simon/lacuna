import type { DetectedEnvironment } from './detector.js';
export declare const TYPECHECK_INCONCLUSIVE = "TypeScript check did not complete (timed out or crashed before emitting diagnostics) \u2014 could not verify.";
export declare function typeCheckFile(absTestPath: string, cwd: string, env: Pick<DetectedEnvironment, 'language'>): Promise<string | null>;
export declare function findTestFilesWithTypeErrors(testFiles: string[], cwd: string, env: Pick<DetectedEnvironment, 'language'>): Promise<string[]>;
//# sourceMappingURL=typecheck.d.ts.map