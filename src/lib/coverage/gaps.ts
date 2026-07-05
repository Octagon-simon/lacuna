import { readdir, readFile, access } from 'fs/promises'
import { join, extname, sep, dirname, basename } from 'path'
import type { CoverageReport, CoverageGap } from './types.js'

export function extractGaps(report: CoverageReport, threshold: number): CoverageGap[] {
  return report.files
    .filter((file) => file.lineRate * 100 < threshold)
    .map((file) => ({
      filePath: file.path,
      uncoveredLines: file.lines.filter((l) => l.hit === 0).map((l) => l.line),
      uncoveredFunctions: file.functions.filter((f) => f.hit === 0).map((f) => f.name),
    }))
    .filter((gap) => gap.uncoveredLines.length > 0 || gap.uncoveredFunctions.length > 0)
}

export interface FilterGapsOptions {
  // When true, gaps for source files that ALREADY have a test file are kept (so the loop can
  // improve an existing below-threshold test) instead of skipped. Used by scoped/`--improve`
  // generate. Default (false) preserves the suite-wide "new files only" behavior.
  includeExisting?: boolean
}

// Filters out gaps where the source file contains only types, interfaces, enums, or constants,
// or — unless includeExisting is set — where a test file already exists for the source file.
export async function filterTestableGaps(
  gaps: CoverageGap[],
  userIgnore: string[] = [],
  opts: FilterGapsOptions = {},
): Promise<CoverageGap[]> {
  const results: CoverageGap[] = []
  for (const gap of gaps) {
    if (userIgnore.some((p) => gap.filePath.includes(p))) continue
    if (shouldIgnore(gap.filePath, [])) continue
    if (!opts.includeExisting && await testFileExists(gap.filePath)) continue
    const source = await readFile(gap.filePath, 'utf-8').catch(() => '')
    if (hasTestableCode(source)) results.push(gap)
  }
  return results
}

// True when absPath is absDir itself or a descendant of it. Used to restrict discovery to a
// scope folder (`lacuna analyze/generate <dir>`).
export function isWithinDir(absPath: string, absDir: string): boolean {
  if (absPath === absDir) return true
  const base = absDir.endsWith(sep) ? absDir : absDir + sep
  return absPath.startsWith(base)
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])

// Returns true if the file content has at least one testable unit:
// a function declaration, an arrow function with a block body, or a class.
// Files that export only types, interfaces, enums, and plain constants are skipped.
function hasTestableCode(source: string): boolean {
  // strip line comments and string literals to avoid false positives in type signatures
  const stripped = source
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, '""')
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, '""')

  // function keyword (declaration or expression: function foo / function(
  if (/\bfunction\s*[\w(]/.test(stripped)) return true
  // arrow function with a block body: `) => {` or `=> {`
  if (/=>\s*\{/.test(stripped)) return true
  // class declaration or expression
  if (/\bclass\s+\w/.test(stripped)) return true
  // exported arrow assigned to a const, EXPRESSION body included:
  // `export const mapOptionsToString = (opts) => opts.map(...)` / `export const f = x => x`.
  // These are testable units; matching only `=> {` above missed every expression-body helper,
  // which (with index files) was a big reason scoped generate skipped real files. Keyed on
  // `export … const … =>` so pure type files (`export type F = () => void`) are NOT matched.
  if (/\bexport\s+(?:default\s+)?const\s+[\w$]+[^\n]*=>/.test(stripped)) return true

  return false
}

// Directories that never contain testable runtime logic
const IGNORE_DIRS = new Set([
  'node_modules',
  '__tests__',
  'types',
  'type',
  'constants',
  'constant',
  'assets',
  'images',
  'icons',
  'fonts',
  'styles',
  'style',
  'css',
  'generated',
  '__generated__',
  'mocks',
  'mock',
  'fixtures',
  'migrations',
  'seeds',
  'i18n',
  'locales',
  'locale',
  'translations',
])

// File name patterns that are not worth testing
const IGNORE_FILE_PATTERNS = [
  /\.d\.ts$/,                    // TypeScript declaration files
  /\.test\.[^.]+$/,              // existing test files
  /\.spec\.[^.]+$/,
  /\.stories\.[^.]+$/,           // Storybook stories
  /\.config\.[^.]+$/,            // config files (vite.config.ts etc)
  /\.mock\.[^.]+$/,              // mock files
  /\.fixture\.[^.]+$/,           // fixture files
  /\.enum\.[^.]+$/,              // pure enum files
  /\.types?\.[^.]+$/,            // *.type.ts / *.types.ts
  /\.constants?\.[^.]+$/,        // *.constant.ts / *.constants.ts
  /\.interface\.[^.]+$/,         // *.interface.ts
  // NOTE: index files are intentionally NOT name-ignored. A pure barrel (`export * from …`)
  // has no testable unit, so `hasTestableCode` already skips it; but many index files carry real
  // logic (helpers, a component + its mappers), and blanket-ignoring them by name dropped those
  // from scoped generate ("doesn't cover all files in the folder"). Let content decide, not name.
]

function shouldIgnore(absPath: string, userIgnore: string[]): boolean {
  const parts = absPath.split(sep)

  // check every path segment against ignored dirs
  for (const part of parts) {
    if (IGNORE_DIRS.has(part.toLowerCase())) return true
  }

  // check file name patterns
  if (IGNORE_FILE_PATTERNS.some((p) => p.test(absPath))) return true

  // check user-defined ignore strings (substring match against the full path)
  if (userIgnore.some((pattern) => absPath.includes(pattern))) return true

  return false
}

async function walkDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name.toLowerCase())) {
        files.push(...(await walkDir(full)))
      }
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(full)
    }
  }
  return files
}

// Walker that descends into __tests__ — used only for test-file discovery,
// not for source-file discovery (where __tests__ is correctly excluded).
async function walkDirForTests(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        files.push(...(await walkDirForTests(full)))
      }
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(full)
    }
  }
  return files
}

async function testFileExists(absSourcePath: string): Promise<boolean> {
  const dir = dirname(absSourcePath)
  const ext = extname(absSourcePath)
  const base = basename(absSourcePath, ext)

  const candidates = [
    join(dir, '__tests__', `${base}.test${ext}`),
    join(dir, '__tests__', `${base}.spec${ext}`),
    join(dir, `${base}.test${ext}`),
    join(dir, `${base}.spec${ext}`),
    join(dir, `test_${base}${ext}`),
    join(dir, `${base}_test${ext}`),
  ]

  for (const c of candidates) {
    try { await access(c); return true } catch { /* not found */ }
  }
  return false
}

export async function findUncoveredFiles(
  report: CoverageReport,
  sourceDir: string | string[],
  cwd: string,
  userIgnore: string[] = [],
  scopeDir?: string,
): Promise<CoverageGap[]> {
  // Normalize LCOV paths: they can be absolute or relative depending on the runner.
  // walkDir always returns absolute paths, so normalise here to avoid false misses.
  const coveredPaths = new Set(
    report.files.map((f) => (f.path.startsWith('/') ? f.path : join(cwd, f.path))),
  )
  // When a scope dir is given, walk only that subtree — the cheap, suite-free part of a
  // scoped analyze/generate (every file here is a real candidate, no runner needed).
  const dirs = scopeDir
    ? [scopeDir]
    : (Array.isArray(sourceDir) ? sourceDir : [sourceDir]).map(d => join(cwd, d))

  const allSourceFiles = (await Promise.all(dirs.map(d => walkDir(d).catch(() => [] as string[])))).flat()

  const uncovered: CoverageGap[] = []
  for (const absPath of allSourceFiles) {
    if (shouldIgnore(absPath, userIgnore)) continue
    if (coveredPaths.has(absPath)) continue

    // skip if a test file already exists for this source file
    if (await testFileExists(absPath)) continue

    // skip files that contain only types, interfaces, enums, or plain constants
    const source = await readFile(absPath, 'utf-8').catch(() => '')
    if (!hasTestableCode(source)) continue

    uncovered.push({ filePath: absPath, uncoveredLines: [], uncoveredFunctions: [] })
  }
  return uncovered
}

// ─── Patch-coverage mode (`@diff`) helpers ──────────────────────────────────────

function toAbs(path: string, cwd: string): string {
  return path.startsWith('/') ? path : join(cwd, path)
}

// Keeps only gaps for files the diff touched and narrows each gap's target lines to the
// intersection of "uncovered per the report" ∩ "changed per git". A file with a coverage
// entry whose changed lines are all covered is dropped (its patch coverage is already 100%).
// A file with NO coverage entry (untested new file) targets every changed line.
export function narrowGapsToDiff(
  gaps: CoverageGap[],
  changed: Map<string, Set<number>>,
  report: CoverageReport,
  cwd: string,
): CoverageGap[] {
  const reportPaths = new Set(report.files.map((f) => toAbs(f.path, cwd)))
  const narrowed: CoverageGap[] = []
  for (const gap of gaps) {
    const abs = toAbs(gap.filePath, cwd)
    const changedLines = changed.get(abs)
    if (!changedLines) continue
    if (reportPaths.has(abs)) {
      const lines = gap.uncoveredLines.filter((l) => changedLines.has(l))
      if (lines.length === 0) continue
      narrowed.push({ ...gap, uncoveredLines: lines })
    } else {
      narrowed.push({ ...gap, uncoveredLines: [...changedLines].sort((a, b) => a - b) })
    }
  }
  return narrowed
}

// Changed files that appear NEITHER in the coverage report NOR in the gap set are still
// patch-relevant: findUncoveredFiles skips any file that already has a test file, so a changed
// file whose test never ran (failing suite, fresh checkout, no coverage entry) would otherwise
// vanish from the diff scope and report a vacuous 100%. Returns whole-file gaps (empty
// uncoveredLines — the diff narrowing turns that into "every changed line") for the testable
// subset of those files.
export async function missingChangedFileGaps(
  changed: Map<string, Set<number>>,
  report: CoverageReport,
  existingGaps: CoverageGap[],
  cwd: string,
  userIgnore: string[] = [],
): Promise<CoverageGap[]> {
  const reportPaths = new Set(report.files.map((f) => toAbs(f.path, cwd)))
  const gapPaths = new Set(existingGaps.map((g) => toAbs(g.filePath, cwd)))
  const candidates: CoverageGap[] = []
  for (const abs of changed.keys()) {
    if (reportPaths.has(abs) || gapPaths.has(abs)) continue
    candidates.push({ filePath: abs, uncoveredLines: [], uncoveredFunctions: [] })
  }
  return filterTestableGaps(candidates, userIgnore, { includeExisting: true })
}

export interface PatchCoverage {
  covered: number
  total: number
  pct: number
}

// Codecov-style patch coverage: covered changed executable lines / total changed executable
// lines. "Executable" = the line has a record in the coverage report (blank/comment/type
// lines aren't instrumented, so they don't count — same as Codecov). Files absent from the
// report contribute nothing UNLESS listed in assumeUncovered (changed testable files whose
// tests never ran — all their changed lines count as uncovered). An empty denominator is
// 100% (nothing executable changed).
export function computePatchCoverage(
  report: CoverageReport,
  changed: Map<string, Set<number>>,
  cwd: string,
  assumeUncovered: Set<string> = new Set(),
): PatchCoverage {
  const hitsByPath = new Map<string, Map<number, number>>()
  for (const f of report.files) {
    hitsByPath.set(toAbs(f.path, cwd), new Map(f.lines.map((l) => [l.line, l.hit])))
  }

  let covered = 0
  let total = 0
  for (const [abs, lines] of changed) {
    const hits = hitsByPath.get(abs)
    if (hits) {
      for (const line of lines) {
        const hit = hits.get(line)
        if (hit === undefined) continue // not executable per the instrumenter
        total++
        if (hit > 0) covered++
      }
    } else if (assumeUncovered.has(abs)) {
      total += lines.size
    }
  }

  return { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 }
}

export function formatCoverageSummary(report: CoverageReport): string {
  const lineRate = (report.totalLineRate * 100).toFixed(1)
  const fnRate = (report.totalFunctionRate * 100).toFixed(1)
  return `Lines: ${lineRate}%  Functions: ${fnRate}%`
}

const TEST_FILE_RE = /\.(test|spec)\.[^.]+$|^test_[^/]+$|_test\.[^.]+$/

export async function findTestFiles(
  cwd: string,
  _env: { sourceDir?: string },
  config: { sourceDir: string | string[]; ignore: string[] },
  scopeDir?: string,
): Promise<string[]> {
  // When scoped, only the scope subtree is searched (so "are there tests under this folder?"
  // decides the FS-only-vs-coverage-run fork without touching the rest of the repo).
  const sourceDirs = scopeDir
    ? [scopeDir]
    : (Array.isArray(config.sourceDir) ? config.sourceDir : [config.sourceDir]).map(d => join(cwd, d))
  // Also search the cwd root so tests in __tests__/ directories alongside source dirs are found
  // (only in the unscoped case — a scope dir searches just itself).
  const searchDirs = scopeDir ? [scopeDir] : [...new Set([cwd, ...sourceDirs])]
  // Use walkDirForTests so __tests__/ directories are not skipped (walkDir excludes them
  // intentionally for source-file discovery, but we need to descend into them here).
  const all = (await Promise.all(searchDirs.map(d => walkDirForTests(d).catch(() => [] as string[])))).flat()
  const seen = new Set<string>()
  return all.filter((f) => {
    if (seen.has(f)) return false
    seen.add(f)
    const rel = f.replace(cwd + sep, '').replace(cwd + '/', '')
    // Only apply user-defined ignores, not the internal IGNORE_DIRS list
    // (which would exclude __tests__ paths entirely).
    return TEST_FILE_RE.test(rel) && !config.ignore.some(p => f.includes(p))
  })
}
