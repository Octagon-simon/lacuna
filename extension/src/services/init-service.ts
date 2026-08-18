import * as vscode from 'vscode'
import * as path from 'node:path'
import { SettingsPanel } from '../ui/settings-panel'
import { isConfigured, folderFor } from './config-service'

/**
 * Onboarding equivalent of `lacuna init`, as UI instead of terminal prompts (§Phase 3). Rather
 * than reimplement init's detection, it opens the schema-driven settings form pre-filled with any
 * detected defaults; the user reviews, sets a key, and saves `.lacuna.json`.
 *
 * Saving `.lacuna.json` is only half of what the CLI's `init` does on a FRESH project — the CLI also
 * installs the test runner + testing-library deps and scaffolds runner config / setup files. The
 * webview can't run `npm install` or show its progress, so that half is delegated to the CLI's
 * `init --scaffold-only` in an integrated terminal (see runScaffold). The panel stays the single
 * writer of `.lacuna.json`; `--scaffold-only` deliberately does NOT touch it.
 */
export async function runInit(context: vscode.ExtensionContext): Promise<void> {
  const folder = folderFor()
  if (!folder) { vscode.window.showWarningMessage('Open a folder to set up Lacuna.'); return }
  const firstRun = !(await isConfigured(folder.uri.fsPath))
  await SettingsPanel.show(context, firstRun)
}

interface LacunaConfigShape { testRunner?: string; sourceDir?: string[] | string; setupFile?: string }

async function readConfig(cwd: string): Promise<LacunaConfigShape | undefined> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, '.lacuna.json')))
    return JSON.parse(Buffer.from(buf).toString('utf8')) as LacunaConfigShape
  } catch { return undefined }
}

// Runners the CLI installs Node deps / scaffolds config for. For anything else (pytest, go, etc.)
// there is nothing to `npm install`, so we skip the offer entirely.
const NODE_RUNNERS = new Set(['vitest', 'jest', 'mocha'])

// A JS/TS project has a package.json. Used to decide whether to offer the scaffold when the config
// has NO testRunner — the settings panel's "(auto-detect)" option writes no `testRunner`, so we
// can't gate on it; instead we let the scaffold self-detect (and fall back to vitest) for any Node
// project, and skip non-Node ones. Without this, auto-detect made the scaffold silently no-op.
async function isNodeProject(cwd: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(cwd, 'package.json')))
    return true
  } catch { return false }
}

async function exists(cwd: string, rel: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(cwd, rel)))
    return true
  } catch { return false }
}

// Whether the runner's binary is present in node_modules.
async function isRunnerInstalled(cwd: string, runner: string): Promise<boolean> {
  return exists(cwd, path.join('node_modules', '.bin', runner))
}

// The config filenames each runner is considered "configured" by (vitest also reads vite.config.*).
const RUNNER_CONFIG_FILES: Record<string, string[]> = {
  vitest: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.mts', 'vitest.config.cjs', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'],
  jest: ['jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json'],
  mocha: ['.mocharc.json', '.mocharc.js', '.mocharc.cjs', '.mocharc.yml', '.mocharc.yaml'],
}

async function readPackageJson(cwd: string): Promise<{ scripts?: Record<string, string>; jest?: unknown } | undefined> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cwd, 'package.json')))
    return JSON.parse(Buffer.from(buf).toString('utf8'))
  } catch { return undefined }
}

/**
 * Whether the project is FULLY set up for `runner` — deps installed, a runner config present, AND a
 * real `test` script. This is the right gate for the setup offer: gating merely on "is the runner
 * installed" wrongly treats a project that has e.g. vitest in node_modules but no config/scripts as
 * done, so it silently skipped the rest of setup and things broke on the first `npm test` / CI run.
 * The scaffold is idempotent, so re-running it when only some pieces are missing is safe.
 */
async function isSetupComplete(cwd: string, runner: string): Promise<boolean> {
  if (!NODE_RUNNERS.has(runner)) return true
  if (!(await isRunnerInstalled(cwd, runner))) return false

  const configFiles = RUNNER_CONFIG_FILES[runner] ?? []
  const pkg = await readPackageJson(cwd)
  const hasConfig = (await Promise.all(configFiles.map((f) => exists(cwd, f)))).some(Boolean)
    || (runner === 'jest' && pkg?.jest != null) // jest config can live in package.json#jest
  if (!hasConfig) return false

  // A real test script: present and actually invoking the runner (not npm's placeholder / a lint alias).
  const test = pkg?.scripts?.test?.trim() ?? ''
  const hasTestScript = /\b(vitest|jest|mocha)\b/.test(test)
  if (!hasTestScript) return false

  return true
}

/**
 * Install the test runner + testing-library deps and scaffold runner config / setup files for the
 * runner recorded in `.lacuna.json`. Runs the extension's OWN bundled scaffold script
 * (`out/scaffold.js`, built from the same embedded core) via `node` in an integrated terminal — not
 * `npx lacuna-cli` — so there is no runtime dependency on a published CLI, no version coupling, and
 * it works offline. Shown in a terminal (not in-process) so the user sees `npm install` progress and
 * can intervene. `.lacuna.json` is left untouched (the settings panel owns it).
 *
 * `scaffoldScript` is the absolute path to the bundled out/scaffold.js (via context.asAbsolutePath).
 */
export async function runScaffold(cwd: string, scaffoldScript: string): Promise<void> {
  const config = await readConfig(cwd)
  const runner = config?.testRunner

  // A concrete non-Node runner (pytest, go, …) has nothing to install/scaffold — say so and stop.
  if (runner && !NODE_RUNNERS.has(runner)) {
    vscode.window.showInformationMessage(`Lacuna: ${runner} needs no Node dependency setup — you're ready to generate tests.`)
    return
  }

  // No runner in .lacuna.json means the settings panel was left on "(auto-detect)". Only offer the
  // scaffold for a Node project (there's something to npm-install); the scaffold script itself
  // detects the runner and falls back to vitest. This replaces the old silent no-op.
  if (!runner && !(await isNodeProject(cwd))) {
    vscode.window.showInformationMessage('Lacuna: no package.json here — no Node test tooling to set up. You can generate tests directly.')
    return
  }

  const sourceDir = Array.isArray(config?.sourceDir) ? config?.sourceDir[0] : config?.sourceDir
  const label = runner ?? 'the test runner'

  // Single consent surface for the whole install/scaffold step (the terminal shows the exact
  // packages). Modal so it isn't missed on a fresh project where nothing works until deps exist.
  const detail = runner
    ? `Lacuna will install ${runner} and its testing-library dependencies and scaffold the runner config / setup file in a terminal. Your .lacuna.json is not changed.`
    : `No test runner is set, so Lacuna will detect one (defaulting to vitest), install it with its testing-library dependencies, and scaffold the runner config / setup file in a terminal. Your .lacuna.json is not changed.`
  const proceed = await vscode.window.showInformationMessage(
    `Set up ${label} for this project?`,
    { modal: true, detail },
    'Install',
  )
  if (proceed !== 'Install') return

  // Omit --runner when auto-detecting so the scaffold script resolves it (detect → vitest fallback).
  const args = runner ? ['--runner', runner] : []
  if (sourceDir) { args.push('--source-dir', sourceDir) }
  // Pass the configured setup-file path so the scaffolded file lands where .lacuna.json says it is,
  // instead of the framework default (which left `setupFile: test/setup.ts` pointing at a file the
  // scaffold actually created under src/test/).
  if (config?.setupFile) { args.push('--setup-file', config.setupFile) }
  const term = vscode.window.createTerminal({ name: 'Lacuna Setup', cwd })
  term.show()
  term.sendText(`node ${[scaffoldScript, ...args].map(shellQuote).join(' ')}`)
}

/**
 * After the settings form saves `.lacuna.json`, offer to run the install/scaffold when the project
 * isn't FULLY set up — deps + runner config + a real `test` script (see isSetupComplete). Gating on
 * completeness (not merely "is the runner installed") is what fixes projects that had the test
 * packages in node_modules but no config/setup file/scripts: they were silently treated as done and
 * broke later. The scaffold is idempotent, so offering when only some pieces are missing is safe.
 * No-op for non-Node runners.
 */
export async function offerScaffoldAfterSave(cwd: string, scaffoldScript: string): Promise<void> {
  const config = await readConfig(cwd)
  const runner = config?.testRunner
  // Concrete non-Node runner → nothing to install, no nudge.
  if (runner && !NODE_RUNNERS.has(runner)) return
  // Fully set up already → don't nag on every settings save. (An absent runner means auto-detect
  // wrote nothing; we can't evaluate completeness, so let runScaffold self-detect and decide.)
  if (runner && await isSetupComplete(cwd, runner)) return
  await runScaffold(cwd, scaffoldScript)
}

// Minimal POSIX-ish quoting so a path/runner with spaces doesn't break the command line.
function shellQuote(s: string): string {
  return /[^\w./@-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s
}
