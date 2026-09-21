import type { DetectedEnvironment, TestRunner } from './detector.js';
export interface TestRoot {
    cwd: string;
    npmTest: boolean;
    runner: TestRunner;
}
export declare function findTestRoot(fromDir: string, repoRoot: string, defaultRunner: TestRunner): Promise<TestRoot>;
export interface ResolvedRun {
    command: string;
    cwd: string;
}
export declare function resolveEnvForFile(env: DetectedEnvironment, absFile: string, repoRoot: string): Promise<DetectedEnvironment>;
export declare function resolveEnvForDir(env: DetectedEnvironment, absDir: string, repoRoot: string): Promise<DetectedEnvironment>;
export declare function resolveFileTestRun(env: DetectedEnvironment, absFile: string, repoRoot: string): Promise<ResolvedRun>;
export declare function resolveScopeTestRun(env: DetectedEnvironment, absDir: string, repoRoot: string): Promise<ResolvedRun>;
export declare function resolveIncrementalCoverageRun(env: DetectedEnvironment, absTestFile: string, absSourceFile: string, repoRoot: string, outDir: string): Promise<ResolvedRun | null>;
export declare function resolveMultiFileTestRun(env: DetectedEnvironment, absFiles: string[], repoRoot: string): Promise<ResolvedRun>;
//# sourceMappingURL=test-run.d.ts.map