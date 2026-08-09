import * as vscode from 'vscode'
import * as path from 'node:path'
import { loadCoverage } from '../core'
import type { CoverageReport } from '../core'
import { resolveProject } from '../services/config-service'

/**
 * Phase 2 — paint uncovered lines from the LCOV report in the gutter / overview ruler of the
 * active editor, so gaps are visible where you are already looking.
 */
export class CoverageGutters implements vscode.Disposable {
  private readonly uncovered: vscode.TextEditorDecorationType
  private readonly disposables: vscode.Disposable[] = []
  private reportByFolder = new Map<string, { report: CoverageReport; loadedAt: number }>()

  constructor() {
    this.uncovered = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.errorForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    })
    this.disposables.push(
      this.uncovered,
      vscode.window.onDidChangeActiveTextEditor((e) => e && this.decorate(e)),
      vscode.workspace.onDidSaveTextDocument(() => this.invalidate()),
    )
    if (vscode.window.activeTextEditor) void this.decorate(vscode.window.activeTextEditor)
  }

  invalidate() {
    this.reportByFolder.clear()
    if (vscode.window.activeTextEditor) void this.decorate(vscode.window.activeTextEditor)
  }

  private async decorate(editor: vscode.TextEditor) {
    const uri = editor.document.uri
    if (uri.scheme !== 'file') return
    const folder = vscode.workspace.getWorkspaceFolder(uri)
    if (!folder) return
    const report = await this.reportFor(folder)
    if (!report) { editor.setDecorations(this.uncovered, []); return }

    const target = uri.fsPath
    const file = report.files.find((f) => {
      const abs = f.path.startsWith('/') ? f.path : path.join(folder.uri.fsPath, f.path)
      return abs === target
    })
    if (!file) { editor.setDecorations(this.uncovered, []); return }

    const ranges = file.lines
      .filter((l) => l.hit === 0)
      .map((l) => new vscode.Range(l.line - 1, 0, l.line - 1, 0))
    editor.setDecorations(this.uncovered, ranges)
  }

  private async reportFor(folder: vscode.WorkspaceFolder): Promise<CoverageReport | null> {
    const key = folder.uri.fsPath
    const cached = this.reportByFolder.get(key)
    if (cached && Date.now() - cached.loadedAt < 15000) return cached.report
    try {
      const project = await resolveProject(folder.uri)
      const report = await loadCoverage(project.config, project.cwd)
      this.reportByFolder.set(key, { report, loadedAt: Date.now() })
      return report
    } catch {
      return null
    }
  }

  dispose() { for (const d of this.disposables) d.dispose() }
}
