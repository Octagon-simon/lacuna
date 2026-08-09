import * as vscode from 'vscode'
import { RunManager } from '../services/run-manager'
import { ApprovalService } from '../services/approval-service'
import type { WorkerState } from '../core'

/**
 * Two always-visible truths (§1, §2): whether a run is active (and spending), and whether the
 * workspace is in "acts first" Auto Mode. Both must be unmissable and one-click actionable.
 */
export class StatusBar implements vscode.Disposable {
  private readonly runItem: vscode.StatusBarItem
  private readonly autoItem: vscode.StatusBarItem
  private readonly disposables: vscode.Disposable[] = []
  private runSub: vscode.Disposable | undefined

  constructor(private readonly runs: RunManager, private readonly approval: ApprovalService) {
    this.runItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.runItem.command = 'lacuna.showActiveRun'
    this.autoItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
    this.autoItem.command = 'lacuna.toggleAutoMode'

    this.disposables.push(
      this.runItem, this.autoItem,
      runs.onDidChangeActiveRuns(() => this.renderRun()),
      approval.onDidChangeAutoMode(() => this.renderAuto()),
    )
    this.renderRun()
    this.renderAuto()
  }

  private renderAuto() {
    if (this.approval.isAutoMode()) {
      this.autoItem.text = '$(zap) Lacuna: Auto'
      this.autoItem.tooltip = 'Auto Mode is ON — runs start without per-run confirmation (mocks-file and environment changes still ask). Click to turn off.'
      this.autoItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
      this.autoItem.show()
    } else {
      // Only shown when active — an "asks first" mode needs no persistent nag.
      this.autoItem.hide()
    }
  }

  private renderRun() {
    this.runSub?.dispose()
    this.runSub = undefined
    const active = this.runs.activeRuns
    if (active.length === 0) {
      this.runItem.hide()
      return
    }
    const run = active[active.length - 1]
    const base = active.length > 1 ? `${active.length} runs` : run.title
    this.runItem.text = `$(sync~spin) Lacuna: ${base}`
    this.runItem.tooltip = 'A Lacuna run is active and making API requests. Click to open its progress panel.'
    this.runItem.show()
    // Live phase text from the most recent run.
    this.runSub = run.onMessage((m) => {
      if (m.type === 'phase') this.runItem.text = `$(sync~spin) Lacuna: ${phaseLabel(m.state)}`
      else if (m.type === 'done') this.renderRun()
    })
  }

  dispose() {
    this.runSub?.dispose()
    for (const d of this.disposables) d.dispose()
  }
}

function phaseLabel(state: WorkerState): string {
  const file = 'file' in state ? shorten(state.file) : ''
  switch (state.phase) {
    case 'retrying': return `fixing ${file} (attempt ${state.attempt}/${state.max})`
    case 'generating': return `generating ${file}`
    case 'writing': return `writing ${file}`
    case 'running': return `testing ${file}`
    case 'waiting': return `waiting · ${file}`
    case 'regenerating': return `regenerating ${file}`
    case 'fixing': return `fixing ${file}`
    case 'passed': return `${file} ✓`
    case 'failed': return `${file} ✗`
    default: return file
  }
}

function shorten(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}
