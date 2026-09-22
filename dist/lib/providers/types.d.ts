export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}
export interface ModelProvider {
    generate(messages: ChatMessage[], system: string, onToken?: (token: string) => void, maxTokens?: number, temperature?: number, signal?: AbortSignal): Promise<string>;
}
export interface ProviderPreset {
    label: string;
    provider: 'anthropic' | 'openai-compatible';
    model: string;
    baseURL?: string;
    apiKeyEnv: string;
    apiKeyHint: string;
}
export declare class ModelStallError extends Error {
    readonly reason: 'first-token-timeout' | 'stream-stall';
    constructor(reason: 'first-token-timeout' | 'stream-stall', timeoutMs: number);
}
export declare class ModelRateLimitError extends Error {
    constructor(message: string);
}
export declare class ModelCancelledError extends Error {
    constructor();
}
export declare class ReasoningBudgetExhaustedError extends Error {
    readonly model: string;
    readonly reasoningChars: number;
    constructor(model: string, reasoningChars: number);
}
export declare const PRESETS: Record<string, ProviderPreset>;
//# sourceMappingURL=types.d.ts.map