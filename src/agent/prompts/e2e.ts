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
POST-ACTION VALIDATION: after any action that changes state (submit, save, delete, navigate), assert
   the observable OUTCOME, not just that you clicked — e.g. a success/status message becomes visible,
   a dialog closes (toBeHidden), the URL changes, a new item appears, or a button becomes disabled.
   Assert user-visible effects, not implementation details.
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
1. Import from Playwright only: import { test, expect } from '@playwright/test'. The spec imports NO application source and uses NO mocks — it exercises the running app.
2. Target ONLY elements present in the PAGE SNAPSHOT. If the page has nothing meaningful to interact with, write a minimal navigation + visibility smoke test rather than fabricating elements. If an element the page clearly needs is absent (the snapshot may be truncated on a busy page), fall back to a visibility check on a container/heading that IS present and note the omission in <thinking> — never invent the missing selector.
3. ${SELECTOR_RULES}
4. ${ASSERTION_RULES}
5. await every action (goto, click, fill, press) and every expect.
6. Navigate with await page.goto('<route>') — paths are relative to the configured baseURL; never hardcode a host.
7. TEST ISOLATION: every test must run independently and in any order. Do not depend on another test's side effects, and do not assume seeded data exists — if a test needs an entity, prefer creating it within the test when the UI allows.
8. AUTHENTICATION: never hardcode credentials. If the app uses auth, prefer existing fixtures / storageState. If a route redirects to a login page (the snapshot's final URL differs from the route), assert that redirect rather than inventing a login flow.
9. SNAPSHOT vs SOURCE: the snapshot is authoritative for SELECTORS (what is on the page); the page source is authoritative for INTENT (what should happen). On conflict, take selectors from the snapshot and behaviour from the source, and note it in <thinking>.
10. DYNAMIC ROUTES: only substitute a parameter value that appears in the snapshot or source; otherwise use an obviously-placeholder value and say so. Prefer assertions that hold regardless of the specific record (the page renders, key UI is visible) over record-specific data.
11. Wrap the spec in a test.describe named for the route, with one or more focused test(...) cases. Keep each test to one user-meaningful behaviour.`
}

export function buildE2EGeneratePrompt(args: {
  route: string
  specFilePath: string          // where the spec will be written, for the model's awareness
  baseURL: string | null
  snapshot: RouteSnapshot | null // captured DOM surface for this route
  pageSource?: string | null     // the page/component source, trimmed — intent, not selectors
  dynamic?: boolean
  existingSpecExample?: string | null // an existing project spec, as a style reference
}): string {
  const { route, specFilePath, baseURL, snapshot, pageSource, dynamic, existingSpecExample } = args
  const parts: string[] = []

  parts.push(`Write a complete Playwright end-to-end spec for this route.`)
  parts.push(`\nROUTE: ${route}`)
  if (baseURL) parts.push(`BASE URL (already configured; use relative paths in goto): ${baseURL}`)
  parts.push(`SPEC FILE PATH: ${specFilePath}`)

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

  parts.push(`\nWrite the complete spec now. Role/label/testid locators only (testids must be from the list above), unique locators, web-first assertions, no arbitrary waits, and assert the outcome of every action.`)
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
}): string {
  const { specFilePath, specCode, failureOutput, route, baseURL, snapshot, existingSpecExample } = args
  const parts: string[] = []

  parts.push(`A Playwright spec is failing. Diagnose the root cause and apply the SMALLEST fix that makes it pass without changing what it tests.`)
  parts.push(`\nSPEC FILE: ${specFilePath}`)
  if (route) parts.push(`ROUTE UNDER TEST: ${route}`)
  if (baseURL) parts.push(`BASE URL: ${baseURL}`)

  parts.push(`\nCURRENT SPEC:`)
  parts.push('```typescript')
  parts.push(specCode)
  parts.push('```')

  parts.push(`\nFAILURE OUTPUT:`)
  parts.push('```')
  parts.push(failureOutput.length > 3000 ? failureOutput.slice(0, 3000) + '\n…truncated' : failureOutput)
  parts.push('```')

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

PRESERVE INTENT: keep what each test verifies, its name, the describe structure, and any helpers.

Output the COMPLETE repaired spec in <code_output>. Same rules as generation: role/label/testid
locators only (testids must exist in the snapshot), unique locators, web-first assertions, no
arbitrary waits, no forced interactions, assert the outcome of every action.`)

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
