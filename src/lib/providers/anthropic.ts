import Anthropic from '@anthropic-ai/sdk'
import type { ModelProvider, ChatMessage } from './types.js'

export class AnthropicProvider implements ModelProvider {
  private client: Anthropic
  private model: string

  constructor(model: string, apiKey: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  async generate(
    messages: ChatMessage[],
    system: string,
    onToken?: (token: string) => void,
    maxTokens = 16000,
    temperature?: number,
  ): Promise<string> {
    let content = ''

    // Mark the first user message as cacheable — it holds the large initial context
    // (source file, existing test, mocks, type definitions) that stays identical
    // across all retries for a given file. Cache hits cost 10% of normal input price.
    const anthropicMessages: Anthropic.Messages.MessageParam[] = messages.map((msg, i) => {
      if (i === 0 && msg.role === 'user') {
        return {
          role: 'user',
          content: [{ type: 'text' as const, text: msg.content, cache_control: { type: 'ephemeral' } as const }],
        }
      }
      return { role: msg.role, content: msg.content }
    })

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
      })

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          content += event.delta.text
          onToken?.(event.delta.text)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      if (/prompt is too long|max_tokens.*exceed|too many tokens/i.test(msg)) {
        throw new Error(
          `${this.model} rejected the request — prompt too large.\n` +
          `The assembled context (source file + test file + type definitions + mocks) exceeds the model's input limit.\n` +
          `Try: lower maxTokens in .lacuna.json, or use --file to target a smaller source file.`,
        )
      }

      if (/rate.?limit|429|output tokens per minute|request.*exceed.*limit/i.test(msg)) {
        throw new Error(
          `Anthropic rate limit hit — your account has a low output-token-per-minute cap (Tier 1: 8k TPM).\n` +
          `Options:\n` +
          `  1. Lower maxTokens in .lacuna.json (e.g. "maxTokens": 4000) to reduce output per request.\n` +
          `  2. Use --workers 1 (default) to avoid parallel requests consuming your quota.\n` +
          `  3. Switch to a cheaper/higher-limit provider: lacuna generate -m deepseek\n` +
          `  4. Upgrade your Anthropic account tier: https://console.anthropic.com/settings/billing`,
        )
      }

      throw err
    }

    return content.trim()
  }
}
