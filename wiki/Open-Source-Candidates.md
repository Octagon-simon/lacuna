# Open-Source Candidates

Which impressive parts are worth releasing on their own — like we did for **FlowMap** — ranked by *standalone value × low extraction effort*.

Legend: **🟢 ship as code** · **🟡 ship as code with work** · **📘 ship as knowledge** (guide/blog/prompt-library — the value is the know-how, not a package).

| # | Piece | Form | Effort | Why it stands alone |
|---|---|---|---|---|
| 1 | **[FlowMap](FlowMap.md)** | 🟢 shipped | — | Pure, zero-dep AST control→outcome map. Open-sourced → **https://github.com/Octagon-simon/flowmap**. Useful to anyone wiring an LLM to write E2E tests. |
| 2 | **Widget driver** (ARIA combobox/listbox) | 🟢 shipped | — | `driveWidgets` (open→type-ahead→wait listbox→pick option) covers Radix/Headless/MUI/Ariakit via one WAI-ARIA sequence. Open-sourced → **https://github.com/Octagon-simon/widget-driver** (peer: `@playwright/test`). |
| 3 | **The "Lessons" post** | 📘 done | — | The bugs→rules writeup bundling #5–#8 below. Shipped at `docs/blog-lessons-ai-e2e.md`. |
| 4 | **[The Explorer](Explorer.md)** → "Playwright Flow Walker" | 🟡 | Medium–High | The full generic walk (fill→drive-widgets→advance→capture-toast, with overlay dismissal + no-progress detection + progress streaming). The flagship companion to FlowMap, but the biggest lift: it's currently a browser-side template string, so extraction means a real `(page, probes, opts)` API, pluggable domain-value heuristics, and the timeout/progress baked in. Not yet done. |
| 5 | **[Assertion-quality ruleset](Assertion-Quality.md)** | 📘 | Low | Catalogue of E2E assertion anti-patterns + prevention rules. Captured in the Lessons post (#3); could also ship as a standalone prompt-library entry. |
| 6 | **[Coverage guards](Coverage-Guards.md)** principle | 📘 + tiny code | Low | "Never let an agent go green by deleting tests; keep-best by passing count." In the Lessons post; `countTestFunctions` is the only code. |
| 7 | **[Authenticated Playwright recipe](Authenticated-Coverage.md)** | 📘 | Low | IndexedDB auth (`indexedDB:true`), 1-hour-token auto-refresh, inline-auth-wall detection. In the Lessons post. |
| 8 | **[Seeding guide](Seeding-And-Test-Data.md)** | 📘 | Low | Deterministic + isolated + setup/teardown, the Ctrl+C clear, the cleanup-project trap. In the Lessons post + README. |
| 9 | **Project-aware route discovery** (`discover.ts`) | 🟡 | Medium | Dependency-gated Next app/pages + React Router discovery. Useful but overlaps existing tools; lower novelty. Not started. |

## Status / sequence
- ✅ **FlowMap** — open-sourced: https://github.com/Octagon-simon/flowmap
- ✅ **Widget driver** — open-sourced: https://github.com/Octagon-simon/widget-driver
- ✅ **Lessons post** — shipped (`docs/blog-lessons-ai-e2e.md`), bundling the assertion/coverage/auth/seeding know-how.
- ⏭ **Flow Walker (#4)** — the remaining flagship piece, and the biggest lift. With FlowMap it forms the compelling pair *"recover a web app's journeys + expected outcomes."* Extraction plan: lift the explorer from a browser-side template string into a real `driveFlow(page, probes, opts)` module that imports `@playwright/test`, with the domain-value heuristics, overlay dismissal, no-progress detection, scaled timeout, and progress callback as first-class options. Reuse the [widget-driver](https://github.com/Octagon-simon/widget-driver) package for the combobox step.

> **Source of truth:** the open-sourced pieces now live in their own repos (above). Their canonical code still lives in lacuna (`src/lib/flows/flowmap.ts`; the widget-driver logic in `explore.ts`); the standalone repos are exports — re-sync on release rather than forking.

## Packaging notes
- **Keep one source of truth.** For FlowMap, `src/lib/flows/flowmap.ts` is canonical and the [flowmap repo](https://github.com/Octagon-simon/flowmap) is the export — re-sync on release rather than forking. Same for widget-driver (canonical in `explore.ts`). Apply the rule to any future extraction.
- **Don't `git init` inside the nested folder** — copy it to a sibling repo (or `git subtree split`). A repo nested in the monorepo becomes an accidental submodule.
- **Borrow the host's tooling at runtime** (FlowMap resolves the *target's* `typescript`) — that pattern keeps an extracted tool dependency-light; reuse it for the Flow Walker (resolve the target's `@playwright/test`).
