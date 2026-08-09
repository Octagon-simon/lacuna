// Structured, machine-readable events emitted by runAgentLoop / runFixLoop when a caller
// supplies `onEvent` in its options. These carry the signal the pretty terminal UI renders
// visually but never exposes as data — the embedding host (e.g. the VS Code extension) needs
// them as structured events to build its own surfaces (progress panel, "learned rules used"
// line, cost readout).
//
// The CLI commands do NOT set `onEvent`, so emitting these is inert for terminal runs: the
// callback is simply undefined and the emit is a no-op. This keeps the terminal experience
// exactly as it was while giving an embedder a first-class data stream.
//
// Distinct from `WorkerState` (worker-display.ts) on purpose: `WorkerState` is a per-worker
// *phase* (idle → generating → running → passed/failed) consumed by WorkerDisplay's exhaustive
// switch, and adding non-phase variants to it would ripple through that switch. `LacunaEvent`
// is the open-ended, additive channel for everything that is not a worker phase.
export type LacunaEvent =
  // A file's prompt was enriched with learned rules retrieved from the memory store. `entries`
  // are the entry ids (e.g. "reanimated-mock-rntl-v14", "err-4471") so a host can show exactly
  // which learned rules were in play — the debugging surface that otherwise only exists by
  // grepping debug logs. Emitted once per file, when the retrieved set is non-empty.
  | { type: 'memory-used'; file: string; entries: string[] }

export type LacunaEventHandler = (event: LacunaEvent) => void
