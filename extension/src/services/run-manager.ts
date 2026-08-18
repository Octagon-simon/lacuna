import * as vscode from 'vscode'
import * as path from 'node:path'
import { runAgentLoop, runFixLoop, resolveDebugBase } from '../core'
import type { LacunaConfig, DetectedEnvironment, WorkerState, LacunaEvent, LoopResult, FixResult } from '../core'
import type { HostToPanel, RunStats, LogLine } from '../protocol'

let RUN_SEQ = 0

export interface StartOptions {
  kind: 'generate' | 'fix'
  cwd: string
  config: LacunaConfig
  env: DetectedEnvironment
  title: string
  files: string[] // display list (relative paths)
  targetFile?: string
  scopeDir?: string
  workers?: number
  verbose: boolean
  apiKey?: string
}

export interface RunHandle {
  readonly id: string
  readonly kind: 'generate' | 'fix'
  readonly title: string
  readonly files: string[]
  /** Header metadata the panel reconstructs `init` from — survives late/re-subscription. */
  readonly meta: { model: string; provider: string; maxIterations: number }
  readonly stats: RunStats
  cancelRequested: boolean
  readonly onMessage: vscode.Event<HostToPanel>
  /** The terminal `done` message once the run has settled, so a panel that opens/reopens AFTER the
   * run finished can replay the final pass/fail state (the live `done` event already fired and is
   * gone). Undefined while still running. */
  readonly finalDone?: HostToPanel
  readonly done: Promise<LoopResult | FixResult>
  /** Full plain-text transcript, for "View Raw Log". */
  readonly rawLog: string[]
  requestCancel(): void
  /** Files that used learned rules AND still failed — the in-moment correction surface (§3.3). */
  failedWithMemory(): { file: string; entries: string[] }[]
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x1B]*/g, '')
}

function phaseText(state: WorkerState): { kind: LogLine['kind']; text: string } | null {
  switch (state.phase) {
    case 'waiting': return { kind: 'phase', text: 'waiting for model…' }
    case 'generating': return { kind: 'phase', text: 'generating tests…' }
    case 'writing': return { kind: 'phase', text: 'writing file…' }
    case 'running': return { kind: 'phase', text: 'running tests…' }
    case 'retrying': return { kind: 'phase', text: `retrying (attempt ${state.attempt}/${state.max})…` }
    case 'regenerating': return { kind: 'phase', text: 'regenerating from scratch…' }
    case 'fixing': return { kind: 'phase', text: 'handing off to the fix specialist…' }
    case 'passed': return { kind: 'success', text: 'passed ✓' }
    case 'failed': return { kind: 'error', text: 'failed ✗' }
    default: return null
  }
}

export class RunManager {
  private readonly runs = new Map<string, InternalRun>()
  private readonly _onDidChange = new vscode.EventEmitter<void>()
  /** Fires whenever the set of active runs changes (drives the status bar). */
  readonly onDidChangeActiveRuns = this._onDidChange.event

  constructor(private readonly output: vscode.OutputChannel) {}

  get activeRuns(): RunHandle[] {
    return [...this.runs.values()]
  }

  start(opts: StartOptions): RunHandle {
    const run = new InternalRun(opts)
    this.runs.set(run.id, run)
    this._onDidChange.fire()

    const config: LacunaConfig = { ...opts.config, apiKey: opts.apiKey }
    const emitter = run.emitter
    const started = Date.now()

    const log = (raw: string) => {
      const text = stripAnsi(raw).trim()
      if (!text) return
      run.rawLog.push(text)
      this.output.appendLine(text)
      run.push({ type: 'log', line: { kind: 'info', text, ts: Date.now() } })
    }

    // Surface debug state at run start so "I can't see the debug files" has an obvious answer: when
    // debug is on (config.debug or LACUNA_DEBUG, env winning), say exactly where the per-file logs
    // land (anchored to the project cwd, matching TestGenerator); when off, say how to enable it.
    // Without this the only signal was files silently (not) appearing somewhere the user couldn't find.
    const debugBase = resolveDebugBase(config.debug)
    if (debugBase) {
      log(`debug: on — writing per-file prompt/response logs to ${path.join(opts.cwd, debugBase.replace(/\.txt$/, '.<file>.txt'))}`)
    } else {
      log('debug: off — enable "debug": true in .lacuna.json (or LACUNA_DEBUG=1) and re-run to capture prompt/response logs')
    }

    // Last phase-text emitted per file, to collapse runs of the SAME phase into one log line. The
    // fix-specialist handoff pins every internal phase (generating/running/retrying, per attempt) to
    // `fixing`, so without this the log fills with dozens of identical "handing off to the fix
    // specialist…" lines and looks stuck. The live `phase` message (for the worker row) still fires
    // every time — only the append-only LOG is de-duplicated.
    const lastPhaseByFile = new Map<string, string>()
    const onStatus = (state: WorkerState) => {
      const t = phaseText(state)
      const file = 'file' in state ? state.file : undefined
      // Request accounting: each generating/retrying is one model call.
      if (state.phase === 'generating' || state.phase === 'retrying') run.stats.requests++
      // Terminal outcomes; regenerating/fixing reopens a file (mirrors WorkerDisplay).
      if (file) {
        if (state.phase === 'passed' || state.phase === 'failed') run.outcomes.set(file, state.phase)
        else if (state.phase === 'regenerating' || state.phase === 'fixing') run.outcomes.delete(file)
      }
      run.recomputeCounts()
      run.stats.elapsedMs = Date.now() - started
      run.push({ type: 'phase', state })
      if (t) {
        const key = file ?? ''
        if (lastPhaseByFile.get(key) !== t.text) {
          lastPhaseByFile.set(key, t.text)
          const line: LogLine = { kind: t.kind, file, text: t.text, ts: Date.now() }
          run.rawLog.push(`${file ? file + ' — ' : ''}${t.text}`)
          run.push({ type: 'log', line })
        }
      }
      run.push({ type: 'stats', stats: { ...run.stats } })
    }

    const onEvent = (ev: LacunaEvent) => {
      if (ev.type === 'memory-used') {
        run.memoryUsed.set(ev.file, ev.entries)
        const text = `used ${ev.entries.length} learned rule${ev.entries.length === 1 ? '' : 's'}: ${ev.entries.join(', ')}`
        run.rawLog.push(`${ev.file} — ${text}`)
        run.push({ type: 'log', line: { kind: 'memory', file: ev.file, text, ts: Date.now() } })
      }
    }

    // NB: no synchronous `init` push here — the panel subscribes AFTER start() returns, so a push
    // now would fire into the void (this is exactly why the model header showed blank). The panel
    // reconstructs `init` from run.meta on bind() instead, which is also correct on reopen.

    const shouldContinue = () => !run.cancelRequested

    const common = {
      config, env: opts.env, cwd: opts.cwd, dryRun: false, verbose: opts.verbose,
      workers: opts.workers, log, onStatus, onEvent, shouldContinue,
      // Instant stop: aborts the in-flight model request, not just between attempts.
      abortSignal: run.abort.signal,
    }

    // Defer the loop kickoff by one microtask so `start()` returns and the caller (the progress
    // panel / status bar) subscribes to onMessage BEFORE the loop emits its first status/event.
    // Otherwise a status emitted synchronously — before the loop's first await — is fired into the
    // void. (The panel also replays rawLog on bind, but a live subscriber must not miss lines.)
    const promise = Promise.resolve().then((): Promise<LoopResult | FixResult> => (opts.kind === 'generate'
      ? runAgentLoop({ ...common, targetFile: opts.targetFile, scopeDir: opts.scopeDir })
      : runFixLoop({ ...common, targetFile: opts.targetFile, scopeDir: opts.scopeDir })
    ))
      .then((result) => {
        run.stats.elapsedMs = Date.now() - started
        const summary = summarize(opts.kind, result, run.cancelRequested)
        run.emitDone({ type: 'done', ok: !hasErrors(result), summary, stats: { ...run.stats } })
        run.rawLog.push(summary)
        this.output.appendLine(summary)
        return result
      })
      .catch((err: unknown) => {
        run.stats.elapsedMs = Date.now() - started
        const msg = err instanceof Error ? err.message : String(err)
        run.emitDone({ type: 'done', ok: false, summary: `Run failed: ${msg}`, stats: { ...run.stats } })
        run.rawLog.push(`ERROR: ${msg}`)
        this.output.appendLine(`ERROR: ${msg}`)
        throw err
      })
      .finally(() => {
        this.runs.delete(run.id)
        this._onDidChange.fire()
        emitter.dispose()
      })

    run.setDone(promise)
    return run
  }
}

function hasErrors(result: LoopResult | FixResult): boolean {
  return Array.isArray(result.errors) && result.errors.length > 0
}

function summarize(kind: 'generate' | 'fix', result: LoopResult | FixResult, cancelled: boolean): string {
  const pre = cancelled ? 'Stopped after the in-flight file(s). ' : ''
  if (kind === 'generate') {
    const r = result as LoopResult
    const cov = r.hasCoverage ? ` Coverage ${r.coverageBefore.toFixed(1)}% → ${r.coverageAfter.toFixed(1)}%.` : ''
    return `${pre}${r.testsWritten}/${r.filesProcessed} file(s) got passing tests.${cov}`
  }
  const r = result as FixResult
  // Single-file run: no batch counts — "0 already passing" is meaningless noise for one file.
  if (r.filesProcessed === 1) {
    if (r.filesFixed === 1) return `${pre}Fixed the test file.`
    if (r.filesAlreadyPassing === 1) return `${pre}Already passing — nothing to fix.`
    return `${pre}Could not fix the test file.`
  }
  // Batch run: only mention already-passing when there actually were some.
  const already = r.filesAlreadyPassing > 0 ? `; ${r.filesAlreadyPassing} already passing` : ''
  return `${pre}Fixed ${r.filesFixed}/${r.filesProcessed} file(s)${already}.`
}

class InternalRun implements RunHandle {
  readonly id = `run-${++RUN_SEQ}`
  readonly kind: 'generate' | 'fix'
  readonly title: string
  readonly files: string[]
  readonly meta: { model: string; provider: string; maxIterations: number }
  readonly stats: RunStats
  readonly rawLog: string[] = []
  readonly outcomes = new Map<string, 'passed' | 'failed'>()
  readonly memoryUsed = new Map<string, string[]>()
  readonly abort = new AbortController()
  cancelRequested = false
  finalDone?: HostToPanel
  readonly emitter = new vscode.EventEmitter<HostToPanel>()
  private _done!: Promise<LoopResult | FixResult>

  constructor(opts: StartOptions) {
    this.kind = opts.kind
    this.title = opts.title
    this.files = opts.files
    this.meta = { model: opts.config.model, provider: opts.config.provider, maxIterations: opts.config.maxIterations }
    this.stats = { requests: 0, elapsedMs: 0, filesTotal: opts.files.length, filesDone: 0, passed: 0, failed: 0 }
  }

  get onMessage() { return this.emitter.event }
  get done() { return this._done }
  setDone(p: Promise<LoopResult | FixResult>) { this._done = p }
  push(m: HostToPanel) { this.emitter.fire(m) }
  /** Fire the terminal `done` AND remember it, so a later bind() can replay the final state. */
  emitDone(m: HostToPanel) { this.finalDone = m; this.emitter.fire(m) }
  requestCancel() { this.cancelRequested = true; this.abort.abort() }

  failedWithMemory(): { file: string; entries: string[] }[] {
    const out: { file: string; entries: string[] }[] = []
    for (const [file, entries] of this.memoryUsed) {
      if (this.outcomes.get(file) === 'failed' && entries.length) out.push({ file, entries })
    }
    return out
  }

  recomputeCounts() {
    let passed = 0, failed = 0
    for (const v of this.outcomes.values()) v === 'passed' ? passed++ : failed++
    this.stats.passed = passed
    this.stats.failed = failed
    this.stats.filesDone = this.outcomes.size
  }
}
