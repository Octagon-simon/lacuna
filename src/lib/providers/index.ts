import type { ModelProvider } from './types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import type { LacunaConfig } from '../config.js'

export { PRESETS } from './types.js'
export type { ModelProvider, ChatMessage, ProviderPreset } from './types.js'

export function createProvider(config: LacunaConfig): ModelProvider {
  const apiKey = config.apiKeyEnv ? (process.env[config.apiKeyEnv] ?? '') : ''

  if (config.provider === 'anthropic') {
    if (!apiKey) {
      throw new Error(
        `${config.apiKeyEnv} environment variable is not set.\nGet your key at https://console.anthropic.com`,
      )
    }
    return new AnthropicProvider(config.model, apiKey)
  }

  if (config.provider === 'openai-compatible') {
    if (!config.baseURL) {
      throw new Error('baseURL is required for openai-compatible provider. Check your .lacuna.json')
    }
    const isLocal = config.baseURL.includes('localhost') || config.baseURL.includes('127.0.0.1')
    if (!isLocal && !apiKey) {
      throw new Error(
        `${config.apiKeyEnv} environment variable is not set.`,
      )
    }
    return new OpenAICompatibleProvider(config.model, {
      baseURL: config.baseURL,
      apiKey: apiKey || undefined,
    })
  }

  throw new Error(`Unknown provider: ${config.provider}`)
}
