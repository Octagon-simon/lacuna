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

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
      stop_sequences: ['</code_output>'],
      ...(temperature !== undefined ? { temperature } : {}),
      system,
      messages,
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        content += event.delta.text
        onToken?.(event.delta.text)
      }
    }

    return content.trim()
  }
}
