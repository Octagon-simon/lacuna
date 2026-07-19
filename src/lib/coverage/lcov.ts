import { readFile, readdir, stat, access } from 'fs/promises'
import { join } from 'path'
import type { CoverageReport, FileCoverage, LineCoverage, FunctionCoverage } from './types.js'

// Some projects customize their reporter's output filename (e.g. Vitest's
// `['lcov', { file: 'coverage.lcov' }]`, often for CI shard-merging) instead of the tool
// default `lcov.info`. Fall back to whatever `.lcov` file is actually in coverageDir — the
// most recently written one, if there happen to be several (leftover shard files) — rather
// than assuming a fixed name that may not match the project's own reporter config.
export async function resolveLcovPath(coverageDir: string, cwd: string): Promise<string> {
  const dir = join(cwd, coverageDir)
  const standard = join(dir, 'lcov.info')
  try {
    await access(standard)
    return standard
  } catch { /* fall through to discovery */ }

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const lcovFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.lcov'))
    if (lcovFiles.length === 0) return standard // let the caller's readFile raise the real ENOENT
    if (lcovFiles.length === 1) return join(dir, lcovFiles[0].name)
    const withMtime = await Promise.all(
      lcovFiles.map(async (e) => {
        const p = join(dir, e.name)
        const { mtimeMs } = await stat(p)
        return { p, mtimeMs }
      }),
    )
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return withMtime[0].p
  } catch {
    return standard
  }
}

interface LcovEntry {
  file: string
  lines: LineCoverage[]
  functions: FunctionCoverage[]
}

function parseLcovText(text: string): LcovEntry[] {
  const entries: LcovEntry[] = []
  let current: LcovEntry | null = null
  const fnNames: Record<string, number> = {}

  for (const raw of text.split('\n')) {
    const line = raw.trim()

    if (line.startsWith('SF:')) {
      current = { file: line.slice(3), lines: [], functions: [] }
      Object.keys(fnNames).forEach((k) => delete fnNames[k])
    } else if (line.startsWith('FN:') && current) {
      const [lineNo, name] = line.slice(3).split(',')
      fnNames[name] = parseInt(lineNo, 10)
    } else if (line.startsWith('FNDA:') && current) {
      const [hitStr, name] = line.slice(5).split(',')
      current.functions.push({ name, line: fnNames[name] ?? 0, hit: parseInt(hitStr, 10) })
    } else if (line.startsWith('DA:') && current) {
      const [lineNo, hitStr] = line.slice(3).split(',')
      current.lines.push({ line: parseInt(lineNo, 10), hit: parseInt(hitStr, 10) })
    } else if (line === 'end_of_record' && current) {
      entries.push(current)
      current = null
    }
  }

  return entries
}

function toFileCoverage(entry: LcovEntry): FileCoverage {
  const coveredLines = entry.lines.filter((l) => l.hit > 0).length
  const coveredFns = entry.functions.filter((f) => f.hit > 0).length
  return {
    path: entry.file,
    lines: entry.lines,
    functions: entry.functions,
    lineRate: entry.lines.length ? coveredLines / entry.lines.length : 1,
    functionRate: entry.functions.length ? coveredFns / entry.functions.length : 1,
  }
}

export async function parseLcov(coverageDir: string, cwd: string = process.cwd()): Promise<CoverageReport> {
  const lcovPath = await resolveLcovPath(coverageDir, cwd)
  const text = await readFile(lcovPath, 'utf-8')
  const entries = parseLcovText(text)
  const files = entries.map(toFileCoverage)

  const totalLines = files.reduce((sum, f) => sum + f.lines.length, 0)
  const coveredLines = files.reduce((sum, f) => sum + f.lines.filter((l) => l.hit > 0).length, 0)
  const totalFns = files.reduce((sum, f) => sum + f.functions.length, 0)
  const coveredFns = files.reduce((sum, f) => sum + f.functions.filter((fn) => fn.hit > 0).length, 0)

  return {
    files,
    totalLineRate: totalLines ? coveredLines / totalLines : 1,
    totalFunctionRate: totalFns ? coveredFns / totalFns : 1,
  }
}
