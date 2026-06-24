// E2E spec generation loop — PHASE 4.
//
// Orchestrates the full DOM-aware flow: discover routes → capture each route's DOM in one
// browser run → for each route, generate a Playwright spec from the captured selectors, write
// it, run it, and (on pass) confirm it isn't flaky, retrying on failure. This is the E2E analogue
// of runAgentLoop in loop.ts, but the "target" is a route+snapshot rather than a coverage gap.
//
// What it deliberately reuses: the model provider, TestGenerator's generateE2E/retry (which
// carries oscillation + truncation handling), and the Playwright result parser. What's new is
// route-driven targeting, the snapshot-as-context step, and flake confirmation.

import { readFile, writeFile, mkdir, rm, access } from 'fs/promises'
import { join } from 'path'
import chalk from 'chalk'
import type { LacunaConfig } from '../lib/config.js'
import { detectPlaywright, loadPlaywrightConfig, playwrightRunCommand, parsePlaywrightResults } from '../lib/playwright.js'
import { discoverFlows, type Flow } from '../lib/flows/discover.js'
import { snapshotRoutes, type RouteSnapshot } from '../lib/flows/snapshot.js'
import { ensureAppServer } from '../lib/flows/app-server.js'
import { envForRunner } from '../lib/detector.js'
import { buildE2ESystemPrompt, buildE2EGeneratePrompt, buildTestIdInjectionSystemPrompt, buildTestIdInjectionPrompt } from './prompts/e2e.js'
import { buildLibraryTestIdGuidance } from '../lib/flows/ui-libraries.js'
import { resolveComponentLibraries } from '../lib/flows/resolve-libraries.js'
import type { PlaywrightConfig } from '../lib/playwright.js'
import { TestGenerator, TruncatedOutputError, OscillationError } from './generator.js'
import { runCommand } from '../lib/runner.js'
import { hasTestFunctions } from '../lib/validate.js'
import { WorkerDisplay } from '../lib/worker-display.js'
import type { WorkerState } from '../lib/worker-display.js'

export interface E2ELoopOptions {
  config: LacunaConfig
  cwd: string
  dryRun: boolean
  verbose: boolean
  targetRoute?: string   // --route: generate for one route only
  maxRoutes?: number     // safety cap on how many flows to process in one run
  workers?: number       // parallel workers (each owns its own generator + processes one route at a time)
  injectTestIds?: boolean // opt-in: add data-testid attributes to page sources before generating (writes source!)
  log: (msg: string) => void
}

export interface E2ELoopResult {
  flowsDiscovered: number
  specsGenerated: number
  specsFailed: number
  skipped: number
  errors: string[]
}

const E2E_TIPS = [
  'Specs target role/label locators (getByRole, getByLabel) from the captured page, not CSS.',
  'Use --route /path to (re)generate a single route; existing specs are skipped.',
  'Each spec is rerun to confirm it is not flaky before being kept.',
  'lacuna fix --e2e repairs failing Playwright specs the same way it fixes unit tests.',
]

const FLAKE_CONFIRM_RUNS = 1   // extra green runs required after the first pass before we accept
const PER_RUN_TIMEOUT_MS = 120_000

const emptyResult = (): E2ELoopResult => ({ flowsDiscovered: 0, specsGenerated: 0, specsFailed: 0, skipped: 0, errors: [] })

export async function runE2ELoop(options: E2ELoopOptions): Promise<E2ELoopResult> {
  const { config, cwd, dryRun, verbose, log } = options

  if (!(await detectPlaywright(cwd))) {
    log(chalk.yellow('\n  E2E generation needs @playwright/test in the project, but none was found.'))
    return emptyResult()
  }

  const pwConfig = await loadPlaywrightConfig(cwd)
  const discovery = await discoverFlows(cwd, config.sourceDir)

  if (discovery.framework === 'unknown' || discovery.flows.length === 0) {
    log(chalk.yellow('\n  No routes discovered. E2E generation currently supports Next.js (app or pages router) and React Router.'))
    return emptyResult()
  }
  log(chalk.dim(`  Detected ${discovery.framework} with ${discovery.flows.length} route(s) under ${discovery.routeRoot}.`))

  // Resolve which flows to process: a single --route, else all (capped), minus routes that
  // already have a spec on disk (we don't regenerate over existing work).
  const testDirAbs = join(cwd, pwConfig.testDir)
  let flows = discovery.flows
  if (options.targetRoute) {
    flows = flows.filter((f) => f.route === options.targetRoute)
    if (flows.length === 0) {
      log(chalk.yellow(`\n  Route ${options.targetRoute} not found among discovered routes.`))
      return emptyResult()
    }
  }

  const result = emptyResult()
  result.flowsDiscovered = discovery.flows.length

  const pending: Flow[] = []
  for (const flow of flows) {
    if (await specExists(testDirAbs, flow)) {
      result.skipped++
      log(chalk.dim(`  Skipping ${flow.route} — spec already exists.`))
    } else {
      pending.push(flow)
    }
  }

  // No implicit ceiling — by default every discovered route is processed (like unit generate);
  // re-runs are cheap because existing specs are skipped. --max-routes is an opt-in limiter for
  // capping an expensive run on a large app.
  if (options.maxRoutes != null && pending.length > options.maxRoutes) {
    log(chalk.dim(`  Limiting this run to ${options.maxRoutes} of ${pending.length} routes (--max-routes); re-run to do the rest.`))
    pending.length = options.maxRoutes
  }

  if (pending.length === 0) {
    log(chalk.green('\n  Every discovered route already has a spec — nothing to generate.'))
    return result
  }

  // Dry-run is a preview: report which specs would be generated, without booting the app,
  // snapshotting, or constructing the model provider (so it needs no API key).
  if (dryRun) {
    log(chalk.yellow(`\n  [dry-run] would generate ${pending.length} spec(s):`))
    for (const flow of pending) {
      log(chalk.dim(`    ${flow.route}  →  ${join(pwConfig.testDir, specFileName(flow.route))}`))
    }
    return result
  }

  // Bring the app up once so parallel spec runs attach to one server instead of racing to bind
  // the port. When we can't confirm a running server, fall back to sequential — each playwright
  // invocation then safely manages its own webServer.
  const server = await ensureAppServer(pwConfig, cwd, config.coverageTimeout * 1000)
  let workerCount = Math.max(1, Math.min(options.workers ?? 1, 8))
  if (workerCount > 1 && !(server.managed || server.alreadyRunning)) {
    log(chalk.yellow(`  Running sequentially (parallel workers need one shared server): ${server.error ?? 'app server not confirmed up'}`))
    workerCount = 1
  }

  let display: WorkerDisplay | null = null
  try {
    // One browser run captures every pending route's DOM (reusing the server we just started).
    log(chalk.dim(`\n  Capturing the DOM for ${pending.length} route(s)...`))
    const snap = await snapshotRoutes(pending.map((f) => f.route), cwd, pwConfig, config.coverageTimeout * 1000)
    if (!snap.ok) {
      log(chalk.yellow(`\n  Could not snapshot the app: ${snap.error}`))
      if (verbose && snap.rawOutput) log(chalk.dim(snap.rawOutput))
      log(chalk.dim('  Specs will be generated as conservative smoke tests without a DOM snapshot.'))
    }
    const snapshotByRoute = new Map<string, RouteSnapshot>()
    for (const s of snap.snapshots) snapshotByRoute.set(s.route, s)

    const pwEnv = envForRunner('playwright')

    // Opt-in pre-pass: add data-testid attributes to page sources so specs can use stable
    // getByTestId locators. Serial (it writes source and re-snapshots per route). Each injection
    // is verified against a fresh snapshot and reverted if the testid never reached the DOM — so
    // a component that doesn't forward props leaves the source unchanged.
    if (options.injectTestIds) {
      log(chalk.dim('\n  --inject-testids: adding data-testid attributes to page sources...'))
      const injector = new TestGenerator({ config, env: pwEnv })
      const depNames = await readProjectDepNames(cwd)   // for barrel-proof UI-library detection
      let added = 0
      for (const flow of pending) {
        const enriched = await injectTestIdsForRoute(flow, snapshotByRoute.get(flow.route) ?? null, injector, cwd, pwConfig, depNames, options)
        if (enriched) { snapshotByRoute.set(flow.route, enriched.snapshot); added += enriched.added }
      }
      log(added > 0
        ? chalk.green(`  Injected ${added} data-testid attribute(s); reverted anything that did not reach the DOM.`)
        : chalk.dim('  No testids were added (already covered, or components do not forward props).'))
    }

    const exampleSpec = await findExampleSpec(testDirAbs)
    const systemPrompt = buildE2ESystemPrompt()

    // In parallel mode, drive the same live worker panel the unit commands use (per-worker rows
    // + progress bar). Sequential mode keeps the plain streamed logs. The display routes its own
    // non-TTY/CI fallback to plain `[wN]` lines, so we suppress our per-route log() calls
    // whenever a display is active to avoid double output.
    display = workerCount > 1
      ? new WorkerDisplay(workerCount, pending.length, E2E_TIPS, 'generated')
      : null
    if (display) { log(''); display.start() }

    // Shared work queue: each worker owns its own TestGenerator (history is per-instance and
    // must not be shared) and pulls the next route until the queue drains.
    let nextIndex = 0
    const disp = display   // const capture so the closure narrows past the null check
    const runWorker = async (workerId: number): Promise<void> => {
      const generator = new TestGenerator({ config, env: pwEnv })
      const onStatus = disp ? (state: WorkerState) => disp.update(workerId, state) : undefined
      while (true) {
        const i = nextIndex++
        if (i >= pending.length) { onStatus?.({ phase: 'idle' }); return }
        const flow = pending[i]
        const specPath = join(testDirAbs, specFileName(flow.route))
        const relSpec = specPath.replace(cwd + '/', '')
        const specName = relSpec.split('/').pop() ?? specFileName(flow.route)
        if (!display) log(chalk.bold(`\n  Generating: ${chalk.cyan(flow.route)} ${chalk.dim('→ ' + relSpec)}`))

        const pageSource = await readFile(join(cwd, flow.sourceFile), 'utf-8').catch(() => null)
        const userPrompt = buildE2EGeneratePrompt({
          route: flow.route,
          specFilePath: relSpec,
          baseURL: pwConfig.baseURL,
          snapshot: snapshotByRoute.get(flow.route) ?? null,
          pageSource,
          dynamic: flow.dynamic,
          existingSpecExample: exampleSpec,
        })

        const outcome = await generateAndVerifySpec(flow, specPath, specName, userPrompt, systemPrompt, generator, options, onStatus)
        if (outcome.success) {
          result.specsGenerated++
          onStatus?.({ phase: 'passed', file: relSpec })
          if (!display) log(chalk.green(`  ${flow.route}: spec passes and is stable.`))
        } else {
          result.specsFailed++
          if (outcome.error) result.errors.push(`${flow.route}: ${outcome.error}`)
          onStatus?.({ phase: 'failed', file: relSpec })
          if (!display) log(chalk.red(`  ${flow.route}: could not produce a passing spec.`))
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(workerCount, pending.length) }, (_, wi) => runWorker(wi)))
  } finally {
    display?.finish()
    server.stop()
  }

  return result
}

// Generate → write → run → (on pass) flake-confirm, retrying on failure up to maxIterations.
// Leaves the spec on disk only if it ends green; otherwise removes it so we never commit a
// broken spec.
async function generateAndVerifySpec(
  flow: Flow,
  specPath: string,
  debugName: string,   // spec filename (e.g. login.spec.ts) — drives the per-file debug log slug
  userPrompt: string,
  systemPrompt: string,
  generator: TestGenerator,
  options: E2ELoopOptions,
  onStatus?: (state: WorkerState) => void,   // when set (parallel mode), drive the live worker panel instead of logging
): Promise<{ success: boolean; error?: string }> {
  const { cwd, verbose, log, config } = options
  const file = specPath.replace(cwd + '/', '')
  let failureMsg = ''

  for (let attempt = 1; attempt <= config.maxIterations; attempt++) {
    onStatus?.(attempt === 1 ? { phase: 'generating', file } : { phase: 'retrying', file, attempt, max: config.maxIterations })
    let code: string
    try {
      code = attempt === 1
        ? await generator.generateE2E(systemPrompt, userPrompt, debugName)
        : await generator.retry(failureMsg)
    } catch (err) {
      if (err instanceof OscillationError) { return { success: false, error: 'Model looped on the same spec.' } }
      if (err instanceof TruncatedOutputError) { failureMsg = 'Your spec was cut off before completion. Write a shorter, complete spec.'; continue }
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (!hasTestFunctions(code)) {
      failureMsg = 'The spec contains no test() blocks. Write at least one test(...) with real actions and web-first assertions.'
      if (!onStatus && verbose) log(chalk.yellow('  No test() found — retrying...'))
      continue
    }

    onStatus?.({ phase: 'writing', file })
    await mkdir(join(specPath, '..'), { recursive: true }).catch(() => {})
    await writeFile(specPath, code, 'utf-8')

    onStatus?.({ phase: 'running', file })
    const run = await runPlaywrightSpec(specPath, cwd)
    if (!run.pass) {
      failureMsg = run.failure
      if (!onStatus) {
        if (verbose) log(chalk.dim(failureMsg.split('\n').slice(0, 12).join('\n')))
        log(chalk.red(`  Spec failed (attempt ${attempt}/${config.maxIterations}).`))
      }
      continue
    }

    // Passed once. Confirm it's not flaky before accepting.
    let flaky = false
    for (let c = 0; c < FLAKE_CONFIRM_RUNS; c++) {
      const confirm = await runPlaywrightSpec(specPath, cwd)
      if (!confirm.pass) { flaky = true; failureMsg = `The spec passed once then FAILED on rerun — it is FLAKY:\n${confirm.failure}\n\nRemove any race conditions and arbitrary waits; rely only on web-first auto-waiting assertions.`; break }
    }
    if (flaky) {
      if (!onStatus) log(chalk.yellow(`  Spec was flaky (attempt ${attempt}/${config.maxIterations}) — retrying for stability.`))
      continue
    }

    return { success: true }
  }

  // Exhausted: don't leave a broken/flaky spec behind.
  await rm(specPath, { force: true }).catch(() => {})
  return { success: false, error: `No stable spec after ${config.maxIterations} attempts. Last failure:\n${failureMsg.slice(0, 800)}` }
}

// Add data-testid attributes to one route's page source, then VERIFY they reached the DOM by
// re-snapshotting; revert the source if they didn't (component didn't forward props, or the edit
// broke render). Returns the enriched snapshot + count of testids that took, or null (no change).
async function injectTestIdsForRoute(
  flow: Flow,
  snapshot: RouteSnapshot | null,
  generator: TestGenerator,
  cwd: string,
  pwConfig: PlaywrightConfig,
  depNames: string[],
  options: E2ELoopOptions,
): Promise<{ snapshot: RouteSnapshot; added: number } | null> {
  const { log, verbose } = options
  if (!snapshot || !snapshot.ok) return null

  // Map only named interactive elements; if everything interactive already has a testid, skip.
  const interactives = snapshot.interactives.filter((e) => e.name)
  if (interactives.length === 0 || snapshot.testIds.length >= interactives.length) return null

  const sourceAbs = join(cwd, flow.sourceFile)
  const original = await readFile(sourceAbs, 'utf-8').catch(() => null)
  if (!original) return null

  // Detect the UI library so the prompt can give its documented testid-forwarding convention (e.g.
  // MUI inputProps). Follows the import chain (including barrel re-exports) so a custom component
  // imported through a barrel is NOT mistaken for a library one; only falls back to installed deps
  // when the chain genuinely can't be resolved.
  const libs = await resolveComponentLibraries(original, sourceAbs, cwd, depNames)
  const libraryGuidance = buildLibraryTestIdGuidance(libs)
  if (libraryGuidance && verbose) log(chalk.dim(`  ${flow.route}: detected ${libs.map((l) => l.name).join(', ')}.`))

  let modified: string
  try {
    modified = await generator.injectTestIds(
      buildTestIdInjectionSystemPrompt(),
      buildTestIdInjectionPrompt({
        sourceFile: flow.sourceFile,
        sourceCode: original,
        interactives,
        existingTestIds: snapshot.testIds.map((t) => t.testId),
        libraryGuidance,
      }),
      'inject-' + (flow.sourceFile.split('/').pop() ?? 'page'),
    )
  } catch { return null }

  // Guard against truncated/garbage rewrites before touching source.
  if (!isPlausibleTestIdEdit(original, modified)) {
    if (verbose) log(chalk.dim(`  ${flow.route}: testid edit looked implausible — skipped.`))
    return null
  }

  const beforeIds = new Set(snapshot.testIds.map((t) => t.testId))
  await writeFile(sourceAbs, modified, 'utf-8')

  // Re-snapshot the single route. A testid only counts if it (a) is new and (b) landed on an
  // actual INTERACTIVE element — a native control or an interactive ARIA role. This empirically
  // enforces "testids go on controls, not wrappers": if library guidance was wrong for a custom
  // component (e.g. a barrel-exported <Button> that isn't really MUI/Radix), the testid that ends
  // up on a layout <div> is rejected and the source is reverted. Physics, not the prompt, decides.
  const reSnap = (await snapshotRoutes([flow.route], cwd, pwConfig, 90_000).catch(() => null))?.snapshots?.[0] ?? null
  const usableNewIds = reSnap && reSnap.ok
    ? reSnap.testIds.filter((t) => !beforeIds.has(t.testId) && isOnInteractiveElement(t))
    : []

  if (!reSnap || !reSnap.ok || usableNewIds.length === 0) {
    await writeFile(sourceAbs, original, 'utf-8').catch(() => {})  // didn't reach a control — restore source
    if (verbose) log(chalk.dim(`  ${flow.route}: testids did not land on an interactive element — reverted ${flow.sourceFile}.`))
    return null
  }

  log(chalk.green(`  ${flow.route}: added ${usableNewIds.length} testid(s) to ${flow.sourceFile}.`))
  return { snapshot: reSnap, added: usableNewIds.length }
}

// A testid is "usable" only if it sits on something a user can actually interact with — a native
// control tag or an element with an interactive ARIA role. A testid on a plain <div>/<span> wrapper
// is rejected (the spec couldn't meaningfully target it, and it signals a mis-placed injection).
const INTERACTIVE_TESTID_TAGS = new Set(['button', 'input', 'a', 'textarea', 'select', 'option'])
const INTERACTIVE_TESTID_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton',
])
function isOnInteractiveElement(t: { tag: string; role: string }): boolean {
  return INTERACTIVE_TESTID_TAGS.has(t.tag) || INTERACTIVE_TESTID_ROLES.has(t.role)
}

// Merged dependency names from package.json (deps + devDeps), for UI-library detection that
// survives barrel re-exports. Empty on any read/parse failure.
async function readProjectDepNames(cwd: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'))
    return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
  } catch {
    return []
  }
}

// A trustworthy testid edit is mostly the original file plus added data-testid attributes — not a
// wholesale rewrite or a truncated fragment.
function isPlausibleTestIdEdit(original: string, modified: string): boolean {
  if (!modified || modified.length < original.length * 0.6) return false
  if (!/\bexport\b/.test(modified)) return false
  return modified.includes('data-testid')
}

async function runPlaywrightSpec(specPath: string, cwd: string): Promise<{ pass: boolean; failure: string }> {
  const run = await runCommand(playwrightRunCommand(specPath), cwd, PER_RUN_TIMEOUT_MS)
  if (run.success) return { pass: true, failure: '' }
  const parsed = parsePlaywrightResults(run.stdout + '\n' + run.stderr)
  const failure = parsed && parsed.failures.length > 0
    ? parsed.failures.map((f) => `${f.title}\n${f.message}`).join('\n\n').slice(0, 3000)
    : (run.stdout + '\n' + run.stderr).trim().slice(-2000)
  return { pass: false, failure }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

// Derive a spec filename from a route: "/" → home.spec.ts; "/products/[id]" → products-id.spec.ts.
function specFileName(route: string): string {
  if (route === '/' || route === '') return 'home.spec.ts'
  const slug = route
    .replace(/^\//, '')
    .replace(/\[\.\.\.(\w+)\]/g, '$1')   // [...slug] → slug
    .replace(/\[(\w+)\]/g, '$1')          // [id] → id
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'home'
  return `${slug}.spec.ts`
}

async function specExists(testDirAbs: string, flow: Flow): Promise<boolean> {
  try { await access(join(testDirAbs, specFileName(flow.route))); return true } catch { return false }
}

// Find an existing spec to show the model as a style reference. Best-effort: the first *.spec.ts
// under the test dir that isn't one of ours.
async function findExampleSpec(testDirAbs: string): Promise<string | null> {
  const { readdir } = await import('fs/promises')
  let entries: string[]
  try { entries = await readdir(testDirAbs) } catch { return null }
  const spec = entries.find((e) => /\.(spec|e2e)\.[jt]sx?$/.test(e) && !e.startsWith('__lacuna'))
  if (!spec) return null
  return readFile(join(testDirAbs, spec), 'utf-8').catch(() => null)
}
