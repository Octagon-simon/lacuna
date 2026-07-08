import { dirname, join, relative } from 'path'
import { readFile, access } from 'fs/promises'
import type { DetectedEnvironment } from './detector.js'
import { fileTestCommand, multiFileTestCommand, scopedTestCommand, sq } from './detector.js'

// Monorepo/workspace support: a test must run under ITS OWN package's config so the package's
// `setupFiles` (cleanup, jest-dom), `environment`, and projects apply — exactly like the
// developer's own `npm test`. Running a bare `npx vitest run <file>` from the repo root skips
// that setup (e.g. Testing Library's afterEach cleanup never fires → DOM leaks across tests →
// false failures). This module resolves the nearest package/config root for a target and builds
// the run command there, preferring the package's own `test` npm script, falling back to bare
// runner invocation. Coverage runs deliberately stay at the repo root (that report is what
// Codecov ingests) — this is only for test EXECUTION (pass/fail) runs.

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

const CONFIG_NAMES = [
  'vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.mts', 'vitest.config.cjs',
  'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts',
  'jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json',
]

// Is `script` a CLEAN single invocation of the detected runner, so `npm test -- <path>` safely
// scopes to a file/dir? Rejects chained/compound scripts (`&&`, `||`, `;`, `|`) and scripts that
// aren't the detected runner — for those we fall back to a bare runner call in the same cwd.
function isCleanRunnerScript(script: string, runner: string): boolean {
  if (/[&|;]/.test(script)) return false
  const s = script.trim().replace(/^npx\s+/, '')
  if (runner === 'vitest') return /^vitest(\s+run)?(\s|$)/.test(s)
  if (runner === 'jest') return /^jest(\s|$)/.test(s)
  return false
}

export interface TestRoot { cwd: string; npmTest: boolean }

// Walk up from `fromDir` (absolute) to the nearest package/config root at or below `repoRoot`.
// Prefers the nearest package.json whose `scripts.test` is a clean runner invocation (→ npm-test
// mode); otherwise remembers the nearest package.json OR runner-config dir as the run cwd for a
// bare invocation. Falls back to `repoRoot`. Single-package repos whose root script is a clean
// runner resolve to root+npmTest — same effective behavior as before, just via `npm test`.
export async function findTestRoot(fromDir: string, repoRoot: string, runner: string): Promise<TestRoot> {
  let dir = fromDir
  let fallbackCwd: string | null = null
  while (true) {
    const pkgPath = join(dir, 'package.json')
    if (await exists(pkgPath)) {
      let script: string | undefined
      try { script = (JSON.parse(await readFile(pkgPath, 'utf-8')).scripts ?? {}).test } catch { /* ignore */ }
      if (script && isCleanRunnerScript(script, runner)) return { cwd: dir, npmTest: true }
      if (!fallbackCwd) fallbackCwd = dir // a package boundary, just no clean test script
    }
    if (!fallbackCwd) {
      for (const c of CONFIG_NAMES) { if (await exists(join(dir, c))) { fallbackCwd = dir; break } }
    }
    if (dir === repoRoot) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { cwd: fallbackCwd ?? repoRoot, npmTest: false }
}

export interface ResolvedRun { command: string; cwd: string }

// Per-file verify/repair run (pass/fail only — never consumes coverage).
export async function resolveFileTestRun(env: DetectedEnvironment, absFile: string, repoRoot: string): Promise<ResolvedRun> {
  const { cwd, npmTest } = await findTestRoot(dirname(absFile), repoRoot, env.testRunner)
  const rel = relative(cwd, absFile)
  if (npmTest) {
    const covOff = env.testRunner === 'vitest' ? ' --coverage.enabled=false' : ''
    return { command: `npm test -- ${sq(rel)}${covOff}`, cwd }
  }
  return { command: fileTestCommand(env, rel), cwd }
}

// Scoped failure-finding run (all tests under a directory).
export async function resolveScopeTestRun(env: DetectedEnvironment, absDir: string, repoRoot: string): Promise<ResolvedRun> {
  const { cwd, npmTest } = await findTestRoot(absDir, repoRoot, env.testRunner)
  const rel = relative(cwd, absDir)
  if (npmTest) return { command: rel ? `npm test -- ${sq(rel)}` : 'npm test', cwd }
  return { command: (rel && scopedTestCommand(env, rel)) || env.testCommand, cwd }
}

// Incremental patch-coverage run for `generate --file <src> @diff`: run the ONE new test file
// under its own package (so the package's setup/env/globalSetup apply and the test actually
// executes), instrument ONLY the changed source, and force the lcov to a temp dir we control.
// This replaces `vitest related` for the single-target case, which (1) balloons to the whole
// suite when the source is transitively imported by a central app module, and (2) writes coverage
// to the package's own reportsDirectory (often customized) that lacuna's root reader never sees.
// Returns null for runners we can't scope this way — caller falls back to the old behavior.
export async function resolveIncrementalCoverageRun(
  env: DetectedEnvironment,
  absTestFile: string,
  absSourceFile: string,
  repoRoot: string,
  outDir: string,
): Promise<ResolvedRun | null> {
  if (env.testRunner !== 'vitest' && env.testRunner !== 'jest') return null
  const { cwd, npmTest } = await findTestRoot(dirname(absTestFile), repoRoot, env.testRunner)
  const relTest = relative(cwd, absTestFile)
  const relSrc = relative(cwd, absSourceFile)
  let covFlags: string
  let bareRun: string
  if (env.testRunner === 'vitest') {
    // Force coverage ON, narrowed to the changed source, reported as lcov into OUR temp dir —
    // overriding whatever custom provider/reporter/reportsDirectory the package config sets.
    covFlags = `--coverage --coverage.enabled=true --coverage.include=${sq(relSrc)} --coverage.reporter=lcov --coverage.reportsDirectory=${sq(outDir)}`
    bareRun = `npx vitest run ${sq(relTest)}`
  } else {
    covFlags = `--coverage --collectCoverageFrom=${sq(relSrc)} --coverageReporters=lcov --coverageDirectory=${sq(outDir)}`
    bareRun = `npx jest ${sq(relTest)}`
  }
  const command = npmTest ? `npm test -- ${sq(relTest)} ${covFlags}` : `${bareRun} ${covFlags}`
  return { command, cwd }
}

// Multi-file run (pollution victim/polluter checks). Uses the shared package root only when ALL
// files live under it; otherwise falls back to a bare repo-root run so we never mis-scope.
export async function resolveMultiFileTestRun(env: DetectedEnvironment, absFiles: string[], repoRoot: string): Promise<ResolvedRun> {
  const first = await findTestRoot(dirname(absFiles[0]), repoRoot, env.testRunner)
  const allUnder = absFiles.every((f) => f === first.cwd || f.startsWith(first.cwd + '/'))
  if (allUnder && first.npmTest) {
    const rels = absFiles.map((f) => sq(relative(first.cwd, f))).join(' ')
    return { command: `npm test -- ${rels}`, cwd: first.cwd }
  }
  if (allUnder) {
    return { command: multiFileTestCommand(env, absFiles.map((f) => relative(first.cwd, f))), cwd: first.cwd }
  }
  return { command: multiFileTestCommand(env, absFiles.map((f) => relative(repoRoot, f))), cwd: repoRoot }
}
