# Lacuna for VS Code

Find coverage gaps, generate tests, and fix failing tests with an agentic loop — without leaving
your editor. This extension embeds the [`lacuna`](https://github.com/octagon-simon/lacuna) core
directly (no shelling out), so runs stream real, structured progress into the editor.

## Features

- **Generate tests** — right-click any source file, or use the editor title bar. Batch a whole
  folder or a multi-selection.
- **Fix failing tests** — right-click a test file, or use the inline CodeLens.
- **Coverage Gaps sidebar** — every file below threshold / with no test, one click to generate.
  Drag files onto it to queue them.
- **Coverage gutters** — uncovered lines highlighted in the active editor from your LCOV report.
- **Live progress panel** — a legible, append-only log of every phase (waiting → generating →
  writing → running → retrying), streamed tokens, and which learned rules were used. "View Raw
  Log" opens the full text in an Output channel.
- **Memory (Learned Rules) sidebar** — browse the confidence-weighted rules Lacuna has learned,
  sort by confidence / hit count, delete or flag ones that stop helping.
- **Settings form** — generated from Lacuna's own config schema, writes `.lacuna.json`.

## Trust, cost, and control

A generate/fix run makes **real, metered API calls** and writes files. This extension never hides
that:

- A one-time disclosure before the first API call in a workspace.
- A confirmation surface before every run — files, model, and worst-case request count.
- A status-bar item present for the entire lifetime of any active run, with a **Stop** control.
- A diff review of every changed file before you keep it. The shared **mocks file** is always
  reviewed separately (it's imported by every test).
- **Auto Mode** (per-workspace, opt-in) suppresses per-run confirmations — but never the mocks-file
  review, and never environment changes. An unmissable status-bar indicator shows when it's on.

## Getting started

1. Open a project with tests (Jest or Vitest).
2. Run **Lacuna: Set Up** (or open settings) to create `.lacuna.json`.
3. Run **Lacuna: Set API Key** — stored securely in the OS keychain via VS Code SecretStorage,
   never written to `.lacuna.json`.
4. Right-click a source file → **Generate Tests with Lacuna**.

## Configuration

All test-generation settings live in `.lacuna.json` (edit directly, or via the settings form).
A few editor-only preferences live in VS Code settings under `lacuna.*` (verbose streaming,
batch worker count, confirmation toggle).

## License

MIT
