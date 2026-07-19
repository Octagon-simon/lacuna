import type { ModelProvider, ChatMessage } from './types.js';
export declare class OpenAICompatibleProvider implements ModelProvider {
    private client;
    private model;
    private firstTokenTimeoutMs;
    private stallTimeoutMs;
    constructor(model: string, options: {
        baseURL: string;
        apiKey?: string;
        isLocal?: boolean;
    });
    generate(messages: ChatMessage[], system: string, onToken?: (token: string) => void, maxTokens?: number, temperature?: number, _attempt?: number): Promise<string>;
}
//# sourceMappingURL=openai-compatible.d.ts.map