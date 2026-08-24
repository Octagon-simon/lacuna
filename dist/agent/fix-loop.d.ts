import type { LacunaConfig } from '../lib/config.js';
import type { DetectedEnvironment } from '../lib/detector.js';
import type { RunResult } from '../lib/runner.js';
import type { WorkerState } from '../lib/worker-display.js';
import type { LacunaEventHandler } from '../lib/events.js';
import { TestGenerator } from './generator.js';
export interface FixOptions {
    config: LacunaConfig;
    env: DetectedEnvironment;
    cwd: string;
    dryRun: boolean;
    verbose: boolean;
    targetFile?: string;
    scopeDir?: string;
    workers?: number;
    fresh?: boolean;
    regenerateOnFailure?: boolean;
    fixPolluters?: boolean;
    types?: boolean;
    log: (msg: string) => void;
    onStatus?: (state: WorkerState) => void;
    onEvent?: LacunaEventHandler;
    shouldContinue?: () => boolean;
    abortSignal?: AbortSignal;
}
export interface FixResult {
    filesProcessed: number;
    filesFixed: number;
    filesAlreadyPassing: number;
    pollutersFixed: number;
    victimsRegenerated: number;
    errors: string[];
}
export declare class DiscoverFailingError extends Error {
    constructor(message: string);
}
/**
 * Discover the failing/erroring test files under an optional scope directory — the SAME suite run
 * and parsing `runFixLoop` does internally. An embedder (the VS Code extension) uses this to show
 * an accurate confirmation ("N failing test file(s)") BEFORE starting a folder-fix, and to skip
 * cleanly when nothing is failing. `allPassing` is true when the suite is green (failing is empty).
 * Returns absolute paths, filtered to the scope. Throws DiscoverFailingError on a config/validation
 * failure or timeout (the suite couldn't tell us what's failing).
 */
export declare function discoverFailingTests(config: LacunaConfig, env: DetectedEnvironment, cwd: string, scopeDir?: string, onLine?: (line: string) => void, signal?: AbortSignal): Promise<{
    failing: string[];
    allPassing: boolean;
}>;
export declare function extractRelativeImportSpecifiers(testCode: string): string[];
export declare function findSourceFile(testFilePath: string, cwd: string, configSourceDirs?: string | string[], testCode?: string): Promise<string | null>;
export declare function fixFile(testFilePath: string, options: FixOptions, generator: TestGenerator, onStatus?: (state: WorkerState) => void, projectMemory?: string | null, precomputedFirstRun?: RunResult): Promise<{
    success: boolean;
    skipped?: boolean;
    error?: string;
    typeOnly?: boolean;
    baselinePassCount?: number;
    environmentLimited?: boolean;
}>;
export declare function runFixLoop(options: FixOptions): Promise<FixResult>;
//# sourceMappingURL=fix-loop.d.ts.map