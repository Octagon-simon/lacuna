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

// Filters out gaps where the source file contains only types, interfaces, enums, or constants,
// or where a test file already exists for the source file.
export async function filterTestableGaps(gaps: CoverageGap[], userIgnore: string[] = []): Promise<CoverageGap[]> {
  const results: CoverageGap[] = []
  for (const gap of gaps) {
    if (userIgnore.some((p) => gap.filePath.includes(p))) continue
    if (shouldIgnore(gap.filePath, [])) continue
    if (await testFileExists(gap.filePath)) continue
    const source = await readFile(gap.filePath, 'utf-8').catch(() => '')
    if (hasTestableCode(source)) results.push(gap)
  }
  return results
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
  /\/index\.[^.]+$/,             // barrel re-export files
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
  sourceDir: string,
  cwd: string,
  userIgnore: string[] = [],
): Promise<CoverageGap[]> {
  // Normalize LCOV paths: they can be absolute or relative depending on the runner.
  // walkDir always returns absolute paths, so normalise here to avoid false misses.
  const coveredPaths = new Set(
    report.files.map((f) => (f.path.startsWith('/') ? f.path : join(cwd, f.path))),
  )
  const absoluteSourceDir = join(cwd, sourceDir)

  const allSourceFiles = await walkDir(absoluteSourceDir).catch(() => [] as string[])

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

export function formatCoverageSummary(report: CoverageReport): string {
  const lineRate = (report.totalLineRate * 100).toFixed(1)
  const fnRate = (report.totalFunctionRate * 100).toFixed(1)
  return `Lines: ${lineRate}%  Functions: ${fnRate}%`
}

const TEST_FILE_RE = /\.(test|spec)\.[^.]+$|^test_[^/]+$|_test\.[^.]+$/

export async function findTestFiles(
  cwd: string,
  _env: { sourceDir?: string },
  config: { sourceDir: string; ignore: string[] },
): Promise<string[]> {
  const root = join(cwd, config.sourceDir)
  const all = await walkDir(root).catch(() => [])
  return all.filter((f) => {
    const rel = f.replace(cwd + sep, '').replace(cwd + '/', '')
    return TEST_FILE_RE.test(rel) && !shouldIgnore(f, config.ignore)
  })
}
