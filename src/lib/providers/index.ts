import type { ModelProvider } from './types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import type { LacunaConfig } from '../config.js'

export { PRESETS } from './types.js'
export type { ModelProvider, ChatMessage, ProviderPreset } from './types.js'

export function createProvider(config: LacunaConfig): ModelProvider {
  // Prefer a runtime key supplied by an embedding host (config.apiKey — e.g. the VS Code
  // extension's SecretStorage value) over the env var. `||` (not `??`) so an empty/absent
  // runtime key cleanly falls through to process.env, keeping the CLI path byte-identical.
  const apiKey = config.apiKey || (config.apiKeyEnv ? (process.env[config.apiKeyEnv] ?? '') : '')

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
      isLocal,
    })
  }

  throw new Error(`Unknown provider: ${config.provider}`)
}
