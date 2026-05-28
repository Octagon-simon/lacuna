import OpenAI from 'openai'
import type { ModelProvider, ChatMessage } from './types.js'

export class OpenAICompatibleProvider implements ModelProvider {
  private client: OpenAI
  private model: string

  constructor(model: string, options: { baseURL: string; apiKey?: string }) {
    this.client = new OpenAI({
      apiKey: options.apiKey || 'no-key-required',
      baseURL: options.baseURL,
    })
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
    })

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content ?? ''
      if (token) {
        content += token
        onToken?.(token)
      }
    }

    return content.trim()
  }
}
