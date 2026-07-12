# Lacuna Wiki

**Lacuna** is an agentic CLI that generates and repairs tests for real codebases — both **unit/integration** tests (coverage-driven) and **end-to-end** tests (Playwright, route-driven). It drives a real browser, reads your source, recovers your app's workflows, and writes tests a senior engineer would write — then runs them and keeps only what genuinely passes.

This wiki documents the parts that make it work, with an eye on which pieces are interesting enough to **open-source on their own**.

## Start here
- **[Architecture](Architecture.md)** — the two testing layers, the loops, and how a run flows end to end.
- **[Open-Source Candidates](Open-Source-Candidates.md)** — the standalone-worthy pieces, ranked, with what each would need to ship alone.

## The impressive parts (one page each)
- **[FlowMap](FlowMap.md)** — static AST map of *control → outcome* (toast / redirect / modal). The principled fix for "what should clicking this button assert?" *(open-sourced: [github.com/Octagon-simon/flowmap](https://github.com/Octagon-simon/flowmap))*
- **[The Explorer](Explorer.md)** — drives a real browser to walk multi-step flows (`--deep`): fill → advance → capture, with widget/​combobox driving and transient-toast capture.
- **[FlowMap vs Explorer](FlowMap-vs-Explorer.md)** — static vs dynamic: why both exist and how they cover each other's blind spots.
- **[Authenticated Coverage](Authenticated-Coverage.md)** — logging in as a test user, capturing the signed-in DOM, auto-refreshing expiring sessions, IndexedDB auth.
- **[Coverage Guards](Coverage-Guards.md)** — the loops refuse to "go green by deleting tests"; keep-best by passing-test count across generate *and* fix.
- **[Assertion Quality](Assertion-Quality.md)** — the rules that stop tautological / vacuous assertions ("sidebar still visible") and force real-outcome checks.
- **[Seeding & Test Data](Seeding-And-Test-Data.md)** — why data-dependent flows need seeding, and the deterministic, isolated pattern.
- **[Hard-Won Lessons](Lessons.md)** — the non-obvious bugs and the rules they produced (the 30s shared-test timeout, networkidle on realtime apps, the toast-junk capture, the regression that birthed FlowMap…).

## Conventions in this wiki
- File references look like `src/lib/flows/flowmap.ts` and are accurate to the codebase.
- Each feature page ends with **Why it's hard** and **Open-source potential** so you can decide what to extract.
