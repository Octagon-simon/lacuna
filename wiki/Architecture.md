# Architecture

Lacuna has **two testing layers** that share one engine.

| | Unit / integration | End-to-end (`--e2e`) |
|---|---|---|
| Targets | Uncovered source symbols | User-reachable routes |
| Context | Source under test + types + mocks | DOM snapshot + page source + recovered flows |
| "Passing" means | Executed lines (coverage) | A green, non-flaky browser run |
| Driver | Vitest / Jest | Playwright (the project's own) |

They share the agent loop, the provider layer, retry/oscillation machinery, and result parsing. What differs is **target selection**, **context**, and **verification**.

## The three loops
- **`src/agent/loop.ts`** — unit generate.
- **`src/agent/e2e-loop.ts`** — e2e generate (route-driven orchestrator).
- **`src/agent/fix-loop.ts`** — repair (handles **both** unit and e2e via an `e2e` flag — there is no separate "e2e fix" loop).

All three are **keep-best**: they never end on a regression, and they refuse to shrink coverage to go green (see **[Coverage Guards](Coverage-Guards.md)**).

## An `--e2e` run, end to end
From `e2e-loop.ts`:

1. **Ensure Playwright** — install/scaffold if missing (`src/lib/playwright.ts`).
2. **Discover routes** — `src/lib/flows/discover.ts` (Next app/pages, React Router), dependency-gated so a Vite app isn't misread as Next.
3. **Snapshot the DOM** — `src/lib/flows/snapshot.ts` runs a throwaway spec in the *project's own* Playwright, capturing the accessibility tree + testids + headings per route.
4. **Authenticated dual-pass** — if a saved session exists (or can be refreshed), re-snapshot login-gated routes **signed in** and mark them for `*.auth.spec.ts`. See **[Authenticated Coverage](Authenticated-Coverage.md)**.
5. **Recover flows:**
   - **FlowMap** (static): `src/lib/flows/flowmap.ts` maps control → outcome from source. See **[FlowMap](FlowMap.md)**.
   - **Explorer** (dynamic, `--deep`): `src/lib/flows/explore.ts` walks multi-step flows in a real browser. See **[The Explorer](Explorer.md)**.
6. **Generate + verify** — a worker pool generates each spec, runs it, flake-confirms, and repairs on failure, keeping the best attempt.

The recovered flows + outcomes are injected into the generation prompt (`src/agent/prompts/e2e.ts`) so the model writes deep, correctly-asserting specs instead of shallow per-page smoke tests.

## The cross-cutting idea
> Deep coverage is a **journey-discovery** problem. Recover the app's latent workflow graph and the expected outcome of each action, and generating Playwright becomes mostly serialization.

FlowMap recovers *expected outcomes* statically; the Explorer recovers *actual journeys* dynamically. Everything else is the engine that turns that into green, non-flaky, non-shrinking specs.

## Key files
| Area | File |
|---|---|
| E2E orchestration | `src/agent/e2e-loop.ts` |
| Repair (unit+e2e) | `src/agent/fix-loop.ts` |
| Route discovery | `src/lib/flows/discover.ts` |
| DOM snapshots | `src/lib/flows/snapshot.ts` |
| Deep explorer | `src/lib/flows/explore.ts` |
| AST FlowMap | `src/lib/flows/flowmap.ts` |
| Playwright glue / auth | `src/lib/playwright.ts` |
| E2E prompts | `src/agent/prompts/e2e.ts` |
| Validation / guards | `src/lib/validate.ts` |
