# FlowMap

**Static AST map of every interactive control → the outcome its handler produces** (toast / redirect / modal). It answers the one question that makes or breaks a generated test:

> "I clicked **this** button — what is supposed to happen?"

File: `src/lib/flows/flowmap.ts` (canonical). **Open-sourced standalone → https://github.com/Octagon-simon/flowmap** (MIT).

## What it does
For each JSX handler attribute (`onClick`/`onSubmit`/`onPress`/`onChange`), it resolves the handler's body and extracts what that body *does*:

```
control (onClick={handleUpgrade})
   │  resolve handler body
   ▼
handleUpgrade() {
   toast.info('Redirecting to upgrade page...')   ──► toast outcome
   router.push('/upgrade')                          ──► redirect outcome
}
```

Output, one record per control:

```jsonc
{ "control": "Upgrade to Pro", "by": "text", "handler": "handleUpgrade",
  "external": false,
  "outcomes": { "toast": { "message": "Redirecting to upgrade page...", "kind": "info" },
                "redirect": "/upgrade" } }
```

Detects: toasts (`toast.*`, `showToast`, `enqueueSnackbar`, `notify`, sonner/MUI), redirects (`router.push/replace`, `navigate`), modal opens (`setShowX(true)`), and notable service `calls`. Controls are located by **data-testid > visible text > aria-label** (`by` tells the consumer which getter to emit).

## Why AST, not regex
Regex finds every `toast()` and `router.push()` string in a file but **can't tell which control owns which** — so on a multi-flow page it asserted the *upsell* redirect as the success of *saving a record*. That regression is exactly why FlowMap exists. The AST resolves `control → handler → the calls inside that handler`, so each action asserts **its own** outcome.

## v2: one-hop cross-file
Handlers rarely live inline. v2 follows **one hop**:
- destructured from a hook — `const { handleSave } = useMenuActions()` → into `useMenuActions.ts`
- imported directly — `import { goBilling } from './actions'`

…and extracts the outcome there (reported via `resolvedFrom`). A handler passed as a **component prop** (body in the caller) stays `external` with no invented outcome — a shallow-but-correct mapping beats a confident-wrong one.

## How it's wired
`e2e-loop.ts` builds the map, keeps only controls with a concrete outcome, and the prompt emits a strictly **per-control** `CONTROL → OUTCOME MAP` block ("assert this outcome ONLY for this control; never invent one"). It also drives standalone tests for those controls.

## Why it's hard
Outcomes to assert are usually **not in the DOM** (toasts are transient, redirects haven't happened). The mapping must be *per-action* and *honest* (no guessing across controls or past one hop). Doing it with the **project's own TypeScript** (resolved at runtime) avoids bundling a compiler and matches the project exactly.

## Open-source potential — ✅ shipped
Open-sourced at **https://github.com/Octagon-simon/flowmap**. Zero runtime deps (borrows the target's `typescript`). Useful to **anyone** wiring an LLM to write E2E tests, not just Lacuna. Roadmap if developed further: caller-analysis (resolve prop handlers back to the parent), Zod/validation extraction for negative-path assertions, Vue/Svelte handler conventions.
