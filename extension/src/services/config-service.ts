import * as vscode from 'vscode'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { loadConfig, detectEnvironment } from '../core'
import type { LacunaConfig, DetectedEnvironment } from '../core'

const CONFIG_FILENAMES = [
  '.lacuna.json',
  '.lacunarc',
  '.lacunarc.json',
  '.lacunarc.yaml',
  '.lacunarc.yml',
  'lacuna.config.js',
  'lacuna.config.cjs',
]

export interface ResolvedProject {
  cwd: string
  config: LacunaConfig
  env: DetectedEnvironment
  folder: vscode.WorkspaceFolder
}

/** The workspace folder that owns a given resource (defaults to the first folder). */
export function folderFor(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (resource) {
    const f = vscode.workspace.getWorkspaceFolder(resource)
    if (f) return f
  }
  return vscode.workspace.workspaceFolders?.[0]
}

/** True when the folder has a lacuna config file (loadConfig silently defaults otherwise). */
export async function isConfigured(cwd: string): Promise<boolean> {
  // package.json#lacuna also counts as configuration.
  const checks = CONFIG_FILENAMES.map(async (name) => {
    try { await fs.access(path.join(cwd, name)); return true } catch { return false }
  })
  if ((await Promise.all(checks)).some(Boolean)) return true
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf-8'))
    return pkg && typeof pkg === 'object' && 'lacuna' in pkg
  } catch {
    return false
  }
}

/**
 * Load config + detect the environment for the folder owning `resource`. Applies the VS Code-side
 * settings that intentionally live outside `.lacuna.json` (see handoff §6 q3). Throws a friendly
 * error if there is no workspace folder.
 */
export async function resolveProject(resource?: vscode.Uri): Promise<ResolvedProject> {
  const folder = folderFor(resource)
  if (!folder) throw new Error('Open a folder to use Lacuna.')
  const cwd = folder.uri.fsPath
  const config = await loadConfig(cwd)
  const env = await detectEnvironment(cwd, config.testRunner)
  if (config.testCommand) env.testCommand = config.testCommand
  return { cwd, config, env, folder }
}

/** Refresh the `lacuna.configured` context key that gates views / welcome content. */
export async function refreshConfiguredContext(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  const configured = folder ? await isConfigured(folder.uri.fsPath) : false
  await vscode.commands.executeCommand('setContext', 'lacuna.configured', configured)
}
