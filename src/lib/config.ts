import { cosmiconfig } from 'cosmiconfig'
import { z } from 'zod'
import { PRESETS } from './providers/types.js'

const ConfigSchema = z.object({
  testRunner: z.enum(['jest', 'vitest', 'pytest', 'mocha', 'go-test']).optional(),
  coverageFormat: z.enum(['lcov', 'json-summary', 'cobertura']).default('lcov'),
  coverageDir: z.string().default('coverage'),
  sourceDir: z.string().default('src'),
  threshold: z.number().min(0).max(100).default(80),
  maxIterations: z.number().min(1).max(10).default(3),
  coverageTimeout: z.number().min(30).default(300),   // seconds; kills hung test suite
  testDir: z.string().optional(),
  ignore: z.array(z.string()).default([]),
  // mock configuration
  mocksFile: z.string().optional(),     // path to shared mock file (e.g. src/test/mocks.ts)
  setupFile: z.string().optional(),     // path to test setup file (e.g. src/test/setup.ts)
  // provider config
  provider: z.enum(['anthropic', 'openai-compatible']).default('anthropic'),
  model: z.string().default('claude-sonnet-4-6'),
  baseURL: z.string().optional(),
  apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'),
  maxTokens: z.number().min(1024).max(128000).default(16000),
})

export type LacunaConfig = z.infer<typeof ConfigSchema>

const explorer = cosmiconfig('lacuna', {
  searchPlaces: [
    'package.json',
    '.lacuna.json',
    '.lacunarc',
    '.lacunarc.json',
    '.lacunarc.yaml',
    '.lacunarc.yml',
    'lacuna.config.js',
    'lacuna.config.cjs',
  ],
})

// Applies a -m / --model flag to the config. If the value matches a preset key
// (e.g. "gemini") or a preset model name (e.g. "gemini-2.5-pro"), the full preset
// is applied so provider/baseURL/apiKeyEnv are also updated. Otherwise, only
// config.model is updated (caller already has the right provider config).
export function applyModelOverride(config: LacunaConfig, model: string): void {
  const byKey = PRESETS[model]
  if (byKey) {
    config.provider = byKey.provider
    config.model = byKey.model
    if (byKey.baseURL) config.baseURL = byKey.baseURL
    if (byKey.apiKeyEnv) config.apiKeyEnv = byKey.apiKeyEnv
    return
  }
  const byModel = Object.values(PRESETS).find((p) => p.model === model)
  if (byModel) {
    config.provider = byModel.provider
    config.model = byModel.model
    if (byModel.baseURL) config.baseURL = byModel.baseURL
    if (byModel.apiKeyEnv) config.apiKeyEnv = byModel.apiKeyEnv
    return
  }
  config.model = model
}

export async function loadConfig(cwd: string = process.cwd()): Promise<LacunaConfig> {
  const result = await explorer.search(cwd)
  const raw = result?.config ?? {}
  return ConfigSchema.parse(raw)
}
