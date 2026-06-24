// Flow (route) discovery for E2E generation — PHASE 1.
//
// The unit-test path picks targets from coverage gaps on source files. E2E has no such anchor,
// so a "target" here is a user-reachable ROUTE plus the page file that backs it. This module
// answers "what flows exist that we could write specs for?" purely from the filesystem — no
// browser, no running app — so it is cheap and unit-testable on its own.
//
// Phase 1 supports Next.js (the app router and the legacy pages router), which is what our
// projects use. Other frameworks (React Router, Vue Router, crawling a live app) are future
// additions; discoverFlows returns framework 'unknown' with no flows rather than guessing.

import { readdir, access, readFile } from 'fs/promises'
import { join, dirname } from 'path'

export interface Flow {
  // URL path the spec navigates to, e.g. "/", "/login", "/products/[id]".
  route: string
  // Human label derived from the route, used in spec titles and logs.
  title: string
  // The page/component file that renders this route, relative to cwd. Feeds the generation
  // context (and lets us skip API-only routes).
  sourceFile: string
  // Route has path params ([id], [...slug]) — the generator must pick a concrete value, so
  // these are lower priority and flagged for the prompt.
  dynamic: boolean
  // Ordering heuristic: lower runs first. Static auth/entry pages before deep dynamic routes.
  priority: number
}

export type FlowFramework = 'next-app' | 'next-pages' | 'react-router' | 'unknown'

export interface FlowDiscovery {
  framework: FlowFramework
  // The route root we discovered from (e.g. "src/app"), for diagnostics.
  routeRoot: string | null
  flows: Flow[]
}

const PAGE_FILE_RE = /^page\.[jt]sx?$/        // app router: app/**/page.tsx
const PAGES_FILE_RE = /\.[jt]sx?$/            // pages router: pages/**/*.tsx

async function dirExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

// Candidate route roots in priority order. We honor common source layouts (src/ prefixed or
// top-level). The first existing app/ dir wins app-router detection; likewise pages/.
function appRootCandidates(cwd: string): string[] {
  return [join(cwd, 'src', 'app'), join(cwd, 'app')]
}
function pagesRootCandidates(cwd: string): string[] {
  return [join(cwd, 'src', 'pages'), join(cwd, 'pages')]
}

// Main entry. Detects the framework, finds its routes, and returns them sorted by priority.
// Detection is dependency-gated so a Vite+React app with a src/pages/ folder isn't misread as
// Next.js: Next's filesystem routers are only consulted when `next` is a dependency (or when
// there's no package.json at all, e.g. a bare fixture). React Router is consulted when
// react-router(-dom) is a dependency. App router wins over pages router when both exist.
export async function discoverFlows(cwd: string, sourceDirs: string[] = ['src']): Promise<FlowDiscovery> {
  const deps = await readDeps(cwd)
  const noManifest = deps === null
  const has = (name: string) => deps !== null && name in deps

  if (has('next') || noManifest) {
    for (const root of appRootCandidates(cwd)) {
      if (await dirExists(root)) {
        const flows = await walkAppRouter(root, cwd)
        if (flows.length > 0) return { framework: 'next-app', routeRoot: relativeTo(cwd, root), flows: sortFlows(flows) }
      }
    }
    for (const root of pagesRootCandidates(cwd)) {
      if (await dirExists(root)) {
        const flows = await walkPagesRouter(root, cwd)
        if (flows.length > 0) return { framework: 'next-pages', routeRoot: relativeTo(cwd, root), flows: sortFlows(flows) }
      }
    }
  }

  if (has('react-router-dom') || has('react-router') || noManifest) {
    const flows = await discoverReactRouter(cwd, sourceDirs)
    if (flows.length > 0) return { framework: 'react-router', routeRoot: null, flows: sortFlows(flows) }
  }

  return { framework: 'unknown', routeRoot: null, flows: [] }
}

// Merged dependencies map, or null when there's no readable package.json (so callers can fall
// back to pure filesystem detection rather than assuming "not that framework").
async function readDeps(cwd: string): Promise<Record<string, string> | null> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'))
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  } catch {
    return null
  }
}

// ─── Next.js app router ─────────────────────────────────────────────────────────
//
// A route is any directory containing a page.{tsx,jsx,ts,js}. The URL is the directory path
// relative to the app root, with Next's segment conventions applied:
//   (group)        route groups        → dropped from the URL
//   @slot          parallel routes     → skipped entirely (not navigable on their own)
//   (.) (..) (...) intercepting routes → skipped (they re-render another route)
//   [id]           dynamic segment     → kept, flagged dynamic
//   [...slug]      catch-all           → kept, flagged dynamic
//   [[...slug]]    optional catch-all  → kept, flagged dynamic
async function walkAppRouter(appRoot: string, cwd: string): Promise<Flow[]> {
  const flows: Flow[] = []

  const walk = async (dir: string, segments: string[]): Promise<void> => {
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    // This directory is a route iff it has a page file (layout.tsx alone is not navigable).
    const pageFile = entries.find((e) => e.isFile() && PAGE_FILE_RE.test(e.name))
    if (pageFile) {
      const route = segmentsToRoute(segments)
      const sourceFile = relativeTo(cwd, join(dir, pageFile.name))
      flows.push(makeFlow(route, sourceFile))
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue
      const name = e.name
      // Skip private folders (_components), parallel-route slots (@modal), and the api/ tree
      // (route handlers, not pages). Intercepting-route groups are skipped via segment rules.
      if (name.startsWith('_') || name.startsWith('@') || name === 'api') continue
      if (isInterceptingSegment(name)) continue
      await walk(join(dir, name), [...segments, name])
    }
  }

  await walk(appRoot, [])
  return flows
}

// Convert app-router path segments to a URL, dropping route groups and mapping dynamic
// segments to a readable form. The model is told these are placeholders to fill with real ids.
function segmentsToRoute(segments: string[]): string {
  const parts = segments
    .filter((s) => !isRouteGroup(s))   // (marketing) etc. contribute nothing to the URL
    .map((s) => s)
  const path = parts.join('/')
  return '/' + path
}

function isRouteGroup(seg: string): boolean {
  return seg.startsWith('(') && seg.endsWith(')')
}

// (.)foo, (..)foo, (...)foo and (..)(..)foo are intercepting routes — they render another
// route's UI in place and aren't independent navigation targets.
function isInterceptingSegment(seg: string): boolean {
  return /^\((?:\.{1,3}|(?:\.\.)+)\)/.test(seg)
}

// ─── Next.js pages router ───────────────────────────────────────────────────────
//
// Each .tsx/.jsx file under pages/ is a route. index files map to the directory root.
// Special framework files (_app, _document, _error, 404, 500) and the api/ tree are excluded.
async function walkPagesRouter(pagesRoot: string, cwd: string): Promise<Flow[]> {
  const flows: Flow[] = []

  const walk = async (dir: string, segments: string[]): Promise<void> => {
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const e of entries) {
      const name = e.name
      if (e.isDirectory()) {
        if (name === 'api' || name.startsWith('_')) continue
        await walk(join(dir, name), [...segments, name])
        continue
      }
      if (!e.isFile() || !PAGES_FILE_RE.test(name)) continue
      const base = name.replace(PAGES_FILE_RE, '')
      if (isSpecialPagesFile(base)) continue

      const routeSegments = base === 'index' ? segments : [...segments, base]
      const route = '/' + routeSegments.join('/')
      const sourceFile = relativeTo(cwd, join(dir, name))
      flows.push(makeFlow(route, sourceFile))
    }
  }

  await walk(pagesRoot, [])
  return flows
}

function isSpecialPagesFile(base: string): boolean {
  return ['_app', '_document', '_error', '404', '500'].includes(base)
}

// ─── Shared helpers ─────────────────────────────────────────────────────────────

function makeFlow(route: string, sourceFile: string): Flow {
  // Dynamic in either dialect: Next's [id]/[...slug] or React Router's :id / * splat.
  const dynamic = /\[.+?\]/.test(route) || /(?:^|\/):[^/]+/.test(route) || route.includes('*')
  return {
    route: route === '' ? '/' : route,
    title: routeTitle(route),
    sourceFile,
    dynamic,
    priority: routePriority(route, dynamic),
  }
}

// "/" → "home"; "/products/[id]" → "products [id]". Used in spec titles/logs.
function routeTitle(route: string): string {
  if (route === '/' || route === '') return 'home'
  return route.replace(/^\//, '').replace(/\//g, ' ')
}

// Lower runs first. Home and shallow static routes are the most valuable smoke targets;
// dynamic routes (need a concrete id) and deeper paths come later.
function routePriority(route: string, dynamic: boolean): number {
  const depth = route.split('/').filter(Boolean).length
  return depth + (dynamic ? 100 : 0)
}

function sortFlows(flows: Flow[]): Flow[] {
  return [...flows].sort((a, b) => a.priority - b.priority || a.route.localeCompare(b.route))
}

function relativeTo(cwd: string, abs: string): string {
  const prefix = cwd.endsWith('/') ? cwd : cwd + '/'
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs
}

// ─── React Router ───────────────────────────────────────────────────────────────
//
// React Router has no filesystem convention — routes are declared in code, either as JSX
// (<Route path="..." element={<Page/>} />) or as route objects (createBrowserRouter/useRoutes).
// We extract them with targeted regexes, the same pragmatic posture loadPlaywrightConfig takes
// with playwright.config.ts: good enough to drive generation, never throws.
//
// KNOWN LIMITATION (v1): paths are taken as declared. A nested child route written relative to
// its parent (e.g. <Route path="settings"> inside <Route path="/dashboard">) is captured as
// "/settings", not "/dashboard/settings", because resolving the parent chain needs a real AST
// walk. Such a route degrades gracefully — the DOM snapshot for a wrong path simply fails and
// the spec becomes a conservative smoke test rather than producing something broken.

const CODE_FILE_RE = /\.[cm]?[jt]sx?$/
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '.git', 'out'])
const MAX_FILES = 2000

async function discoverReactRouter(cwd: string, sourceDirs: string[]): Promise<Flow[]> {
  const files = await collectSourceFiles(cwd, sourceDirs)
  const byRoute = new Map<string, Flow>()

  for (const abs of files) {
    const content = await readFile(abs, 'utf-8').catch(() => null)
    if (!content) continue
    // Cheap pre-filter: only parse files that actually look like they define routes.
    if (!/<Route\b/.test(content) && !/createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes/.test(content)) continue

    const rel = relativeTo(cwd, abs)
    for (const raw of parseReactRoutes(content)) {
      const route = normalizeReactRoute(raw.path)
      if (route === null || byRoute.has(route)) continue
      const sourceFile = await resolveComponentSource(content, raw.component, cwd, abs, rel)
      byRoute.set(route, makeFlow(route, sourceFile))
    }
  }

  return [...byRoute.values()]
}

// Recursively collect code files under the given source dirs, skipping vendored/build dirs and
// test files. Bounded by MAX_FILES so a pathological tree can't run away.
async function collectSourceFiles(cwd: string, sourceDirs: string[]): Promise<string[]> {
  const out: string[] = []

  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_FILES) return
    let entries: import('fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(join(dir, e.name))
      } else if (e.isFile() && CODE_FILE_RE.test(e.name) && !TEST_FILE_RE.test(e.name)) {
        out.push(join(dir, e.name))
      }
    }
  }

  for (const sd of sourceDirs) {
    if (await dirExists(join(cwd, sd))) await walk(join(cwd, sd))
  }
  // Fall back to scanning cwd directly if no configured source dir exists (flat projects).
  if (out.length === 0) await walk(cwd)
  return out
}

interface RawRoute { path: string; component: string | null }

// Extract { path, component } pairs from both the JSX and object-config route styles.
function parseReactRoutes(content: string): RawRoute[] {
  const routes: RawRoute[] = []

  // JSX: <Route path="..." element={<Page/>} /> or component={Page}. Index routes (no path
  // attribute) are skipped — the parent route covers the same URL.
  const jsxRe = /<Route\b([^>]*?)\/?>/g
  let m: RegExpExecArray | null
  while ((m = jsxRe.exec(content)) !== null) {
    const attrs = m[1]
    const pathM = attrs.match(/\bpath\s*=\s*(?:["']([^"']*)["']|\{\s*["']([^"']*)["']\s*\})/)
    if (!pathM) continue
    const path = pathM[1] ?? pathM[2] ?? ''
    const compM = attrs.match(/\belement\s*=\s*\{\s*<\s*(\w+)/) || attrs.match(/\bcomponent\s*=\s*\{?\s*(\w+)/)
    routes.push({ path, component: compM ? compM[1] : null })
  }

  // Object config: only when a data-router/useRoutes API is present, to limit false matches on
  // unrelated `path:` keys. Component is read from a small window after the path.
  if (/createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes/.test(content)) {
    const objRe = /\bpath\s*:\s*["']([^"']+)["']/g
    let om: RegExpExecArray | null
    while ((om = objRe.exec(content)) !== null) {
      const path = om[1]
      const windowStr = content.slice(om.index, om.index + 200)
      const compM = windowStr.match(/\belement\s*:\s*<\s*(\w+)/) || windowStr.match(/\bComponent\s*:\s*(\w+)/)
      routes.push({ path, component: compM ? compM[1] : null })
    }
  }

  return routes
}

// Normalise a declared path to a URL, or null to drop it. Splat/catch-all routes (*) aren't
// independent navigation targets; empty paths are layout/index wrappers.
function normalizeReactRoute(p: string): string | null {
  let s = (p ?? '').trim()
  if (s === '' || s === '/' && p === '') return null
  if (s.includes('*')) return null
  if (!s.startsWith('/')) s = '/' + s        // best-effort: treat relative as top-level
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

// Best-effort resolution of the route's component to its source file, for prompt context. We
// look up the component's import in the same file and resolve a relative specifier by probing
// common extensions. Bare/aliased specifiers fall back to the routing file (still useful context).
async function resolveComponentSource(
  content: string,
  component: string | null,
  cwd: string,
  fileAbs: string,
  relFallback: string,
): Promise<string> {
  if (!component) return relFallback
  const esc = component.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const importRe = new RegExp(
    `import\\s+(?:${esc}\\b|(?:\\w+\\s*,\\s*)?\\{[^}]*\\b${esc}\\b[^}]*\\})\\s+from\\s+["']([^"']+)["']`,
  )
  const im = content.match(importRe)
  if (!im) return relFallback
  const spec = im[1]
  if (!spec.startsWith('.')) return relFallback   // alias/bare — don't guess

  for (const cand of resolveCandidates(dirname(fileAbs), spec)) {
    if (await fileAccessible(cand)) return relativeTo(cwd, cand)
  }
  return relFallback
}

function resolveCandidates(fromDir: string, spec: string): string[] {
  const base = join(fromDir, spec)
  const exts = ['.tsx', '.ts', '.jsx', '.js']
  if (CODE_FILE_RE.test(base)) return [base]
  return [...exts.map((e) => base + e), ...exts.map((e) => join(base, 'index' + e))]
}

async function fileAccessible(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}
