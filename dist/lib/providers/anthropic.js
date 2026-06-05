import Anthropic from '@anthropic-ai/sdk';
export class AnthropicProvider {
    client;
    model;
    constructor(model, apiKey) {
        this.client = new Anthropic({ apiKey });
        this.model = model;
    }
    async generate(messages, system, onToken, maxTokens = 16000, temperature) {
        let content = '';
        try {
            const stream = this.client.messages.stream({
                model: this.model,
                max_tokens: maxTokens,
                stop_sequences: ['</code_output>'],
                ...(temperature !== undefined ? { temperature } : {}),
                system,
                messages,
            });
            for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    content += event.delta.text;
                    onToken?.(event.delta.text);
                }
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/prompt is too long|max_tokens.*exceed|too many tokens/i.test(msg)) {
                throw new Error(`${this.model} rejected the request — prompt too large.\n` +
                    `The assembled context (source file + test file + type definitions + mocks) exceeds the model's input limit.\n` +
                    `Try: lower maxTokens in .lacuna.json, or use --file to target a smaller source file.`);
            }
            if (/rate.?limit|429|output tokens per minute|request.*exceed.*limit/i.test(msg)) {
                throw new Error(`Anthropic rate limit hit — your account has a low output-token-per-minute cap (Tier 1: 8k TPM).\n` +
                    `Options:\n` +
                    `  1. Lower maxTokens in .lacuna.json (e.g. "maxTokens": 4000) to reduce output per request.\n` +
                    `  2. Use --workers 1 (default) to avoid parallel requests consuming your quota.\n` +
                    `  3. Switch to a cheaper/higher-limit provider: lacuna generate -m deepseek\n` +
                    `  4. Upgrade your Anthropic account tier: https://console.anthropic.com/settings/billing`);
            }
            throw err;
        }
        return content.trim();
    }
}
//# sourceMappingURL=anthropic.js.map