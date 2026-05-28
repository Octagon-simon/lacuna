import { cosmiconfig } from 'cosmiconfig'
import { z } from 'zod'

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

export async function loadConfig(cwd: string = process.cwd()): Promise<LacunaConfig> {
  const result = await explorer.search(cwd)
  const raw = result?.config ?? {}
  return ConfigSchema.parse(raw)
}
