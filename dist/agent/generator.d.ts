import type { LacunaConfig } from '../lib/config.js';
import type { DetectedEnvironment } from '../lib/detector.js';
import { buildFixPrompt, buildPollutionFixPrompt } from './prompts.js';
import type { FileContext } from './context.js';
import type { CoverageGap } from '../lib/coverage/types.js';
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
}
declare const TRUNCATION_RETRY_MESSAGE: string;
export declare class TestGenerator {
    private provider;
    private env;
    private rawOnToken?;
    private maxTokens;
    private history;
    private lastHypothesis;
    private failedAttempts;
    private previousCodes;
    constructor(options: GeneratorOptions);
    setTokenCallback(cb: ((token: string) => void) | undefined): void;
    resetOscillationState(): void;
    generate(context: FileContext, gap: CoverageGap, projectMemory?: string | null): Promise<string>;
    fix(args: Parameters<typeof buildFixPrompt>[0]): Promise<string>;
    fixPollution(args: Parameters<typeof buildPollutionFixPrompt>[0]): Promise<string>;
    retry(failureOutput: string): Promise<string>;
}
export { TRUNCATION_RETRY_MESSAGE };
//# sourceMappingURL=generator.d.ts.map