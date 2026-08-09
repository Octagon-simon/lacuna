import * as vscode from 'vscode'
import * as path from 'node:path'
import type { CoverageGap } from '../core'
import { resolveProject, isConfigured } from '../services/config-service'
import { discoverGaps } from '../commands'

interface GapNode { gap: CoverageGap }

/**
 * Phase 2 — one entry per source file below threshold / with no test. Click jumps to the file;
 * the inline action generates tests for it. Backed by the same discovery the CLI's analyze uses.
 */
export class GapsTreeProvider implements vscode.TreeDataProvider<GapNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private cache: GapNode[] | undefined

  refresh() { this.cache = undefined; this._onDidChange.fire() }

  getTreeItem(node: GapNode): vscode.TreeItem {
    const uri = vscode.Uri.file(node.gap.filePath)
    const folder = vscode.workspace.getWorkspaceFolder(uri)
    const rel = folder ? path.relative(folder.uri.fsPath, node.gap.filePath) : node.gap.filePath
    const item = new vscode.TreeItem(path.basename(rel), vscode.TreeItemCollapsibleState.None)
    item.description = path.dirname(rel)
    item.resourceUri = uri
    item.contextValue = 'gap'
    item.iconPath = new vscode.ThemeIcon('beaker')
    const fns = node.gap.uncoveredFunctions
    item.tooltip = fns.length ? `Uncovered: ${fns.slice(0, 8).join(', ')}${fns.length > 8 ? '…' : ''}` : 'No test file / below threshold'
    item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] }
    return item
  }

  async getChildren(): Promise<GapNode[]> {
    if (this.cache) return this.cache
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return []
    // Don't discover gaps against a DEFAULT config on an unconfigured project — loadConfig returns
    // defaults (never throws) when there's no .lacuna.json, so without this the tree would walk src/
    // and show every untested file as a "gap", overriding (after a flash) the "Set Up" welcome.
    if (!(await isConfigured(folder.uri.fsPath))) return []
    try {
      const project = await resolveProject(folder.uri)
      const gaps = await discoverGaps(project)
      this.cache = gaps
        .sort((a, b) => a.filePath.localeCompare(b.filePath))
        .map((gap) => ({ gap }))
      return this.cache
    } catch {
      return []
    }
  }
}

// Creates the provider and its refresh command, but does NOT register the tree view — extension.ts
// owns that via createTreeView (it attaches the drag-and-drop controller). Registering here too
// would double-register the same view id.
export function registerGapsView(context: vscode.ExtensionContext): GapsTreeProvider {
  const provider = new GapsTreeProvider()
  context.subscriptions.push(
    vscode.commands.registerCommand('lacuna.gaps.refresh', () => provider.refresh()),
  )
  return provider
}
