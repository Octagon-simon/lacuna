import type { DetectedEnvironment } from '../lib/detector.js';
export declare function buildSystemPrompt(env: DetectedEnvironment): string;
export declare function buildGeneratePrompt(args: {
    sourceFile: string;
    sourceCode: string;
    existingTestCode: string | null;
    uncoveredFunctions: string[];
    uncoveredLines: number[];
    env: DetectedEnvironment;
    sourceImportPath?: string | null;
    mocksCode?: string | null;
    mocksImportPath?: string | null;
    setupFileCode?: string | null;
    packageDeps?: string | null;
    tsconfigPaths?: string | null;
    typeDefinitions?: string | null;
    localImportPaths?: string[] | null;
    reactMajorVersion?: number | null;
    projectMemory?: string | null;
}): string;
export declare function buildFixPrompt(args: {
    testFile: string;
    testCode: string;
    sourceFile: string | null;
    sourceCode: string | null;
    sourceImportPath?: string | null;
    errorOutput: string;
    mocksCode?: string | null;
    mocksImportPath?: string | null;
    setupFileCode?: string | null;
    packageDeps?: string | null;
    tsconfigPaths?: string | null;
    typeDefinitions?: string | null;
    localImportPaths?: string[] | null;
    reactMajorVersion?: number | null;
    projectMemory?: string | null;
}): string;
export interface FailedAttempt {
    attemptNumber: number;
    hypothesis: string;
    failureReason: string;
}
export declare function buildRetryPrompt(failureOutput: string, failedAttempts?: FailedAttempt[]): string;
//# sourceMappingURL=prompts.d.ts.map