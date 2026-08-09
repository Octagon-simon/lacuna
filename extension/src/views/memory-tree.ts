import * as vscode from 'vscode'
import { globalMemoryRoot, readIndex, readEntry, deleteEntry, MEMORY_CATEGORIES } from '../core'
import type { MemoryEntry, MemoryCategory } from '../core'

type Node = CategoryNode | EntryNode
interface CategoryNode { kind: 'category'; category: MemoryCategory; count: number }
interface EntryNode { kind: 'entry'; entry: MemoryEntry }

type SortKey = 'confidence' | 'hit_count'

/**
 * §3.2 — a browsable view of the learned-rules store, backed directly by the same memory
 * functions the `lacuna memory` CLI uses. Grouped by category, sortable by confidence / hit count,
 * with delete exposed as a UI action instead of a CLI arg.
 */
export class MemoryTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private sortKey: SortKey = 'confidence'

  refresh() { this._onDidChange.fire() }
  setSort(k: SortKey) { this.sortKey = k; this.refresh() }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'category') {
      const item = new vscode.TreeItem(`${node.category} (${node.count})`, vscode.TreeItemCollapsibleState.Expanded)
      item.contextValue = 'memoryCategory'
      item.iconPath = new vscode.ThemeIcon('symbol-namespace')
      return item
    }
    const e = node.entry
    const item = new vscode.TreeItem(e.id, vscode.TreeItemCollapsibleState.None)
    item.description = `conf ${e.confidence.toFixed(2)} · hits ${e.hit_count}`
    item.tooltip = new vscode.MarkdownString(
      `**${e.id}**\n\n${e.summary}\n\n\`\`\`\n${e.rule}\n\`\`\`\n\n_tags: ${e.tags.join(', ')} · source: ${e.source}_`,
    )
    item.contextValue = 'memoryEntry'
    item.iconPath = new vscode.ThemeIcon(e.source === 'seed' ? 'lightbulb' : e.source === 'web' ? 'globe' : 'sparkle')
    item.command = { command: 'lacuna.memory.show', title: 'Show', arguments: [node] }
    return item
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const root = globalMemoryRoot()
    const byCat = await this.loadByCategory(root)
    if (!node) {
      return MEMORY_CATEGORIES
        .filter((c) => (byCat.get(c)?.length ?? 0) > 0)
        .map((c) => ({ kind: 'category', category: c, count: byCat.get(c)!.length }))
    }
    if (node.kind === 'category') {
      const entries = [...(byCat.get(node.category) ?? [])]
      entries.sort((a, b) => (this.sortKey === 'confidence' ? b.confidence - a.confidence : b.hit_count - a.hit_count))
      return entries.map((entry) => ({ kind: 'entry', entry }))
    }
    return []
  }

  private async loadByCategory(root: string): Promise<Map<MemoryCategory, MemoryEntry[]>> {
    const map = new Map<MemoryCategory, MemoryEntry[]>()
    let index: Record<string, string[]>
    try { index = await readIndex(root) } catch { return map }
    const refs = new Set<string>()
    for (const list of Object.values(index)) for (const ref of list) refs.add(ref)
    await Promise.all([...refs].map(async (ref) => {
      const slash = ref.indexOf('/')
      if (slash < 0) return
      const category = ref.slice(0, slash) as MemoryCategory
      const id = ref.slice(slash + 1)
      const entry = await readEntry(root, category, id).catch(() => null)
      if (entry) { const arr = map.get(category) ?? []; arr.push(entry); map.set(category, arr) }
    }))
    return map
  }
}

export function registerMemoryView(context: vscode.ExtensionContext): MemoryTreeProvider {
  const provider = new MemoryTreeProvider()
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('lacuna.memoryView', provider),
    vscode.commands.registerCommand('lacuna.memory.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('lacuna.memory.sortConfidence', () => provider.setSort('confidence')),
    vscode.commands.registerCommand('lacuna.memory.sortHits', () => provider.setSort('hit_count')),
    vscode.commands.registerCommand('lacuna.memory.show', (node?: { entry?: MemoryEntry }) => {
      if (!node?.entry) return
      const e = node.entry
      const md = new vscode.MarkdownString(
        `## ${e.id}\n\n**${e.summary}**\n\n\`\`\`\n${e.rule}\n\`\`\`\n\n` +
        `- category: \`${e.category}\`\n- confidence: ${e.confidence.toFixed(2)}\n- hits: ${e.hit_count}\n` +
        `- tags: ${e.tags.map((t) => '`' + t + '`').join(', ')}\n- source: ${e.source}\n- created: ${e.created_at}`,
      )
      md.supportHtml = true
      vscode.window.showInformationMessage(e.summary, { modal: false })
      // Also open a readable rendering.
      void vscode.workspace.openTextDocument({ language: 'markdown', content: md.value })
        .then((doc) => vscode.window.showTextDocument(doc, { preview: true }))
    }),
    vscode.commands.registerCommand('lacuna.memory.delete', async (node?: { entry?: MemoryEntry }) => {
      if (!node?.entry) return
      const e = node.entry
      const DEL = 'Delete'
      const c = await vscode.window.showWarningMessage(`Delete learned rule "${e.id}"?`, { modal: true, detail: e.summary }, DEL)
      if (c === DEL) {
        await deleteEntry(globalMemoryRoot(), e.category, e.id)
        provider.refresh()
      }
    }),
  )
  return provider
}
