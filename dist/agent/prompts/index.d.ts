import type { DetectedEnvironment } from '../../lib/detector.js';
export declare const PATCH_MODE_LINE_THRESHOLD = 300;
export declare function detectWeakAsyncWait(code: string): string | null;
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
    localImportContents?: string | null;
    reactMajorVersion?: number | null;
    projectMemory?: string | null;
    existingTestLineCount?: number;
}): string;
export declare function buildFixPrompt(args: {
    testFile: string;
    testCode: string;
    sourceFile: string | null;
    sourceCode: string | null;
    sourceImportPath?: string | null;
    errorOutput: string;
    env: DetectedEnvironment;
    mocksCode?: string | null;
    mocksImportPath?: string | null;
    setupFileCode?: string | null;
    packageDeps?: string | null;
    tsconfigPaths?: string | null;
    typeDefinitions?: string | null;
    localImportPaths?: string[] | null;
    reactMajorVersion?: number | null;
    projectMemory?: string | null;
    existingTestLineCount?: number;
}): string;
export declare function buildPollutionFixPrompt(args: {
    pollutorFile: string;
    pollutorCode: string;
    victimFile: string;
    victimCode: string;
    victimError: string;
    env: DetectedEnvironment;
}): string;
export interface FailedAttempt {
    attemptNumber: number;
    hypothesis: string;
    failureReason: string;
}
export declare function buildRetryPrompt(failureOutput: string, failedAttempts?: FailedAttempt[], patchMode?: boolean, reactish?: boolean): string;
//# sourceMappingURL=index.d.ts.map