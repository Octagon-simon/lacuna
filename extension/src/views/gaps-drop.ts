import * as vscode from 'vscode'
import { isTestFile } from '../commands'

/**
 * Phase 2 nicety — drop a source file (or multi-selection) from the Explorer onto the Coverage
 * Gaps view to queue generation, exactly like the right-click command.
 */
export class GapsDropController implements vscode.TreeDragAndDropController<unknown> {
  readonly dropMimeTypes = ['text/uri-list']
  readonly dragMimeTypes: string[] = []

  async handleDrop(_target: unknown, sources: vscode.DataTransfer): Promise<void> {
    const item = sources.get('text/uri-list')
    if (!item) return
    const uris = (await item.asString())
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => vscode.Uri.parse(l))
      .filter((u) => u.scheme === 'file' && !isTestFile(u.fsPath))
    if (uris.length === 0) return
    if (uris.length === 1) await vscode.commands.executeCommand('lacuna.generateTests', uris[0])
    else await vscode.commands.executeCommand('lacuna.generateSelected', uris[0], uris)
  }
}
