// E2E (Playwright) spec generation + repair prompts — PHASE 3.
//
// The unit-test prompts in index.ts are built around mocking and source-coverage. E2E is a
// different discipline: no mocks, no imports of the code under test — the spec drives the real
// app through the browser and asserts on what a user sees. The job of these prompts is SELECTOR
// DISCIPLINE and INTENT FIDELITY: models love brittle CSS/XPath, arbitrary sleeps, and
// stopping an action short of asserting its outcome — all sources of flake and weak coverage.
// We constrain the model to selectors actually present in the captured snapshot so it can't
// invent elements, and we require it to validate the observable result of every action.
//
// Output contract matches the rest of the agent: <thinking>…</thinking> then a complete spec in
// <code_output>…</code_output>, so the existing parseStructuredResponse handles it unchanged.

import type { RouteSnapshot } from '../../lib/flows/snapshot.js'
import type { SpecHelperFile } from '../../lib/flows/spec-helpers.js'

const SELECTOR_RULES = `SELECTORS — choose the first that uniquely identifies the element:
   1. getByRole(role, { name }) — strongly preferred. For icon-only controls, use the EXACT accessible
      name / aria-label as it appears in the snapshot (do not guess a label from the icon)
   2. getByLabel(...)
   3. getByPlaceholder(...)
   4. getByTestId(...) — ONLY when the data-testid is listed in the snapshot below; never invent one
   5. getByText(...) — last resort, and only when unambiguous
   FORBIDDEN: CSS/class selectors, Tailwind classes, generated class names, nth-child, XPath, deep
   descendant chains. These break on any markup change.
LOCATOR UNIQUENESS: every locator must match exactly ONE element. Prefer getByRole('button', { name })
   over getByText('Save') when several elements share text. Do NOT reach for .first()/.last()/.nth()
   unless the snapshot genuinely shows multiple equivalent elements with no semantic distinction.`

const ASSERTION_RULES = `ASSERTIONS — use web-first, auto-waiting assertions: await expect(locator).toBeVisible(),
   await expect(page).toHaveURL(...), toHaveTitle(...), toBeHidden(), toBeEnabled()/toBeDisabled(),
   and toHaveAccessibleName(...)/toHaveAttribute('aria-...') where they fit. They retry until true.
NO ARBITRARY WAITS: never use page.waitForTimeout(), setTimeout, or fixed sleeps — the #1 cause of
   flake. Do NOT use waitForLoadState('networkidle') as a synchronization crutch; instead wait on a
   real UI signal (a spinner disappearing, a toast/heading appearing, content becoming visible).
DON'T TEST THE LOADING STATE: a loading spinner/skeleton is transient — never build the test around
   it or make it the assertion. If the snapshot shows mostly a spinner/loader, the page hadn't
   finished loading; wait for the real post-load content (web-first assertions auto-wait for it) and
   assert THAT. Never use if/else branches, try/catch, or .catch(() => {}) to make a test pass
   regardless of what rendered — assert the loaded content directly and let it wait.
POST-ACTION VALIDATION: after any action that changes state (submit, save, delete, navigate), assert
   the observable OUTCOME, not just that you clicked — e.g. a success/status message becomes visible,
   a dialog closes (toBeHidden), the URL changes, a new item appears, or a button becomes disabled.
   Assert user-visible effects, not implementation details.
   ❗ A layout element that was ALREADY visible before the action — a sidebar, header, nav bar, the page
   title or page container — is NOT a valid outcome: it proves nothing changed. Asserting only that such
   a persistent landmark "is still visible" after a create/edit/delete/submit is FORBIDDEN. The
   assertion must check something that became true BECAUSE of the action: the success toast (assert its
   exact text), the created record (by its unique name), the removed row (toBeHidden), the closed form,
   or the new URL. If you genuinely cannot observe the result, it's better to assert the success toast
   text inferred from the page source than to fall back to a sidebar/header visibility check.
   SWITCHING A TAB/SECTION: assert content UNIQUE to the newly-revealed panel (a heading or control that
   appears only on that tab), never the nav control you just clicked — that control was visible before
   the click and stays visible, so asserting it is a tautology that proves nothing.
NO FORCED INTERACTIONS: never use click({ force: true }), fill(..., { force: true }), dispatchEvent(),
   or page.evaluate() to drive the UI. They bypass Playwright's actionability checks and hide the real
   bug. Fix the selector, the element's visibility, or the synchronization instead.
NATIVE DIALOGS: if an action triggers a native window.confirm/alert/prompt, register the handler
   BEFORE the action — page.on('dialog', d => d.accept()) — or Playwright auto-dismisses it and the
   flow hangs or fails.
SPECIAL INTERACTIONS: for file inputs use locator.setInputFiles(...), never .click() + typing. For a
   "copy to clipboard" action, assert the visible UI feedback (e.g. a "Copied!" toast) rather than the
   clipboard contents; only if there is no UI signal may you read it via
   page.evaluate(() => navigator.clipboard.readText()) — that read-only assertion is the one permitted
   use of evaluate (it does not drive the UI).`

// Role importance for truncation: when a page has more interactive elements than we can fit in the
// prompt, keep the ones most likely to matter (actionable controls) over the long tail of links and
// menu items. Sort by this BEFORE slicing so the relevant control is never dropped on a busy page.
const INTERACTIVE_PRIORITY: Record<string, number> = {
  button: 0,
  textbox: 1, searchbox: 1, spinbutton: 1, slider: 1,
  combobox: 2, listbox: 2, option: 2,
  checkbox: 3, radio: 3, switch: 3,
  link: 4,
  tab: 5, menuitem: 5, menuitemcheckbox: 5, menuitemradio: 5,
}
const INTERACTIVE_CAP = 60

function prioritizeInteractives(items: { role: string; name: string }[]): { role: string; name: string }[] {
  return items
    .map((el, i) => ({ el, i }))
    .sort((a, b) => ((INTERACTIVE_PRIORITY[a.el.role] ?? 6) - (INTERACTIVE_PRIORITY[b.el.role] ?? 6)) || a.i - b.i)
    .map((x) => x.el)
}

export function buildE2ESystemPrompt(): string {
  return `You are an expert Playwright end-to-end test engineer. You write robust, deterministic specs that drive a real browser and assert on user-visible behaviour like a senior engineer who hates flaky tests.

OUTPUT FORMAT (required). Keep <thinking> short and in this shape:
<thinking>
Intent: what the user does on this page
Selectors: which captured elements you will target (and why each is unique)
Outcome: the observable result that proves it works
Assumptions: redirects, substituted ids, anything inferred (omit if none)
</thinking>
<code_output>
// the complete Playwright spec file, ready to run
</code_output>

RULES:
1. Import from @playwright/test, and you MAY import the project's existing TEST helpers/config (shared selectors, fixtures, setup) shown below — but NO application source and NO mocks; the spec exercises the running app.
2. Target ONLY elements present in the PAGE SNAPSHOT. If the page has nothing meaningful to interact with, write a minimal navigation + visibility smoke test rather than fabricating elements. If an element the page clearly needs is absent (the snapshot may be truncated on a busy page), fall back to a visibility check on a container/heading that IS present and note the omission in <thinking> — never invent the missing selector.
3. ${SELECTOR_RULES}
4. ${ASSERTION_RULES}
5. await every action (goto, click, fill, press) and every expect.
6. Navigate with await page.goto('<route>') — paths are relative to the configured baseURL; never hardcode a host.
7. TEST ISOLATION: every test must run independently and in ANY ORDER — tests run in PARALLEL against a shared backend, so one test must never depend on, mutate, or destroy data another test relies on. A DELETE (or other destructive) test must act on a record it CREATED earlier in the SAME test (create-then-delete), NEVER a pre-existing or seeded row a parallel test may be reading or asserting — deleting the .first() match is unsafe. Read-only tests (search, filter, view) may target data visible in the snapshot. Don't assume seeded data exists; if a test needs an entity to act on, create it within the test when the UI allows.
8. AUTHENTICATION: never hardcode credentials. If the app uses auth, prefer existing fixtures / storageState. If a route redirects to a login page (the snapshot's final URL differs from the route), assert that redirect rather than inventing a login flow.
9. SNAPSHOT vs SOURCE: the snapshot is authoritative for SELECTORS (what is on the page); the page source is authoritative for INTENT (what should happen). On conflict, take selectors from the snapshot and behaviour from the source, and note it in <thinking>.
10. DYNAMIC ROUTES: only substitute a parameter value that appears in the snapshot or source; otherwise use an obviously-placeholder value and say so. Prefer assertions that hold regardless of the specific record (the page renders, key UI is visible) over record-specific data.
11. Wrap the spec in a test.describe named for the route, with one or more focused test(...) cases. Keep each test to one user-meaningful behaviour.
12. WHEN FIXING A FAILURE: repair the failing test — never delete it, skip it, comment it out, or shrink the suite to go green. Coverage must not decrease across attempts; keep every test() you previously wrote and only change what's needed to make the failing one pass.`
}

export function buildE2EGeneratePrompt(args: {
  route: string
  specFilePath: string          // where the spec will be written, for the model's awareness
  baseURL: string | null
  snapshot: RouteSnapshot | null // captured DOM surface for this route
  pageSource?: string | null     // the page/component source, trimmed — intent, not selectors
  dynamic?: boolean
  existingSpecExample?: string | null // an existing project spec, as a style reference
  helpers?: SpecHelperFile[]          // shared selectors/helpers the project's specs import
  authenticated?: boolean             // spec runs signed in (storageState); snapshot is the logged-in view
  // Multi-step flows discovered by clicking "opener" controls (Stage 3): each trigger + the NEW UI it
  // revealed, so the model can write specs that perform the action and assert the result.
  flows?: Array<{
    trigger: { role: string; name: string }
    revealed: { interactives: { role: string; name: string }[]; headings: string[]; testIds: { testId: string; tag: string }[] }
  }>
  // Deep-walked multi-step journeys (--deep): an opener and the ordered steps lacuna actually drove
  // (inputs filled, advance control clicked, UI that appeared). The model writes the full journey.
  journeys?: Array<{
    opener: { role: string; name: string }
    steps: Array<{ filled: { name: string; value: string; by?: string }[]; advance: string | null; interactives: { role: string; name: string }[]; headings: string[]; note: string | null; toast?: string | null }>
  }>
  // AST FlowMap (control → outcome): the EXACT result of clicking a specific control, derived from
  // its handler in the page source. Each entry is scoped to ITS control — assert it ONLY for that one.
  controlOutcomes?: Array<{
    control: string
    by: 'testid' | 'text' | 'label'
    outcomes: { toast?: { message: string; kind: string }; redirect?: string; opensModal?: boolean }
  }>
}): string {
  const { route, specFilePath, baseURL, snapshot, pageSource, dynamic, existingSpecExample, helpers, authenticated, flows, journeys, controlOutcomes } = args
  const parts: string[] = []

  parts.push(`Write a complete Playwright end-to-end spec for this route.`)
  parts.push(`\nROUTE: ${route}`)
  if (baseURL) parts.push(`BASE URL (already configured; use relative paths in goto): ${baseURL}`)
  parts.push(`SPEC FILE PATH: ${specFilePath}`)

  if (authenticated) {
    parts.push(`\n🔓 AUTHENTICATED SPEC: this runs SIGNED IN (the project applies a saved storageState), so the snapshot below is the real LOGGED-IN view of this route — NOT a login page. Do NOT write a login flow or assert a redirect to login; you are already authenticated. Exercise the post-login UI: trigger the actions, forms, and navigation a signed-in user performs here, and assert their outcomes. If a flow needs credentials (e.g. a re-auth or password confirm), import { testUser } from the project's test-config helper rather than hardcoding. Keep the *.auth.spec.ts filename so it runs under the authenticated project.`)
    parts.push(`⏳ AUTH REHYDRATION: a signed-in client app often shows a loading spinner on first paint while it restores the session from storage (e.g. \`if (authLoading) return <LoadingSpinner/>\`), THEN renders the dashboard. So in a beforeEach, after page.goto(): (1) await page.waitForLoadState('networkidle'), then (2) wait for the FIRST stable signed-in landmark (a nav/sidebar/heading from the snapshot) with a GENEROUS timeout — await expect(<landmark>).toBeVisible({ timeout: 30000 }) — BEFORE any other assertion. Do not assert dashboard elements cold; the spinner can take several seconds to clear. This is a legitimate readiness wait, not a spinner-driven test.`)
  }

  if (dynamic) {
    parts.push(`\n⚠ DYNAMIC ROUTE: this path has parameters (e.g. [id]). Substitute a value only if one appears below; otherwise use an obvious placeholder and note the assumption. Prefer assertions that hold regardless of the specific record.`)
  }

  if (snapshot && snapshot.ok) {
    parts.push(`\nPAGE SNAPSHOT (captured from the running app — target ONLY what appears here):`)
    if (snapshot.url && !sameRoute(snapshot.url, route)) {
      parts.push(`- ⚠ REDIRECT: navigating to ${route} ended at ${snapshot.url}. The spec must account for this — assert the redirect (toHaveURL) and target the page that actually renders.`)
    }
    if (snapshot.title) parts.push(`- Page title: ${JSON.stringify(snapshot.title)}`)
    if (snapshot.headings.length > 0) {
      parts.push(`- Headings: ${snapshot.headings.slice(0, 15).map((h) => JSON.stringify(h)).join(', ')}`)
    }
    if (snapshot.interactives.length > 0) {
      parts.push(`- Interactive elements (role + accessible name — use getByRole(role, { name })):`)
      for (const el of prioritizeInteractives(snapshot.interactives).slice(0, INTERACTIVE_CAP)) {
        parts.push(`    ${el.role}: ${JSON.stringify(el.name)}`)
      }
    }
    if (snapshot.testIds.length > 0) {
      parts.push(`- data-testid values present (use getByTestId('<id>') for these; do NOT invent others):`)
      for (const t of snapshot.testIds.slice(0, INTERACTIVE_CAP)) {
        parts.push(`    ${JSON.stringify(t.testId)}${t.text ? ` (${t.tag} "${t.text}")` : ` (${t.tag})`}`)
      }
    }
    if (snapshot.interactives.length === 0 && snapshot.testIds.length === 0) {
      parts.push(`- No interactive elements or testids were captured. Write a navigation + visibility smoke test (page loads, a heading/title is visible).`)
    }
  } else {
    const why = snapshot?.error ? ` (snapshot failed: ${snapshot.error})` : ''
    parts.push(`\nNo page snapshot is available${why}. Write a conservative smoke test: navigate to the route and assert the page loads (URL is correct and a heading/body is visible). Do not invent specific elements.`)
  }

  if (pageSource) {
    parts.push(`\nPAGE SOURCE (for understanding intent and confirming testids — do NOT import it; selectors still come from the snapshot):`)
    parts.push('```')
    parts.push(pageSource.length > 4000 ? pageSource.slice(0, 4000) + '\n// …truncated' : pageSource)
    parts.push('```')
  }

  if (existingSpecExample) {
    parts.push(`\nEXISTING SPEC IN THIS PROJECT — mirror its conventions: import style, test.describe hierarchy, any fixtures / custom helpers / test.step() / beforeEach hooks / tags / storageState. Only deviate where a convention would violate the rules above.`)
    parts.push('```')
    parts.push(existingSpecExample.length > 2500 ? existingSpecExample.slice(0, 2500) + '\n// …truncated' : existingSpecExample)
    parts.push('```')
  }

  if (helpers && helpers.length > 0) {
    parts.push(`\nSHARED TEST HELPERS / CONFIG used by this project's specs — import and reuse these (their selectors, fixtures, and setup) instead of inlining selector strings or duplicating setup:`)
    for (const h of helpers) {
      parts.push(`\n--- ${h.path} ---`)
      parts.push('```typescript')
      parts.push(h.content)
      parts.push('```')
    }
  }

  if (controlOutcomes && controlOutcomes.length > 0) {
    parts.push(`\nCONTROL → OUTCOME MAP (derived from the page source by resolving each control's own event handler). Each line is the REAL result of clicking THAT specific control. Write a focused test() for EACH control below — activate it and assert its stated outcome — IN ADDITION to any flows/journeys above. Apply each outcome ONLY to its own control, never to a different one:`)
    for (const c of controlOutcomes.slice(0, 12)) {
      const bits: string[] = []
      if (c.outcomes.redirect) bits.push(`navigates to ${JSON.stringify(c.outcomes.redirect)} (assert with toHaveURL)`)
      if (c.outcomes.toast) bits.push(`shows a ${c.outcomes.toast.kind} toast ${JSON.stringify(c.outcomes.toast.message)} (assert getByText is visible)`)
      if (c.outcomes.opensModal) bits.push(`opens a modal/panel (assert the revealed dialog/heading is visible)`)
      const how = c.by === 'testid' ? `testid '${c.control}'` : c.by === 'label' ? `aria-label "${c.control}"` : `text "${c.control}"`
      parts.push(`- The control with ${how} → ${bits.join('; ')}`)
    }
    parts.push(`Each of these is a SMALL standalone test (one action + one assertion) — keep them compact so they don't crowd out the journeys. Do NOT assert one control's outcome after a different control's action. A control not listed here has no statically-known outcome — assert the visible UI change instead. Never invent a toast/redirect that isn't listed.`)
  }

  if (flows && flows.length > 0) {
    parts.push(`\nFLOWS DISCOVERED — clicking these controls revealed NEW UI that is NOT on the initial page (a modal, form, panel, or different tab). Write a focused test() for each meaningful flow: perform the action, then assert a REVEALED element is visible. Use ONLY the revealed role+name / testid selectors listed — they were observed in the real DOM after the click:`)
    for (const fl of flows.slice(0, 6)) {
      const els = fl.revealed.interactives.slice(0, 8).map((e) => `${e.role} "${e.name}"`).join(', ')
      const hs = fl.revealed.headings.slice(0, 4).map((h) => `"${h}"`).join(', ')
      const ids = fl.revealed.testIds.slice(0, 6).map((t) => `'${t.testId}'`).join(', ')
      const bits = [els && `controls ${els}`, hs && `headings ${hs}`, ids && `testids ${ids}`].filter(Boolean).join('; ')
      parts.push(`- Click the ${fl.trigger.role} "${fl.trigger.name}" → reveals ${bits}`)
    }
    parts.push(`For each flow: getByRole(<trigger role>, { name: <trigger name> }).click(), then verify what it OPENED — never just that you clicked.`)
    parts.push(`- If it revealed a FORM (textbox / spinbutton / combobox / checkbox inputs together with a Save/Add/Create/Submit button), EXERCISE it, don't just assert it opened: fill every input with valid, obviously-fake test data — a textbox → a string like "Playwright Test Item"; a spinbutton/number field → a number like 9.99; a combobox/select → selectOption to the first real option; check any required checkbox — then click the submit button and assert the SUCCESS outcome (a confirmation/toast, the new record appearing in the list, or the form closing). Infer the success signal from the page source. Use clearly-identifiable test data so any created record is obvious. Cancel/Close is for cleanup only, never the assertion.`)
    parts.push(`- IDEMPOTENCY: submitting a create-form makes a real record. After asserting success, if the UI offers a way to delete/remove the record you just created (a delete button/menu on the new row), do so at the end so re-running doesn't pile up duplicates. If no cleanup path is visible, still submit and assert — but keep the test data clearly labelled.`)
    parts.push(`- If it revealed a non-form panel / modal / tab, assert a revealed heading or control is visible.`)
    const tabFlows = flows.filter((f) => f.trigger.role === 'tab')
    if (tabFlows.length > 1) {
      parts.push(`- FEATURE BOUNDARIES: this route is a multi-tab page (${tabFlows.map((t) => `"${t.trigger.name}"`).join(', ')}). Each tab is a separate feature region — write a SEPARATE, focused test() per tab: activate the tab with getByRole('tab', { name }).click(), then assert that tab's OWN distinctive heading/control (from its revealed list above), and exercise that tab's form if it revealed one. Do not bundle all tabs into one assertion or rely on one tab's content being present under another.`)
    }
    parts.push(`Match the field labels EXACTLY as listed above (e.g. getByRole('textbox', { name: 'Item Name *' })). Use a web-first auto-waiting assertion for every outcome. Skip a flow only if you cannot identify a safe, meaningful action and assertion.`)
  }

  if (journeys && journeys.length > 0) {
    parts.push(`\nMULTI-STEP JOURNEYS — lacuna DROVE these flows (filling inputs, advancing each step) and recorded the real UI at each step. For each journey write ONE test that uses test.step() per step to walk the WHOLE flow, performing each action and asserting ONE key result per step (the heading/control that proves the step advanced). Mirror the depth — don't stop after step 1:`)
    // Richest first (most steps), so a deep create-flow isn't dropped by the cap in favour of a
    // shallow "clicked a nav section, nothing more" journey.
    const ranked = [...journeys].sort((a, b) => b.steps.length - a.steps.length)
    for (const j of ranked.slice(0, 4)) {
      parts.push(`\n  Journey — click ${j.opener.role} "${j.opener.name}":`)
      j.steps.slice(0, 5).forEach((s, i) => {
        // Emit the field WITH the locator that matches how it was found, so a placeholder like
        // "0.00" becomes getByPlaceholder('0.00') — never getByLabel('0.00') (a real, recurring bug).
        const locatorFor = (by: string | undefined, n: string): string =>
          by === 'testid' ? `getByTestId(${JSON.stringify(n)})`
          : by === 'placeholder' ? `getByPlaceholder(${JSON.stringify(n)})`
          : by === 'name' ? `locator(${JSON.stringify(`[name="${n}"]`)})`
          : by === 'label' ? `getByLabel(${JSON.stringify(n)})`
          : `getByLabel(${JSON.stringify(n)}) /* or getByRole with this name */`
        const fills = s.filled.length > 0 ? s.filled.slice(0, 5).map((f) =>
          f.by === 'combobox'
            ? `OPEN combobox getByRole('combobox', { name: ${JSON.stringify(f.name)} }).click() then click option getByRole('option', { name: ${JSON.stringify(f.value)} })`
            : `${locatorFor(f.by, f.name)}=${JSON.stringify(f.value)}`,
        ).join(', ') : '—'
        // One landmark per step keeps the prompt (and the generated spec) short enough to not truncate.
        // Prefer the captured TOAST — it's the action's real outcome; a heading may be always-on-screen.
        const landmark = s.toast ? `toast getByText(${JSON.stringify(s.toast)})` : s.headings[0] ? `heading "${s.headings[0]}"` : (s.interactives[0] ? `${s.interactives[0].role} "${s.interactives[0].name}"` : 'the next view')
        parts.push(`    ${i + 1}. fill ${fills}${s.advance ? ` → click "${s.advance}"` : ' (final)'} → assert ${landmark} visible${s.note ? ` [${s.note}]` : ''}`)
      })
    }
    parts.push(`A field shown as "OPEN combobox …" is a custom widget (a search/select popper) — drive it exactly as shown: click it open, then click the named option from the listbox. Never call fill() on it.`)
    parts.push(`When a step's landmark is a toast (getByText shown), that is the action's REAL outcome (success or validation) — assert it IMMEDIATELY after the action (await expect(...).toBeVisible()), because toasts auto-dismiss. Prefer it over asserting a generic page heading that may always be present.`)
    parts.push(`Use the EXACT locator shown for each field (the getter is chosen to match how the field is actually identified — do NOT swap getByLabel for a value that came from getByPlaceholder) and these values (or realistic equivalents) so the flow actually progresses. Keep it COMPACT: one assertion per step, web-first auto-waiting, no arbitrary waits, no try/catch or if/else. If a step's note says it was blocked by validation, assert that validation message instead of forcing past it. Keep <thinking> brief — the spec for a deep journey is long, so don't waste the output budget on planning.`)
  }

  parts.push(`\nWrite the complete spec now. Reuse the shared helpers/selectors where they fit; for any NEW locators prefer role/label/testid (testids must be from the list above), unique locators, web-first assertions, no arbitrary waits, and assert the outcome of every action.`)
  return parts.join('\n')
}

// Repair prompt for `lacuna fix --e2e`. Unlike the unit fix prompt (mocks/imports/coverage), this
// is a failure-analysis task: diagnose why a browser spec broke and apply the smallest fix that
// preserves the test's intent. A fresh snapshot, when available, is authoritative for selectors —
// the common failure is selector drift after a UI change.
export function buildE2EFixPrompt(args: {
  specFilePath: string
  specCode: string
  failureOutput: string
  route?: string | null
  baseURL?: string | null
  snapshot?: RouteSnapshot | null
  existingSpecExample?: string | null
  helpers?: SpecHelperFile[]    // local files the spec imports (selectors/helpers/config)
  failurePageState?: string | null   // aria snapshot of the page AT failure, from Playwright's error-context
}): string {
  const { specFilePath, specCode, failureOutput, route, baseURL, snapshot, existingSpecExample, helpers, failurePageState } = args
  const parts: string[] = []

  parts.push(`A Playwright spec is failing. Diagnose the root cause and apply the SMALLEST fix that makes it pass without changing what it tests.`)
  parts.push(`\nSPEC FILE: ${specFilePath}`)
  if (route) parts.push(`ROUTE UNDER TEST: ${route}`)
  if (baseURL) parts.push(`BASE URL: ${baseURL}`)

  parts.push(`\nCURRENT SPEC:`)
  parts.push('```typescript')
  parts.push(specCode)
  parts.push('```')

  if (helpers && helpers.length > 0) {
    parts.push(`\nSHARED TEST HELPERS / CONFIG (imported by this spec — these define its selectors, fixtures, and setup; REUSE them, do not inline or duplicate them):`)
    for (const h of helpers) {
      parts.push(`\n--- ${h.path} ---`)
      parts.push('```typescript')
      parts.push(h.content)
      parts.push('```')
    }
  }

  parts.push(`\nFAILURE OUTPUT:`)
  parts.push('```')
  parts.push(failureOutput.length > 3000 ? failureOutput.slice(0, 3000) + '\n…truncated' : failureOutput)
  parts.push('```')

  if (failurePageState) {
    parts.push(`\nPAGE STATE AT FAILURE (captured by Playwright at the exact moment the spec broke — this is the page the failing step was on, which in a multi-step flow is NOT the first route; AUTHORITATIVE for the failing step's selectors):`)
    parts.push('```')
    parts.push(failurePageState.length > 2500 ? failurePageState.slice(0, 2500) + '\n…truncated' : failurePageState)
    parts.push('```')
  }

  if (snapshot && snapshot.ok) {
    parts.push(`\nFRESH PAGE SNAPSHOT (current state of the page — AUTHORITATIVE for selectors; the page may have changed since the spec was written):`)
    if (snapshot.url && route && !sameRoute(snapshot.url, route)) {
      parts.push(`- ⚠ The route now redirects to ${snapshot.url} — the spec may need to expect this.`)
    }
    if (snapshot.headings.length > 0) parts.push(`- Headings: ${snapshot.headings.slice(0, 15).map((h) => JSON.stringify(h)).join(', ')}`)
    if (snapshot.interactives.length > 0) {
      parts.push(`- Interactive elements (role + name):`)
      for (const el of prioritizeInteractives(snapshot.interactives).slice(0, INTERACTIVE_CAP)) parts.push(`    ${el.role}: ${JSON.stringify(el.name)}`)
    }
    if (snapshot.testIds.length > 0) {
      parts.push(`- data-testid values present:`)
      for (const t of snapshot.testIds.slice(0, INTERACTIVE_CAP)) parts.push(`    ${JSON.stringify(t.testId)} (${t.tag})`)
    }
  }

  if (existingSpecExample) {
    parts.push(`\nPROJECT SPEC STYLE (preserve these conventions):`)
    parts.push('```')
    parts.push(existingSpecExample.length > 1500 ? existingSpecExample.slice(0, 1500) + '\n// …truncated' : existingSpecExample)
    parts.push('```')
  }

  parts.push(`
FAILURE ANALYSIS — in <thinking>, identify the root cause. Common causes: selector drift (the
element's role/name/testid changed), a strict-mode violation (the locator matched multiple elements),
a timing/synchronization gap (asserting before the UI settles), an auth/redirect change, a data
dependency, a removed feature, or an accessibility change.

REPAIR PRIORITY — apply the smallest fix at the highest applicable level, in this order. Try the
upper levels before ever touching an assertion:
  1. Selector repair (match the fresh snapshot — the current truth)
  2. Synchronization repair (web-first auto-waiting assertions / wait on a UI signal — never waitForTimeout)
  3. Redirect adjustment (expect the new URL)
  4. Accessibility update (the role/name/aria changed)
  5. Data-setup change (the test needs an entity it can create via the UI)
  6. Feature removal (the feature is genuinely gone — update the test to the new behaviour)
  Only after none of the above apply: modify, and as a last resort remove, an assertion — and ONLY
  when the snapshot proves it is now invalid. Say why in <thinking>.

STRICT-MODE VIOLATIONS — if the failure says "strict mode violation / resolved to N elements", the
locator matched more than one element. Make it UNIQUE (role + accessible name, or a data-testid from
the snapshot). Do NOT silence it with .first()/.last()/.nth() unless the snapshot shows the matches
are genuinely equivalent with no semantic distinction.

PRESERVE INTENT and CONVENTIONS: keep what each test verifies, its name, the describe structure, and
the project's helpers. When the spec uses SHARED TEST HELPERS / CONFIG (e.g. a central \`selectors\`
object or helper functions), KEEP USING them — reference selectors.x and the helpers exactly as the
spec does. Do NOT inline a selector string, duplicate a helper, or convert the project's selectors to
getByRole. If the project centralises selectors as CSS strings, that is its deliberate convention;
the role/label/testid preference is for NEW selectors you author, and does NOT override it.

FIX AT THE SOURCE (multi-file) — if the real cause is a stale selector or value DEFINED IN a helper
file shown above (e.g. selectors.loginButton points at a data-testid that changed), fix it THERE, not
by inlining a workaround in the spec. After the spec, append the corrected file like this:
// ---HELPER_FILE: <exact path shown above>---
<the COMPLETE updated contents of that file>
Only emit a HELPER_FILE you were shown above; change only what is necessary in it.

Output the repaired spec in <code_output> (followed by any // ---HELPER_FILE--- sections). Same rules
as generation: prefer role/label/testid for any NEW locators, unique locators, web-first assertions,
no arbitrary waits, no forced interactions, assert the outcome of every action.`)

  return parts.join('\n')
}

// ─── data-testid injection (opt-in, --inject-testids) ───────────────────────────
//
// This is the ONLY E2E prompt that edits application source. It adds data-testid attributes to a
// component so generated specs can use stable getByTestId locators. The caller injects, re-snapshots,
// and reverts if the testid didn't reach the DOM (e.g. a component that doesn't forward props), so
// the prompt only needs to add attributes correctly — it does not need to reason about forwarding.

export function buildTestIdInjectionSystemPrompt(): string {
  return `You add data-testid attributes to a React/JSX component so its interactive elements can be targeted by Playwright's getByTestId(). You are a careful, surgical editor.

OUTPUT FORMAT (required):
<thinking>
Which elements get a testid and what id you chose for each.
</thinking>
<code_output>
// the COMPLETE modified source file
</code_output>

ABSOLUTE RULES:
1. ONLY add data-testid attributes. Change NOTHING else — not logic, imports, styling, class names, text, structure, whitespace, or formatting. The diff must be purely added data-testid="..." attributes.
2. Add a data-testid to each requested interactive element that does not already have one. Do not add testids to elements that already have one, and do not add them anywhere else.
3. IDs are stable, lowercase, kebab-case, derived from the element's purpose and type, e.g. the "Sign in" button → data-testid="sign-in-button", an "Email" field → data-testid="email-input". Keep them unique within the file.
4. data-testid is a plain DOM data-* attribute: it has no effect on rendering or layout. Put it directly on NATIVE elements (<button>, <input>, <a>, <textarea>, <select>) — these always forward it to the DOM.
5. CUSTOM COMPONENTS (<Button>, <Field>): only add data-testid to a component usage when the component plainly forwards arbitrary props (you can see it spread {...props}/{...rest}) OR already accepts a testid/test-related prop. If you are unsure whether it forwards, prefer adding the testid to a nearby native element instead, or leave it unchanged. Never assume forwarding, and never GUESS component-specific prop bags. EXCEPTION: if a LIBRARY-SPECIFIC FORWARDING section is provided below, use the exact documented prop it names for that library (e.g. MUI inputProps) — that is the supported path to the DOM, not a guess.
6. Do NOT invent or rename anything. If you cannot confidently map a requested element to a JSX node, leave it alone rather than guessing.
7. Return the entire file, unchanged except for the added attributes.`
}

export function buildTestIdInjectionPrompt(args: {
  sourceFile: string
  sourceCode: string
  interactives: { role: string; name: string }[]
  existingTestIds: string[]
  libraryGuidance?: string | null   // documented forwarding for detected UI libraries (ui-libraries.ts)
}): string {
  const { sourceFile, sourceCode, interactives, existingTestIds, libraryGuidance } = args
  const parts: string[] = []

  parts.push(`Add data-testid attributes to the interactive elements in this component so Playwright specs can target them.`)
  parts.push(`\nSOURCE FILE: ${sourceFile}`)

  if (libraryGuidance) parts.push(`\n${libraryGuidance}`)

  parts.push(`\nINTERACTIVE ELEMENTS that need a data-testid (role + accessible name, from the rendered page):`)
  for (const el of interactives.slice(0, 40)) {
    parts.push(`  ${el.role}: ${JSON.stringify(el.name)}`)
  }
  if (existingTestIds.length > 0) {
    parts.push(`\nALREADY have a data-testid (do not touch these, and keep your new ids distinct from them): ${existingTestIds.map((t) => JSON.stringify(t)).join(', ')}`)
  }

  parts.push(`\nCOMPONENT SOURCE:`)
  parts.push('```tsx')
  parts.push(sourceCode)
  parts.push('```')

  parts.push(`\nReturn the COMPLETE file with data-testid attributes added to the elements above. Add ONLY data-testid attributes — change nothing else.`)
  return parts.join('\n')
}

// True when a final URL corresponds to the requested route (ignoring origin / trailing slash), so
// we only flag a genuine redirect, not the normal origin-prefixed URL.
function sameRoute(finalUrl: string, route: string): boolean {
  try {
    const path = new URL(finalUrl).pathname.replace(/\/$/, '')
    const want = route.replace(/\/$/, '')
    return path === want || path === want + '/' || (want === '' && path === '')
  } catch {
    return finalUrl.endsWith(route)
  }
}
