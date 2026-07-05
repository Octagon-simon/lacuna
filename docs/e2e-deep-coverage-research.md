# Research brief: deep, project-aware E2E test generation

**Goal in one line:** generate Playwright E2E specs that walk *complete, multi-step user journeys* and assert the *real outcomes* — i.e. tests a human engineer who knows the app would write — automatically, from a running app + its source.

This document frames the problem, what lacuna already does, where it breaks, and the open research directions. It's meant as a starting point for deeper investigation, not a spec.

---

## 1. The bar (what "good" looks like)

A hand-written reference from afriex-server, `business-web/e2e/tests/sendAsKenyaUser.spec.ts`, is the target quality. It is a **user journey toward a goal** ("send money to a Benin recipient"):

1. Login (email/password) → **OTP** → home — using a shared `test-config.ts` (selectors + test credentials).
2. Click Send → pick **sending/receiving currency** (custom combobox: open → search "XOF" → select "CFA Franc BCEAO") → fill amount.
3. **New-recipient wizard**: country (Benin) → mobile-money provider (MTN) → phone → account name → Continue → Send.
4. **Transaction-PIN sub-flow with negative cases**: weak PIN (assert "Transaction pin too weak") → wrong PIN (assert "Transaction pin incorrect") → correct PIN → confirm.
5. A second test navigates to Transactions, opens the new transaction, and asserts the amounts/status.

Properties that make it good — and hard to generate:
- **Goal-oriented & multi-screen**, not per-page. ~20 chained steps across several routes/forms.
- **Real selectors at every step**, including steps only reachable *after* prior actions.
- **Custom widgets** (search-combobox, option lists) driven correctly (open → type → pick).
- **Domain values** (a real currency, a real provider, valid amounts, specific PINs).
- **Negative-path assertions** with exact error strings.
- **Cross-screen verification** (the thing you created/sent shows up elsewhere).
- Shared **fixtures/config** and `describe.serial` with `beforeAll` login / `afterAll` logout.

---

## 2. What lacuna does today (and what's reliable)

Pipeline for `lacuna generate --e2e` (see `src/agent/e2e-loop.ts`, `src/lib/flows/`, `src/agent/prompts/e2e.ts`):

**Reliable core (keep):**
- **Route discovery** (Next.js app/pages, React Router) → one spec per route.
- **DOM snapshot** per route via a temp Playwright spec run in the *project's own* Playwright (real webServer/browser/version). Captures the accessibility tree (role+name palette), `data-testid`s, headings, final URL. Waits for loaders to clear so it captures *loaded* content, not spinners.
- **Auth**: scaffolds `test-config.ts` (test user) + `auth.setup.ts` (login → `storageState`, incl. `indexedDB:true` for Firebase) + a 3-project config (setup / public `chromium` / `authenticated` for `*.auth.spec.ts`). Detects protected routes by **redirect-to-login OR inline login form**, re-snapshots them *signed in*, and generates `*.auth.spec.ts`.
- **1-level flow exploration**: clicks "opener" controls (Add/New/Edit/tabs…), captures what each reveals, and the model writes specs that open forms/panels and assert the revealed UI.
- **Verify + repair**: run each spec, flake-confirm, keep-best on failure, `lacuna fix --e2e --file <spec>` to repair. JSON report read from a file (`PLAYWRIGHT_JSON_OUTPUT_NAME`) so dev-server logs can't corrupt it; surfaces top-level Playwright `errors[]`; per-spec runs use `--no-deps` so the login `setup` project doesn't re-run each time.

This core produced genuinely good specs (e.g. cheflymenu `/admin`: dashboard + tab navigation + opening the Brand-Settings and Add-Item forms with real selectors, zero anti-patterns).

**Experimental (`--deep`, `src/lib/flows/explore.ts`):** walks a flow multiple steps — fill visible inputs (type-aware values), find the advance control (Continue/Save/Submit…), click, capture the next step, repeat (depth-capped). Records a "journey" the model turns into a serial multi-step test. Hardened to: fill only *new* inputs (skip a pre-existing search bar), scope to a dialog when present, dismiss onboarding/promo overlays (Got it/Skip/Maybe later/Close/Escape), detect no-progress, capture post-advance state.

---

## 3. Where it breaks (the actual research problems)

Observed on a real monolithic app (cheflymenu `/admin` — menu, categories, orders, team, brand, upgrade all in ONE component):

### P1. Custom widgets can't be driven generically
Native `<input>/<select>/checkbox` fill fine. But **search-comboboxes, country/provider pickers, segmented controls, rich editors** need bespoke sequences (open → type → wait → pick option). The afriex currency picker is the canonical example. Generic "fill the input" doesn't progress these flows.
- *Directions:* a small library of **widget adapters** keyed by detected pattern (ARIA `combobox`+`listbox`, Radix/Headless UI/MUI signatures); use the accessibility tree's `option` children; LLM-in-the-loop "given this opened widget, what's the action?" micro-calls; record-and-replay seeds.

### P2. No per-action outcome mapping (the regression we hit)
The result to *assert* after an action (a success toast, a redirect, a row appearing) is usually **not in the DOM snapshot** (toasts are transient). We tried extracting all toast/error/nav strings from the source — but a multi-flow component yields dozens, unrelated to the specific action, so feeding them as "assert one of these" produced wrong assertions (asserting the *upsell* redirect as the success of saving a menu item).
- *Core need:* map **control → handler → the toast/redirect/mutation that handler triggers**, so each action's assertion uses *its own* outcome.
- *Directions:* lightweight **AST** (ts-morph/Babel) — find the JSX onClick/onSubmit → resolve the handler → find `toast.*('…')` / `router.push('…')` / the service call *inside that handler's scope*. Scope strings to the action, not the file.

### P3. Intended modal vs. interrupt modal
A modal can be the *result* of an action (a confirmation dialog you should interact with) or an *interrupt* (onboarding/cookie/promo to dismiss). Dismissing the wrong one breaks the flow; not dismissing an interrupt blocks it.
- *Directions:* heuristics (interrupt = appeared without our action / matches promo copy / has Skip/Maybe-later); only dismiss when it *blocks our intended click*; classify by content.

### P4. "Reachability" of later steps & state pollution
Deep walking mutates state (creates records, sends things). Steps branch (new vs existing recipient). Re-running must be idempotent (the delete-cleanup idea). Some flows are terminal (save → toast, no next step) vs. true wizards (multi-screen).
- *Directions:* model each flow as a small **state machine** discovered by exploration; record the path; generate cleanup (delete what was created); detect terminal vs. wizard by whether the DOM advanced.

### P5. Domain values
Real flows need *valid, meaningful* data (a real currency code, a provider that exists, an amount within limits, a 4-digit PIN, an account name). Generic "Playwright Test …" / "100" often fails validation and can't progress.
- *Directions:* infer from the field (type, pattern, min/max, `<option>`s, placeholder example); pull enums/constants from source; a per-project **fixtures** file the user seeds.

### P6. Locator identity: label vs placeholder vs testid
The snapshot/explorer records a field by aria-label OR placeholder OR name, but the model then guesses `getByLabel(...)` even when the string was a *placeholder* → no match. (Seen: `getByLabel("0.00")`.)
- *Directions:* record *how* each field was identified (label/placeholder/testid/role) so the prompt emits the matching locator.

### P7. Monolithic multi-flow components
One giant `/admin` component hosting many flows defeats "one spec per route + per-file source analysis." The route is one URL but a dozen journeys.
- *Directions:* treat **tabs/sections as sub-routes**; segment the source by feature region; explore per-section.

### P8. Token budget
Deep journeys + source context blow small models' output limits (`deepseek-chat` ~8K) → truncation. Compression that drops fill+submit makes specs shallow.
- *Directions:* compress *inputs* (a tight flow-map instead of raw source), raise/segment output (one journey per spec file), or use a larger-output model for E2E.

---

## 4. The cross-cutting insight

**Deep coverage is inherently project-specific.** The reliable path is: a strong *generic* pass (auth, snapshots, navigation, native forms, 1-level flows — done) **plus a thin per-project layer** of knowledge the generic pass can't infer. Candidate `.lacuna.json` E2E hints to research:
- `dismiss`: strings/selectors for interrupt modals (e.g. `["Maybe later"]`).
- `successSignal` / per-action outcome hints.
- `fixtures`: domain values (currency, provider, amounts, PIN).
- `skipFields`, `widgets`: adapters for known custom components.
- `flows`: optional hand-named journeys to deepen.

The research question: **how much of that layer can be auto-derived (AST + exploration) vs. must be declared?**

---

## 5. Approaches worth investigating

1. **AST-driven flow-map** (ts-morph/Babel): control→handler→outcome/service per action. The principled fix for P2/P5/P6. Compresses context (token win).
2. **LLM-guided exploration**: at each opened widget/step, a cheap model call decides the next action from the captured tree (handles custom widgets P1 without enumerating them).
3. **Widget-adapter library**: pattern-matched drivers for ARIA combobox/listbox, Radix/Headless/MUI.
4. **Per-project config layer** (§4) — the pragmatic 80/20.
5. **Record-assist**: let a human do the flow once (codegen/trace), and have lacuna generalize/parameterize it — bridges the fully-auto gap.
6. **State-machine model of flows** for branching, terminal-vs-wizard, and cleanup (P4).

---

## 6. Open questions
- Can control→outcome be resolved reliably with regex+scoping, or is a real AST required? (We hit the wall with regex.)
- Best generic way to drive an arbitrary custom combobox from the accessibility tree alone?
- How to classify interrupt vs. intended modals with low error?
- Where's the auto-derive / declare line — what's the *minimum* per-project config for journey-level depth?
- Which model/output-budget makes deep single-shot generation viable, vs. generating a journey across multiple repair passes?

---

## 7. Pointers (code)
- `src/agent/e2e-loop.ts` — orchestration (discover → snapshot → auth dual-pass → flow exploration → generate/verify/keep-best).
- `src/lib/flows/snapshot.ts` — DOM + interaction snapshots (`snapshotRoutes`, `snapshotInteractions`, `parseAriaSnapshot`).
- `src/lib/flows/explore.ts` — `--deep` multi-step explorer (fill/advance/dismiss/no-progress).
- `src/lib/flows/discover.ts` — route discovery.
- `src/lib/playwright.ts` — config/auth scaffolding, run commands, JSON-to-file result parsing.
- `src/agent/prompts/e2e.ts` — generation + repair prompts (selector discipline, flows, journeys).
- Reference target: afriex-server `packages/business-web/e2e/tests/sendAsKenyaUser.spec.ts`.
