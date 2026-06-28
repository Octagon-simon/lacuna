// Deep (multi-step) flow exploration — Stage 4, opt-in via `lacuna generate --e2e --deep`.
//
// Stage 3 clicks one "opener" and captures what it reveals. This goes further: starting from an
// opener, it WALKS the flow — fills the visible inputs with type-aware test data, clicks the
// advance control (Continue/Next/Send/Save/…), captures the next step, and repeats up to a depth
// cap. The result is a recorded "journey" (the ordered steps + the real DOM at each) that the model
// turns into a full multi-step user-journey spec with real selectors at every step.
//
// SAFETY: this DRIVES and SUBMITS real flows (it creates records and can trigger real actions like
// payments). It is opt-in and intended for a test/staging environment with test credentials — the
// caller gates it behind `--deep` and warns the user. Everything here is best-effort and wrapped in
// try/catch: a step that can't be filled or advanced ends the journey rather than throwing.

import { writeFile, readFile, mkdir, rm, readdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCommand } from '../runner.js'
import type { PlaywrightConfig } from '../playwright.js'
import { parseAriaSnapshot, type InteractionProbe, type InteractiveElement, type TestIdElement } from './snapshot.js'

export interface JourneyStep {
  filled: { name: string; value: string; by?: string }[]   // inputs this step filled; `by` = how the field is locatable (testid/label/placeholder/name/role)
  advance: string | null                              // the advance control clicked (null = terminal step)
  interactives: InteractiveElement[]                  // controls visible after this step
  headings: string[]                                  // headings visible after this step
  testIds: TestIdElement[]
  note: string | null                                 // why the journey stopped/branched, if anything
  toast: string | null                                // transient toast/alert that appeared after the action — the real outcome to assert
}

export interface Journey {
  route: string
  opener: { role: string; name: string }
  ok: boolean
  steps: JourneyStep[]
  error: string | null
}

const EXPLORE_SPEC_NAME = '__lacuna_explore__.spec.ts'

// Walks each probe's flow to depth `maxDepth`, recording the journey. One browser run for all probes
// (each re-navigates from the route, so journeys don't pollute each other). Authenticated when
// storageState is given.
export async function exploreFlows(
  probes: InteractionProbe[],
  cwd: string,
  pwConfig: PlaywrightConfig,
  timeoutMs = 180_000,
  storageState?: string,
  maxDepth = 4,
  onProgress?: (msg: string) => void,
): Promise<Journey[]> {
  if (probes.length === 0) return []
  const testDirAbs = join(cwd, pwConfig.testDir)
  const specPath = join(testDirAbs, EXPLORE_SPEC_NAME)
  const outDir = join(tmpdir(), `lacuna-explore-${process.pid}-${Date.now()}`)
  // ALL probes run in ONE test sharing one page. Playwright's DEFAULT per-test timeout is 30s, so a
  // multi-probe walk gets killed mid-loop — the page is closed and every remaining probe fails with
  // "Target page/context/browser has been closed" (this silently dropped all the later routes,
  // e.g. an auth-gated /admin whose probes come last). Scale the test timeout to the probe count, and
  // make the process-spawn timeout a bit larger so the runner isn't killed before the test finishes.
  const PER_PROBE_MS = 30_000
  const testTimeoutMs = probes.length * PER_PROBE_MS + 60_000
  const spawnTimeoutMs = Math.max(timeoutMs, testTimeoutMs + 60_000)
  // Stream per-probe progress (the spec console.logs "LACUNA_PROBE i/N route :: name") so a long
  // exploration shows live movement instead of looking hung.
  const onLine = onProgress
    ? (line: string) => { const m = line.match(/LACUNA_PROBE (\d+\/\d+) (.+)/); if (m) onProgress(`    [${m[1]}] ${m[2]}`) }
    : undefined
  try {
    await mkdir(testDirAbs, { recursive: true })
    await mkdir(outDir, { recursive: true })
    await writeFile(specPath, buildExploreSpec(probes, outDir, maxDepth, testTimeoutMs, storageState), 'utf-8')
    await runCommand(`npx playwright test ${EXPLORE_SPEC_NAME} --no-deps --reporter=line`, cwd, spawnTimeoutMs, onLine)

    const journeys: Journey[] = []
    for (let i = 0; i < probes.length; i++) {
      let raw: RawJourney | null = null
      try { raw = JSON.parse(await readFile(join(outDir, `journey-${i}.json`), 'utf-8')) } catch { /* missing */ }
      if (!raw) { journeys.push({ route: probes[i].route, opener: { role: probes[i].role, name: probes[i].name }, ok: false, steps: [], error: 'no journey captured' }); continue }
      journeys.push({
        route: probes[i].route,
        opener: { role: probes[i].role, name: probes[i].name },
        ok: !!raw.ok,
        error: raw.error ?? null,
        steps: (raw.steps ?? []).map((s): JourneyStep => {
          const { interactives, headings } = parseAriaSnapshot(s.aria ?? null)
          return { filled: s.filled ?? [], advance: s.advance ?? null, interactives, headings, testIds: s.testIds ?? [], note: s.note ?? null, toast: s.toast ?? null }
        }),
      })
    }
    return journeys
  } catch {
    return probes.map((p) => ({ route: p.route, opener: { role: p.role, name: p.name }, ok: false, steps: [], error: 'exploration failed' }))
  } finally {
    await rm(specPath, { force: true }).catch(() => {})
    await rm(outDir, { recursive: true, force: true }).catch(() => {})
  }
}

interface RawJourney {
  ok?: boolean
  error?: string | null
  steps?: { filled?: { name: string; value: string; by?: string }[]; advance?: string | null; aria?: string | null; testIds?: TestIdElement[]; note?: string | null; toast?: string | null }[]
}

function buildExploreSpec(probes: InteractionProbe[], outDir: string, maxDepth: number, testTimeoutMs: number, storageState?: string): string {
  const useAuth = storageState ? `test.use({ storageState: ${JSON.stringify(storageState)} })\n` : ''
  return `// AUTO-GENERATED by lacuna for deep flow exploration (--deep). Safe to delete.
import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

${useAuth}const PROBES = ${JSON.stringify(probes)}
const OUT = ${JSON.stringify(outDir)}
const MAX_DEPTH = ${maxDepth}
const LOADER = '[data-testid*="load"]:visible, [data-testid*="spinner"]:visible, [data-testid*="skeleton"]:visible, [aria-busy="true"]:visible, .spinner:visible, .loading:visible, .skeleton:visible'
const ADVANCE = /^(continue|next|send|save|submit|create|add|confirm|proceed|done|finish|review|pay)\\b/i
const SKIP_BTN = /(cancel|back|close|dismiss|previous|prev|logout|sign\\s?out|delete|remove)/i

function valueFor(name, type) {
  const n = (name || '').toLowerCase()
  if (type === 'email' || /e-?mail/.test(n)) return 'qa.playwright@example.com'
  // URL BEFORE everything else: placeholders are often the URL itself (https://facebook.com/...).
  if (type === 'url' || /^https?:|www\\.|\\.com|\\.co\\b|url|website|link|instagram|facebook|twitter|tiktok|linkedin|youtube|handle/.test(n)) return 'https://example.com/playwright-test'
  if (type === 'tel' || /phone|mobile|whatsapp|tel\\b|^\\+?\\d[\\d ]{5,}/.test(n)) return '9990001234'
  if (type === 'number' || /price|amount|qty|quantity|count|age|stock|^\\s*[0-9.]+\\s*$/.test(n)) return '100'
  if (type === 'date' || /date|dob|birthday/.test(n)) return '2030-01-01'
  if (type === 'password') return 'PlaywrightTest123!'
  if (/\\b(pin|otp|code|cvv)\\b/.test(n)) return '123456'
  // Default: a labelled string, but never echo a URL/placeholder verbatim (produces junk).
  const base = (name || '').replace(/https?:\\/\\/\\S+/g, '').replace(/[^a-z0-9 ]/gi, ' ').replace(/\\s+/g, ' ').trim().slice(0, 18)
  return 'Playwright Test ' + (base || 'Value')
}

async function settle(page) {
  // Realtime apps (Firebase/websockets) keep the network busy, so 'networkidle' NEVER fires and this
  // would burn the FULL timeout on every call — the dominant cost across many probes. Keep it short;
  // the loader-hidden wait below is the meaningful readiness signal.
  await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {})
  await page.locator(LOADER).first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
}

// Onboarding / welcome / promo / cookie modals interrupt and intercept clicks. Best-effort dismissal:
// click a clearly-dismissive control (Got it / Skip / Maybe later / No thanks / Close / ✕) in the
// topmost dialog, else press Escape. Only DISMISS words — never "Continue/OK/Save" (those advance a
// real flow). Returns true if it clicked something.
const DISMISS_BTN = /\\b(got it|skip|maybe later|no thanks|not now|dismiss|don'?t show|remind me|close)\\b|^[✕×x]$/i
async function dismissOverlay(page) {
  const dlg = page.locator('[role="dialog"]:visible, [aria-modal="true"]:visible, .fixed.inset-0:visible').last()
  try {
    if ((await dlg.count()) > 0) {
      const btns = await dlg.getByRole('button').all().catch(() => [])
      for (const b of btns) {
        const name = ((await b.textContent().catch(() => '')) || (await b.getAttribute('aria-label').catch(() => '')) || '').replace(/\\s+/g, ' ').trim()
        if (name && DISMISS_BTN.test(name)) { await b.click({ timeout: 2000 }).catch(() => {}); await settle(page); return true }
      }
    }
    // Fallback: an onboarding/promo modal rendered in a CUSTOM portal (not a standard dialog
    // container — e.g. cheflymenu's "Build your plan" with a "Maybe later" button). The dismiss
    // words are unambiguous enough to click anywhere on the page without risking a real-flow control.
    const loose = page.getByRole('button', { name: DISMISS_BTN }).first()
    if ((await loose.count().catch(() => 0)) > 0 && (await loose.isVisible().catch(() => false))) {
      await loose.click({ timeout: 2000 }).catch(() => {}); await settle(page); return true
    }
  } catch { /* fall through */ }
  await page.keyboard.press('Escape').catch(() => {})
  await settle(page)
  return false
}

// Names of visible inputs right now — used to skip pre-existing inputs (a search bar, a header
// filter) that aren't part of the flow we just opened.
async function inputNames(page) {
  return await page.locator('input:visible, textarea:visible').evaluateAll((els) =>
    els.map((e) => e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('name') || ''),
  ).catch(() => [])
}

// Fills inputs that belong to the opened flow — i.e. NOT in \`skip\` (the inputs that existed before
// we opened it). Prefers a visible dialog/modal as the scope when one is present.
async function fillVisibleInputs(page, skip) {
  const dialog = page.locator('[role="dialog"]:visible, [aria-modal="true"]:visible, .modal:visible').first()
  const scope = (await dialog.count().catch(() => 0)) > 0 ? dialog : page
  const filled = []
  const inputs = await scope.locator('input:visible, textarea:visible, [contenteditable="true"]:visible').all().catch(() => [])
  for (const inp of inputs.slice(0, 16)) {
    try {
      const type = (await inp.getAttribute('type').catch(() => null)) || 'text'
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color'].includes(type)) continue
      const testid = await inp.getAttribute('data-testid').catch(() => null)
      const label = await inp.getAttribute('aria-label').catch(() => null)
      const placeholder = await inp.getAttribute('placeholder').catch(() => null)
      const nameAttr = await inp.getAttribute('name').catch(() => null)
      const skipName = label || placeholder || nameAttr || ''
      if (skip && skip.includes(skipName)) continue   // pre-existing input (search bar, etc.) — not this flow
      // Record HOW the field is locatable so the spec uses the matching Playwright getter (the
      // placeholder "0.00" must become getByPlaceholder, NOT getByLabel — that mismatch was a real bug).
      let by = 'role', loc = skipName
      if (testid) { by = 'testid'; loc = testid }
      else if (label) { by = 'label'; loc = label }
      else if (placeholder) { by = 'placeholder'; loc = placeholder }
      else if (nameAttr) { by = 'name'; loc = nameAttr }
      if (type === 'checkbox' || type === 'radio') { await inp.check({ timeout: 1500 }).catch(() => {}); filled.push({ name: loc || type, by, value: 'checked' }); continue }
      const val = valueFor(skipName, type)
      await inp.fill(val, { timeout: 1500 })
      filled.push({ name: loc || 'input', by, value: val })
    } catch { /* skip this input */ }
  }
  const selects = await scope.locator('select:visible').all().catch(() => [])
  for (const s of selects.slice(0, 5)) {
    try {
      const testid = await s.getAttribute('data-testid').catch(() => null)
      const label = await s.getAttribute('aria-label').catch(() => null)
      const nameAttr = await s.getAttribute('name').catch(() => null)
      let by = 'role', loc = label || ''
      if (testid) { by = 'testid'; loc = testid } else if (label) { by = 'label'; loc = label } else if (nameAttr) { by = 'name'; loc = nameAttr }
      await s.selectOption({ index: 1 }, { timeout: 1500 })
      filled.push({ name: loc || 'select', by, value: 'option-1' })
    } catch { /* skip */ }
  }
  return filled
}

// P1 widget adapter: drive ARIA comboboxes / listbox-poppers that generic fill() can't (the afriex
// currency picker is the canonical case). Radix, Headless UI and MUI all expose role="combobox" /
// aria-haspopup="listbox", so this single ARIA sequence covers them: open → (type-ahead if needed) →
// wait for the listbox → click the first real option. Best-effort and non-throwing; returns a
// filled-style record per widget advanced (by:'combobox', value = the chosen option's text) so the
// generated spec drives it the same way instead of calling fill() on a non-input.
async function driveWidgets(page) {
  const dialog = page.locator('[role="dialog"]:visible, [aria-modal="true"]:visible, .modal:visible').first()
  const scope = (await dialog.count().catch(() => 0)) > 0 ? dialog : page
  const out = []
  const combos = await scope.locator('[role="combobox"]:visible, [aria-haspopup="listbox"]:visible').all().catch(() => [])
  for (const c of combos.slice(0, 6)) {
    try {
      const tag = await c.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')
      if (tag === 'select') continue   // native <select> is handled by fillVisibleInputs
      const label = (await c.getAttribute('aria-label').catch(() => null)) || (await c.getAttribute('placeholder').catch(() => null)) || 'combobox'
      await c.click({ timeout: 1500 }).catch(() => {})
      await page.locator('[role="listbox"]:visible, [role="option"]:visible').first().waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
      let options = await page.locator('[role="option"]:visible').all().catch(() => [])
      if (options.length === 0) {
        // Type-ahead combobox: a few chars usually reveal options. Use a neutral letter.
        const typeAhead = page.locator('[role="combobox"] input:visible, input[aria-autocomplete="list"]:visible, [aria-modal="true"] input:visible').first()
        await typeAhead.fill('a', { timeout: 1000 }).catch(() => {})
        await page.waitForTimeout(350)
        options = await page.locator('[role="option"]:visible').all().catch(() => [])
      }
      if (options.length > 0) {
        const opt = options[0]
        const txt = ((await opt.textContent().catch(() => '')) || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
        await opt.click({ timeout: 1500 }).catch(() => {})
        await settle(page)
        out.push({ name: label, by: 'combobox', value: txt || 'first option' })
      } else {
        await page.keyboard.press('Escape').catch(() => {})   // couldn't drive it — don't leave it open blocking
      }
    } catch { /* skip this widget */ }
  }
  return out
}

// The button that advances the flow. Excludes \`exclude\` (the opener's own name — e.g. "Add Item"
// opening AND submitting would be ambiguous) and skip-words (cancel/back/delete/…). Prefers a button
// inside a visible dialog when a modal is open. \`justFilled\` = inputs were filled this step, so we're
// SUBMITTING a form — a button sharing the opener's name is then almost certainly the submit (a real
// case: cheflymenu's "Add Item" form, not a role=dialog, whose submit is also "Add Item").
async function findAdvance(page, exclude, justFilled) {
  const dialog = page.locator('[role="dialog"]:visible, [aria-modal="true"]:visible, .modal:visible').first()
  const inDialog = (await dialog.count().catch(() => 0)) > 0
  const scope = inDialog ? dialog : page
  // Strongest signal — an explicit submit button (especially right after filling a form).
  const submit = scope.locator('button[type="submit"]:visible').first()
  if ((await submit.count().catch(() => 0)) > 0) {
    try {
      if (await submit.isEnabled()) {
        const name = ((await submit.textContent()) || (await submit.getAttribute('aria-label')) || 'Submit').replace(/\\s+/g, ' ').trim()
        if (!SKIP_BTN.test(name)) return { name, locator: submit }
      }
    } catch { /* fall through */ }
  }
  const btns = await scope.getByRole('button').all().catch(() => [])
  let openerNamed = null   // an ADVANCE button sharing the opener's name — last resort when justFilled
  for (const b of btns) {
    try {
      if (!(await b.isVisible()) || !(await b.isEnabled())) continue
      const name = ((await b.textContent()) || (await b.getAttribute('aria-label')) || '').replace(/\\s+/g, ' ').trim()
      if (!name || SKIP_BTN.test(name) || !ADVANCE.test(name)) continue
      const isOpener = !inDialog && exclude && name.toLowerCase() === exclude.toLowerCase()
      if (isOpener) {
        // Keep the LAST opener-named match (a form's submit sits below the top opener control), and
        // only use it after we actually filled a form — otherwise it'd just re-open the flow.
        if (justFilled) openerNamed = { name, locator: b }
        continue
      }
      return { name, locator: b }
    } catch { /* skip */ }
  }
  return openerNamed
}

// Capture a transient success/validation TOAST that appears right after an action — the real outcome
// to assert (a persistent page heading is a poor proxy). Toasts auto-dismiss, so poll briefly and
// grab the first one. Covers sonner, react-toastify, MUI snackbar, and ARIA status/alert live regions.
async function captureToast(page) {
  const TOAST = '[data-sonner-toast]:visible, .Toastify__toast:visible, [class*="toast" i]:visible, [class*="snackbar" i]:visible, [role="status"]:visible, [role="alert"]:visible'
  // Reject non-toast matches: framework dev overlays (Next.js badge) and elements whose text is really
  // CSS from an embedded <style> (has braces / custom props / keyframes), and require a real word.
  const isMessage = (s) =>
    !!s && s.length >= 2 && s.length <= 100 &&
    !/[{}]|--[a-z-]+\\s*:|cubic-bezier|@keyframes|data-next|nextjs/i.test(s) &&
    /[a-z]{3,}/i.test(s)
  const loc = page.locator(TOAST)
  try {
    await loc.first().waitFor({ state: 'visible', timeout: 2500 })
    const all = await loc.all().catch(() => [])
    for (const el of all.slice(0, 8)) {
      // innerText (rendered text) skips <style>/<script>; scan candidates for the first real message.
      const txt = ((await el.innerText().catch(() => '')) || '').replace(/\\s+/g, ' ').trim()
      if (isMessage(txt)) return txt.slice(0, 120)
    }
  } catch { /* none */ }
  return null
}

async function capture(page) {
  const aria = await page.locator('body').ariaSnapshot().catch(() => null)
  const testIds = await page.locator('[data-testid]').evaluateAll((els) =>
    els.map((e) => ({ testId: e.getAttribute('data-testid') || '', tag: e.tagName.toLowerCase(), text: (e.textContent || '').trim().slice(0, 40), role: e.getAttribute('role') || '' })),
  ).catch(() => [])
  return { aria, testIds }
}

test('lacuna deep explore', async ({ page }) => {
  test.setTimeout(${testTimeoutMs})   // all probes share one test; default 30s would kill it mid-walk
  mkdirSync(OUT, { recursive: true })
  for (let pi = 0; pi < PROBES.length; pi++) {
    const p = PROBES[pi]
    console.log('LACUNA_PROBE ' + (pi + 1) + '/' + PROBES.length + ' ' + p.route + ' :: ' + p.name)   // streamed as progress
    const journey = { ok: false, steps: [], error: null }
    try {
      await page.goto(p.route, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await settle(page)
      await dismissOverlay(page)   // clear an onboarding/cookie modal that loaded with the page
      const baseInputs = await inputNames(page)   // inputs present BEFORE opening the flow (skip these)
      await page.getByRole(p.role, { name: p.name, exact: true }).first().click({ timeout: 6000 })
      await settle(page)

      let prevSig = ''
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const step = { filled: [], advance: null, aria: null, testIds: [], note: null, toast: null }
        step.filled = await fillVisibleInputs(page, baseInputs)
        const widgetFills = await driveWidgets(page)   // P1: comboboxes/listbox-poppers fill() can't drive
        if (widgetFills.length) step.filled = step.filled.concat(widgetFills)
        const sig = step.filled.map((f) => f.name).sort().join('|')

        // No progress: filling the very same fields as the previous step means we're stuck on the
        // same form (validation error or a blocking modal). Record the current state once and stop.
        if (sig && sig === prevSig) {
          const snap = await capture(page); step.aria = snap.aria; step.testIds = snap.testIds
          step.note = 'no progress — same form as the previous step (blocked by validation or a modal)'
          journey.steps.push(step); break
        }
        prevSig = sig

        const advance = await findAdvance(page, p.name, step.filled.length > 0)
        if (!advance) {
          const snap = await capture(page); step.aria = snap.aria; step.testIds = snap.testIds
          step.note = 'no advance control — terminal step'; journey.steps.push(step); break
        }
        step.advance = advance.name
        try {
          await advance.locator.click({ timeout: 6000 })
        } catch {
          // Likely an onboarding/promo overlay intercepted the click. Dismiss it and retry once.
          const dismissed = await dismissOverlay(page)
          try {
            await advance.locator.click({ timeout: 6000 })
            if (dismissed) step.note = 'dismissed an intercepting overlay, then advanced'
          } catch {
            const snap = await capture(page); step.aria = snap.aria; step.testIds = snap.testIds
            step.note = 'advance click blocked by an overlay that could not be dismissed — terminal'; journey.steps.push(step); break
          }
        }
        step.toast = await captureToast(page)   // the action's real outcome (success/validation), before it fades
        await settle(page)
        await dismissOverlay(page)   // a step may pop a fresh interrupt before the next one
        // Capture the state AFTER advancing — this step's recorded UI is the RESULT of its action.
        const snap = await capture(page)
        step.aria = snap.aria; step.testIds = snap.testIds
        journey.steps.push(step)
      }
      journey.ok = journey.steps.length > 0
    } catch (e) {
      journey.error = String((e && e.message) || e)
    }
    writeFileSync(join(OUT, 'journey-' + pi + '.json'), JSON.stringify(journey))
  }
})
`
}
