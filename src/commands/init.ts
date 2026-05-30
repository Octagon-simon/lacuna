import { Command } from '@oclif/core'
import { writeFile, readFile, access } from 'fs/promises'
import { join } from 'path'
import { execSync } from 'child_process'
import { select, input, confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import { detectEnvironment } from '../lib/detector.js'
import { PRESETS } from '../lib/providers/index.js'
import type { LacunaConfig } from '../lib/config.js'

const RUNNER_SETUP: Record<string, {
  packages: string[]
  configFile: string
  configContent: string
  scriptHint: string
}> = {
  vitest: {
    packages: ['vitest', '@vitest/coverage-v8'],
    configFile: 'vitest.config.ts',
    configContent: `import { defineConfig } from 'vitest/config'\n\nexport default defineConfig({\n  test: {\n    coverage: {\n      provider: 'v8',\n      reporter: ['lcov', 'text-summary'],\n      reportsDirectory: './coverage',\n    },\n  },\n})\n`,
    scriptHint: '"test": "vitest run --coverage"',
  },
  jest: {
    packages: ['jest', '@types/jest', 'ts-jest'],
    configFile: 'jest.config.js',
    configContent: `/** @type {import('jest').Config} */\nmodule.exports = {\n  coverageReporters: ['lcov', 'text-summary'],\n  coverageDirectory: 'coverage',\n}\n`,
    scriptHint: '"test": "jest --coverage"',
  },
  mocha: {
    packages: ['mocha', '@types/mocha', 'c8'],
    configFile: '.mocharc.json',
    configContent: `{\n  "spec": "src/**/*.test.{ts,js}",\n  "require": ["ts-node/register"]\n}\n`,
    scriptHint: '"test": "c8 --reporter=lcov mocha"',
  },
}

async function isRunnerInstalled(runner: string, cwd: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const all = { ...pkg.dependencies, ...pkg.devDependencies }
    return runner in all
  } catch {
    return false
  }
}

async function ensureTestRunnerSetup(runner: string, cwd: string, log: (msg: string) => void): Promise<void> {
  const setup = RUNNER_SETUP[runner]
  if (!setup) return // pytest, go-test — handled outside Node ecosystem

  const installed = await isRunnerInstalled(runner, cwd)
  if (installed) return // already set up

  log(chalk.yellow(`\n  ${runner} is not installed in this project.`))
  const doInstall = await confirm({
    message: `Install ${setup.packages.join(', ')} and create ${setup.configFile}?`,
    default: true,
  })
  if (!doInstall) {
    log(chalk.dim(`  Skipped. Install manually: npm install -D ${setup.packages.join(' ')}`))
    return
  }

  log(chalk.dim(`\n  Installing ${setup.packages.join(', ')}...`))
  try {
    execSync(`npm install -D ${setup.packages.join(' ')}`, { cwd, stdio: 'inherit' })
  } catch {
    log(chalk.red(`  Install failed. Run manually: npm install -D ${setup.packages.join(' ')}`))
    return
  }

  const configPath = join(cwd, setup.configFile)
  try {
    await access(configPath)
    log(chalk.dim(`  ${setup.configFile} already exists — skipping.`))
  } catch {
    await writeFile(configPath, setup.configContent)
    log(chalk.green(`  ✓ Created ${setup.configFile}`))
  }

  log(chalk.dim(`\n  Add this to your package.json scripts if not already there:`))
  log(chalk.dim(`    ${setup.scriptHint}`))
}

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

    // ── Test runner setup (if not installed) ─────────────────────────────

    await ensureTestRunnerSetup(testRunner, process.cwd(), (msg) => this.log(msg))

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
