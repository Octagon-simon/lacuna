import * as vscode from 'vscode'
import { globalMemoryRoot, readEntry, deleteEntry, MEMORY_CATEGORIES } from '../core'
import type { RunHandle } from '../services/run-manager'

/**
 * §3.3 — in-the-moment correction. When a run used learned rules but a file still failed, the
 * failure panel is the best place to ask whether the rule that just proved unhelpful should be
 * kept or flagged, rather than waiting for slow, silent confidence decay. The CLI has no surface
 * for this human-in-the-loop signal.
 */
export async function maybeOfferMemoryCorrection(run: RunHandle): Promise<void> {
  const failed = run.failedWithMemory()
  if (failed.length === 0) return
  const ids = [...new Set(failed.flatMap((f) => f.entries))]

  const KEEP = 'Keep'
  const FLAG = 'Review / Delete a rule…'
  const VIEW = 'Open Memory View'
  const choice = await vscode.window.showWarningMessage(
    `Lacuna used ${ids.length} learned rule(s) that didn't resolve ${failed.length} still-failing file(s): ${ids.join(', ')}. Keep them, or review?`,
    KEEP, FLAG, VIEW,
  )
  if (choice === VIEW) {
    await vscode.commands.executeCommand('lacuna.memoryView.focus')
    return
  }
  if (choice !== FLAG) return

  const root = globalMemoryRoot()
  const pick = await vscode.window.showQuickPick(ids, { title: 'Which learned rule looked wrong?', placeHolder: 'Select a rule id' })
  if (!pick) return

  const entry = await resolveEntry(root, pick)
  if (!entry) { vscode.window.showWarningMessage(`Lacuna: rule ${pick} not found (it may already be gone).`); return }

  const DELETE = 'Delete Rule'
  const detail = `${entry.summary}\n\nRule: ${entry.rule}\nConfidence: ${entry.confidence.toFixed(2)} · Hits: ${entry.hit_count}`
  const act = await vscode.window.showWarningMessage(
    `Delete learned rule "${pick}"?`, { modal: true, detail }, DELETE,
  )
  if (act === DELETE) {
    await deleteEntry(root, entry.category, entry.id)
    vscode.window.showInformationMessage(`Lacuna: deleted rule ${pick}.`)
    await vscode.commands.executeCommand('lacuna.memory.refresh')
  }
}

async function resolveEntry(root: string, id: string) {
  for (const cat of MEMORY_CATEGORIES) {
    const e = await readEntry(root, cat, id).catch(() => null)
    if (e) return e
  }
  return null
}
