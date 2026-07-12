# Coverage Guards

Generation/repair loops have a failure mode: when "all green" is the success metric, a model can game it by **deleting the failing tests**. Lacuna refuses to let coverage shrink to go green.

Files: `src/lib/validate.ts` (`countTestFunctions`), `src/agent/e2e-loop.ts`, `src/agent/fix-loop.ts`.

## The problem
- A retry "fixes" a failure by removing the failing `test()` → the smaller suite goes green → it's accepted. Silent coverage loss (we saw a spec shrink 190 → 149 lines).
- A pass-count check alone can't catch it: deleting a **failing** test leaves the pass count unchanged while the test count drops.

## The guards
- **`countTestFunctions(code)`** counts real `test(`/`it(` cases (ignores `describe`/`step`/`beforeEach`).
- **Generate (`e2e-loop.ts`)** tracks `maxTests` (the most cases any attempt produced). A retry with **fewer** cases is **rejected before it even runs**, with a "restore the deleted tests" message. **Keep-best by passing-test count**: it records the attempt with the most passing tests and, on exhaustion, **restores that** — never the last attempt, never a shrunk-green spec.
- **Fix (`fix-loop.ts`)** captures `baselineTestCount` up front and rejects any green run with fewer cases — covering **both unit and e2e** (the guard sits before the e2e/type branches). No final-attempt exception: a repair tool must never silently drop the user's tests.
- **Prompt rule** reinforces it: "repair the failing test — never delete, skip, or comment it out; coverage must not decrease across attempts."

## The keep-best insight
The honest reason generate *used* to accept a shrunk-green spec on the final attempt was a limitation: it tracked only a pass/fail **boolean**, not a pass **count**, so it had no fuller version to fall back to. Once `runPlaywrightSpec` returns `passed`/`failed` counts and the loop keeps-best, a smaller all-green spec (4/4) naturally **loses** to a fuller one (5 passing of 6) — and the special case disappears. All three loops now keep-best by passing coverage.

## Why it's hard
"The suite is green" is a seductive but wrong success signal. The fix is to make the metric **coverage that doesn't decrease** (test count *and* pass count), and to always preserve the best attempt rather than the latest.

## Open-source potential — 🟢 as a *principle*, 🟡 as code
The **idea** — "never let an agent go green by deleting tests; gate on non-decreasing coverage; keep-best by passing count" — is broadly valuable to anyone building test-writing agents and worth a short writeup. The code is small and loop-specific, so it travels best as documented patterns + the `countTestFunctions` helper rather than a package.
