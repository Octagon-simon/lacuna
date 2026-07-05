import { cosmiconfig } from 'cosmiconfig';
import { z } from 'zod';
import { PRESETS } from './providers/types.js';
// NOTE: the .describe() text on each field is the single source of truth for both code
// readers AND the generated JSON Schema (lacuna.schema.json) that powers editor completion
// and hover docs in .lacuna.json. Keep descriptions concise and user-facing.
export const ConfigSchema = z.object({
    testRunner: z.enum(['jest', 'vitest', 'pytest', 'mocha', 'go-test', 'phpunit', 'pest', 'rspec', 'cargo-test', 'dotnet-test', 'gradle-test', 'maven-test', 'swift-test']).optional()
        .describe('Test runner. Auto-detected from your project dependencies if omitted.'),
    coverageFormat: z.enum(['lcov', 'json-summary', 'cobertura']).default('lcov')
        .describe('Coverage report format your test runner produces.'),
    coverageDir: z.string().default('coverage')
        .describe('Directory where your test runner writes its coverage report.'),
    sourceDir: z.union([z.string(), z.array(z.string())]).default('src')
        .describe('Source directory (or directories) to scan for coverage gaps. A string, or an array like ["src","lib"] when source lives in multiple top-level dirs.')
        .transform((v) => (Array.isArray(v) ? v : [v])),
    threshold: z.number().min(0).max(100).default(80)
        .describe('Minimum line-coverage % a file must reach to be considered covered.'),
    maxIterations: z.number().min(1).max(10).default(3)
        .describe('How many times to retry a failing generated/fixed test before giving up.'),
    coverageTimeout: z.number().min(30).default(300)
        .describe('Seconds before the test suite is killed — guards against hung open handles (unclosed servers, timers).'),
    testDir: z.string().optional()
        .describe('Optional explicit test directory. Rarely needed — test locations are auto-detected.'),
    ignore: z.array(z.string()).default([])
        .describe('Path substrings to exclude from gap detection, e.g. ["src/graphql/", "src/theme/"].'),
    mocksFile: z.string().optional()
        .describe('Path to a shared mock file every generated test imports from, e.g. "src/test/mocks.ts".'),
    setupFile: z.string().optional()
        .describe('Path to your test setup file. Its contents are shown to the AI so it knows which globals/matchers exist.'),
    provider: z.enum(['anthropic', 'openai-compatible']).default('openai-compatible')
        .describe('AI provider. "anthropic" uses the Anthropic SDK; "openai-compatible" covers DeepSeek, OpenAI, Groq, OpenRouter, Ollama, etc.'),
    model: z.string().default('deepseek-chat')
        .describe('Model name, e.g. "deepseek-chat", "claude-sonnet-4-6", "gpt-4o".'),
    baseURL: z.string().default('https://api.deepseek.com/v1')
        .describe('API base URL. Required for the "openai-compatible" provider.'),
    apiKeyEnv: z.string().default('DEEPSEEK_API_KEY')
        .describe('Name of the environment variable that holds your API key.'),
    maxTokens: z.number().min(1024).max(128000).default(16000)
        .describe('Maximum output tokens per model call. Lower for strict providers (Groq free tier ~8000); raise if large test files are cut off.'),
    testCommand: z.string().optional()
        .describe('Override the auto-detected test command, e.g. "npx jest --no-coverage". Use to add flags.'),
    testEnv: z.record(z.string()).default({})
        .describe('Environment variables injected into every test-runner invocation, e.g. { "NODE_CONFIG_DIR": "packages/server/config" }.'),
    debug: z.boolean().optional()
        .describe('Set true to log every raw model prompt + response. Each target file gets its own log (lacuna-debug.<file>.txt). Equivalent to LACUNA_DEBUG=1.'),
    format: z.boolean().default(true)
        .describe('Run the project\'s local eslint --fix and prettier on each generated/fixed test file before declaring success, so output matches your repo style and passes lint. Best-effort; set false to disable.'),
    nodeEnvRouting: z.boolean().default(true)
        .describe('For DOM-free generated tests (services, utils, validators) in a jsdom project, add a `@vitest-environment node` / `@jest-environment node` docblock so the file skips jsdom startup and runs much faster. Verified per-file (reverted if it breaks the test). Set false to disable.'),
});
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
});
// Applies a -m / --model flag to the config. If the value matches a preset key
// (e.g. "gemini") or a preset model name (e.g. "gemini-2.5-pro"), the full preset
// is applied so provider/baseURL/apiKeyEnv are also updated. Otherwise, only
// config.model is updated (caller already has the right provider config).
export function applyModelOverride(config, model) {
    const byKey = PRESETS[model];
    if (byKey) {
        config.provider = byKey.provider;
        config.model = byKey.model;
        if (byKey.baseURL)
            config.baseURL = byKey.baseURL;
        if (byKey.apiKeyEnv)
            config.apiKeyEnv = byKey.apiKeyEnv;
        return;
    }
    const byModel = Object.values(PRESETS).find((p) => p.model === model);
    if (byModel) {
        config.provider = byModel.provider;
        config.model = byModel.model;
        if (byModel.baseURL)
            config.baseURL = byModel.baseURL;
        if (byModel.apiKeyEnv)
            config.apiKeyEnv = byModel.apiKeyEnv;
        return;
    }
    config.model = model;
}
export async function loadConfig(cwd = process.cwd()) {
    const result = await explorer.search(cwd);
    const raw = result?.config ?? {};
    return ConfigSchema.parse(raw);
}
//# sourceMappingURL=config.js.map