# Assertion Quality

A green suite isn't a good suite. Lacuna's prompts forbid the assertions that pass without proving anything.

File: `src/agent/prompts/e2e.ts` (`ASSERTION_RULES` + system rules). These are **generate-side** — the `fix` loop deliberately preserves a passing test's intent, so weak assertions are prevented at generation, and improving an existing weak spec means regenerating it.

## The anti-patterns it bans (each from a real review)
1. **Persistent-landmark as outcome.** Asserting "the sidebar/header/nav/title is still visible" after a create/edit/delete proves nothing changed. **Banned.** The assertion must check what became true *because* of the action: the success toast (exact text), the created record (unique name), the removed row (`toBeHidden`), the closed form, or the new URL.
2. **Tab/section tautology.** Clicking "Categories" then asserting the *Categories nav button* is still visible — it was always there. **Rule:** assert content unique to the **revealed panel**, never the control you clicked (or, when the app uses query-param tabs, assert the `?tab=…` URL).
3. **Vacuous conditionals.** `if (await button.isVisible()) { … }` with no `else` passes having asserted nothing. **Rule:** use `test.skip(reason)` so an absent control shows as *skipped*, not a false pass.
4. **Loading-state / crutch assertions.** Don't build the test around a spinner, and don't use `networkidle` as a sync crutch or `try/catch`/`if-else` to force a pass — assert the loaded content and let web-first assertions auto-wait.

## The positive rule (`POST-ACTION VALIDATION`)
After any state change, assert the **observable outcome**. FlowMap and the Explorer feed the *specific* outcome to assert (the exact toast / redirect), so the model isn't guessing — it's asserting a recovered fact.

## Why it's hard
The expected result is usually **transient or off-screen** (a toast fades; a redirect is a URL change), so the lazy fallback is "assert something that's definitely there" — which is exactly the worthless assertion. Closing that gap needs the *real* outcome supplied (FlowMap/Explorer) **and** explicit prohibitions on the lazy fallback.

## Open-source potential — 🟢 as a checklist/ruleset
The catalogue of E2E assertion anti-patterns + the rules that prevent them is a great standalone **"LLM E2E test-quality checklist"** (blog/gist/prompt-library entry). It's prompt text, not a library, so it open-sources as knowledge.
