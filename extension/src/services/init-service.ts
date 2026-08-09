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

interface LacunaConfigShape { testRunner?: string; sourceDir?: string[] | string }

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

// Whether the runner's binary is present in node_modules. This — NOT "does .lacuna.json exist" — is
// the correct signal for "does this project still need the install/scaffold step": a project can
// have a saved config but no installed deps (e.g. config written, npm install never run). The
// auto-offer keys off this so it fires exactly when there's real setup work left, and stays quiet on
// an already-provisioned project.
async function isRunnerInstalled(cwd: string, runner: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(cwd, 'node_modules', '.bin', runner)))
    return true
  } catch { return false }
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
  const term = vscode.window.createTerminal({ name: 'Lacuna Setup', cwd })
  term.show()
  term.sendText(`node ${[scaffoldScript, ...args].map(shellQuote).join(' ')}`)
}

/**
 * First-run nudge: after the settings form saves `.lacuna.json` on a fresh project, offer to run the
 * install/scaffold so the project is actually runnable (a bare `.lacuna.json` with no runner
 * installed would fail the first generate/fix). No-op for non-Node runners.
 */
export async function offerScaffoldAfterSave(cwd: string, scaffoldScript: string): Promise<void> {
  const config = await readConfig(cwd)
  const runner = config?.testRunner
  // Concrete non-Node runner → nothing to install, no nudge.
  if (runner && !NODE_RUNNERS.has(runner)) return
  // A Node runner that's already installed → the project is set up, don't nag on every settings save.
  // (An absent runner means auto-detect wrote nothing; we can't know it's installed, so let
  // runScaffold — which detects + checks — decide.)
  if (runner && await isRunnerInstalled(cwd, runner)) return
  await runScaffold(cwd, scaffoldScript)
}

// Minimal POSIX-ish quoting so a path/runner with spaces doesn't break the command line.
function shellQuote(s: string): string {
  return /[^\w./@-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s
}
