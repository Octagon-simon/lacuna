import * as vscode from 'vscode'
import { iterationCeiling } from '../core'
import type { LacunaConfig } from '../core'

const AUTO_MODE_KEY = 'lacuna.autoMode'
const FIRST_RUN_KEY = 'lacuna.firstRunSeen'

export interface ConfirmRequest {
  kind: 'generate' | 'fix'
  files: string[]
  config: LacunaConfig
}

/**
 * Owns the disclosure (§1) and approval (§2) models. State is per-workspace: a workspace the user
 * has run cleanly in is a different trust level than one just opened.
 */
export class ApprovalService {
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeAutoMode = this._onDidChange.event

  constructor(private readonly memento: vscode.Memento) {}

  isAutoMode(): boolean {
    return this.memento.get<boolean>(AUTO_MODE_KEY, false)
  }

  async setAutoMode(on: boolean): Promise<void> {
    await this.memento.update(AUTO_MODE_KEY, on)
    await vscode.commands.executeCommand('setContext', 'lacuna.autoMode', on)
    this._onDidChange.fire()
  }

  async toggleAutoMode(): Promise<void> {
    await this.setAutoMode(!this.isAutoMode())
  }

  /**
   * Gate a run. Returns true to proceed. Shows the one-time first-run modal (§1) before the very
   * first run in this workspace, then the Tier-1 confirmation surface unless Auto Mode is on or
   * the user disabled confirmations. Never fire-and-forget.
   */
  async confirmRun(req: ConfirmRequest): Promise<boolean> {
    if (!(await this.ensureFirstRunAck(req.config))) return false

    const confirmSetting = vscode.workspace.getConfiguration('lacuna').get<boolean>('confirmBeforeRun', true)
    if (this.isAutoMode() || !confirmSetting) return true

    // Worst case uses the convergence CEILING (up to 2× maxIterations), not the flat base — a file
    // that keeps making progress can run past maxIterations, so the cost disclosure must reflect
    // the real upper bound rather than under-stating it.
    const perFileMax = iterationCeiling(req.config.maxIterations)
    const worstCase = Math.max(1, req.files.length) * perFileMax
    const verb = req.kind === 'generate' ? 'Generate tests for' : 'Fix'
    const fileLabel = req.files.length === 1 ? req.files[0] : `${req.files.length} file(s)`
    const detail =
      `${verb} ${fileLabel}\n\n` +
      `Model:    ${req.config.model} (${req.config.provider})\n` +
      `Retries:  up to ${req.config.maxIterations} per file (up to ${perFileMax} while it keeps making progress)\n` +
      `Worst case: ~${worstCase} model request(s) before this finishes.\n\n` +
      `This makes real, metered API calls and writes files you'll review in a diff before keeping.`

    const RUN = 'Run'
    const AUTO = 'Run + Enable Auto Mode'
    const choice = await vscode.window.showWarningMessage(
      `Lacuna: ${verb.toLowerCase()} ${fileLabel}?`,
      { modal: true, detail },
      RUN, AUTO,
    )
    if (choice === AUTO) { await this.setAutoMode(true); return true }
    return choice === RUN
  }

  /** The one-time, must-be-seen-once workspace disclosure before the first API call ever. */
  private async ensureFirstRunAck(config: LacunaConfig): Promise<boolean> {
    if (this.memento.get<boolean>(FIRST_RUN_KEY, false)) return true
    const PROCEED = 'I understand — continue'
    const detail =
      `Lacuna will call ${config.model} (${config.provider}) to generate/fix tests.\n\n` +
      `• It makes real API requests billed to your configured key.\n` +
      `• It runs in the background and writes files to disk.\n` +
      `• You review a diff before anything is kept.\n\n` +
      `You can stop a run at any time, and you'll always see it in the status bar while it's active.`
    const choice = await vscode.window.showInformationMessage(
      'Before Lacuna makes its first API call in this workspace',
      { modal: true, detail },
      PROCEED,
    )
    if (choice !== PROCEED) return false
    await this.memento.update(FIRST_RUN_KEY, true)
    return true
  }

  /**
   * Tier 3 (§2): environment mutation (e.g. installing test deps during setup) ALWAYS requires
   * explicit approval, even in Auto Mode.
   */
  async confirmEnvMutation(what: string): Promise<boolean> {
    const YES = 'Allow'
    const choice = await vscode.window.showWarningMessage(
      `Lacuna wants to modify your environment: ${what}`,
      { modal: true, detail: 'This changes files outside your test suite (dependencies / config). It is never done automatically, even in Auto Mode.' },
      YES,
    )
    return choice === YES
  }
}
