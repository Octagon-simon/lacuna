// Typed postMessage protocol between the extension host and the progress webview. The webview
// script is inlined (see progress-panel.ts) so these types are host-side documentation of the
// message shapes; keeping them in one place stops the two ends drifting.
import type { WorkerState } from './core'

// A single line in the progress panel's append-only log.
export interface LogLine {
  kind: 'info' | 'phase' | 'warn' | 'error' | 'success' | 'memory' | 'token'
  file?: string
  text: string
  ts: number
}

export interface RunStats {
  requests: number // model calls so far (counted from generating/retrying transitions)
  elapsedMs: number
  filesTotal: number
  filesDone: number
  passed: number
  failed: number
}

// host → webview
export type HostToPanel =
  | { type: 'init'; title: string; model: string; provider: string; maxIterations: number; files: string[] }
  | { type: 'log'; line: LogLine }
  | { type: 'phase'; state: WorkerState }
  | { type: 'stats'; stats: RunStats }
  | { type: 'done'; ok: boolean; summary: string; stats: RunStats }

// webview → host
export type PanelToHost =
  | { type: 'ready' }
  | { type: 'viewRawLog' }
  | { type: 'cancel' }
