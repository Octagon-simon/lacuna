import * as vscode from 'vscode'
import { KeyService } from './services/key-service'
import { ApprovalService } from './services/approval-service'
import { RunManager } from './services/run-manager'
import { Commands } from './commands'
import type { Services } from './commands'
import { StatusBar } from './ui/status-bar'
import { BeforeContentProvider } from './ui/diff'
import { registerMemoryView } from './views/memory-tree'
import { registerGapsView } from './views/gaps-tree'
import { GapsDropController } from './views/gaps-drop'
import { registerFixCodeLens } from './lens/fix-codelens'
import { CoverageGutters } from './coverage/gutters'
import { SettingsPanel } from './ui/settings-panel'
import { runInit, runScaffold } from './services/init-service'
import { showDebugLog } from './ui/debug-viewer'
import { refreshConfiguredContext } from './services/config-service'

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Lacuna', 'log')
  const keys = new KeyService(context.secrets)
  const approval = new ApprovalService(context.workspaceState)
  const runs = new RunManager(output)
  const before = new BeforeContentProvider()

  // Sidebars.
  const memoryView = registerMemoryView(context)
  const gapsView = registerGapsView(context)
  const gutters = new CoverageGutters()
  registerFixCodeLens(context)

  const refreshViews = () => { gapsView.refresh(); memoryView.refresh(); gutters.invalidate() }

  const services: Services = { keys, approval, runs, output, before, context, refreshViews }
  const commands = new Commands(services)
  const statusBar = new StatusBar(runs, approval)

  context.subscriptions.push(
    output,
    { dispose: () => statusBar.dispose() },
    gutters,
    vscode.workspace.registerTextDocumentContentProvider(BeforeContentProvider.scheme, before),
    // Gaps view with drag-and-drop.
    vscode.window.createTreeView('lacuna.gapsView', { treeDataProvider: gapsView, dragAndDropController: new GapsDropController() }),
    ...commands.register(),
    // Commands owned by the entry point (setup / config / debug).
    vscode.commands.registerCommand('lacuna.openSettings', () => SettingsPanel.show(context)),
    vscode.commands.registerCommand('lacuna.runInit', () => runInit(context)),
    vscode.commands.registerCommand('lacuna.runSetup', () => {
      const folder = vscode.workspace.workspaceFolders?.[0]
      if (!folder) { vscode.window.showWarningMessage('Open a folder to set up Lacuna.'); return }
      return runScaffold(folder.uri.fsPath, context.asAbsolutePath('out/scaffold.js'))
    }),
    vscode.commands.registerCommand('lacuna.showDebugLog', () => showDebugLog()),
    // Keep view gating + gaps fresh as the workspace changes.
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void refreshConfiguredContext(); gapsView.refresh() }),
    vscode.workspace.onDidCreateFiles(() => gapsView.refresh()),
    vscode.workspace.onDidDeleteFiles(() => gapsView.refresh()),
  )

  // Initialize context keys (view welcome content + auto-mode indicator).
  void refreshConfiguredContext()
  void vscode.commands.executeCommand('setContext', 'lacuna.autoMode', approval.isAutoMode())
}

export function deactivate() { /* subscriptions disposed by VS Code */ }
