# The Explorer (`--deep`)

**Drives a real browser to walk multi-step user journeys**, recording the actual path and the real outcomes — the dynamic counterpart to FlowMap.

File: `src/lib/flows/explore.ts`. Opt-in via `--deep` (it fills and **submits** real forms — test/staging only).

## What it does
For each "opener" control (Add/New/Edit/tabs/section-nav…), it walks a flow step by step:

1. **Fill** visible inputs with type-aware values (email/phone/number/PIN/text, checkboxes, native selects) — only *new* inputs, scoped to a dialog when one is open.
2. **Drive widgets** that `fill()` can't — ARIA comboboxes / listbox-poppers (Radix/Headless/MUI all expose `role=combobox`/`aria-haspopup=listbox`): open → type-ahead → wait for `listbox` → click the first `option`.
3. **Advance** — find the submit/continue button (`findAdvance`), click it. Handles the case where the submit shares the opener's name (e.g. an "Add Item" form whose submit is also "Add Item").
4. **Capture the outcome** — `captureToast` polls briefly for the real success/validation toast (the action's true result), plus the post-advance DOM.
5. **Repeat** until terminal / no-progress (same form repeats = validation block) / depth cap.

It returns `Journey[]` (opener + ordered steps with filled fields, advance, revealed UI, and the toast), which the prompt turns into a serial multi-step `test()`.

## The robustness work (each from a real failure)
- **Fill only new inputs**, scoped to the dialog — so a page's search bar isn't mistaken for the form.
- **`dismissOverlay`** clears onboarding/promo/cookie modals (Got it/Skip/Maybe later/✕, else Escape; never Continue/OK/Save), with a page-wide fallback for portal-rendered modals.
- **No-progress detection** via a fill-signature, so it doesn't loop on a stuck form.
- **`captureToast`** ignores framework dev overlays and `<style>` text (it once captured the Next.js dev-badge CSS), using `innerText` and a real-message filter.
- **Per-test timeout scaled to probe count** — all probes share one page in one `test()`; the default 30s silently killed the test mid-walk and dropped every later route. See **[Lessons](Lessons.md)**.
- **Live progress** — streams `LACUNA_PROBE i/N route :: name` so a long walk never looks hung.

## Why it's hard
A running UI is a **state machine** a black-box DOM snapshot can't navigate. Custom widgets need bespoke ARIA sequences; modals are sometimes the result and sometimes an interrupt; later steps are only reachable after earlier ones succeed; real flows need **valid domain data** (a real currency, a category that exists — see **[Seeding](Seeding-And-Test-Data.md)**). And it has to do all this without polluting state or looking hung.

## Open-source potential — 🟡 strong, but couples to Playwright + app specifics
The **generic walk algorithm** (fill→drive-widgets→advance→capture, with overlay dismissal, no-progress detection, and toast capture) is reusable and interesting. To ship alone it would need: a clean input (a list of "opener" probes + a Playwright `page`), the per-test-timeout + progress streaming baked in, and the domain-value heuristics made pluggable. Natural name: a **"flow walker"** / journey recorder for Playwright. Medium extraction effort — more than FlowMap (which is pure/standalone), because it assumes a Playwright run context. Its combobox step is already extracted as **[widget-driver](https://github.com/Octagon-simon/widget-driver)** — a flow-walker package would depend on it.
