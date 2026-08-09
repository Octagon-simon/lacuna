import * as vscode from 'vscode'
import type { LacunaConfig } from '../core'

// "Get your key" links per known env-var name. Purely UI text, so it lives here rather than
// widening the core's export surface.
const KEY_HINTS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'https://console.anthropic.com',
  DEEPSEEK_API_KEY: 'https://platform.deepseek.com',
  OPENAI_API_KEY: 'https://platform.openai.com/api-keys',
  GROQ_API_KEY: 'https://console.groq.com',
  OPENROUTER_API_KEY: 'https://openrouter.ai/keys',
  GEMINI_API_KEY: 'https://aistudio.google.com/app/apikey',
}

/** Local providers (Ollama etc.) need no key — mirrors createProvider's isLocal check. */
export function providerIsLocal(config: LacunaConfig): boolean {
  const url = config.baseURL ?? ''
  return url.includes('localhost') || url.includes('127.0.0.1')
}

/** True when this provider requires a key at all. */
export function requiresKey(config: LacunaConfig): boolean {
  return !providerIsLocal(config) && !!config.apiKeyEnv
}

function secretId(apiKeyEnv: string): string {
  // Scope by env-var name so a workspace on GROQ_API_KEY and one on ANTHROPIC_API_KEY each keep
  // their own secret.
  return `lacuna.apiKey.${apiKeyEnv}`
}

export class KeyService {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * Resolve the key for a run. Precedence: an already-populated process.env[apiKeyEnv] wins (a
   * user who launched from a configured terminal), then SecretStorage, then — only when
   * `interactive` — a prompt whose result is stored. Returns undefined for local providers, and
   * throws if a key is required but unavailable / the prompt is cancelled.
   */
  async resolve(config: LacunaConfig, opts: { interactive: boolean }): Promise<string | undefined> {
    if (!requiresKey(config)) return undefined
    const env = config.apiKeyEnv

    const fromEnv = process.env[env]
    if (fromEnv) return fromEnv

    const stored = await this.secrets.get(secretId(env))
    if (stored) return stored

    if (!opts.interactive) {
      throw new Error(`No API key for ${env}. Run “Lacuna: Set API Key”.`)
    }
    const entered = await this.promptAndStore(config)
    if (!entered) throw new Error(`A ${env} key is required to run Lacuna.`)
    return entered
  }

  /** Force a prompt and store the result (used by the "Set API Key" command and onboarding). */
  async promptAndStore(config: LacunaConfig): Promise<string | undefined> {
    const env = config.apiKeyEnv
    const hint = KEY_HINTS[env]
    const value = await vscode.window.showInputBox({
      title: `Lacuna — ${env}`,
      prompt: hint ? `Enter your API key. Get one at ${hint}` : `Enter your ${env}`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: env,
    })
    if (value === undefined || value.trim() === '') return undefined
    await this.secrets.store(secretId(env), value.trim())
    return value.trim()
  }

  async clear(config: LacunaConfig): Promise<void> {
    await this.secrets.delete(secretId(config.apiKeyEnv))
  }

  hintFor(config: LacunaConfig): string | undefined {
    return KEY_HINTS[config.apiKeyEnv]
  }
}
