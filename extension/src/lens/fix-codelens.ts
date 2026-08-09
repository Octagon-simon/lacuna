import * as vscode from 'vscode'
import { isTestFile } from '../commands'

/**
 * Phase 2 — an inline "Fix Failing Tests with Lacuna" action at the top of any test file. It is an
 * entry point, not a claim the tests are currently failing (knowing that needs a run); Lacuna
 * skips already-passing files itself.
 */
export class FixCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isTestFile(document.uri.fsPath)) return []
    const top = new vscode.Range(0, 0, 0, 0)
    return [
      new vscode.CodeLens(top, { title: '$(wrench) Fix Failing Tests with Lacuna', command: 'lacuna.fixTests', arguments: [document.uri] }),
    ]
  }
}

export function registerFixCodeLens(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'typescript' }, { language: 'typescriptreact' },
        { language: 'javascript' }, { language: 'javascriptreact' },
      ],
      new FixCodeLensProvider(),
    ),
  )
}
