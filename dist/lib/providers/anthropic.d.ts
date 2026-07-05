import type { ModelProvider, ChatMessage } from './types.js';
export declare class AnthropicProvider implements ModelProvider {
    private client;
    private model;
    constructor(model: string, apiKey: string);
    generate(messages: ChatMessage[], system: string, onToken?: (token: string) => void, maxTokens?: number, temperature?: number): Promise<string>;
}
//# sourceMappingURL=anthropic.d.ts.map