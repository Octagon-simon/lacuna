import { readFile, access, mkdir, readdir } from 'fs/promises'
import { join, dirname, basename, extname, relative } from 'path'
import type { DetectedEnvironment } from '../lib/detector.js'
import type { LacunaConfig } from '../lib/config.js'

export interface FileContext {
  sourceFile: string
  sourceCode: string
  existingTestFile: string | null
  existingTestCode: string | null
  suggestedTestFile: string
  sourceImportPath: string | null  // relative import path from test file to source file
  mocksCode: string | null
  mocksImportPath: string | null
  setupFileCode: string | null
  packageDeps: string | null      // test-relevant lines from package.json
  tsconfigPaths: string | null    // path aliases from tsconfig.json
  typeDefinitions: string | null  // interface/type/enum declarations from locally imported files
  localImportPaths: string[] | null  // pre-computed vi.mock() paths (relative from test file to each local dep)
  localImportContents: string | null // full content (capped) of directly imported local files — hook/service implementations
  reactMajorVersion: number | null   // major React version detected from package.json, or null
}

// Compute the relative import path from one file to another, stripping the extension.
export function computeRelativeImport(fromFile: string, toFile: string): string {
  const rel = relative(dirname(fromFile), toFile)
  const noExt = rel.replace(/\.(tsx?|jsx?|mts|cts)$/, '')
  return noExt.startsWith('.') ? noExt : `./${noExt}`
}

const TEST_SUFFIXES = ['.test', '.spec']

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// Candidate test-directory roots for mirrored project layouts (test/unit/…, etc.)
const MIRROR_TEST_ROOTS = ['test/unit', 'test/integration', 'test', 'tests/unit', 'tests', 'spec']

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/

// True if dir contains at least one test file (recursively, shallow). Guards against
// treating a helpers-only directory — e.g. a `test/` holding only mock.ts/setup.ts —
// as a mirror test root, which would scatter new tests far from the source.
async function dirContainsTestFile(dir: string, depth = 0, maxDepth = 6): Promise<boolean> {
  if (depth > maxDepth) return false
  let entries: import('fs').Dirent<string>[]
  try { entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' }) } catch { return false }
  for (const entry of entries) {
    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) return true
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      if (await dirContainsTestFile(join(dir, entry.name), depth + 1, maxDepth)) return true
    }
  }
  return false
}

// Recursively search dir for a file matching filename, up to maxDepth levels deep.
// Returns the first absolute path found, or null.
export async function findFileByName(dir: string, filename: string, depth = 0, maxDepth = 6): Promise<string | null> {
  if (depth > maxDepth) return null
  let entries: import('fs').Dirent<string>[]
  try { entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' }) } catch { return null }
  for (const entry of entries) {
    if (entry.name === filename) return join(dir, entry.name)
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      const found = await findFileByName(join(dir, entry.name), filename, depth + 1, maxDepth)
      if (found) return found
    }
  }
  return null
}

// Given source file path (relative to cwd) and a list of configured sourceDirs,
// returns { srcDirParent, relPath } when the source file sits inside one of the
// sourceDirs — the building blocks for mirrored test path resolution.
function mirrorParts(
  sourceFile: string,
  sourceDirs: string[],
): { srcDirParent: string; relPath: string } | null {
  const norm = sourceFile.replace(/\\/g, '/')
  for (const srcDir of sourceDirs) {
    const nd = srcDir.replace(/\\/g, '/').replace(/\/$/, '')
    // Case 1: sourceDir is a prefix of the path ("packages/server/src/adapters/...")
    if (norm.startsWith(nd + '/')) {
      return { srcDirParent: '', relPath: norm.slice(nd.length + 1) }
    }
    // Case 2: sourceDir appears as a path segment ("packages/server/src/adapters/...")
    // with sourceDir = "src" → srcDirParent = "packages/server/", relPath = "adapters/..."
    const idx = norm.indexOf('/' + nd + '/')
    if (idx !== -1) {
      return { srcDirParent: norm.slice(0, idx + 1), relPath: norm.slice(idx + nd.length + 2) }
    }
  }
  return null
}

async function inferTestFilePath(
  sourceFile: string,
  cwd: string,
  env: DetectedEnvironment,
  sourceDirs: string[] = ['src'],
): Promise<string> {
  const dir = dirname(sourceFile)
  const ext = extname(sourceFile)
  const base = basename(sourceFile, ext)

  if (env.language === 'python') {
    return join(dir, `test_${base}${ext}`)
  }
  if (env.language === 'go') {
    return join(dir, `${base}_test${ext}`)
  }

  const colocated =
    (await dirExists(join(cwd, dir, `${base}.test${ext}`))) ||
    (await dirExists(join(cwd, dir, `${base}.spec${ext}`)))
  if (colocated) {
    return join(dir, `${base}.test${ext}`)
  }

  // Sibling convention: scan other source files in the same directory.
  // If their tests are in a __tests__/ subfolder or co-located, follow that pattern
  // rather than deferring to mirror roots (which can pick up a wrong project-level test/).
  const srcAbsDir = join(cwd, dir)
  let siblingConventionDir: string | null = null
  try {
    const sibEntries = await readdir(srcAbsDir, { withFileTypes: true })
    sibLoop: for (const entry of sibEntries) {
      if (!entry.isFile()) continue
      const sibExt = extname(entry.name)
      if (!['.ts', '.tsx', '.js', '.jsx'].includes(sibExt)) continue
      const sibBase = basename(entry.name, sibExt)
      if (sibBase === base || TEST_SUFFIXES.some(s => entry.name.endsWith(`${s}${sibExt}`))) continue
      // __tests__ subdirectory (check first — preferred convention in React Native)
      for (const s of TEST_SUFFIXES) {
        try { await access(join(srcAbsDir, '__tests__', `${sibBase}${s}${sibExt}`)); siblingConventionDir = join(dir, '__tests__'); break sibLoop } catch { /* next */ }
      }
      // co-located test next to the source file
      for (const s of TEST_SUFFIXES) {
        try { await access(join(srcAbsDir, `${sibBase}${s}${sibExt}`)); siblingConventionDir = dir; break sibLoop } catch { /* next */ }
      }
    }
  } catch { /* readdir failed — fall through */ }

  if (siblingConventionDir !== null) {
    await mkdir(join(cwd, siblingConventionDir), { recursive: true })
    return join(siblingConventionDir, `${base}.test${ext}`)
  }

  // Mirror test directory: if this project uses a separate test/ tree, place the
  // new test there rather than creating a co-located __tests__ folder.
  const parts = mirrorParts(sourceFile, sourceDirs)
  if (parts) {
    const { srcDirParent, relPath } = parts
    for (const testRoot of MIRROR_TEST_ROOTS) {
      const testRootAbs = join(cwd, srcDirParent, testRoot)
      // Require the root to actually contain tests — a bare `test/` that only holds
      // mock/setup helpers must not hijack placement away from the real convention.
      if ((await dirExists(testRootAbs)) && (await dirContainsTestFile(testRootAbs))) {
        const targetDir = join(testRootAbs, dirname(relPath))
        await mkdir(targetDir, { recursive: true })
        return join(srcDirParent, testRoot, dirname(relPath), `${base}.test${ext}`)
      }
    }
  }

  const testsDir = join(cwd, dir, '__tests__')
  await mkdir(testsDir, { recursive: true })
  return join(dir, '__tests__', `${base}.test${ext}`)
}

export async function findExistingTestFile(sourceFile: string, cwd: string, sourceDirs: string[] = ['src']): Promise<string | null> {
  const ext = extname(sourceFile)
  const base = basename(sourceFile, ext)
  const dir = dirname(sourceFile)

  // Attempt 1: co-located (next to source, or inside __tests__ sibling)
  const candidates = [
    ...TEST_SUFFIXES.map((s) => join(cwd, dir, '__tests__', `${base}${s}${ext}`)),
    ...TEST_SUFFIXES.map((s) => join(cwd, dir, `${base}${s}${ext}`)),
    join(cwd, dir, `test_${base}${ext}`),
    join(cwd, dir, `${base}_test${ext}`),
  ]
  for (const candidate of candidates) {
    try { await readFile(candidate); return candidate } catch { /* not found */ }
  }

  // Attempt 2: mirrored test directory tree (exact path mirror)
  // Finds: packages/server/src/adapters/auth/Foo.ts → packages/server/test/unit/adapters/auth/Foo.test.ts
  const parts = mirrorParts(sourceFile, sourceDirs)
  if (parts) {
    const { srcDirParent, relPath } = parts
    const relDir = dirname(relPath)
    for (const testRoot of MIRROR_TEST_ROOTS) {
      for (const s of TEST_SUFFIXES) {
        const candidate = join(cwd, srcDirParent, testRoot, relDir, `${base}${s}${ext}`)
        try { await readFile(candidate); return candidate } catch { /* not found */ }
      }
    }
  }

  // Attempt 3: filename search within known test root directories
  // Handles projects where test path doesn't exactly mirror source path
  // (e.g. src/lib/interactors/Foo.ts → test/unit/interactors/Foo.test.ts — "lib" dropped)
  const srcDirParent = parts?.srcDirParent ?? ''
  for (const testRoot of MIRROR_TEST_ROOTS) {
    const searchRoot = join(cwd, srcDirParent, testRoot)
    for (const s of TEST_SUFFIXES) {
      const found = await findFileByName(searchRoot, `${base}${s}${ext}`)
      if (found) return found
    }
  }

  return null
}

function relativeMockPath(testFile: string, mockFile: string): string {
  const rel = relative(dirname(testFile), mockFile)
  return rel.startsWith('.') ? rel : `./${rel}`
}

// ─── Type definition collector ────────────────────────────────────────────────

// Strips JSONC-style // and /* */ comments WITHOUT touching string contents — a naive
// regex-replace (the previous approach) treats any `/*` inside a STRING VALUE as a comment
// start, which is exactly the shape of the standard `"@/*": ["./src/*"]` path-alias entry.
// That corrupts the JSON (silently eating everything up to the next stray `*/`-like substring
// elsewhere in the file, e.g. inside an `exclude` glob like `src/**/__tests__`) and JSON.parse
// then throws, caught by the `try candidates` loop above — so EVERY project using the extremely
// common `@/*` alias pattern got zero aliases back, with no visible error.
function stripJsonComments(text: string): string {
  let result = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inLineComment) {
      if (c === '\n') { inLineComment = false; result += c }
      continue
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++ }
      continue
    }
    if (inString) {
      result += c
      if (c === '\\') { result += next; i++; continue }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; result += c; continue }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue }
    result += c
  }
  return result
}

async function readTsconfigAliases(cwd: string): Promise<Record<string, string[]>> {
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json']
  for (const name of candidates) {
    try {
      const raw = await readFile(join(cwd, name), 'utf-8')
      const stripped = stripJsonComments(raw)
      const tsconfig = JSON.parse(stripped) as { compilerOptions?: { paths?: Record<string, string[]> } }
      if (tsconfig.compilerOptions?.paths) return tsconfig.compilerOptions.paths
    } catch { /* try next */ }
  }
  return {}
}

// Resolve an import path to an absolute filesystem base path (no extension).
// Returns null for node_modules and unresolvable paths.
function resolveLocalImport(
  importPath: string,
  absoluteSourcePath: string,
  cwd: string,
  aliases: Record<string, string[]>,
): string | null {
  // Tsconfig alias resolution (e.g. "@/*" → "src/*")
  for (const [pattern, targets] of Object.entries(aliases)) {
    const aliasPrefix = pattern.replace(/\*$/, '')   // "@/*" → "@/"
    const targetBase = (targets[0] ?? '').replace(/\*$/, '')  // "src/*" → "src/"
    if (importPath.startsWith(aliasPrefix)) {
      return join(cwd, targetBase + importPath.slice(aliasPrefix.length))
    }
    if (importPath === pattern.replace(/\/\*$/, '')) {
      return join(cwd, targets[0] ?? '')
    }
  }
  // Relative import
  if (importPath.startsWith('.')) return join(dirname(absoluteSourcePath), importPath)
  return null
}

// Find the actual file by trying common extensions on a base path. NodeNext-style projects
// require an explicit compiled extension in relative specifiers even though the real source is
// TypeScript (`import './foo.js'` resolving to `./foo.ts`) — strip it first, or every suffix
// attempt below would double up (`foo.js.ts`) and silently fail to resolve.
async function resolveToFile(basePath: string): Promise<string | null> {
  const base = basePath.replace(/\.(m|c)?js$/, '')
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
    try { await access(base + suffix); return base + suffix } catch { /* try next */ }
  }
  return null
}

// A tsconfig path alias can point at another WORKSPACE PACKAGE's root (e.g.
// `"@afriex/core": ["../core"]` in a monorepo), not just a local directory. When the import has
// a subpath beyond the bare alias (`@afriex/core/domain`), the real target isn't a plain file
// under that root — it's resolved through the package's OWN package.json `exports` map, which
// commonly points at compiled output (`./dist/src/domain/index.js`) whose TypeScript source
// lives one directory removed (`src/domain/index.ts`, since TS project references mirror
// `src/**` into `dist/src/**` 1:1). Naively joining the subpath under the package root — what
// the alias loop above does — silently produces a nonexistent path, hiding that package's real
// exported types from the prompt entirely.
async function resolvePackageExport(pkgRoot: string, subpath: string): Promise<string | null> {
  let pkg: { exports?: unknown; main?: string; types?: string; typings?: string }
  try { pkg = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf-8')) } catch { return null }

  let target: string | undefined
  const exportsMap = pkg.exports
  if (exportsMap && typeof exportsMap === 'object') {
    const entry = (exportsMap as Record<string, unknown>)[subpath ? `./${subpath}` : '.']
    target = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object'
          ? ((entry as Record<string, unknown>).types
              ?? (entry as Record<string, unknown>).import
              ?? (entry as Record<string, unknown>).default) as string | undefined
          : undefined)
  }
  if (!target && !subpath) target = pkg.types ?? pkg.typings ?? pkg.main
  if (!target) return null

  // Map compiled output back to source: strip a leading dist/ segment and the compiled/
  // declaration extension, leaving a base resolveToFile can re-attach .ts/.tsx suffixes to.
  const stripped = target
    .replace(/^\.\//, '')
    .replace(/^dist\//, '')
    .replace(/\.d\.ts$|\.(m|c)?js$/, '')
  return join(pkgRoot, stripped)
}

// Fallback for when the plain alias-join resolution (resolveLocalImport + resolveToFile) misses
// a cross-package subpath import — tries every alias whose prefix matches, resolving the
// remainder through that package's own exports map instead of assuming a flat directory layout.
async function resolveViaPackageExports(
  importPath: string,
  aliases: Record<string, string[]>,
  cwd: string,
): Promise<string | null> {
  for (const [pattern, targets] of Object.entries(aliases)) {
    const aliasPrefix = pattern.replace(/\*$/, '')
    if (!importPath.startsWith(aliasPrefix)) continue
    const targetBase = (targets[0] ?? '').replace(/\*$/, '')
    const pkgRoot = join(cwd, targetBase)
    const subpath = importPath.slice(aliasPrefix.length).replace(/^\/+/, '')
    const resolved = await resolvePackageExport(pkgRoot, subpath)
    if (!resolved) continue
    const file = await resolveToFile(resolved)
    if (file) return file
  }
  return null
}

// Matches `import ... from '...'` (including `import type`) — used where re-export forms don't
// apply (collectLocalImportPaths only cares about the current file's own direct imports).
const IMPORT_RE = /^import(?:\s+type)?\s[^'"]*['"]([^'"]+)['"]/gm

export interface ModuleSpecifier {
  path: string
  // Named symbols imported/re-exported from `path` (alias-resolved to the LOCAL-facing name),
  // or null for a wildcard/default/namespace form (`export * from`, `import Foo from`,
  // `import * as NS from`) whose exported names can't be determined from this line alone.
  names: string[] | null
}

function parseNamedList(braceContent: string): string[] {
  return braceContent
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const asMatch = /^(?:type\s+)?[\w$]+\s+as\s+([\w$]+)$/.exec(s)
      if (asMatch) return asMatch[1]
      const bare = /^(?:type\s+)?([\w$]+)$/.exec(s)
      return bare ? bare[1] : s
    })
}

const NAMED_IMPORT_RE = /^import(?:\s+type)?\s+([^'"]+?)\s+from\s*['"]([^'"]+)['"]/gm
const NAMED_REEXPORT_RE = /^export(?:\s+type)?\s*(\*(?:\s+as\s+\w+)?|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/gm

// Extracts every import/re-export line's module path AND which named symbols it asks for.
// Matches `import ... from '...'` (including `import type`) AND re-export forms (`export *
// from '...'`, `export * as X from '...'`, `export {...} from '...'`, `export type {...} from
// '...'`) — barrel/index files are overwhelmingly written as pure re-exports with ZERO `import`
// statements (e.g. `export * from './enums/index.js'`), so following only `import` lines misses
// every type funneled through one. Tracking names lets a barrel that re-exports dozens of
// unrelated modules (e.g. `@/types`-style files) be traversed selectively instead of blindly, so
// a handful of genuinely-needed types don't get crowded out of the MAX_TYPE_FILES/MAX_TYPE_CHARS
// budget by unrelated ones the current file never actually uses.
function extractModuleSpecifiersWithNames(code: string): ModuleSpecifier[] {
  const specs: ModuleSpecifier[] = []

  for (const m of code.matchAll(NAMED_IMPORT_RE)) {
    const clause = m[1].trim()
    const path = m[2]
    const braceMatch = /^\{([\s\S]*)\}$/.exec(clause)
    specs.push(braceMatch ? { path, names: parseNamedList(braceMatch[1]) } : { path, names: null })
  }

  for (const m of code.matchAll(NAMED_REEXPORT_RE)) {
    const clause = m[1]
    const path = m[2]
    specs.push(clause.startsWith('*') ? { path, names: null } : { path, names: parseNamedList(clause.slice(1, -1)) })
  }

  return specs
}

// Extract exported interface/type/enum declarations via brace-depth tracking.
// Only captures the declarations themselves — not function bodies, classes, or constants.
// When `neededNames` is given (concrete, non-null), only declarations whose OWN name is in it
// are kept. Only pass this for a file reached via a WILDCARD re-export (`export * from`) that
// we're blindly traversing while chasing a specific name — such a file is often just one of many
// pass-through siblings (e.g. an unrelated sibling enum under a package's `enums/index.ts`) and
// showing its full, unrelated declarations would burn budget without value. A file reached via a
// CONFIRMED named match (`export {Foo} from './bar'` where Foo is what we want) should NOT be
// filtered this way — e.g. a component's OWN prop-type interface is legitimately named
// differently from the component itself (`Button` → `ButtonProps`), and filtering by exact name
// there would incorrectly drop it.
function extractTypeDeclarations(code: string, neededNames: string[] | null = null): string {
  const lines = code.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const declMatch = /^\s*export\s+(?:interface|type|enum)\s+(\w+)/.exec(line)
    if (declMatch) {
      if (neededNames && !neededNames.includes(declMatch[1])) { i++; continue }
      const block: string[] = [line]
      let depth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length

      if (depth <= 0) {
        // Single-line: export type Foo = string | number
        result.push(line.trimEnd())
        i++
        continue
      }

      // Multi-line: collect until braces balance
      i++
      while (i < lines.length && depth > 0) {
        block.push(lines[i])
        depth += (lines[i].match(/\{/g) ?? []).length
        depth -= (lines[i].match(/\}/g) ?? []).length
        i++
      }
      result.push(block.join('\n'))
      result.push('')
      continue
    }
    i++
  }

  return result.join('\n').trim()
}

// Named-import-aware filtering (above) now lets barrels be followed without wasting budget on
// unrelated re-exports, so a genuinely-needed type several barrel hops deep (e.g. an enum
// re-exported through a chain of index.ts files across a workspace package boundary) no longer
// gets crowded out by a source file's other, shallower direct imports competing for the same
// budget. Raised from the original 10/4000 accordingly — those were calibrated for a world where
// re-exports silently failed to resolve, so most of the budget went unused rather than being a
// real constraint.
const MAX_TYPE_FILES = 40
const MAX_TYPE_CHARS = 15000

// Scans a source file's imports and follows them transitively, depth-first per import, to
// collect interface/type/enum declarations from any locally-defined types they reference.
// Stops at MAX_TYPE_FILES files or MAX_TYPE_CHARS characters to stay prompt-safe.
//
// Depth-first (not breadth-first) matters here: a source file typically has many direct
// imports, each shallow (one hop). But a single one of those can be a barrel (e.g. `@/types`)
// whose real target is several re-export hops deep, possibly across a workspace package
// boundary (`@scope/pkg/subpath` → that package's own exports map → its compiled-output
// convention back to real source — see resolveViaPackageExports). A shared FIFO queue processes
// every direct import's own single hop before any of them gets to go deeper, so the budget can
// exhaust on shallow breadth before a deep-but-relevant chain is ever reached. Finishing each
// import's chain (however deep) before starting the next avoids that.
export async function collectTypeDefinitions(
  sourceCode: string,
  absoluteSourcePath: string,
  cwd: string,
): Promise<string | null> {
  const aliases = await readTsconfigAliases(cwd)
  // Keyed by file + which names we were chasing (not file alone): a shared barrel/index file
  // (e.g. a workspace package's `domain/index.ts`) is commonly re-entered from DIFFERENT
  // top-level imports chasing DIFFERENT names — deduping by file path alone means the first visit
  // (chasing an unrelated name that happens to resolve through the same barrel) permanently
  // blocks every later, differently-targeted visit from ever re-scanning it.
  const visited = new Set<string>()
  const visitKey = (file: string, names: string[] | null) => `${file}::${names ? names.slice().sort().join(',') : '*'}`
  const blocks: string[] = []
  let totalChars = 0

  const topLevel = extractModuleSpecifiersWithNames(sourceCode)
  // Fair-share cap per TOP-LEVEL import: DFS means one import's chain runs to completion before
  // the next starts, so an early import that happens to be a deep/wide barrel (a component
  // library re-exporting many components, each importing several more type files) could
  // otherwise consume the entire global budget by itself, starving every import that comes
  // after it in the file — including the one actually relevant to the current task. At least 3
  // files / 1000 chars per import, however many imports there are, so a single-import file still
  // gets the full global budget.
  const perImportFileCap = Math.max(8, Math.ceil(MAX_TYPE_FILES / Math.max(1, topLevel.length)))
  const perImportCharCap = Math.max(3000, Math.ceil(MAX_TYPE_CHARS / Math.max(1, topLevel.length)))

  // neededNames: the specific symbols being chased FROM `specifier` (null = unfiltered — follow
  // everything found inside, used for the root source file's own imports and any wildcard
  // `export *` hop, since we can't know what a wildcard re-exports without reading it). A
  // barrel/index file can re-export dozens of unrelated modules; without this, a handful of
  // genuinely-needed types get crowded out of the budget by whichever unrelated re-export
  // happens to appear first in the barrel.
  async function visit(
    specifier: string,
    fromAbsolutePath: string,
    neededNames: string[] | null,
    arrivedViaWildcard: boolean,
    branchBlocksStart: number,
    branchCharsStart: number,
  ): Promise<void> {
    if (blocks.length >= MAX_TYPE_FILES || totalChars >= MAX_TYPE_CHARS) return
    if (blocks.length - branchBlocksStart >= perImportFileCap) return
    if (totalChars - branchCharsStart >= perImportCharCap) return

    const base = resolveLocalImport(specifier, fromAbsolutePath, cwd, aliases)
    let file = base ? await resolveToFile(base) : null
    if (!file) file = await resolveViaPackageExports(specifier, aliases, cwd)
    if (!file || file === absoluteSourcePath) return
    const key = visitKey(file, neededNames)
    if (visited.has(key)) return
    visited.add(key)

    let content: string
    try { content = await readFile(file, 'utf-8') } catch { return }

    // Collect type declarations from this file (if any). Only filter by neededNames when we
    // arrived via a wildcard (blind traversal, e.g. chasing one enum through `export * from
    // './enums/index.js'` where most siblings are irrelevant) — a file reached via a CONFIRMED
    // named match keeps its full declarations (e.g. a component's own differently-named props
    // interface).
    const declarations = extractTypeDeclarations(content, arrivedViaWildcard ? neededNames : null)
    if (declarations) {
      const block = `// from ${relative(cwd, file)}\n${declarations}`
      blocks.push(block)
      totalChars += block.length
    }

    // Follow this file's imports too — it might re-export types from deeper files even if it
    // has no declarations of its own. Each nested specifier's own names (if concrete) become the
    // filter for ITS target; a wildcard here (names === null) means THIS line doesn't tell us
    // what's inside, so keep chasing whatever we were ALREADY asked for (neededNames) rather than
    // resetting to unfiltered — otherwise a single `export * from` hop anywhere in the chain
    // (extremely common — e.g. `core/domain/index.ts` re-exporting `./enums/index.js` etc.)
    // permanently disables filtering for its entire subtree, which is exactly the barrel-flood
    // this filtering exists to prevent.
    for (const { path: nextSpecifier, names } of extractModuleSpecifiersWithNames(content)) {
      if (blocks.length >= MAX_TYPE_FILES || totalChars >= MAX_TYPE_CHARS) break
      if (blocks.length - branchBlocksStart >= perImportFileCap) break
      if (totalChars - branchCharsStart >= perImportCharCap) break
      if (neededNames && names && !names.some((n) => neededNames.includes(n))) continue
      await visit(nextSpecifier, file, names ?? neededNames, names === null, branchBlocksStart, branchCharsStart)
    }
  }

  for (const { path: specifier, names } of topLevel) {
    if (blocks.length >= MAX_TYPE_FILES || totalChars >= MAX_TYPE_CHARS) break
    await visit(specifier, absoluteSourcePath, names, false, blocks.length, totalChars)
  }

  return blocks.length > 0 ? blocks.join('\n\n') : null
}

// Returns the pre-computed relative import paths (from the test file) for every
// local module imported by the source file. These are the exact strings the AI
// should use in vi.mock() / jest.mock() calls — no directory counting required.
// Only direct imports are included (no BFS) since you mock direct deps, not transitive ones.
export async function collectLocalImportPaths(
  sourceCode: string,
  absoluteSourcePath: string,
  absoluteTestFilePath: string,
  cwd: string,
): Promise<string[] | null> {
  const aliases = await readTsconfigAliases(cwd)
  const results: string[] = []
  const seen = new Set<string>()

  for (const m of sourceCode.matchAll(IMPORT_RE)) {
    const importPath = m[1]
    const base = resolveLocalImport(importPath, absoluteSourcePath, cwd, aliases)
    let file = base ? await resolveToFile(base) : null
    if (!file) file = await resolveViaPackageExports(importPath, aliases, cwd)
    if (!file || seen.has(file)) continue
    seen.add(file)

    const rel = computeRelativeImport(absoluteTestFilePath, file)
    results.push(rel)
  }

  return results.length > 0 ? results : null
}

// ─── Used-symbols context ─────────────────────────────────────────────────────
// Builds a targeted map of exactly what the source component uses from its local
// imports: hook return shapes, service method signatures, type declarations.
// No arbitrary line cap — output is naturally bounded by what's actually referenced.
// BFS follows transitive type references (e.g. Draw type used by useDraws hook).

// Extract a brace-balanced block starting at lines[startIdx].
// Also handles brace-less type aliases by continuing while a continuation is implied.
function extractBraceBlock(lines: string[], startIdx: number): string {
  const block: string[] = []
  let depth = 0
  let opened = false
  for (let i = startIdx; i < lines.length; i++) {
    block.push(lines[i])
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true }
      else if (ch === '}') depth--
    }
    if (opened && depth <= 0) break
    if (!opened && i > startIdx) {
      const t = lines[i].trimEnd()
      const nextStartsCont = (i + 1 < lines.length) && /^\s*[|&]/.test(lines[i + 1])
      const isCont = t.endsWith('|') || t.endsWith('&') || t.endsWith(',') || t.endsWith('=') || nextStartsCont
      if (!isCont) break
    }
  }
  return block.join('\n')
}

const MAX_FN_LINES = 25

// For long functions/hooks: keep signature + "// ..." + last return statement.
function summariseFunctionBlock(code: string): string {
  const lines = code.split('\n')
  if (lines.length <= MAX_FN_LINES) return code

  let bodyOpen = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('{')) { bodyOpen = i; break }
  }

  let returnStart = -1
  for (let i = lines.length - 2; i > bodyOpen; i--) {
    if (/^\s*return\b/.test(lines[i])) { returnStart = i; break }
  }

  const sig = lines.slice(0, bodyOpen + 1)
  if (returnStart === -1) return [...sig, '  // ...', '}'].join('\n')
  return [...sig, '  // ...', ...lines.slice(returnStart)].join('\n')
}

// For classes: keep declaration + method signatures, collapse all bodies.
function summariseClassBlock(code: string): string {
  const lines = code.split('\n')
  const out: string[] = [lines[0]]
  let depth = 0
  for (const ch of lines[0]) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }
  let i = 1
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (!t || /^[/*]/.test(t) || t === '}') {
      out.push(line)
      for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth-- }
      i++; continue
    }
    // At class body depth (1): detect method-like lines by presence of '('
    if (depth === 1 && /\(/.test(t) && !/^\s*\/\//.test(line)) {
      const sigLines: string[] = []
      let d = depth
      let j = i
      while (j < lines.length) {
        const l = lines[j]
        d += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length
        sigLines.push(l)
        j++
        if (d > depth) break  // body opened
        if (d === depth) break // abstract / no body
      }
      // Show sig lines but strip the opening `{` from the last one
      for (let k = 0; k < sigLines.length - 1; k++) out.push(sigLines[k])
      const last = sigLines[sigLines.length - 1].replace(/\s*\{[^}]*$/, '').trimEnd()
      if (last.trim()) out.push(last)
      if (d > depth) {
        // Skip method body
        i = j
        while (i < lines.length && d > depth) {
          d += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length
          i++
        }
        depth = d
        continue
      }
      depth = d; i = j; continue
    }
    out.push(line)
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth-- }
    i++
  }
  return out.join('\n')
}

// PascalCase identifiers in code that look like local type references.
const TYPE_REF_BUILTINS = new Set([
  'React', 'Promise', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Error',
  'Date', 'Map', 'Set', 'RegExp', 'Function', 'Symbol', 'URL', 'JSON', 'Event',
  'HTMLElement', 'Element', 'Node', 'Window', 'Document', 'MouseEvent', 'KeyboardEvent',
  'FC', 'ReactNode', 'ReactElement', 'ComponentProps', 'Dispatch', 'SetStateAction',
  'MutableRefObject', 'RefObject', 'CSSProperties', 'SyntheticEvent', 'PropsWithChildren',
  'Partial', 'Required', 'Readonly', 'Record', 'Pick', 'Omit', 'Exclude', 'Extract',
  'NonNullable', 'ReturnType', 'InstanceType', 'Parameters', 'Awaited',
  'View', 'Text', 'ScrollView', 'FlatList', 'TouchableOpacity', 'Animated',
])
function extractTypeRefs(code: string): string[] {
  const found = new Set<string>()
  for (const m of code.matchAll(/\b([A-Z][a-zA-Z0-9]+)\b/g)) {
    if (!TYPE_REF_BUILTINS.has(m[1])) found.add(m[1])
  }
  return [...found]
}

function extractAllExportNames(code: string): string[] {
  const names: string[] = []
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/gm)) names.push(m[1])
  for (const m of code.matchAll(/^export\s+\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name && /^\w+$/.test(name)) names.push(name)
    }
  }
  return [...new Set(names)]
}

interface SymbolExtractionResult {
  code: string
  reexportPath?: string
  reexportName?: string
}

function extractSymbolFromCode(code: string, name: string): SymbolExtractionResult | null {
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!/\bexport\b/.test(line)) continue

    // Re-export: export [type] { X as Y } from './path'
    const reFrom = line.match(/^export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/)
    if (reFrom) {
      for (const part of reFrom[1].split(',')) {
        const halves = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)
        const exported = (halves[1] ?? halves[0]).trim()
        if (exported === name) return { code: '', reexportPath: reFrom[2], reexportName: halves[0].trim() }
      }
      continue
    }

    if (name === 'default' && /^\s*export\s+default\b/.test(line)) {
      const block = extractBraceBlock(lines, i)
      const isClass = /^\s*export\s+default\s+(?:abstract\s+)?class\b/.test(line)
      return { code: isClass ? summariseClassBlock(block) : summariseFunctionBlock(block) }
    }
    if (new RegExp(`^\\s*export\\s+(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*[<(]`).test(line)) {
      return { code: summariseFunctionBlock(extractBraceBlock(lines, i)) }
    }
    if (new RegExp(`^\\s*export\\s+const\\s+${name}\\s*[=:]`).test(line)) {
      return { code: summariseFunctionBlock(extractBraceBlock(lines, i)) }
    }
    if (new RegExp(`^\\s*export\\s+(?:abstract\\s+)?class\\s+${name}\\b`).test(line)) {
      return { code: summariseClassBlock(extractBraceBlock(lines, i)) }
    }
    if (new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:interface|type|enum)\\s+${name}\\b`).test(line)) {
      return { code: extractBraceBlock(lines, i) }
    }
  }
  return null
}

// Parse which symbols a source file imports from each local dependency.
// Returns Map<absoluteFilePath, Set<symbolName>> — '*' means namespace import.
async function parseImportedSymbols(
  code: string,
  fromAbsPath: string,
  cwd: string,
  aliases: Record<string, string[]>,
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>()
  for (const m of code.matchAll(/^import(?:\s+type)?\s+(.+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = m[1].trim()
    const base = resolveLocalImport(m[2], fromAbsPath, cwd, aliases)
    if (!base) continue
    const file = await resolveToFile(base)
    if (!file) continue
    const syms = result.get(file) ?? new Set<string>()
    result.set(file, syms)
    if (/\*\s+as\s+/.test(clause)) { syms.add('*'); continue }
    const namedMatch = clause.match(/\{([^}]+)\}/)
    if (namedMatch) {
      for (const part of namedMatch[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (/^\w+$/.test(name)) syms.add(name)
      }
    }
    const stripped = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+\w+/, '').trim()
    const def = stripped.match(/^(\w+)/)
    if (def && def[1] !== 'type') syms.add('default')
  }
  return result
}

const MAX_SYMBOLS_TOTAL_CHARS = 14000

// Builds targeted context from only the symbols the source component actually uses.
// For each imported symbol: extracts its declaration, collapses function bodies to
// signature + return, collapses class bodies to method signatures.
// Transitively follows PascalCase type references through their import chains (BFS).
export async function collectUsedSymbolsContext(
  sourceCode: string,
  absoluteSourcePath: string,
  cwd: string,
): Promise<string | null> {
  const aliases = await readTsconfigAliases(cwd)
  const directImports = await parseImportedSymbols(sourceCode, absoluteSourcePath, cwd, aliases)

  type QItem = { file: string; symbols: Set<string> }
  const queue: QItem[] = []
  for (const [file, syms] of directImports) queue.push({ file, symbols: new Set(syms) })

  const visited = new Set<string>()  // `${file}::${symbol}`
  const fileSections: string[] = []
  let totalChars = 0

  while (queue.length > 0 && totalChars < MAX_SYMBOLS_TOTAL_CHARS) {
    const { file, symbols } = queue.shift()!
    let fileContent: string
    try { fileContent = await readFile(file, 'utf-8') } catch { continue }

    const toProcess = symbols.has('*') ? new Set(extractAllExportNames(fileContent)) : symbols
    const fileBlocks: string[] = []
    const typeRefs = new Set<string>()

    for (const sym of toProcess) {
      const key = `${file}::${sym}`
      if (visited.has(key)) continue
      visited.add(key)

      const result = extractSymbolFromCode(fileContent, sym)
      if (!result) continue

      if (result.reexportPath) {
        const base = resolveLocalImport(result.reexportPath, file, cwd, aliases)
        if (base) {
          const reFile = await resolveToFile(base)
          if (reFile) {
            const reSym = result.reexportName ?? sym
            if (!visited.has(`${reFile}::${reSym}`)) queue.push({ file: reFile, symbols: new Set([reSym]) })
          }
        }
        continue
      }

      if (result.code) {
        fileBlocks.push(result.code)
        for (const ref of extractTypeRefs(result.code)) typeRefs.add(ref)
      }
    }

    // Follow type references: first check same file, then follow cross-file imports
    if (typeRefs.size > 0) {
      // Same-file types (defined in this file but not yet extracted)
      for (const ref of typeRefs) {
        const key = `${file}::${ref}`
        if (visited.has(key)) continue
        const local = extractSymbolFromCode(fileContent, ref)
        if (local?.code) {
          visited.add(key)
          fileBlocks.push(local.code)
        }
      }
      // Cross-file types (imported by this file from another local file)
      const typeImports = await parseImportedSymbols(fileContent, file, cwd, aliases)
      for (const [typeFile, typeSyms] of typeImports) {
        const relevant = new Set([...typeSyms].filter(s => typeRefs.has(s)))
        if (relevant.size > 0) queue.push({ file: typeFile, symbols: relevant })
      }
    }

    if (fileBlocks.length > 0) {
      const section = `// from ${relative(cwd, file)}\n${fileBlocks.join('\n\n')}`
      fileSections.push(section)
      totalChars += section.length
    }
  }

  return fileSections.length > 0 ? fileSections.join('\n\n') : null
}

// Reads the React major version from package.json, or null if React is not a dependency.
export async function detectReactMajorVersion(cwd: string): Promise<number | null> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const version = { ...pkg.dependencies, ...pkg.devDependencies }['react']
    if (!version) return null
    const m = version.match(/(\d+)/)
    return m ? parseInt(m[1], 10) : null
  } catch {
    return null
  }
}

async function readPackageDeps(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const testKeys = [
      'vitest', 'jest', '@jest/core', 'mocha', 'chai',
      '@testing-library/react', '@testing-library/user-event', '@testing-library/jest-dom',
      '@testing-library/vue', '@testing-library/svelte',
      'react', 'react-dom', 'vue', 'svelte',
      'msw', 'nock', 'supertest', 'axios-mock-adapter',
      '@types/jest', 'ts-jest', 'babel-jest',
    ]
    const relevant = Object.entries(deps)
      .filter(([k]) => testKeys.some((t) => k.includes(t)))
      .map(([k, v]) => `  "${k}": "${v}"`)
      .join('\n')
    return relevant || null
  } catch {
    return null
  }
}

async function readTsconfigPaths(cwd: string): Promise<string | null> {
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json']
  for (const name of candidates) {
    try {
      const raw = await readFile(join(cwd, name), 'utf-8')
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
      const tsconfig = JSON.parse(stripped) as {
        compilerOptions?: {
          paths?: Record<string, string[]>
          baseUrl?: string
          strict?: boolean
          noImplicitAny?: boolean
          noUncheckedIndexedAccess?: boolean
          exactOptionalPropertyTypes?: boolean
          strictNullChecks?: boolean
          target?: string
          jsx?: string
        }
      }
      const opts = tsconfig.compilerOptions
      if (!opts) continue

      const lines: string[] = []

      // Strictness flags — critical for the AI to know what type safety is enforced
      const strictFlags = [
        opts.strict && 'strict',
        opts.noImplicitAny && 'noImplicitAny',
        opts.strictNullChecks && 'strictNullChecks',
        opts.noUncheckedIndexedAccess && 'noUncheckedIndexedAccess',
        opts.exactOptionalPropertyTypes && 'exactOptionalPropertyTypes',
      ].filter(Boolean) as string[]
      if (strictFlags.length) lines.push(`Strict flags: ${strictFlags.join(', ')}`)
      if (opts.target) lines.push(`target: "${opts.target}"`)
      if (opts.jsx) lines.push(`jsx: "${opts.jsx}"`)

      // Path aliases
      if (opts.baseUrl) lines.push(`baseUrl: "${opts.baseUrl}"`)
      if (opts.paths) {
        for (const [alias, targets] of Object.entries(opts.paths)) {
          lines.push(`  "${alias}" → "${targets[0]}"`)
        }
      }

      if (lines.length === 0) continue
      return lines.join('\n')
    } catch { /* try next */ }
  }
  return null
}

// Lightweight context for fix-loop: reads mocks/setup/deps/tsconfig relative to
// the actual test file path. Does NOT call inferTestFilePath or findExistingTestFile
// (which would compute wrong paths and create spurious __tests__/ directories).
export async function buildFixFileContext(
  absTestPath: string,
  cwd: string,
  config?: LacunaConfig,
): Promise<Pick<FileContext, 'mocksCode' | 'mocksImportPath' | 'setupFileCode' | 'packageDeps' | 'tsconfigPaths'>> {
  let mocksCode: string | null = null
  let mocksImportPath: string | null = null
  if (config?.mocksFile) {
    const absoluteMocks = join(cwd, config.mocksFile)
    mocksImportPath = relativeMockPath(absTestPath, absoluteMocks)
    try {
      mocksCode = await readFile(absoluteMocks, 'utf-8')
    } catch { /* mocks file not created yet — AI will create it */ }
  }

  let setupFileCode: string | null = null
  if (config?.setupFile) {
    try {
      setupFileCode = await readFile(join(cwd, config.setupFile), 'utf-8')
    } catch { /* setup file not found */ }
  }

  const [packageDeps, tsconfigPaths] = await Promise.all([
    readPackageDeps(cwd),
    readTsconfigPaths(cwd),
  ])

  return { mocksCode, mocksImportPath, setupFileCode, packageDeps, tsconfigPaths }
}

export async function buildFileContext(
  sourceFilePath: string,
  cwd: string,
  env: DetectedEnvironment,
  config?: LacunaConfig,
): Promise<FileContext> {
  const absoluteSource = join(cwd, sourceFilePath)
  const sourceCode = await readFile(absoluteSource, 'utf-8')

  const srcDirs = config?.sourceDir ? (Array.isArray(config.sourceDir) ? config.sourceDir : [config.sourceDir]) : ['src']
  const existingTestFile = await findExistingTestFile(sourceFilePath, cwd, srcDirs)
  const existingTestCode = existingTestFile ? await readFile(existingTestFile, 'utf-8') : null

  const suggestedTestFile =
    existingTestFile ?? join(cwd, await inferTestFilePath(sourceFilePath, cwd, env, srcDirs))

  const sourceImportPath = computeRelativeImport(suggestedTestFile, absoluteSource)

  let mocksCode: string | null = null
  let mocksImportPath: string | null = null
  if (config?.mocksFile) {
    const absoluteMocks = join(cwd, config.mocksFile)
    // Always compute the import path — even if the file doesn't exist yet,
    // the AI needs to know where to create/import it from.
    mocksImportPath = relativeMockPath(suggestedTestFile, absoluteMocks)
    try {
      mocksCode = await readFile(absoluteMocks, 'utf-8')
    } catch { /* file not created yet — AI will create it */ }
  }

  let setupFileCode: string | null = null
  if (config?.setupFile) {
    try {
      setupFileCode = await readFile(join(cwd, config.setupFile), 'utf-8')
    } catch { /* setup file not found — skip */ }
  }

  const [packageDeps, tsconfigPaths, typeDefinitions, localImportPaths, localImportContents, reactMajorVersion] = await Promise.all([
    readPackageDeps(cwd),
    readTsconfigPaths(cwd),
    collectTypeDefinitions(sourceCode, absoluteSource, cwd),
    collectLocalImportPaths(sourceCode, absoluteSource, suggestedTestFile, cwd),
    collectUsedSymbolsContext(sourceCode, absoluteSource, cwd),
    detectReactMajorVersion(cwd),
  ])

  return {
    sourceFile: sourceFilePath,
    sourceCode,
    existingTestFile,
    existingTestCode,
    suggestedTestFile,
    sourceImportPath,
    mocksCode,
    mocksImportPath,
    setupFileCode,
    packageDeps,
    tsconfigPaths,
    typeDefinitions,
    localImportPaths,
    localImportContents,
    reactMajorVersion,
  }
}
