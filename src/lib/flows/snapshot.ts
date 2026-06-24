// DOM snapshotting for E2E generation — PHASE 2.
//
// To write specs with REAL selectors (getByRole/getByLabel) instead of hallucinated CSS, the
// generator needs to see what's actually on each page. We capture that by driving a real
// browser — but rather than launch Playwright from lacuna's process (fragile cross-package
// resolution, version skew), we run the snapshot AS a Playwright test in the PROJECT's own
// context (Option B). That has two payoffs:
//
//   1. `npx playwright test` reads the project's playwright.config.ts and starts its `webServer`
//      automatically, so the app under test comes up exactly the way the project expects — we
//      don't reimplement app startup.
//   2. The browser + Playwright version are the project's own, so the captured tree matches what
//      the project's specs will run against.
//
// Mechanism: we write a temporary spec into the project's testDir with the routes baked in. It
// navigates to each route, captures the accessibility tree (the selector surface), and writes
// one JSON file per route. We run it filtered by filename, read the JSON back, and delete the
// temp spec. The accessibility tree is exactly what maps onto Playwright's role/name locators.

import { writeFile, readFile, mkdir, rm, readdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCommand } from '../runner.js'
import type { PlaywrightConfig } from '../playwright.js'

export interface InteractiveElement {
  role: string   // 'button' | 'link' | 'textbox' | 'checkbox' | ...
  name: string   // accessible name — what getByRole(role, { name }) matches
}

export interface TestIdElement {
  testId: string // the data-testid value — what getByTestId(testId) matches
  tag: string    // element tag (button, input, …) for the model's context
  text: string   // trimmed visible text, if any
  role: string   // explicit role attribute, if any — used to confirm injected testids landed on a control
}

export interface RouteSnapshot {
  route: string
  ok: boolean
  url: string | null            // final URL after navigation (reveals redirects, e.g. → /login)
  title: string | null          // document.title
  headings: string[]            // visible heading text, top-down — the page's structure
  interactives: InteractiveElement[] // the role+name selector surface the model should target
  testIds: TestIdElement[]      // data-testid values actually present (so getByTestId is never invented)
  aria: string | null           // raw Playwright aria snapshot (YAML), kept for richer context
  error: string | null
}

export interface SnapshotResult {
  ok: boolean
  snapshots: RouteSnapshot[]
  error?: string
  // The raw Playwright run output, for diagnostics when ok is false (webServer failed, etc.).
  rawOutput?: string
}

const TEMP_SPEC_NAME = '__lacuna_snapshot__.spec.ts'

// Roles worth surfacing as the selector palette. Headings are collected separately (they
// describe structure, not interaction).
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch',
  'slider', 'spinbutton', 'option',
])

// Capture each route's DOM via a throwaway Playwright test run in the project. Returns one
// RouteSnapshot per requested route (ok:false per route on navigation failure; ok:false at the
// top level when the run itself couldn't produce output, e.g. webServer never started).
export async function snapshotRoutes(
  routes: string[],
  cwd: string,
  pwConfig: PlaywrightConfig,
  timeoutMs = 180_000,
): Promise<SnapshotResult> {
  if (routes.length === 0) return { ok: true, snapshots: [] }

  const testDirAbs = join(cwd, pwConfig.testDir)
  const specPath = join(testDirAbs, TEMP_SPEC_NAME)
  // Output goes to an OS temp dir (not the repo) so a crashed run never litters the project.
  const outDir = join(tmpdir(), `lacuna-snapshot-${process.pid}-${Date.now()}`)

  try {
    await mkdir(testDirAbs, { recursive: true })
    await mkdir(outDir, { recursive: true })
    await writeFile(specPath, buildSnapshotSpec(routes, outDir), 'utf-8')

    // Filter the run to just our temp spec by filename. The project's webServer/baseURL come
    // from its own config, so the app is started for us.
    const cmd = `npx playwright test ${TEMP_SPEC_NAME} --reporter=line`
    const run = await runCommand(cmd, cwd, timeoutMs)

    const snapshots = await readSnapshots(outDir, routes)

    // If we got no per-route files at all, the run failed before our test executed (almost
    // always a webServer/start problem). Surface the raw output so the caller can explain it.
    if (snapshots.length === 0) {
      return {
        ok: false,
        snapshots: [],
        error: run.timedOut
          ? `Snapshot run timed out after ${Math.round(timeoutMs / 1000)}s — the app may be slow to start or unreachable at ${pwConfig.baseURL ?? 'the configured baseURL'}.`
          : 'Playwright produced no snapshot output — the app likely failed to start (check the webServer config).',
        rawOutput: (run.stdout + '\n' + run.stderr).trim().slice(-2000),
      }
    }

    return { ok: true, snapshots }
  } catch (err) {
    return { ok: false, snapshots: [], error: err instanceof Error ? err.message : String(err) }
  } finally {
    await rm(specPath, { force: true }).catch(() => {})
    await rm(outDir, { recursive: true, force: true }).catch(() => {})
  }
}

// The temporary spec. Routes and the output dir are baked in as literals (no env coupling). One
// test iterates all routes so the browser/app start once; each route is independently guarded
// and written immediately, so a hang on one route doesn't lose the others.
function buildSnapshotSpec(routes: string[], outDir: string): string {
  return `// AUTO-GENERATED by lacuna for DOM snapshotting. Safe to delete.
import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const ROUTES = ${JSON.stringify(routes)}
const OUT = ${JSON.stringify(outDir)}

test('lacuna route snapshot', async ({ page }) => {
  mkdirSync(OUT, { recursive: true })
  for (let i = 0; i < ROUTES.length; i++) {
    const route = ROUTES[i]
    const rec = { route, ok: false, url: null, title: null, aria: null, testIds: [], error: null }
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
      rec.url = page.url()
      rec.title = await page.title().catch(() => null)
      // page.accessibility was removed in modern Playwright; ariaSnapshot() is the supported
      // way to get the accessible tree (returns a YAML-ish string of role/name entries).
      rec.aria = await page.locator('body').ariaSnapshot()
      // Capture data-testid values actually present, so the model can use getByTestId() with
      // real ids instead of inventing them (the aria tree carries no testids).
      rec.testIds = await page.locator('[data-testid]').evaluateAll((els) =>
        els.map((e) => ({ testId: e.getAttribute('data-testid') || '', tag: e.tagName.toLowerCase(), text: (e.textContent || '').trim().slice(0, 40), role: e.getAttribute('role') || '' })),
      ).catch(() => [])
      rec.ok = true
    } catch (e) {
      rec.error = String((e && e.message) || e)
    }
    writeFileSync(join(OUT, 'route-' + i + '.json'), JSON.stringify(rec))
  }
})
`
}

// Read the per-route JSON files back and enrich each with a flattened interactive/heading view.
// Missing files (a route that never got written) are reported as failed snapshots so the caller
// has one entry per requested route.
async function readSnapshots(outDir: string, routes: string[]): Promise<RouteSnapshot[]> {
  let files: string[]
  try {
    files = await readdir(outDir)
  } catch {
    return []
  }
  if (files.length === 0) return []

  const byIndex = new Map<number, RawRecord>()
  for (const f of files) {
    const m = f.match(/^route-(\d+)\.json$/)
    if (!m) continue
    try {
      byIndex.set(Number(m[1]), JSON.parse(await readFile(join(outDir, f), 'utf-8')))
    } catch { /* skip unreadable/partial file */ }
  }

  return routes.map((route, i): RouteSnapshot => {
    const raw = byIndex.get(i)
    if (!raw) {
      return { route, ok: false, url: null, title: null, headings: [], interactives: [], testIds: [], aria: null, error: 'No snapshot captured for this route.' }
    }
    const { interactives, headings } = parseAriaSnapshot(raw.aria ?? null)
    return {
      route,
      ok: !!raw.ok,
      url: raw.url ?? null,
      title: raw.title ?? null,
      headings,
      interactives,
      testIds: dedupeTestIds(raw.testIds ?? []),
      aria: raw.aria ?? null,
      error: raw.error ?? null,
    }
  })
}

// Drop testids with empty ids and collapse duplicates (same id appearing on multiple elements),
// preserving first-seen order.
function dedupeTestIds(raw: TestIdElement[]): TestIdElement[] {
  const seen = new Set<string>()
  const out: TestIdElement[] = []
  for (const t of raw) {
    if (!t.testId || seen.has(t.testId)) continue
    seen.add(t.testId)
    out.push({ testId: t.testId, tag: t.tag ?? '', text: t.text ?? '', role: t.role ?? '' })
  }
  return out
}

interface RawRecord {
  route: string
  ok: boolean
  url: string | null
  title: string | null
  aria: string | null
  testIds: TestIdElement[]
  error: string | null
}

// Parse Playwright's aria snapshot (a YAML-ish tree) into the interactive elements (the selector
// palette) and the heading outline. Each meaningful line looks like `- button "Sign in"` or
// `- heading "Welcome" [level=1]`. De-duplicates identical role+name pairs, first-seen order.
export function parseAriaSnapshot(aria: string | null): { interactives: InteractiveElement[]; headings: string[] } {
  const interactives: InteractiveElement[] = []
  const headings: string[] = []
  const seen = new Set<string>()
  if (!aria) return { interactives, headings }

  for (const rawLine of aria.split('\n')) {
    const m = rawLine.match(/^\s*-\s+([a-zA-Z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?/)
    if (!m) continue
    const role = m[1]
    const name = (m[2] ?? '').replace(/\\"/g, '"').trim()
    if (role === 'heading') {
      if (name) headings.push(name)
    } else if (INTERACTIVE_ROLES.has(role)) {
      const key = `${role} ${name}`
      if (!seen.has(key)) {
        seen.add(key)
        interactives.push({ role, name })
      }
    }
  }
  return { interactives, headings }
}
