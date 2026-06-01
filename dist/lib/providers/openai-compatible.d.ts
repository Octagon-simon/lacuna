import type { ModelProvider, ChatMessage } from './types.js';
export declare class OpenAICompatibleProvider implements ModelProvider {
    private client;
    private model;
    constructor(model: string, options: {
        baseURL: string;
        apiKey?: string;
    });
    generate(messages: ChatMessage[], system: string, onToken?: (token: string) => void, maxTokens?: number, temperature?: number): Promise<string>;
}
//# sourceMappingURL=openai-compatible.d.ts.map