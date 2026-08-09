import Anthropic from '@anthropic-ai/sdk';
import { ModelStallError, ModelRateLimitError, ModelCancelledError } from './types.js';
const FIRST_TOKEN_TIMEOUT_MS = 30_000;
const STALL_TIMEOUT_MS = 60_000;
export class AnthropicProvider {
    client;
    model;
    constructor(model, apiKey) {
        this.client = new Anthropic({ apiKey });
        this.model = model;
    }
    async generate(messages, system, onToken, maxTokens = 16000, temperature, signal) {
        let content = '';
        // Mark the first user message as cacheable — it holds the large initial context
        // (source file, existing test, mocks, type definitions) that stays identical
        // across all retries for a given file. Cache hits cost 10% of normal input price.
        const anthropicMessages = messages.map((msg, i) => {
            if (i === 0 && msg.role === 'user') {
                return {
                    role: 'user',
                    content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }],
                };
            }
            return { role: msg.role, content: msg.content };
        });
        if (signal?.aborted)
            throw new ModelCancelledError();
        const controller = new AbortController();
        // Bridge an external cancel (embedder "Stop") into our internal controller — see the
        // openai-compatible provider's identical bridge.
        if (signal)
            signal.addEventListener('abort', () => controller.abort('user-cancel'), { once: true });
        let firstTokenReceived = false;
        let lastTokenAt = 0;
        const firstTokenTimer = setTimeout(() => {
            controller.abort('first-token-timeout');
        }, FIRST_TOKEN_TIMEOUT_MS);
        const stallInterval = setInterval(() => {
            if (firstTokenReceived && Date.now() - lastTokenAt > STALL_TIMEOUT_MS) {
                controller.abort('stream-stall');
            }
        }, 5_000);
        try {
            const stream = this.client.messages.stream({
                model: this.model,
                max_tokens: maxTokens,
                stop_sequences: ['</code_output>'],
                ...(temperature !== undefined ? { temperature } : {}),
                // Cache the system prompt — same ~3000 tokens sent on every generate/fix/retry
                // call and across all parallel workers. Without caching each call pays full price.
                system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
                messages: anthropicMessages,
            }, { signal: controller.signal });
            for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    if (!firstTokenReceived) {
                        firstTokenReceived = true;
                        clearTimeout(firstTokenTimer);
                        lastTokenAt = Date.now();
                    }
                    else {
                        lastTokenAt = Date.now();
                    }
                    content += event.delta.text;
                    onToken?.(event.delta.text);
                }
            }
        }
        catch (err) {
            if (controller.signal.aborted) {
                if (controller.signal.reason === 'user-cancel')
                    throw new ModelCancelledError();
                const reason = controller.signal.reason === 'first-token-timeout' ? 'first-token-timeout' : 'stream-stall';
                throw new ModelStallError(reason, reason === 'first-token-timeout' ? FIRST_TOKEN_TIMEOUT_MS : STALL_TIMEOUT_MS);
            }
            const msg = err instanceof Error ? err.message : String(err);
            if (/prompt is too long|max_tokens.*exceed|too many tokens/i.test(msg)) {
                throw new Error(`${this.model} rejected the request — prompt too large.\n` +
                    `The assembled context (source file + test file + type definitions + mocks) exceeds the model's input limit.\n` +
                    `Try: lower maxTokens in .lacuna.json, or use --file to target a smaller source file.`);
            }
            if (/rate.?limit|429|output tokens per minute|request.*exceed.*limit/i.test(msg)) {
                throw new ModelRateLimitError(`Anthropic rate limit hit — your account has a low output-token-per-minute cap (Tier 1: 8k TPM).\n` +
                    `Options:\n` +
                    `  1. Lower maxTokens in .lacuna.json (e.g. "maxTokens": 4000) to reduce output per request.\n` +
                    `  2. Use --workers 1 (default) to avoid parallel requests consuming your quota.\n` +
                    `  3. Switch to a cheaper/higher-limit provider: lacuna generate -m deepseek\n` +
                    `  4. Upgrade your Anthropic account tier: https://console.anthropic.com/settings/billing`);
            }
            // Anthropic returns 529 "Overloaded" when their infrastructure is at capacity — a
            // transient "too much load right now" signal, worth a short backoff-and-retry rather
            // than failing the file outright.
            if (/overloaded|529/i.test(msg)) {
                throw new ModelRateLimitError(`${this.model} is overloaded: ${msg}\nlacuna will back off and retry.`);
            }
            throw err;
        }
        finally {
            clearTimeout(firstTokenTimer);
            clearInterval(stallInterval);
        }
        return content.trim();
    }
}
//# sourceMappingURL=anthropic.js.map