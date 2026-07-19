import { gunzipSync } from 'node:zlib'
import OpenAI from 'openai'
import type { ModelProvider, ChatMessage } from './types.js'
import { ModelStallError } from './types.js'

const FIRST_TOKEN_TIMEOUT_MS = 30_000
const STALL_TIMEOUT_MS = 60_000

// Local backends (LM Studio, Ollama) process the prompt on the user's own CPU/GPU with a
// single inference slot — ingesting a large agentic prompt (system + source + test context)
// can easily take well past 30s before the first token streams back, especially for
// reasoning models that think before answering. The hosted-API timeouts above starved local
// models of the time they need and made every request look "stuck", so local gets more room.
// Small distilled reasoning models (e.g. DeepSeek-R1-Qwen3-8B) are known to think for many
// thousands of tokens — sometimes tens of thousands — before answering, so both windows are
// generous: 10 minutes of total silence (across content AND reasoning_content) before giving up.
const LOCAL_FIRST_TOKEN_TIMEOUT_MS = 600_000
const LOCAL_STALL_TIMEOUT_MS = 600_000

export class OpenAICompatibleProvider implements ModelProvider {
  private client: OpenAI
  private model: string
  private firstTokenTimeoutMs: number
  private stallTimeoutMs: number

  constructor(model: string, options: { baseURL: string; apiKey?: string; isLocal?: boolean }) {
    this.firstTokenTimeoutMs = options.isLocal ? LOCAL_FIRST_TOKEN_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS
    this.stallTimeoutMs = options.isLocal ? LOCAL_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS
    this.client = new OpenAI({
      apiKey: options.apiKey || 'no-key-required',
      baseURL: options.baseURL,
      // For error responses, manually decompress gzip and strip the
      // content-encoding header so the SDK always receives a plain-text body.
      // Some providers (e.g. DeepSeek on GCP) return gzip-encoded 4xx bodies
      // but ignore Accept-Encoding: identity, making error messages unreadable.
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init)
        if (response.ok) return response

        // Decode error response body regardless of compression.
        // Some providers (e.g. Gemini) set content-encoding: gzip but don't actually
        // gzip the body; we try gunzip and fall back to raw UTF-8 if it fails.
        const encoding = response.headers.get('content-encoding') ?? ''
        const raw = Buffer.from(await response.arrayBuffer())
        let bodyText: string
        try {
          bodyText = encoding === 'gzip' ? gunzipSync(raw).toString('utf-8') : raw.toString('utf-8')
        } catch {
          bodyText = raw.toString('utf-8')
        }

        // Normalize non-OpenAI error shapes to {error:{message,type,code}} so the
        // SDK can extract the message. Google's format is [{error:{code,message,status}}].
        let normalized = bodyText
        try {
          const parsed: unknown = JSON.parse(bodyText)
          const obj = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed
          const err = (obj as Record<string, unknown> | null)?.['error'] as Record<string, unknown> | undefined
          if (err) {
            normalized = JSON.stringify({
              error: {
                message: String(err['message'] ?? err['code'] ?? 'unknown error'),
                type: String(err['status'] ?? err['type'] ?? 'api_error'),
                code: String(err['code'] ?? err['reason'] ?? ''),
              },
            })
          }
        } catch {
          // not JSON — leave bodyText as-is; SDK will surface it in e.message
        }

        const newHeaders = new Headers(response.headers)
        newHeaders.delete('content-encoding')
        newHeaders.set('content-length', String(Buffer.byteLength(normalized, 'utf-8')))
        return new Response(normalized, { status: response.status, statusText: response.statusText, headers: newHeaders })
      },
    })
    this.model = model
  }

  async generate(
    messages: ChatMessage[],
    system: string,
    onToken?: (token: string) => void,
    maxTokens = 16000,
    temperature?: number,
    _attempt = 0,           // internal retry counter for transient network errors
  ): Promise<string> {
    let content = ''

    const controller = new AbortController()
    let firstTokenReceived = false
    let lastTokenAt = 0

    const firstTokenTimer = setTimeout(() => {
      controller.abort('first-token-timeout')
    }, this.firstTokenTimeoutMs)

    const stallInterval = setInterval(() => {
      if (firstTokenReceived && Date.now() - lastTokenAt > this.stallTimeoutMs) {
        controller.abort('stream-stall')
      }
    }, 5_000)

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          max_tokens: maxTokens,
          stop: ['</code_output>'],
          ...(temperature !== undefined ? { temperature } : {}),
          stream: true,
          messages: [
            { role: 'system', content: system },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        },
        { signal: controller.signal },
      )

      for await (const chunk of stream) {
        // Reasoning models (DeepSeek R1 and compatible local servers, mirroring DeepSeek's own
        // API) stream their <think> phase through a separate `reasoning_content` delta field,
        // not `content`. If we only watch `content`, the entire thinking phase looks like dead
        // air to the stall/first-token timers even though the model is actively generating —
        // LM Studio's own token counter keeps climbing while our client silently times out.
        // Treat either field as proof of life; only `content` feeds the parsed result.
        const delta = chunk.choices[0]?.delta as { content?: string | null; reasoning_content?: string | null } | undefined
        const token = delta?.content ?? ''
        const reasoningToken = delta?.reasoning_content ?? ''
        if (token || reasoningToken) {
          if (!firstTokenReceived) {
            firstTokenReceived = true
            clearTimeout(firstTokenTimer)
          }
          lastTokenAt = Date.now()
        }
        if (token) {
          content += token
          onToken?.(token)
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        clearTimeout(firstTokenTimer)
        clearInterval(stallInterval)
        const reason = (controller.signal.reason as string) === 'first-token-timeout' ? 'first-token-timeout' : 'stream-stall'
        throw new ModelStallError(reason, reason === 'first-token-timeout' ? this.firstTokenTimeoutMs : this.stallTimeoutMs)
      }
      if (err != null && typeof err === 'object' && 'status' in err) {
        const e = err as { status?: number; message?: string; error?: { message?: string; type?: string; code?: string } }
        const body = e.error?.message
          ? `${e.error.message}${e.error.type ? ` (type: ${e.error.type})` : ''}${e.error.code ? ` [${e.error.code}]` : ''}`
          : (e.message ?? 'no message')
        if (/tokens to keep.*greater than.*context length|context length.*exceed|context.*window.*exceed/i.test(body)) {
          throw new Error(
            `${this.model} rejected the request — the prompt doesn't fit in the model's loaded context window.\n` +
            `Local servers (LM Studio/Ollama) reserve context for the PROMPT plus maxTokens together, so a\n` +
            `large maxTokens shrinks the room left for input.\n` +
            `Options:\n` +
            `  1. In LM Studio, reload this model with a larger Context Length (Model Settings before loading).\n` +
            `  2. Lower maxTokens in .lacuna.json (e.g. "maxTokens": 4000) to leave more room for the prompt.\n` +
            `  3. Use --file to target a smaller source file.`,
          )
        }
        if (e.status === 429 || /rate.?limit|output tokens per minute|request.*exceed.*limit/i.test(body)) {
          throw new Error(
            `Rate limit hit (HTTP 429) — ${this.model} is rejecting requests due to quota.\n` +
            `Options:\n` +
            `  1. Lower maxTokens in .lacuna.json (e.g. "maxTokens": 4000) to reduce output per request.\n` +
            `  2. Use --workers 1 to avoid parallel requests consuming your quota.\n` +
            `  3. Try a different model: lacuna generate -m deepseek\n` +
            `  4. Check your provider's usage dashboard and upgrade if needed.`,
          )
        }
        throw new Error(`${this.model} API error (HTTP ${e.status ?? '?'}): ${body}`)
      }
      // Transient network termination (ECONNRESET, stream aborted, "terminated") —
      // common when many parallel workers flood a single API endpoint. Retry once
      // with a short backoff before surfacing the error.
      const msg = err instanceof Error ? err.message : String(err)
      if (_attempt === 0 && /terminated|ECONNRESET|ECONNREFUSED|socket hang up|network error/i.test(msg)) {
        clearTimeout(firstTokenTimer)
        clearInterval(stallInterval)
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000))
        return this.generate(messages, system, onToken, maxTokens, temperature, 1)
      }
      throw err
    } finally {
      clearTimeout(firstTokenTimer)
      clearInterval(stallInterval)
    }

    return content.trim()
  }
}
