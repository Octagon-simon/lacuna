import * as vscode from 'vscode'

/**
 * Phase 3 — open a per-file prompt/response debug log. Lacuna writes `lacuna-debug.<file>.txt`
 * when `debug` is on in `.lacuna.json` (or LACUNA_DEBUG=1). This just surfaces them for reading.
 */
export async function showDebugLog(): Promise<void> {
  const found = await vscode.workspace.findFiles('**/lacuna-debug*.txt', '**/node_modules/**', 50)
  if (found.length === 0) {
    vscode.window.showInformationMessage('Lacuna: no debug logs found. Enable "debug" in .lacuna.json (or set LACUNA_DEBUG=1) and run again.')
    return
  }
  const pick = found.length === 1
    ? found[0]
    : (await vscode.window.showQuickPick(
        found.map((u) => ({ label: u.path.split('/').pop() || u.path, uri: u })),
        { title: 'Open Lacuna debug log', placeHolder: 'Select a per-file debug log' },
      ))?.uri
  if (!pick) return
  const doc = await vscode.workspace.openTextDocument(pick)
  await vscode.window.showTextDocument(doc, { preview: true })
}
