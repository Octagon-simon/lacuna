import { Command } from '@oclif/core'
import { writeFile, access } from 'fs/promises'
import { join } from 'path'
import { select, input, confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import { detectEnvironment } from '../lib/detector.js'
import { PRESETS } from '../lib/providers/index.js'
import type { LacunaConfig } from '../lib/config.js'

export default class Init extends Command {
  static description = 'Interactive setup wizard — configure lacuna for your project'
  static examples = ['$ lacuna init']

  async run(): Promise<void> {
    const configPath = join(process.cwd(), '.lacuna.json')

    try {
      await access(configPath)
      const overwrite = await confirm({
        message: '.lacuna.json already exists. Overwrite it?',
        default: false,
      })
      if (!overwrite) {
        this.log('Keeping existing config.')
        return
      }
    } catch { /* file doesn't exist — proceed */ }

    this.log(chalk.bold('\nlacuna init\n'))

    const env = await detectEnvironment()

    // ── Model / provider ──────────────────────────────────────────────────

    const presetKey = await select({
      message: 'Which model do you want to use?',
      choices: [
        ...Object.entries(PRESETS).map(([key, p]) => ({ value: key, name: p.label })),
      ],
    })

    let preset = PRESETS[presetKey]

    if (presetKey === 'custom') {
      preset = {
        ...preset,
        baseURL: await input({ message: 'Base URL (e.g. https://api.example.com/v1):' }),
        model: await input({ message: 'Model name:' }),
        apiKeyEnv: await input({ message: 'API key env var name:', default: 'LLM_API_KEY' }),
        apiKeyHint: '',
      }
    } else if (presetKey === 'openrouter') {
      const orModel = await input({
        message: 'OpenRouter model (leave blank for default):',
        default: preset.model,
      })
      preset = { ...preset, model: orModel }
    } else if (presetKey === 'ollama') {
      const ollamaModel = await input({
        message: 'Ollama model name:',
        default: 'llama3.2',
      })
      preset = { ...preset, model: ollamaModel }
    }

    // ── Test runner ───────────────────────────────────────────────────────

    const detectedRunner = env.testRunner !== 'unknown' ? env.testRunner : undefined

    const testRunner = await select({
      message: 'Test runner:',
      choices: [
        { value: 'jest', name: `jest${detectedRunner === 'jest' ? ' (detected)' : ''}` },
        { value: 'vitest', name: `vitest${detectedRunner === 'vitest' ? ' (detected)' : ''}` },
        { value: 'mocha', name: `mocha${detectedRunner === 'mocha' ? ' (detected)' : ''}` },
        { value: 'pytest', name: `pytest${detectedRunner === 'pytest' ? ' (detected)' : ''}` },
        { value: 'go-test', name: `go test${detectedRunner === 'go-test' ? ' (detected)' : ''}` },
      ],
      default: detectedRunner ?? 'jest',
    })

    // ── Mocks file ────────────────────────────────────────────────────────

    const hasMocks = await confirm({
      message: 'Do you have (or want) a shared mock file for all tests?',
      default: true,
    })

    let mocksFile: string | undefined
    if (hasMocks) {
      mocksFile = await input({
        message: 'Path to shared mock file:',
        default: 'src/test/mocks.ts',
      })
    }

    // ── Coverage threshold ────────────────────────────────────────────────

    const thresholdStr = await input({
      message: 'Coverage threshold (%):',
      default: '80',
    })
    const threshold = parseInt(thresholdStr, 10)

    // ── Build config ──────────────────────────────────────────────────────

    const config: Partial<LacunaConfig> = {
      provider: preset.provider,
      model: preset.model,
      apiKeyEnv: preset.apiKeyEnv || undefined,
      testRunner: testRunner as LacunaConfig['testRunner'],
      coverageFormat: 'lcov',
      coverageDir: 'coverage',
      sourceDir: 'src',
      threshold,
      maxIterations: 3,
    }

    if (preset.baseURL) config.baseURL = preset.baseURL
    if (mocksFile) config.mocksFile = mocksFile

    // remove undefined keys
    const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined))

    await writeFile(configPath, JSON.stringify(clean, null, 2) + '\n')

    // ── Summary ───────────────────────────────────────────────────────────

    this.log(chalk.green('\n✓ Created .lacuna.json\n'))
    this.log(chalk.bold('Setup summary:'))
    this.log(`  Model:      ${chalk.cyan(preset.model)} via ${preset.provider}`)
    this.log(`  Runner:     ${chalk.cyan(testRunner)}`)
    this.log(`  Threshold:  ${threshold}%`)

    if (preset.apiKeyEnv) {
      const keySet = process.env[preset.apiKeyEnv]
      const keyStatus = keySet ? chalk.green('set ✓') : chalk.red('NOT set ✗')
      this.log(`  API key:    ${chalk.dim(preset.apiKeyEnv)} — ${keyStatus}`)
      if (!keySet) {
        this.log(chalk.yellow(`\n  Get your key: ${preset.apiKeyHint}`))
        this.log(chalk.dim(`  Then run: export ${preset.apiKeyEnv}=your-key-here`))
      }
    } else {
      this.log(`  API key:    ${chalk.dim('none (local model)')}`)
    }

    this.log(`\nNext steps:`)
    this.log(`  ${chalk.cyan('lacuna analyze')}   — see coverage gaps`)
    this.log(`  ${chalk.cyan('lacuna generate')}  — fill them with AI-generated tests\n`)
  }
}
