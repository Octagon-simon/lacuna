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

import { readFile, writeFile, mkdir, rm, access, stat } from 'fs/promises'
import { join } from 'path'
import chalk from 'chalk'
import type { LacunaConfig } from '../lib/config.js'
import { ensurePlaywrightForRun, loadPlaywrightConfig, playwrightRunCommand, runPlaywrightJson, refreshAuthState } from '../lib/playwright.js'
import { discoverFlows, type Flow } from '../lib/flows/discover.js'
import { snapshotRoutes, snapshotInteractions, type RouteSnapshot, type InteractionProbe, type InteractiveElement, type TestIdElement } from '../lib/flows/snapshot.js'
import { exploreFlows, type Journey } from '../lib/flows/explore.js'
import { buildFlowMap } from '../lib/flows/flowmap.js'
import { ensureAppServer } from '../lib/flows/app-server.js'
import { envForRunner } from '../lib/detector.js'
import { buildE2ESystemPrompt, buildE2EGeneratePrompt, buildTestIdInjectionSystemPrompt, buildTestIdInjectionPrompt } from './prompts/e2e.js'
import { buildLibraryTestIdGuidance } from '../lib/flows/ui-libraries.js'
import { resolveComponentLibraries } from '../lib/flows/resolve-libraries.js'
import { collectSpecHelpers } from '../lib/flows/spec-helpers.js'
import type { PlaywrightConfig } from '../lib/playwright.js'
import { TestGenerator, TruncatedOutputError, OscillationError, debugLogPattern } from './generator.js'
import { runCommand } from '../lib/runner.js'
import { hasTestFunctions, countTestFunctions } from '../lib/validate.js'
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
  deep?: boolean         // opt-in (--deep): walk multi-step flows by filling+submitting forms (drives real actions!)
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

  // Offer to install Playwright when it's missing (interactive, non-CI, non-dry-run). This runs
  // before the worker pool spawns, so the prompt never races the workers.
  if (!(await ensurePlaywrightForRun(cwd, { log, offerInstall: !dryRun }))) {
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

    // ── Authenticated snapshots (Stage 2) ──────────────────────────────────────
    // If the project has a saved login session (auth.setup.ts → the config's storageState path),
    // protected routes that redirected to login in the unauthenticated pass are re-snapshotted
    // SIGNED IN, so the model sees the real post-login DOM and we generate an authenticated spec
    // (*.auth.spec.ts that runs under the `authenticated` project) instead of a shallow redirect
    // assertion. Routes that still redirect even when authenticated are left as public.
    const authedRoutes = new Set<string>()
    // The saved-session path comes from the config's `authenticated` project (so a customized path
    // is respected); falls back to the scaffolded default when the config doesn't declare one.
    const storageStatePath = pwConfig.storageState ?? 'playwright/.auth/user.json'
    let hasAuthState = await access(join(cwd, storageStatePath)).then(() => true).catch(() => false)

    // Auto-refresh the login session. Token sessions (Firebase/Supabase/JWT) expire ~1h, and lacuna
    // runs verify with --no-deps (no per-attempt re-login), so a stale storageState silently fails
    // every authed spec — the authed snapshot may scrape past the auth-loading spinner, but the
    // generated beforeEach then times out. So when the session is STALE (>45 min) or MISSING (but a
    // setup/login file exists), run the `setup` project to log in fresh. Best-effort: needs valid
    // creds; on failure we fall back to the existing session (or skip authed coverage).
    const ageMin = hasAuthState ? await stat(join(cwd, storageStatePath)).then((st) => (Date.now() - st.mtimeMs) / 60000).catch(() => 0) : Infinity
    const setupAvailable = (await Promise.all(
      [join(cwd, pwConfig.testDir, 'auth.setup.ts'), join(cwd, 'e2e', 'auth.setup.ts'), join(cwd, 'tests', 'auth.setup.ts')]
        .map((p) => access(p).then(() => true).catch(() => false)),
    )).some(Boolean)
    if ((!hasAuthState || ageMin > 45) && setupAvailable && !dryRun) {
      log(chalk.dim(`\n  ${hasAuthState ? `Saved login session is ~${Math.round(ageMin)} min old (token sessions expire ~60 min)` : 'No saved login session yet'} — refreshing via the setup (login) project...`))
      const { refreshed, reason } = await refreshAuthState(cwd, storageStatePath, config.coverageTimeout * 1000)
      if (refreshed) { hasAuthState = true; log(chalk.green('  ✓ Login session refreshed.')) }
      else log(chalk.yellow(`  Could not refresh the login session: ${reason}.\n    ${hasAuthState ? 'Using the existing (possibly stale) session — authenticated specs may fail.' : 'Skipping authenticated coverage.'}`))
    }

    if (hasAuthState) {
      const gated = pending.filter((f) => {
        const s = snapshotByRoute.get(f.route)
        // Gated = redirected to a login URL, OR an inline login/signup form is rendered on the route.
        return !!s?.ok && (redirectedToLogin(f.route, s.url) || looksLikeAuthWall(s))
      })
      if (gated.length > 0) {
        log(chalk.dim(`\n  Found a saved login session — re-snapshotting ${gated.length} protected route(s) signed in...`))
        const authSnap = await snapshotRoutes(gated.map((f) => f.route), cwd, pwConfig, config.coverageTimeout * 1000, storageStatePath)
        for (const s of authSnap.snapshots) {
          // Keep the authenticated snapshot only if login actually got us past the gate — neither a
          // redirect to login nor an inline auth form remains.
          if (s.ok && !redirectedToLogin(s.route, s.url) && !looksLikeAuthWall(s)) {
            snapshotByRoute.set(s.route, s)
            authedRoutes.add(s.route)
          }
        }
        if (authedRoutes.size > 0) {
          log(chalk.dim(`  ${authedRoutes.size} route(s) will get authenticated specs (*.auth.spec.ts).`))
        } else {
          const dir = pwConfig.testDir.replace(/^\.\//, '').replace(/\/$/, '')
          log(chalk.yellow('\n  The saved session did not unlock those routes — re-snapshotting them signed in STILL showed the login screen.'))
          log(chalk.dim('  That means the saved session isn\'t a valid logged-in session for them. Check, in order:'))
          log(chalk.dim(`    1. ${dir}/test-config.ts has REAL credentials (not the CHANGE_ME placeholders).`))
          log(chalk.dim(`    2. ${dir}/test-config.ts \`authRoutes.login\` points at the actual login page, and ${dir}/auth.setup.ts uses the right field/button selectors.`))
          log(chalk.dim(`    3. if you use Firebase/Supabase/Amplify auth (session in IndexedDB), ${dir}/auth.setup.ts must save with storageState({ path, indexedDB: true }) — otherwise the session is empty.`))
          log(chalk.dim('    4. that user actually has access to these routes (e.g. an admin account for /admin).'))
          log(chalk.dim('  Then re-create the session:  npx playwright test --project=setup  (these routes stay public until it works).'))
        }
      }
    }

    // ── Flow exploration (Stage 3, one-level) ───────────────────────────────────
    // Probe a few "opener" controls per route (Add/New/Edit/tabs/…), capture what each click reveals
    // (a modal, form, panel — UI not on the initial page), and feed those flows to the model so it
    // writes multi-step specs, not just landed-page assertions. One extra browser run for all probes;
    // authenticated when a session exists, so it explores behind the login too.
    const flowsByRoute = new Map<string, RouteFlow[]>()
    // ── Deep flow exploration (Stage 4, --deep) ─────────────────────────────────
    // Opt-in: WALK each opener's flow — fill+submit forms step by step — to record full journeys.
    const journeysByRoute = new Map<string, Journey[]>()
    {
      const probes: InteractionProbe[] = []
      for (const f of pending) probes.push(...pickOpenerProbes(f.route, snapshotByRoute.get(f.route), 4))
      if (probes.length > 0 && options.deep) {
        log(chalk.yellow(`\n  --deep: walking ${probes.length} flow(s) step-by-step (this fills & SUBMITS forms — make sure this is a test environment)...`))
        const journeys = await exploreFlows(probes, cwd, pwConfig, config.coverageTimeout * 1000, hasAuthState ? storageStatePath : undefined, 4, (m) => log(chalk.dim(m)))
        // Debug: dump the RAW result of every probe (incl. 0-step / failed ones, which are dropped
        // below) so an empty/thin exploration is diagnosable — did the opener open? fields fill?
        // advance fire? where/why did it stop? Without this the explorer is a black box reporting only
        // a step count.
        await writeExploreDebug(journeys, config.debug, cwd).catch(() => {})
        for (const j of journeys) {
          if (!j.ok || j.steps.length === 0) continue
          const arr = journeysByRoute.get(j.route) ?? []
          arr.push(j)
          journeysByRoute.set(j.route, arr)
        }
        const total = [...journeysByRoute.values()].reduce((n, a) => n + a.reduce((m, j) => m + j.steps.length, 0), 0)
        log(chalk.dim(total > 0 ? `  Recorded ${total} step(s) across the explored journeys.` : '  No multi-step journeys could be walked from the probed controls.'))
      } else if (probes.length > 0) {
        log(chalk.dim(`\n  Exploring ${probes.length} interaction(s) for multi-step flows...`))
        const captures = await snapshotInteractions(probes, cwd, pwConfig, config.coverageTimeout * 1000, hasAuthState ? storageStatePath : undefined)
        for (const cap of captures) {
          if (!cap.ok) continue
          const base = snapshotByRoute.get(cap.probe.route)
          if (!base?.ok) continue
          const revealed = revealedAfter(cap, base)
          if (revealed.interactives.length === 0 && revealed.headings.length === 0) continue   // click changed nothing visible
          const arr = flowsByRoute.get(cap.probe.route) ?? []
          arr.push({ trigger: { role: cap.probe.role, name: cap.probe.name }, revealed })
          flowsByRoute.set(cap.probe.route, arr)
        }
        const total = [...flowsByRoute.values()].reduce((n, a) => n + a.length, 0)
        log(chalk.dim(total > 0 ? `  Found ${total} flow(s) that reveal new UI.` : '  No new UI surfaced from the probed controls.'))
      }
    }

    const exampleSpec = await findExampleSpec(testDirAbs)
    // Shared selectors/helpers the project's specs import — so generated specs reuse the project's
    // convention (central selectors object, fixtures, setup) instead of inlining their own.
    const e2eHelpers = exampleSpec ? await collectSpecHelpers(exampleSpec.content, exampleSpec.path, cwd).catch(() => []) : []
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
        const authed = authedRoutes.has(flow.route)
        const specPath = join(testDirAbs, specFileName(flow.route, authed))
        const relSpec = specPath.replace(cwd + '/', '')
        const specName = relSpec.split('/').pop() ?? specFileName(flow.route, authed)
        if (!display) log(chalk.bold(`\n  Generating: ${chalk.cyan(flow.route)}${authed ? chalk.dim(' (authenticated)') : ''} ${chalk.dim('→ ' + relSpec)}`))

        const pageSource = await readFile(join(cwd, flow.sourceFile), 'utf-8').catch(() => null)
        // AST FlowMap: per-control → outcome (toast/redirect/modal) from the page's own handlers.
        // Only emit controls with a CONCRETE outcome, so each assertion uses ITS OWN result —
        // never a generic file-wide signal (the regression). External handlers are dropped here.
        const controlOutcomes = (buildFlowMap(pageSource, cwd, join(cwd, flow.sourceFile)) ?? [])
          .filter((a) => a.outcomes.toast || a.outcomes.redirect || a.outcomes.opensModal)
          .map((a) => ({ control: a.control, by: a.by, outcomes: a.outcomes }))
        const userPrompt = buildE2EGeneratePrompt({
          route: flow.route,
          specFilePath: relSpec,
          baseURL: pwConfig.baseURL,
          snapshot: snapshotByRoute.get(flow.route) ?? null,
          pageSource,
          controlOutcomes: controlOutcomes.length ? controlOutcomes : undefined,
          dynamic: flow.dynamic,
          existingSpecExample: exampleSpec?.content ?? null,
          helpers: e2eHelpers,
          authenticated: authed,
          flows: flowsByRoute.get(flow.route) ?? [],
          journeys: (journeysByRoute.get(flow.route) ?? []).map((j) => ({
            opener: j.opener,
            steps: j.steps.map((s) => ({ filled: s.filled, advance: s.advance, interactives: s.interactives, headings: s.headings, note: s.note, toast: s.toast })),
          })),
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
          if (!display) {
            if (outcome.kept) log(chalk.yellow(`  ${flow.route}: spec still failing — kept at ${relSpec}. Repair just this file: \`lacuna fix --e2e --file ${relSpec}\``))
            else log(chalk.red(`  ${flow.route}: could not produce a runnable spec.`))
          }
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
): Promise<{ success: boolean; kept?: boolean; error?: string }> {
  const { cwd, verbose, log, config } = options
  const file = specPath.replace(cwd + '/', '')
  let failureMsg = ''
  // Whether any attempt produced a runnable spec (had test() blocks and was written to disk).
  // On exhaustion we KEEP that spec so `lacuna fix --e2e` can repair it — only a route that never
  // yielded a runnable spec is cleaned up.
  let everWritten = false
  // Most test cases any runnable attempt had — guards against a retry quietly DROPPING tests to go
  // green (the "delete the failing test" anti-pattern that silently shrinks coverage across attempts).
  let maxTests = 0
  // Keep-best (mirrors fix-loop): the attempt with the MOST passing tests (tie-break: more tests).
  // On exhaustion we restore THIS — never the last attempt and never a shrunk green — so a fuller
  // spec with more passing coverage always wins over a smaller all-green one.
  let bestCode = ''
  let bestPassed = -1
  let bestTests = 0

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

    // Coverage guard: a retry must FIX failing tests, not delete them. If this attempt has fewer test
    // cases than the fullest we've produced, reject it and require restoration. No final-attempt
    // exception: keep-best below restores the fuller, more-passing spec on exhaustion, so we never
    // accept a shrunk green just because we ran out of retries.
    const testCount = countTestFunctions(code)
    if (attempt > 1 && testCount < maxTests) {
      failureMsg = `You DELETED ${maxTests - testCount} test case(s) (the spec had ${maxTests}, this version has ${testCount}). NEVER remove, skip, or comment out a failing test to make the suite pass. Restore ALL ${maxTests} tests and FIX the failing one using the error above.`
      if (!onStatus) log(chalk.yellow(`  Attempt ${attempt} dropped ${maxTests - testCount} test(s) — requiring restore.`))
      continue
    }

    onStatus?.({ phase: 'writing', file })
    await mkdir(join(specPath, '..'), { recursive: true }).catch(() => {})
    await writeFile(specPath, code, 'utf-8')
    everWritten = true
    maxTests = Math.max(maxTests, testCount)

    onStatus?.({ phase: 'running', file })
    const run = await runPlaywrightSpec(specPath, cwd)
    if (!run.pass) {
      // Keep-best by passing-test count (tie-break: more tests) — restored on exhaustion so the
      // fullest, most-passing attempt wins over a later regression or a smaller all-green spec.
      if (run.passed > bestPassed || (run.passed === bestPassed && testCount > bestTests)) {
        bestCode = code; bestPassed = run.passed; bestTests = testCount
      }
      failureMsg = `${run.failure}\n\nFIX the failing test(s) above — do NOT delete, skip, or comment out any test() to make the suite pass. Keep all ${testCount} test case(s); only change what's needed to make the failing one pass.`
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

  // Exhausted. Keep the last runnable spec on disk so `lacuna fix --e2e` can iterate on it —
  // the generate loop and the unit loop both preserve their best attempt rather than discarding
  // usable work. Only clean up when no attempt ever yielded a runnable spec (all truncated / had
  // no test() blocks), since there's nothing useful to keep or repair.
  if (everWritten) {
    // Restore the BEST attempt (most passing tests / most coverage), not whatever the last attempt
    // left on disk — so we never end on a regression or a shrunk-to-pass spec.
    if (bestCode) await writeFile(specPath, bestCode, 'utf-8').catch(() => {})
    const kept = bestTests > 0 ? ` (kept best: ${bestPassed}/${bestTests} passing)` : ''
    return { success: false, kept: true, error: `No stable spec after ${config.maxIterations} attempts${kept} (kept for repair). Last failure:\n${failureMsg.slice(0, 800)}` }
  }
  await rm(specPath, { force: true }).catch(() => {})
  return { success: false, kept: false, error: `No runnable spec after ${config.maxIterations} attempts. Last failure:\n${failureMsg.slice(0, 800)}` }
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

// Diagnostic dump of --deep exploration: one block per probed journey, including the ones dropped
// for having 0 steps or failing, with each step's fills/advance/toast/note and the journey's error.
// Written to lacuna-debug.e2e-explore.txt only when debug is on. This is how an empty/thin
// exploration (e.g. an auth-gated route whose openers were clicked before the dashboard rendered)
// becomes diagnosable instead of just "Recorded N steps".
async function writeExploreDebug(journeys: Journey[], configDebug: boolean | undefined, cwd: string): Promise<void> {
  const pattern = debugLogPattern(configDebug)
  if (!pattern) return
  const file = join(cwd, pattern.replace('<file>', 'e2e-explore'))
  const lines: string[] = [`${'='.repeat(72)}`, `--deep EXPLORATION — ${new Date().toISOString()} — ${journeys.length} probe(s)`, '='.repeat(72)]
  for (const j of journeys) {
    const walked = j.steps.length
    lines.push(`\n[${j.route}] click ${j.opener.role} "${j.opener.name}" → ${j.ok ? `${walked} step(s)` : 'FAILED'}${j.error ? `  error: ${j.error}` : ''}${j.ok && walked === 0 ? '  ⚠ 0 steps (dropped — opener opened nothing walkable)' : ''}`)
    j.steps.forEach((s, i) => {
      const fills = s.filled.length ? s.filled.map((f) => `${f.by ?? '?'}:${f.name}=${JSON.stringify(f.value)}`).join(', ') : '(no inputs filled)'
      lines.push(`    ${i + 1}. fill ${fills}${s.advance ? ` → click "${s.advance}"` : ' (no advance)'}${s.toast ? ` → toast ${JSON.stringify(s.toast)}` : ''}${s.note ? `  [${s.note}]` : ''}`)
    })
  }
  await writeFile(file, lines.join('\n') + '\n', 'utf-8')
}

async function runPlaywrightSpec(specPath: string, cwd: string): Promise<{ pass: boolean; failure: string; passed: number; failed: number }> {
  // JSON report goes to a file so interleaved dev-server logs can't corrupt it (see runPlaywrightJson).
  const { run, parsed } = await runPlaywrightJson(playwrightRunCommand(specPath), cwd, PER_RUN_TIMEOUT_MS)
  const passed = parsed?.passed ?? 0
  const failed = parsed?.failed ?? 0
  if (run.success) return { pass: true, failure: '', passed, failed }
  const failure = parsed && parsed.failures.length > 0
    ? parsed.failures.map((f) => `${f.title}\n${f.message}`).join('\n\n').slice(0, 3000)
    : cleanPlaywrightFallback(run.stdout + '\n' + run.stderr)
  return { pass: false, failure, passed, failed }
}

// Last-resort failure text when the JSON report couldn't be parsed at all: surface the human-readable
// error lines and drop the JSON/config noise, so the model (and the user) never see a meaningless
// slice of `config.projects`. Keeps lines that look like real Playwright errors.
function cleanPlaywrightFallback(raw: string): string {
  const lines = raw.split('\n')
    .filter((l) => !/^\s*["{}\[\]]/.test(l))   // drop bare JSON structural lines
    .filter((l) => !/^\s*"(name|testDir|testIgnore|testMatch|timeout|outputDir|repeatEach|retries|metadata|projects|config|rootDir|grep)"\s*:/.test(l))   // drop config keys
  const errorish = lines.filter((l) => /error|expect|timed out|✘|✗|×|failed|assertion|locator|toBe|toHaveURL|not (visible|found)/i.test(l))
  const picked = (errorish.length > 0 ? errorish : lines.filter((l) => l.trim())).slice(-25).join('\n').trim()
  return picked || 'Playwright run failed but produced no parseable report (the app may not be reachable, or the spec failed to load).'
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

// Derive a spec filename from a route: "/" → home.spec.ts; "/products/[id]" → products-id.spec.ts.
function specFileName(route: string, authed = false): string {
  const ext = authed ? 'auth.spec.ts' : 'spec.ts'
  if (route === '/' || route === '') return `home.${ext}`
  const slug = route
    .replace(/^\//, '')
    .replace(/\[\.\.\.(\w+)\]/g, '$1')   // [...slug] → slug
    .replace(/\[(\w+)\]/g, '$1')          // [id] → id
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'home'
  return `${slug}.${ext}`
}

// A route already has a spec if EITHER its public or its authenticated variant exists — so a
// re-run never regenerates a route in the other flavour (and never duplicates coverage).
async function specExists(testDirAbs: string, flow: Flow): Promise<boolean> {
  for (const authed of [false, true]) {
    try { await access(join(testDirAbs, specFileName(flow.route, authed))); return true } catch { /* try next */ }
  }
  return false
}

// True when navigating to `route` (unauthenticated) bounced us to a login-looking page — i.e. the
// route is auth-gated. Distinguishes a real login redirect from a normal one (e.g. / → /home) by
// requiring the landed path to look like a login/auth page AND differ from the requested route.
function redirectedToLogin(route: string, url: string | null): boolean {
  if (!url) return false
  let path: string
  try { path = new URL(url).pathname } catch { return false }
  const norm = (p: string) => p.replace(/\/+$/, '') || '/'
  // login | log-in | log_in | signin | sign-in | sign_in | auth | authenticate (any path segment).
  return norm(path) !== norm(route) && /(?:^|\/)(log[-_]?in|sign[-_]?in|auth|authenticate)(?:\/|$)/i.test(path)
}

// True when the snapshot is a login/signup screen rendered INLINE (no URL redirect) — common for
// client-side route guards that render an auth form on the protected path itself. A password field
// is the strongest signal (public pages rarely have one); otherwise we require a sign-in/up CTA
// paired with a credential field, so a lone "Sign in" nav link on a public page isn't mistaken for
// an auth wall. Used alongside redirectedToLogin so both redirect- and inline-gated routes are
// re-snapshotted authenticated.
function looksLikeAuthWall(s: RouteSnapshot | undefined): boolean {
  if (!s?.ok) return false
  const inter = s.interactives
  const isField = (re: RegExp) => inter.some((i) => i.role === 'textbox' && re.test(i.name))
  const hasPasswordField = isField(/pass(word|code)|^pin$/i)
  const hasAuthCta = inter.some((i) =>
    (i.role === 'button' || i.role === 'tab' || i.role === 'link') &&
    /\b(sign[\s-]?in|log[\s-]?in|sign[\s-]?up|register|create account)\b/i.test(i.name))
  // OAuth/SSO-only screens have no password field — a "Continue/Sign in with <provider>" button is
  // the tell ("Continue with Google", "Sign in with GitHub"). Strong enough to stand alone.
  const hasOAuthCta = inter.some((i) =>
    (i.role === 'button' || i.role === 'link') &&
    /\b(continue|sign[\s-]?in|log[\s-]?in|sign[\s-]?up)\s+with\b/i.test(i.name))
  return hasPasswordField || hasOAuthCta || (hasAuthCta && isField(/email|username|phone/i))
}

// A discovered multi-step flow: clicking `trigger` revealed `revealed` UI that wasn't on the page.
export interface RouteFlow {
  trigger: { role: string; name: string }
  revealed: { interactives: InteractiveElement[]; headings: string[]; testIds: TestIdElement[] }
}

// Pick a few controls on a route worth clicking to surface hidden UI (a form, modal, panel). Targets
// tabs and openers (Add/New/Create/Edit/Open/…); skips destructive or navigate-away controls
// (logout, delete, back, print, download) so exploration doesn't sign out, destroy data, or leave
// the page. Capped per route to bound the extra browser work.
function pickOpenerProbes(route: string, snapshot: RouteSnapshot | undefined, cap = 4): InteractionProbe[] {
  if (!snapshot?.ok) return []
  const OPENER = /\b(add|new|create|edit|open|invite|upload|import|connect|generate|configure|manage|details?|settings?|customi[sz]e|expand|select)\b/i
  const SKIP = /\b(log\s?out|sign\s?out|delete|remove|destroy|cancel|close|dismiss|back|print|download|export|logo)\b/i
  // P7 (feature boundaries): tabs ARE the sub-routes of a monolithic page (one /admin → menu, orders,
  // team, settings…). Give them a separate, larger budget so they aren't crowded out by Add/New
  // openers — otherwise a 6-tab dashboard explores 4 controls and silently skips whole features.
  const tabs: InteractionProbe[] = []
  const sections: InteractionProbe[] = []
  const openers: InteractionProbe[] = []
  const seen = new Set<string>()
  // A nav/section switcher: a short, plain label that isn't an action verb or destructive. Many apps
  // build their primary nav from plain <button>s (role=button, not role=tab) — cheflymenu's sidebar
  // (Menu Items / Categories / Orders / Team) is exactly this, so the opener-verb filter skipped whole
  // features. When SEVERAL such siblings exist they're almost certainly a tab/sidebar nav; each one's
  // panel holds its own add/edit flows, which the depth-walk then chains into.
  const isSection = (name: string): boolean => {
    const n = name.trim()
    return n.split(/\s+/).length <= 3 && n.length <= 22 && /[a-z]/i.test(n) && !/\d{2,}|\(\d|→|\/|%/.test(n)
  }
  for (const el of snapshot.interactives) {
    if (!['button', 'tab', 'link', 'menuitem'].includes(el.role)) continue
    const name = el.name.trim()
    if (!name || SKIP.test(name)) continue
    const key = `${el.role}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    if (el.role === 'tab') { tabs.push({ route, role: el.role, name }); continue }
    if (OPENER.test(name) || /^\s*\+/.test(name)) { openers.push({ route, role: el.role, name }); continue }
    if (isSection(name)) sections.push({ route, role: el.role, name })
  }
  // Sections only count as feature boundaries when there's a CLUSTER — a single stray short-named
  // button isn't a nav, and probing it would just add noise.
  const sectionProbes = sections.length >= 3 ? sections.slice(0, SECTION_PROBE_CAP) : []
  return [...tabs.slice(0, TAB_PROBE_CAP), ...sectionProbes, ...openers.slice(0, cap)]
}
const TAB_PROBE_CAP = 8
const SECTION_PROBE_CAP = 6

// What a click revealed = the interactives/headings/testIds present AFTER the click that weren't in
// the base (pre-click) snapshot. That delta is the new UI the flow opened.
function revealedAfter(cap: { interactives: InteractiveElement[]; headings: string[]; testIds: TestIdElement[] }, base: RouteSnapshot): RouteFlow['revealed'] {
  const baseEls = new Set(base.interactives.map((i) => `${i.role}:${i.name}`))
  const baseHeadings = new Set(base.headings)
  const baseIds = new Set(base.testIds.map((t) => t.testId))
  return {
    interactives: cap.interactives.filter((i) => i.name.trim() && !baseEls.has(`${i.role}:${i.name}`)).slice(0, 20),
    headings: cap.headings.filter((h) => !baseHeadings.has(h)).slice(0, 10),
    testIds: cap.testIds.filter((t) => t.testId && !baseIds.has(t.testId)).slice(0, 20),
  }
}

// Find an existing spec to show the model as a style reference. Best-effort: the first *.spec.ts
// under the test dir that isn't one of ours.
async function findExampleSpec(testDirAbs: string): Promise<{ path: string; content: string } | null> {
  const { readdir } = await import('fs/promises')
  let entries: string[]
  try { entries = await readdir(testDirAbs) } catch { return null }
  const spec = entries.find((e) => /\.(spec|e2e)\.[jt]sx?$/.test(e) && !e.startsWith('__lacuna'))
  if (!spec) return null
  const abs = join(testDirAbs, spec)
  const content = await readFile(abs, 'utf-8').catch(() => null)
  return content === null ? null : { path: abs, content }
}
