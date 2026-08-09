import * as vscode from 'vscode'
import * as path from 'node:path'
import { loadCoverage, findUncoveredFiles, filterTestableGaps, extractGaps, discoverScopeGaps, DiscoverGapsError, discoverFailingTests, DiscoverFailingError } from './core'
import type { CoverageGap, CoverageReport } from './core'
import { resolveProject, folderFor, isConfigured } from './services/config-service'
import type { ResolvedProject } from './services/config-service'
import { KeyService } from './services/key-service'
import { ApprovalService } from './services/approval-service'
import { RunManager } from './services/run-manager'
import { ProgressPanel } from './ui/progress-panel'
import { DiffSession, BeforeContentProvider } from './ui/diff'
import { maybeOfferMemoryCorrection } from './ui/memory-correction'

const TEST_RE = /\.(test|spec)\.[jt]sx?$/

export function isTestFile(fsPath: string): boolean {
  return TEST_RE.test(fsPath) || fsPath.includes('__tests__/') || /\/test_[^/]+\.[jt]sx?$/.test(fsPath)
}

const EMPTY_REPORT: CoverageReport = { files: [], totalLineRate: 0, totalFunctionRate: 0 }

/**
 * Testable gaps under an optional scope dir — the confirmation count + gaps-tree source. Mirrors
 * the CLI's `analyze`: gaps come from TWO sources, unioned —
 *  1. files in the coverage report but below threshold (have some tests, need more), and
 *  2. files that never appear in the report (no test at all).
 * All paths are normalized to absolute so the tree + generate target the right file.
 */
export async function discoverGaps(project: ResolvedProject, scopeDir?: string): Promise<CoverageGap[]> {
  const { config, cwd } = project
  let report: CoverageReport
  try { report = await loadCoverage(config, cwd) } catch { report = EMPTY_REPORT }
  const abs = (p: string) => (p.startsWith('/') ? p : path.join(cwd, p))
  const inScope = (p: string) => !scopeDir || abs(p) === scopeDir || abs(p).startsWith(scopeDir + path.sep)

  // 1. Below-threshold files that already have tests (includeExisting keeps them).
  const belowThreshold = (await filterTestableGaps(
    extractGaps(report, config.threshold),
    config.ignore,
    { includeExisting: true, cwd },
  ))
    .map((g) => ({ ...g, filePath: abs(g.filePath) }))
    .filter((g) => inScope(g.filePath))

  // 2. Files never in the report (findUncoveredFiles already walks sourceDir/scopeDir + filters
  //    ignore/has-test/testable-code, and returns absolute paths).
  const untouched = await findUncoveredFiles(report, config.sourceDir, cwd, config.ignore, scopeDir)

  const seen = new Set(belowThreshold.map((g) => g.filePath))
  const gaps = [...belowThreshold]
  for (const g of untouched) if (!seen.has(g.filePath)) gaps.push(g)
  return gaps
}

export interface Services {
  keys: KeyService
  approval: ApprovalService
  runs: RunManager
  output: vscode.OutputChannel
  before: BeforeContentProvider
  context: vscode.ExtensionContext
  refreshViews: () => void
}

export class Commands {
  constructor(private readonly svc: Services) {}

  register(): vscode.Disposable[] {
    const reg = (id: string, fn: (...a: any[]) => any) => vscode.commands.registerCommand(id, fn)
    return [
      reg('lacuna.generateTests', (uri?: vscode.Uri) => this.generateForFile(uri)),
      reg('lacuna.fixTests', (uri?: vscode.Uri) => this.fixForFile(uri)),
      reg('lacuna.generateFolder', (uri?: vscode.Uri) => this.generateForFolder(uri)),
      reg('lacuna.fixFolder', (uri?: vscode.Uri) => this.fixForFolder(uri)),
      reg('lacuna.generateSelected', (uri?: vscode.Uri, uris?: vscode.Uri[]) => this.generateForSelected(uri, uris)),
      reg('lacuna.fixSelected', (uri?: vscode.Uri, uris?: vscode.Uri[]) => this.fixForSelected(uri, uris)),
      reg('lacuna.gaps.generateHere', (item: { gap?: CoverageGap }) => this.generateForGap(item?.gap)),
      reg('lacuna.toggleAutoMode', () => this.svc.approval.toggleAutoMode()),
      reg('lacuna.showActiveRun', () => {
        // If the panel tab was closed, re-open it bound to the still-running run (it replays the
        // transcript and resumes live-streaming) — not just reveal an existing one.
        const active = this.svc.runs.activeRuns
        if (active.length > 0) ProgressPanel.showFor(this.svc.output, active[active.length - 1])
        else if (!ProgressPanel.revealLatest()) vscode.window.showInformationMessage('Lacuna: no active run.')
      }),
      reg('lacuna.showRawLog', () => this.svc.output.show(true)),
      reg('lacuna.setApiKey', () => this.setApiKey()),
      reg('lacuna.clearApiKey', () => this.clearApiKey()),
    ]
  }

  // ── entry points ───────────────────────────────────────────────────────────
  private async generateForFile(uri?: vscode.Uri) {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri
    if (!target) return vscode.window.showWarningMessage('Lacuna: open or select a source file first.')
    if (isTestFile(target.fsPath)) return vscode.window.showWarningMessage('Lacuna: that is a test file. Pick the source file to generate tests for.')
    const project = await this.project(target)
    if (!project) return
    const rel = path.relative(project.cwd, target.fsPath)
    await this.run('generate', project, { targetFile: rel, files: [rel], title: `generate ${base(rel)}` })
  }

  private async fixForFile(uri?: vscode.Uri) {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri
    if (!target) return vscode.window.showWarningMessage('Lacuna: open or select a failing test file first.')
    const project = await this.project(target)
    if (!project) return
    const rel = path.relative(project.cwd, target.fsPath)
    await this.run('fix', project, { targetFile: rel, files: [rel], title: `fix ${base(rel)}` })
  }

  private async generateForFolder(uri?: vscode.Uri) {
    if (!uri) return
    const project = await this.project(uri)
    if (!project) return
    const rel = path.relative(project.cwd, uri.fsPath) || '.'
    // Discover gaps the SAME way the run will (runs the scoped coverage command fresh), not by
    // reading a possibly-stale on-disk report — otherwise the confirmation count disagrees with
    // what the run actually does, which also mis-states the cost disclosure.
    let gaps: CoverageGap[]
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Lacuna: measuring coverage under ${rel}…`, cancellable: false },
        () => discoverScopeGaps(project.config, project.env, project.cwd, uri.fsPath),
      )
      gaps = result.gaps
    } catch (e) {
      const msg = e instanceof DiscoverGapsError ? e.message : e instanceof Error ? e.message : String(e)
      return vscode.window.showErrorMessage(`Lacuna: ${msg}`)
    }
    if (gaps.length === 0) return vscode.window.showInformationMessage(`Lacuna: no testable coverage gaps under ${rel}.`)
    const files = gaps.map((g) => path.relative(project.cwd, g.filePath))
    // Parallelize across files via runAgentLoop's worker pool, capped at the file count (no point
    // spawning more workers than files).
    const workers = Math.min(files.length, this.workers())
    await this.run('generate', project, { scopeDir: uri.fsPath, files, title: `generate gaps in ${rel} (${files.length})`, workers })
  }

  private async fixForFolder(uri?: vscode.Uri) {
    if (!uri) return
    const project = await this.project(uri)
    if (!project) return
    const rel = path.relative(project.cwd, uri.fsPath) || '.'
    // Run the scoped suite to find which test files are actually failing (same discovery runFixLoop
    // does) so the confirmation states a real count — and so we can skip cleanly if all green.
    let failing: string[]
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Lacuna: finding failing tests under ${rel}…`, cancellable: false },
        () => discoverFailingTests(project.config, project.env, project.cwd, uri.fsPath),
      )
      if (result.allPassing) return vscode.window.showInformationMessage(`Lacuna: all tests under ${rel} are passing — nothing to fix.`)
      failing = result.failing
    } catch (e) {
      const msg = e instanceof DiscoverFailingError ? e.message : e instanceof Error ? e.message : String(e)
      return vscode.window.showErrorMessage(`Lacuna: ${msg}`)
    }
    if (failing.length === 0) return vscode.window.showInformationMessage(`Lacuna: no failing test files found under ${rel}.`)
    const files = failing.map((f) => path.relative(project.cwd, f))
    const workers = Math.min(files.length, this.workers())
    await this.run('fix', project, { scopeDir: uri.fsPath, files, title: `fix failing tests in ${rel} (${files.length})`, workers })
  }

  private async generateForSelected(_uri?: vscode.Uri, uris?: vscode.Uri[]) {
    const picked = (uris ?? []).filter((u) => !isTestFile(u.fsPath))
    if (picked.length === 0) return vscode.window.showWarningMessage('Lacuna: select one or more source files.')
    const project = await this.project(picked[0])
    if (!project) return
    // Batch of individual files → run them one-by-one under one confirmation via the scope of each.
    const files = picked.map((u) => path.relative(project.cwd, u.fsPath))
    // Use a synthetic parent dir scope is not possible for arbitrary selections; run sequentially
    // by targeting each. Confirm once for the batch.
    if (!(await this.svc.approval.confirmRun({ kind: 'generate', files, config: project.config }))) return
    const apiKey = await this.svc.keys.resolve(project.config, { interactive: true }).catch((e) => { vscode.window.showErrorMessage(String(e.message ?? e)); return undefined })
    if (apiKey === undefined && this.needsKey(project)) return
    for (const rel of files) {
      await this.run('generate', project, { targetFile: rel, files: [rel], title: `generate ${base(rel)}`, preConfirmed: true, apiKey })
    }
  }

  private async fixForSelected(_uri?: vscode.Uri, uris?: vscode.Uri[]) {
    const picked = (uris ?? []).filter((u) => isTestFile(u.fsPath))
    if (picked.length === 0) return vscode.window.showWarningMessage('Lacuna: select one or more test files (.test/.spec).')
    const project = await this.project(picked[0])
    if (!project) return
    const files = picked.map((u) => path.relative(project.cwd, u.fsPath))
    if (!(await this.svc.approval.confirmRun({ kind: 'fix', files, config: project.config }))) return
    const apiKey = await this.svc.keys.resolve(project.config, { interactive: true }).catch((e) => { vscode.window.showErrorMessage(String(e.message ?? e)); return undefined })
    if (apiKey === undefined && this.needsKey(project)) return
    for (const rel of files) {
      await this.run('fix', project, { targetFile: rel, files: [rel], title: `fix ${base(rel)}`, preConfirmed: true, apiKey })
    }
  }

  private async generateForGap(gap?: CoverageGap) {
    if (!gap) return
    const project = await this.project(vscode.Uri.file(gap.filePath))
    if (!project) return
    const rel = path.relative(project.cwd, gap.filePath)
    await this.run('generate', project, { targetFile: rel, files: [rel], title: `generate ${base(rel)}` })
  }

  // ── shared run flow ──────────────────────────────────────────────────────────
  private async run(
    kind: 'generate' | 'fix',
    project: ResolvedProject,
    opts: { targetFile?: string; scopeDir?: string; files: string[]; title: string; workers?: number; preConfirmed?: boolean; apiKey?: string },
  ) {
    const { config, env, cwd } = project

    if (!opts.preConfirmed) {
      if (!(await this.svc.approval.confirmRun({ kind, files: opts.files, config }))) return
    }
    let apiKey = opts.apiKey
    if (apiKey === undefined) {
      try { apiKey = await this.svc.keys.resolve(config, { interactive: true }) }
      catch (e: any) { return vscode.window.showErrorMessage(String(e?.message ?? e)) }
    }

    const diff = new DiffSession(cwd, config, this.svc.before)
    await diff.snapshot()

    const run = this.svc.runs.start({
      kind, cwd, config, env, title: opts.title, files: opts.files,
      targetFile: opts.targetFile, scopeDir: opts.scopeDir,
      workers: opts.workers ?? 1, verbose: this.verbose(), apiKey,
    })
    ProgressPanel.showFor(this.svc.output, run)

    try {
      await run.done
    } catch (e: any) {
      vscode.window.showErrorMessage(`Lacuna: ${e?.message ?? e}`)
    } finally {
      this.svc.refreshViews()
    }

    await diff.review()
    await maybeOfferMemoryCorrection(run)
  }

  // ── small commands ───────────────────────────────────────────────────────────
  private async setApiKey() {
    const project = await this.project().catch(() => undefined)
    if (!project) return
    const v = await this.svc.keys.promptAndStore(project.config)
    if (v) vscode.window.showInformationMessage(`Lacuna: stored ${project.config.apiKeyEnv}.`)
  }

  private async clearApiKey() {
    const project = await this.project().catch(() => undefined)
    if (!project) return
    await this.svc.keys.clear(project.config)
    vscode.window.showInformationMessage(`Lacuna: cleared stored ${project.config.apiKeyEnv}.`)
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private async project(resource?: vscode.Uri): Promise<ResolvedProject | undefined> {
    const folder = folderFor(resource)
    if (folder && !(await isConfigured(folder.uri.fsPath))) {
      const SET_UP = 'Set Up'
      const c = await vscode.window.showWarningMessage('Lacuna isn’t set up in this workspace yet. Finish setup, then run this again.', SET_UP)
      if (c === SET_UP) await vscode.commands.executeCommand('lacuna.runInit')
      // ABORT — don't run against a default config. loadConfig returns defaults (never throws) with
      // no .lacuna.json, so falling through would launch a generate/fix run CONCURRENTLY with the
      // settings panel we just opened. The user finishes setup, then re-triggers the command.
      return undefined
    }
    return resolveProject(resource)
  }

  private needsKey(p: ResolvedProject): boolean {
    return !!p.config.apiKeyEnv && !(p.config.baseURL ?? '').match(/localhost|127\.0\.0\.1/)
  }
  private verbose(): boolean { return vscode.workspace.getConfiguration('lacuna').get<boolean>('alwaysVerbose', true) }
  private workers(): number { return vscode.workspace.getConfiguration('lacuna').get<number>('workers', 1) }
}

function base(rel: string): string { return rel.split('/').pop() || rel }
