import * as vscode from 'vscode'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import { mocksFileList } from '../core'
import type { LacunaConfig } from '../core'

const pExecFile = promisify(execFile)

// A file lacuna would have written as a test. Kept local (not imported from commands.ts) to avoid a
// circular import. Mirrors the `.test`/`.spec`/`__tests__`/`test_`/`_test` conventions lacuna uses.
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[jt]sx?$|__tests__\/|\/test_[^/]+\.[jt]sx?$|_test\.[jt]sx?$)/

// Serves pre-run "before" content to the native diff editor (read-only left side).
export class BeforeContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'lacuna-before'
  private readonly store = new Map<string, string>()
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this._onDidChange.event

  set(key: string, content: string) { this.store.set(key, content) }
  provideTextDocumentContent(uri: vscode.Uri): string { return this.store.get(uri.query) ?? '' }
  uriFor(key: string, label: string): vscode.Uri {
    return vscode.Uri.parse(`${BeforeContentProvider.scheme}:${label}?${encodeURIComponent(key)}`)
      .with({ query: key })
  }
}

async function gitHead(cwd: string, rel: string): Promise<string | null> {
  try {
    const { stdout } = await pExecFile('git', ['show', `HEAD:${rel}`], { cwd, maxBuffer: 20 * 1024 * 1024 })
    return stdout
  } catch {
    return null // untracked / new file / not a git repo
  }
}

/**
 * A diff-review session around one run (§2). Snapshots the shared mocks file(s) up front (their
 * exact pre-run content — tier 2b must be reviewable precisely), watches for files the run
 * touches, and after the run presents the test-file changes and — always separately, even in Auto
 * Mode — the mocks-file change.
 */
export class DiffSession {
  private readonly mocksAbs: Set<string>
  private readonly preRun = new Map<string, string>() // abs path -> before content
  private readonly changed = new Set<string>()
  private readonly watcher: vscode.FileSystemWatcher

  private readonly ignoredPrefixes: string[]

  constructor(
    private readonly cwd: string,
    config: LacunaConfig,
    private readonly before: BeforeContentProvider,
  ) {
    this.mocksAbs = new Set(mocksFileList(config).map((m) => path.resolve(cwd, m)))
    // Generated / non-source trees a run legitimately writes to but the user must NEVER be asked to
    // review — most importantly the coverage report dir, whose lcov-report/*.js (prettify, sorter,
    // block-navigation) jest rewrites on every run. lacuna itself only writes test files + the mocks
    // file, so anything here is incidental output.
    const generatedDirs = [config.coverageDir || 'coverage', 'node_modules', 'dist', 'build', '.next', 'out', '.nyc_output', '.turbo']
    this.ignoredPrefixes = generatedDirs.map((d) => path.resolve(cwd, d) + path.sep)
    const pattern = new vscode.RelativePattern(cwd, '**/*.{ts,tsx,js,jsx,mts,cts}')
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern)
    const track = (u: vscode.Uri) => { if (!this.isIgnored(u.fsPath)) this.changed.add(u.fsPath) }
    this.watcher.onDidChange(track)
    this.watcher.onDidCreate(track)
  }

  private isIgnored(fsPath: string): boolean {
    return this.ignoredPrefixes.some((p) => fsPath.startsWith(p))
  }

  /** Snapshot known-important files (the mocks file) BEFORE the run mutates them. */
  async snapshot(): Promise<void> {
    for (const abs of this.mocksAbs) {
      try {
        const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(abs))
        this.preRun.set(abs, Buffer.from(buf).toString('utf8'))
      } catch { /* mocks file may not exist yet — before = none */ }
    }
  }

  dispose() { this.watcher.dispose() }

  /**
   * Present the review. Test-file changes first, then the mocks-file change separately/explicitly.
   * Returns nothing; user acts through the diff editors' Accept/Reject prompts.
   */
  async review(): Promise<void> {
    this.dispose()
    const files = [...this.changed].filter((f) => !f.endsWith('.d.ts') && !this.isIgnored(f))
    // lacuna only ever writes TEST files and the shared mocks file — restrict the review to exactly
    // those so incidental churn (coverage output, a formatter touching a neighbour, etc.) is never
    // offered for accept/reject.
    const testFiles = files.filter((f) => TEST_FILE_RE.test(f) && !this.mocksAbs.has(f))
    const mocksFiles = files.filter((f) => this.mocksAbs.has(f))

    if (testFiles.length === 0 && mocksFiles.length === 0) {
      vscode.window.showInformationMessage('Lacuna: no file changes to review.')
      return
    }

    for (const f of testFiles) await this.reviewOne(f, 'test file')
    // Tier 2b: the shared mocks file is imported by every test — always its own explicit review.
    for (const f of mocksFiles) await this.reviewOne(f, 'shared mocks file', true)
  }

  private async reviewOne(abs: string, label: string, emphasise = false): Promise<void> {
    const rel = path.relative(this.cwd, abs)
    const beforeContent = this.preRun.get(abs) ?? (await gitHead(this.cwd, rel)) ?? ''
    const isNew = beforeContent === ''

    this.before.set(abs, beforeContent)
    const leftUri = this.before.uriFor(abs, `${rel} (before)`)
    const rightUri = vscode.Uri.file(abs)
    await vscode.commands.executeCommand(
      'vscode.diff', leftUri, rightUri,
      `${rel} — Lacuna ${label}${isNew ? ' (new)' : ''}`,
      { preview: true },
    )

    const ACCEPT = 'Accept'
    const REJECT = isNew ? 'Reject (delete)' : 'Reject (revert)'
    const prompt = emphasise
      ? `Review the SHARED MOCKS file ${rel}. Every test imports it — a bad change here breaks the whole suite.`
      : `Keep Lacuna's changes to ${rel}?`
    const choice = await vscode.window.showInformationMessage(prompt, { modal: false }, ACCEPT, REJECT)

    if (choice === REJECT) {
      if (isNew) {
        await vscode.workspace.fs.delete(rightUri).then(undefined, () => {})
      } else {
        await vscode.workspace.fs.writeFile(rightUri, Buffer.from(beforeContent, 'utf8'))
      }
      vscode.window.setStatusBarMessage(`Lacuna: reverted ${rel}`, 3000)
    }
  }
}
