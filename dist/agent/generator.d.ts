import type { LacunaConfig } from '../lib/config.js';
import type { DetectedEnvironment } from '../lib/detector.js';
export { ModelStallError, ModelRateLimitError, ModelCancelledError, ReasoningBudgetExhaustedError } from '../lib/providers/types.js';
import { buildFixPrompt, buildPollutionFixPrompt } from './prompts/index.js';
import type { FileContext } from './context.js';
import type { CoverageGap } from '../lib/coverage/types.js';
export declare function resolveDebugBase(configDebug: boolean | undefined): string | null;
export declare function debugLogPattern(configDebug: boolean | undefined): string | null;
export declare function perFileDebugPath(base: string | null, filePath: string): string | null;
export declare function debugWrite(file: string | null, label: string, content: string, clear?: boolean): Promise<void>;
export declare class TruncatedOutputError extends Error {
    readonly partialCode: string;
    constructor(partialCode: string);
}
export declare class OscillationError extends Error {
    constructor();
}
export declare const OSCILLATION_ESCAPE_MESSAGE: string;
export interface GeneratorOptions {
    config: LacunaConfig;
    env: DetectedEnvironment;
    onToken?: (token: string) => void;
    cwd?: string;
}
declare const TRUNCATION_RETRY_MESSAGE: string;
export declare class TestGenerator {
    private provider;
    private env;
    private rawOnToken?;
    private rawFirstTokenCallback?;
    private abortSignal?;
    private maxTokens;
    private reasoningModel;
    private history;
    private lastHypothesis;
    private failedAttempts;
    private previousCodes;
    private lastIsPatch;
    private patchMode;
    private testLineCount;
    private reactish;
    private coveredPatterns;
    private sourceResolved;
    private readonly debugFile;
    private activeDebugFile;
    constructor(options: GeneratorOptions);
    setTokenCallback(cb: ((token: string) => void) | undefined): void;
    setAbortSignal(signal: AbortSignal | undefined): void;
    setEnv(env: DetectedEnvironment): void;
    setFirstTokenCallback(cb: (() => void) | undefined): void;
    private buildOnToken;
    resetOscillationState(): void;
    get isPatch(): boolean;
    setCoveredPatterns(patterns: string[]): void;
    setPatchMode(v: boolean): void;
    markAsReasoningModel(): void;
    generate(context: FileContext, gap: CoverageGap, projectMemory?: string | null): Promise<string>;
    fix(args: Parameters<typeof buildFixPrompt>[0]): Promise<string>;
    fixPollution(args: Parameters<typeof buildPollutionFixPrompt>[0]): Promise<string>;
    retry(failureOutput: string, rawFailureOutput?: string): Promise<string>;
}
export { TRUNCATION_RETRY_MESSAGE };
//# sourceMappingURL=generator.d.ts.map