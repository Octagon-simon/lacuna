import { gunzipSync } from 'node:zlib';
import OpenAI from 'openai';
import { ModelStallError, ModelRateLimitError, ModelCancelledError, ReasoningBudgetExhaustedError } from './types.js';
const FIRST_TOKEN_TIMEOUT_MS = 30_000;
const STALL_TIMEOUT_MS = 60_000;
// Local backends (LM Studio, Ollama) process the prompt on the user's own CPU/GPU with a
// single inference slot — ingesting a large agentic prompt (system + source + test context)
// can easily take well past 30s before the first token streams back, especially for
// reasoning models that think before answering. The hosted-API timeouts above starved local
// models of the time they need and made every request look "stuck", so local gets more room.
// Small distilled reasoning models (e.g. DeepSeek-R1-Qwen3-8B) are known to think for many
// thousands of tokens — sometimes tens of thousands — before answering, so both windows are
// generous: 10 minutes of total silence (across content AND reasoning_content) before giving up.
const LOCAL_FIRST_TOKEN_TIMEOUT_MS = 600_000;
const LOCAL_STALL_TIMEOUT_MS = 600_000;
// TEMPORARY diagnostic (LACUNA_DIAGNOSE_TOKENS=1) — added to confirm/rule out a specific
// hypothesis: a model returning an empty `content` string with NO error thrown (as observed on a
// real project using deepseek-v4-flash from retry 2 onward) could mean the model burned its
// entire max_tokens budget on `reasoning_content` and never reached real `content` — the same
// failure mode isReasoningModel()/estimateMaxTokens (generator.ts) already exist to prevent, but
// only for models whose NAME matches a known reasoning pattern. Logs one line per call to stderr
// so it doesn't interleave with the WorkerDisplay TUI's stdout redraws; remove once confirmed.
const DIAGNOSE_TOKENS = process.env.LACUNA_DIAGNOSE_TOKENS === '1';
export class OpenAICompatibleProvider {
    client;
    model;
    firstTokenTimeoutMs;
    stallTimeoutMs;
    constructor(model, options) {
        this.firstTokenTimeoutMs = options.isLocal ? LOCAL_FIRST_TOKEN_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS;
        this.stallTimeoutMs = options.isLocal ? LOCAL_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS;
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
    async generate(messages, system, onToken, maxTokens = 16000, temperature, signal, _attempt = 0) {
        let content = '';
        let reasoningChars = 0;
        let contentChars = 0;
        let lastFinishReason = null;
        // Already cancelled before we even start — don't open a request. (Defensive: the loop's
        // per-attempt check normally returns before calling generate.)
        if (signal?.aborted)
            throw new ModelCancelledError();
        const controller = new AbortController();
        // Bridge an external cancel into our internal controller so the in-flight fetch aborts. Reason
        // 'user-cancel' distinguishes it from the timeout aborts below.
        if (signal)
            signal.addEventListener('abort', () => controller.abort('user-cancel'), { once: true });
        let firstTokenReceived = false;
        let lastTokenAt = 0;
        const firstTokenTimer = setTimeout(() => {
            controller.abort('first-token-timeout');
        }, this.firstTokenTimeoutMs);
        const stallInterval = setInterval(() => {
            if (firstTokenReceived && Date.now() - lastTokenAt > this.stallTimeoutMs) {
                controller.abort('stream-stall');
            }
        }, 5_000);
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
            }, { signal: controller.signal });
            for await (const chunk of stream) {
                // Reasoning models (DeepSeek R1 and compatible local servers, mirroring DeepSeek's own
                // API) stream their <think> phase through a separate `reasoning_content` delta field,
                // not `content`. If we only watch `content`, the entire thinking phase looks like dead
                // air to the stall/first-token timers even though the model is actively generating —
                // LM Studio's own token counter keeps climbing while our client silently times out.
                // Treat either field as proof of life; only `content` feeds the parsed result.
                const delta = chunk.choices[0]?.delta;
                const token = delta?.content ?? '';
                const reasoningToken = delta?.reasoning_content ?? '';
                if (chunk.choices[0]?.finish_reason)
                    lastFinishReason = chunk.choices[0].finish_reason;
                if (token || reasoningToken) {
                    if (!firstTokenReceived) {
                        firstTokenReceived = true;
                        clearTimeout(firstTokenTimer);
                    }
                    lastTokenAt = Date.now();
                }
                if (reasoningToken)
                    reasoningChars += reasoningToken.length;
                if (token) {
                    content += token;
                    contentChars += token.length;
                    onToken?.(token);
                }
            }
        }
        catch (err) {
            if (controller.signal.aborted) {
                clearTimeout(firstTokenTimer);
                clearInterval(stallInterval);
                // User cancel (external signal) — never retried, unlike a timeout stall.
                if (controller.signal.reason === 'user-cancel')
                    throw new ModelCancelledError();
                const reason = controller.signal.reason === 'first-token-timeout' ? 'first-token-timeout' : 'stream-stall';
                if (DIAGNOSE_TOKENS) {
                    console.error(`[lacuna-diagnose] model=${this.model} maxTokens=${maxTokens} ABORTED(${reason}) reasoningChars=${reasoningChars} contentChars=${contentChars} finishReason=${lastFinishReason}`);
                }
                throw new ModelStallError(reason, reason === 'first-token-timeout' ? this.firstTokenTimeoutMs : this.stallTimeoutMs);
            }
            if (err != null && typeof err === 'object' && 'status' in err) {
                const e = err;
                const body = e.error?.message
                    ? `${e.error.message}${e.error.type ? ` (type: ${e.error.type})` : ''}${e.error.code ? ` [${e.error.code}]` : ''}`
                    : (e.message ?? 'no message');
                if (/tokens to keep.*greater than.*context length|context length.*exceed|context.*window.*exceed/i.test(body)) {
                    throw new Error(`${this.model} rejected the request — the prompt doesn't fit in the model's loaded context window.\n` +
                        `Local servers (LM Studio/Ollama) reserve context for the PROMPT plus maxTokens together, so a\n` +
                        `large maxTokens shrinks the room left for input.\n` +
                        `Options:\n` +
                        `  1. In LM Studio, reload this model with a larger Context Length (Model Settings before loading).\n` +
                        `  2. Lower maxTokens in .lacuna.json (e.g. "maxTokens": 4000) to leave more room for the prompt.\n` +
                        `  3. Use --file to target a smaller source file.`);
                }
                if (e.status === 429 || /rate.?limit|output tokens per minute|request.*exceed.*limit/i.test(body)) {
                    throw new ModelRateLimitError(`Rate limit hit (HTTP 429) — ${this.model} is rejecting requests due to quota.\n` +
                        `Options:\n` +
                        `  1. Lower maxTokens in .lacuna.json (e.g. "maxTokens": 4000) to reduce output per request.\n` +
                        `  2. Use --workers 1 to avoid parallel requests consuming your quota.\n` +
                        `  3. Try a different model: lacuna generate -m deepseek\n` +
                        `  4. Check your provider's usage dashboard and upgrade if needed.`);
                }
                // Capacity/overload rejections — not a quota problem, a "too many requests RIGHT NOW"
                // problem. Providers signal this differently: DeepSeek returns 503 with a message like
                // "concurrency is too high" / "server is busy"; others return 502/504 under load. Worth
                // a short backoff-and-retry (ModelRateLimitError) rather than failing the file outright,
                // since the same request often succeeds moments later once other in-flight requests clear.
                if (e.status === 503 || e.status === 502 || e.status === 504 || /overload|too many concurrent|concurrency.*(high|too)|server.*busy|try again later/i.test(body)) {
                    throw new ModelRateLimitError(`${this.model} is overloaded (HTTP ${e.status ?? '?'}): ${body}\n` +
                        `This is the provider rejecting requests under load, not a bug in your test — lacuna will back off and retry.\n` +
                        `If this keeps happening: lower --workers, or try again later.`);
                }
                throw new Error(`${this.model} API error (HTTP ${e.status ?? '?'}): ${body}`);
            }
            // Transient network termination (ECONNRESET, stream aborted, "terminated") —
            // common when many parallel workers flood a single API endpoint. Retry once
            // with a short backoff before surfacing the error.
            const msg = err instanceof Error ? err.message : String(err);
            if (_attempt === 0 && /terminated|ECONNRESET|ECONNREFUSED|socket hang up|network error/i.test(msg)) {
                clearTimeout(firstTokenTimer);
                clearInterval(stallInterval);
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
                return this.generate(messages, system, onToken, maxTokens, temperature, signal, 1);
            }
            throw err;
        }
        finally {
            clearTimeout(firstTokenTimer);
            clearInterval(stallInterval);
        }
        if (DIAGNOSE_TOKENS) {
            console.error(`[lacuna-diagnose] model=${this.model} maxTokens=${maxTokens} reasoningChars=${reasoningChars} contentChars=${contentChars} finishReason=${lastFinishReason} resultEmpty=${content.trim().length === 0}`);
        }
        // The model streamed reasoning_content but never reached real content — it burned the whole
        // max_tokens budget thinking. A silent empty return here reads identically to "the model said
        // nothing" further up the stack (TruncatedOutputError's code-based heuristics see an empty
        // string either way), so the retry loop just re-sends the same too-small budget forever.
        // Surfacing it as its own error lets the caller widen the budget instead of repeating the
        // same failure — see generator.ts's markAsReasoningModel().
        if (content.trim().length === 0 && reasoningChars > 0) {
            throw new ReasoningBudgetExhaustedError(this.model, reasoningChars);
        }
        return content.trim();
    }
}
//# sourceMappingURL=openai-compatible.js.map