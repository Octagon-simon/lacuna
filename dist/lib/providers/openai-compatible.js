import { gunzipSync } from 'node:zlib';
import OpenAI from 'openai';
export class OpenAICompatibleProvider {
    client;
    model;
    constructor(model, options) {
        this.client = new OpenAI({
            apiKey: options.apiKey || 'no-key-required',
            baseURL: options.baseURL,
            // For error responses, manually decompress gzip and strip the
            // content-encoding header so the SDK always receives a plain-text body.
            // Some providers (e.g. DeepSeek on GCP) return gzip-encoded 4xx bodies
            // but ignore Accept-Encoding: identity, making error messages unreadable.
            fetch: async (url, init) => {
                const response = await globalThis.fetch(url, init);
                if (response.ok)
                    return response;
                // Decode error response body regardless of compression.
                // Some providers (e.g. Gemini) set content-encoding: gzip but don't actually
                // gzip the body; we try gunzip and fall back to raw UTF-8 if it fails.
                const encoding = response.headers.get('content-encoding') ?? '';
                const raw = Buffer.from(await response.arrayBuffer());
                let bodyText;
                try {
                    bodyText = encoding === 'gzip' ? gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
                }
                catch {
                    bodyText = raw.toString('utf-8');
                }
                // Normalize non-OpenAI error shapes to {error:{message,type,code}} so the
                // SDK can extract the message. Google's format is [{error:{code,message,status}}].
                let normalized = bodyText;
                try {
                    const parsed = JSON.parse(bodyText);
                    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
                    const err = obj?.['error'];
                    if (err) {
                        normalized = JSON.stringify({
                            error: {
                                message: String(err['message'] ?? err['code'] ?? 'unknown error'),
                                type: String(err['status'] ?? err['type'] ?? 'api_error'),
                                code: String(err['code'] ?? err['reason'] ?? ''),
                            },
                        });
                    }
                }
                catch {
                    // not JSON — leave bodyText as-is; SDK will surface it in e.message
                }
                const newHeaders = new Headers(response.headers);
                newHeaders.delete('content-encoding');
                newHeaders.set('content-length', String(Buffer.byteLength(normalized, 'utf-8')));
                return new Response(normalized, { status: response.status, statusText: response.statusText, headers: newHeaders });
            },
        });
        this.model = model;
    }
    async generate(messages, system, onToken, maxTokens = 16000, temperature) {
        let content = '';
        try {
            const stream = await this.client.chat.completions.create({
                model: this.model,
                max_tokens: maxTokens,
                stop: ['</code_output>'],
                ...(temperature !== undefined ? { temperature } : {}),
                stream: true,
                messages: [
                    { role: 'system', content: system },
                    ...messages.map((m) => ({ role: m.role, content: m.content })),
                ],
            });
            for await (const chunk of stream) {
                const token = chunk.choices[0]?.delta?.content ?? '';
                if (token) {
                    content += token;
                    onToken?.(token);
                }
            }
        }
        catch (err) {
            if (err != null && typeof err === 'object' && 'status' in err) {
                const e = err;
                const body = e.error?.message
                    ? `${e.error.message}${e.error.type ? ` (type: ${e.error.type})` : ''}${e.error.code ? ` [${e.error.code}]` : ''}`
                    : (e.message ?? 'no message');
                if (e.status === 429 || /rate.?limit|output tokens per minute|request.*exceed.*limit/i.test(body)) {
                    throw new Error(`Rate limit hit (HTTP 429) — ${this.model} is rejecting requests due to quota.\n` +
                        `Options:\n` +
                        `  1. Lower maxTokens in .lacuna.json (e.g. "maxTokens": 4000) to reduce output per request.\n` +
                        `  2. Use --workers 1 to avoid parallel requests consuming your quota.\n` +
                        `  3. Try a different model: lacuna generate -m deepseek\n` +
                        `  4. Check your provider's usage dashboard and upgrade if needed.`);
                }
                throw new Error(`${this.model} API error (HTTP ${e.status ?? '?'}): ${body}`);
            }
            throw err;
        }
        return content.trim();
    }
}
//# sourceMappingURL=openai-compatible.js.map