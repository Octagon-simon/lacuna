import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { runCommand } from './runner.js'
import { fileTestCommand, type DetectedEnvironment } from './detector.js'

// Route a DOM-free generated test off jsdom and onto the `node` environment via a per-file
// docblock. jsdom instantiation is the dominant cost in a large suite (often more than running
// the tests themselves); a pure-logic test — a service, util, validator, formatter — pays that
// startup tax for nothing. A `@vitest-environment node` / `@jest-environment node` docblock makes
// just that file skip jsdom, with no project-wide config or `projects` split required.
//
// Why per-file (and not a workspace/projects split): lacuna generates tests for a fresh repo and
// can't know which directories are DOM-free. It DOES know — per file — whether the test it just
// wrote touches the DOM, so it routes the exact files that benefit and leaves everything else alone.
//
// Design rules:
//   • Conservative. We only route a test with ZERO DOM signals (no render/screen/document/window/
//     localStorage/testing-library render, etc.). A false negative just misses a speed win; a false
//     positive is caught by the verify step below.
//   • Verified. The win is only valid if the project's setup file is node-safe. lacuna's own
//     generated setup is, but an existing repo's setup may call cleanup()/document in a hook, which
//     crashes under node. So after adding the docblock we RE-RUN the file; if it no longer passes,
//     we restore the original (no docblock). Routing can never regress a green file. Mirrors the
//     verify-and-revert guard in format.ts.
//   • Targeted. Skipped entirely when the project has no DOM environment installed (jsdom /
//     happy-dom) — there a `node` docblock would be redundant since node is already the default.

const domEnvCache = new Map<string, boolean>()

// Any of these in a test means it needs a browser-like environment — don't route it to node.
// Over-matching (e.g. a literal "window" in a comment) only costs a missed optimization, so the
// list errs on the side of leaving the test on jsdom.
const DOM_SIGNAL =
  /@testing-library\/(?:react|vue|svelte|angular|dom|jest-dom)|\b(?:render|renderHook|screen|fireEvent|userEvent|act|cleanup|document|window|navigator|location|localStorage|sessionStorage|matchMedia|IntersectionObserver|ResizeObserver|MutationObserver|requestAnimationFrame|HTMLElement|getComputedStyle)\b/

// True if the project declares a DOM test environment (jsdom / happy-dom). When it doesn't, node is
// already the default environment and a docblock would be pointless noise.
async function projectHasDomEnv(cwd: string): Promise<boolean> {
  const hit = domEnvCache.get(cwd)
  if (hit !== undefined) return hit
  let has = false
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    has = 'jsdom' in deps || 'happy-dom' in deps || 'jest-environment-jsdom' in deps
  } catch { /* no/unparseable package.json — assume no DOM env */ }
  domEnvCache.set(cwd, has)
  return has
}

export interface NodeRouteOptions {
  enabled?: boolean
  env: DetectedEnvironment
}

// Returns true if the file was routed to the node environment, false otherwise (left untouched).
export async function routeTestToNodeEnv(absPath: string, cwd: string, opts: NodeRouteOptions): Promise<boolean> {
  if (opts.enabled === false) return false
  const runner = opts.env.testRunner
  if (runner !== 'vitest' && runner !== 'jest') return false

  const content = await readFile(absPath, 'utf-8').catch(() => null)
  if (content === null) return false
  if (/@(?:vitest|jest)-environment\b/.test(content)) return false // author already chose an env
  if (DOM_SIGNAL.test(content)) return false                        // test needs the DOM
  if (!(await projectHasDomEnv(cwd))) return false                  // node is already the default

  const pragma = runner === 'vitest' ? '@vitest-environment node' : '@jest-environment node'
  const routed = `/** ${pragma} */\n${content}`
  await writeFile(absPath, routed, 'utf-8')

  // The setup file may not be node-safe (e.g. an afterEach cleanup() that touches document), or the
  // test may depend on a DOM global we didn't flag. Re-run to confirm; restore on any regression.
  const res = await runCommand(fileTestCommand(opts.env, absPath), cwd, 60_000)
  if (!res.success) {
    await writeFile(absPath, content, 'utf-8')
    return false
  }
  return true
}
