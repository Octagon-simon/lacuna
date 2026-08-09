import { Command, Flags } from '@oclif/core'
import { writeFile, access } from 'fs/promises'
import { join } from 'path'
import { select, input, confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import { detectEnvironment } from '../lib/detector.js'
import { PRESETS } from '../lib/providers/index.js'
import type { LacunaConfig } from '../lib/config.js'
import { seedIfEmpty, globalMemoryRoot } from '../lib/memory/index.js'
import { ensureTestRunnerSetup, readProjectMeta, findProjectRoot } from '../lib/scaffold.js'

// Hosted JSON Schema for .lacuna.json — gives editor key completion + hover docs.
// Hosted (not a node_modules path) because lacuna installs globally, so there's no local copy.
const LACUNA_SCHEMA_URL = 'https://raw.githubusercontent.com/Octagon-simon/lacuna/main/lacuna.schema.json'


export default class Init extends Command {
  static description = 'Interactive setup wizard — configure lacuna for your project'
  static examples = [
    '$ lacuna init',
    '$ lacuna init --yes --runner vitest --source-dir src --threshold 80',
    '$ lacuna init -y --preset claude --runner jest --force',
  ]

  // Non-interactive levers. Passing a flag skips its prompt; `--yes` accepts the default for every
  // prompt not covered by a flag (and auto-installs). This is what the VS Code extension drives: it
  // collects the values in its settings form, then runs `lacuna init --yes --force <flags>` in a
  // terminal so the user types nothing and only watches the install progress. See init-service.ts.
  static flags = {
    yes: Flags.boolean({ char: 'y', default: false, description: 'Non-interactive: accept defaults for any prompt not given as a flag, and install without asking' }),
    force: Flags.boolean({ char: 'f', default: false, description: 'Overwrite an existing .lacuna.json instead of keeping it' }),
    preset: Flags.string({ description: 'Model preset key', options: Object.keys(PRESETS) }),
    model: Flags.string({ description: 'Model name (overrides the preset default)' }),
    'base-url': Flags.string({ description: 'Custom provider base URL (with --preset custom)' }),
    'api-key-env': Flags.string({ description: 'API key env var name (with --preset custom)' }),
    runner: Flags.string({ description: 'Test runner', options: ['vitest', 'jest', 'mocha', 'pytest', 'go-test', 'phpunit', 'pest', 'rspec', 'cargo-test', 'dotnet-test', 'gradle-test', 'maven-test', 'swift-test'] }),
    'source-dir': Flags.string({ description: 'Source directory where your source files live' }),
    'setup-file': Flags.string({ description: 'Path to a test setup file' }),
    mocks: Flags.string({ description: 'Path(s) to a shared mock file, comma-separated' }),
    threshold: Flags.integer({ description: 'Coverage threshold percentage' }),
    'scaffold-only': Flags.boolean({ default: false, description: 'Only install deps + scaffold runner config/setup files; do NOT write .lacuna.json (for callers that own the config, e.g. the VS Code extension)' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Init)
    const scaffoldOnly = flags['scaffold-only']
    // scaffold-only implies non-interactive: the caller owns .lacuna.json, so there is nothing to
    // ask about beyond runner/source-dir (taken from flags), and we never write config.
    const yes = flags.yes
    const noninteractive = yes || scaffoldOnly
    const cwd = await findProjectRoot(process.cwd())
    if (cwd !== process.cwd()) {
      this.log(chalk.dim(`  (running from ${process.cwd()} — using project root: ${cwd})\n`))
    }
    const configPath = join(cwd, '.lacuna.json')

    // scaffold-only never writes config, so the "already exists / overwrite?" gate doesn't apply —
    // and MUST be skipped, else an existing .lacuna.json (the whole reason the caller runs this)
    // would short-circuit the install/scaffold with "Keeping existing config".
    if (!scaffoldOnly) {
      try {
        await access(configPath)
        const overwrite = flags.force ? true : yes ? false : await confirm({
          message: '.lacuna.json already exists. Overwrite it?',
          default: false,
        })
        if (!overwrite) {
          this.log(yes && !flags.force ? 'Keeping existing config (pass --force to overwrite).' : 'Keeping existing config.')
          return
        }
      } catch { /* file doesn't exist — proceed */ }
    }

    this.log(chalk.bold(scaffoldOnly ? '\nlacuna init — installing test dependencies\n' : '\nlacuna init\n'))

    const env = await detectEnvironment()

    // ── Model / provider ──────────────────────────────────────────────────────
    // scaffold-only doesn't write config, so no provider is needed — 'claude' is a harmless
    // placeholder that never gets prompted for or persisted.

    const presetKey = flags.preset ?? (noninteractive ? 'claude' : await select({
      message: 'Which model do you want to use?',
      choices: [
        ...Object.entries(PRESETS).map(([key, p]) => ({ value: key, name: p.label })),
      ],
    }))

    let preset = PRESETS[presetKey]

    if (presetKey === 'custom') {
      preset = {
        ...preset,
        baseURL: flags['base-url'] ?? (yes ? '' : await input({ message: 'Base URL (e.g. https://api.example.com/v1):' })),
        model: flags.model ?? (yes ? preset.model : await input({ message: 'Model name:' })),
        apiKeyEnv: flags['api-key-env'] ?? (yes ? 'LLM_API_KEY' : await input({ message: 'API key env var name:', default: 'LLM_API_KEY' })),
        apiKeyHint: '',
      }
    } else if (presetKey === 'openrouter') {
      const orModel = flags.model ?? (yes ? preset.model : await input({ message: 'OpenRouter model (leave blank for default):', default: preset.model }))
      preset = { ...preset, model: orModel }
    } else if (presetKey === 'ollama') {
      const ollamaModel = flags.model ?? (yes ? 'llama3.2' : await input({ message: 'Ollama model name:', default: 'llama3.2' }))
      preset = { ...preset, model: ollamaModel }
    } else if (flags.model) {
      // --model overrides the default model of any standard preset too.
      preset = { ...preset, model: flags.model }
    }

    // ── Test runner ───────────────────────────────────────────────────────────

    const detectedRunner = env.testRunner !== 'unknown' ? env.testRunner : undefined

    const testRunner = flags.runner ?? (noninteractive ? (detectedRunner ?? 'vitest') : await select({
      message: 'Test runner:',
      choices: [
        { value: 'vitest',       name: `vitest${detectedRunner === 'vitest' ? ' (detected)' : ''}` },
        { value: 'jest',         name: `jest${detectedRunner === 'jest' ? ' (detected)' : ''}` },
        { value: 'mocha',        name: `mocha${detectedRunner === 'mocha' ? ' (detected)' : ''}` },
        { value: 'pytest',       name: `pytest${detectedRunner === 'pytest' ? ' (detected)' : ''}` },
        { value: 'go-test',      name: `go test${detectedRunner === 'go-test' ? ' (detected)' : ''}` },
        { value: 'phpunit',      name: `phpunit${detectedRunner === 'phpunit' ? ' (detected)' : ''}` },
        { value: 'pest',         name: `pest (PHP)${detectedRunner === 'pest' ? ' (detected)' : ''}` },
        { value: 'rspec',        name: `rspec (Ruby)${detectedRunner === 'rspec' ? ' (detected)' : ''}` },
        { value: 'cargo-test',   name: `cargo test (Rust)${detectedRunner === 'cargo-test' ? ' (detected)' : ''}` },
        { value: 'dotnet-test',  name: `dotnet test (C#)${detectedRunner === 'dotnet-test' ? ' (detected)' : ''}` },
        { value: 'gradle-test',  name: `gradle test (Java/Kotlin)${detectedRunner === 'gradle-test' ? ' (detected)' : ''}` },
        { value: 'maven-test',   name: `mvn test (Java)${detectedRunner === 'maven-test' ? ' (detected)' : ''}` },
        { value: 'swift-test',   name: `swift test (Swift)${detectedRunner === 'swift-test' ? ' (detected)' : ''}` },
      ],
      default: detectedRunner ?? 'vitest',
    }))

    // ── Source directory ──────────────────────────────────────────────────────

    const sourceDir = flags['source-dir'] ?? (noninteractive ? 'src' : await input({
      message: 'Source directory (where your source files live):',
      default: 'src',
    }))

    // ── Test runner setup (install + config + setup file) ─────────────────────

    const createdSetupFile = await ensureTestRunnerSetup(
      testRunner, sourceDir, cwd, (msg: string) => this.log(msg), noninteractive,
      (message) => confirm({ message, default: true }),
    )

    // scaffold-only stops here: deps installed + runner config/setup file scaffolded, config left to
    // the caller. Seed memory (idempotent) so a later generate/fix doesn't pay for it on first run.
    if (scaffoldOnly) {
      const seededCount = await seedIfEmpty(globalMemoryRoot()).catch(() => 0)
      this.log(chalk.green(`\n✓ ${testRunner} dependencies installed and test config scaffolded.`))
      if (createdSetupFile) this.log(`  Setup file: ${chalk.cyan(createdSetupFile)}`)
      if (seededCount > 0) this.log(chalk.dim(`  Seeded memory store with ${seededCount} built-in rule(s).`))
      this.log(chalk.dim('  Configuration (.lacuna.json) is managed by the extension.'))
      return
    }

    // ── Setup file (if not created above) ────────────────────────────────────

    let setupFile: string | undefined = createdSetupFile
    if (!setupFile) {
      if (flags['setup-file']) {
        setupFile = flags['setup-file']
      } else if (!yes) {
        const hasSetup = await confirm({
          message: 'Do you have a test setup file (e.g. vitest.setup.ts / jest.setup.ts)?',
          default: false,
        })
        if (hasSetup) {
          setupFile = await input({
            message: 'Path to setup file:',
            default: `${sourceDir}/test/setup.ts`,
          })
        }
      }
      // yes && no --setup-file → leave undefined (mirrors the interactive default of "no")
    }

    // ── Mocks file ────────────────────────────────────────────────────────────
    // Accepts a comma-separated list for projects that split mocks across multiple files
    // (e.g. one for external services, one for internal utils) — the first path becomes
    // the primary/writable file the AI creates and patches; the rest are shown read-only.
    const defaultMocksPath = async () =>
      (await readProjectMeta(cwd)).isReactNative ? `${sourceDir}/test/mock.tsx` : `${sourceDir}/test/mocks.ts`
    const toMocksValue = (raw: string): string | string[] | undefined => {
      const paths = raw.split(',').map(p => p.trim()).filter(Boolean)
      return paths.length === 0 ? undefined : paths.length > 1 ? paths : paths[0]
    }

    let mocksFile: string | string[] | undefined
    if (flags.mocks !== undefined) {
      mocksFile = toMocksValue(flags.mocks)
    } else if (yes) {
      // Mirror the interactive default (hasMocks = true with the framework-default path).
      mocksFile = await defaultMocksPath()
    } else {
      const hasMocks = await confirm({
        message: 'Do you have (or want) a shared mock file for all tests?',
        default: true,
      })
      if (hasMocks) {
        const mocksInput = await input({
          message: 'Path to shared mock file (comma-separate if you have more than one):',
          default: await defaultMocksPath(),
        })
        mocksFile = toMocksValue(mocksInput)
      }
    }

    // ── Coverage threshold ────────────────────────────────────────────────────

    const threshold = flags.threshold ?? (yes ? 80 : parseInt(await input({ message: 'Coverage threshold (%):', default: '80' }), 10))

    // ── Build config ──────────────────────────────────────────────────────────

    const config: Partial<LacunaConfig> = {
      provider: preset.provider,
      model: preset.model,
      apiKeyEnv: preset.apiKeyEnv || undefined,
      testRunner: testRunner as LacunaConfig['testRunner'],
      coverageFormat: 'lcov',
      coverageDir: 'coverage',
      sourceDir: [sourceDir],
      threshold,
      maxIterations: 3,
    }

    if (preset.baseURL) config.baseURL = preset.baseURL
    if (mocksFile)   config.mocksFile = mocksFile
    if (setupFile)   config.setupFile = setupFile

    const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined))
    // $schema first so editors (VS Code, etc.) offer key completion + hover docs in .lacuna.json.
    const withSchema = { $schema: LACUNA_SCHEMA_URL, ...clean }
    await writeFile(configPath, JSON.stringify(withSchema, null, 2) + '\n')

    // ── Seed memory store ───────────────────────────────────────────────────────
    // Explicit + visible here (init isn't required — generate/fix auto-seed lazily too, see
    // retrieve.ts — but users who DO run init get to see it happen up front rather than
    // silently on their first real generate/fix call). Idempotent via the same on-disk
    // sentinel either path uses, so running init twice never double-seeds.
    if (config.memory?.enabled !== false) {
      const seededCount = await seedIfEmpty(globalMemoryRoot()).catch(() => 0)
      if (seededCount > 0) this.log(chalk.dim(`  Seeded memory store with ${seededCount} built-in rule(s).`))
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    this.log(chalk.green('\n✓ Created .lacuna.json\n'))
    this.log(chalk.bold('Setup summary:'))
    this.log(`  Model:      ${chalk.cyan(preset.model)} via ${preset.provider}`)
    this.log(`  Runner:     ${chalk.cyan(testRunner)}`)
    this.log(`  Source dir: ${chalk.cyan(sourceDir)}`)
    this.log(`  Threshold:  ${threshold}%`)
    if (setupFile) this.log(`  Setup file: ${chalk.cyan(setupFile)}`)
    if (mocksFile) this.log(`  Mocks file: ${chalk.cyan(Array.isArray(mocksFile) ? mocksFile.join(', ') : mocksFile)}`)

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
