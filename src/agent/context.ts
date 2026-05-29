import { readFile, access, mkdir } from 'fs/promises'
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

async function inferTestFilePath(
  sourceFile: string,
  cwd: string,
  env: DetectedEnvironment,
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

  const testsDir = join(cwd, dir, '__tests__')
  await mkdir(testsDir, { recursive: true })
  return join(dir, '__tests__', `${base}.test${ext}`)
}

async function findExistingTestFile(sourceFile: string, cwd: string): Promise<string | null> {
  const ext = extname(sourceFile)
  const base = basename(sourceFile, ext)
  const dir = dirname(sourceFile)

  const candidates = [
    ...TEST_SUFFIXES.map((s) => join(cwd, dir, '__tests__', `${base}${s}${ext}`)),
    ...TEST_SUFFIXES.map((s) => join(cwd, dir, `${base}${s}${ext}`)),
    join(cwd, dir, `test_${base}${ext}`),
    join(cwd, dir, `${base}_test${ext}`),
  ]

  for (const candidate of candidates) {
    try {
      await readFile(candidate)
      return candidate
    } catch { /* not found */ }
  }
  return null
}

function relativeMockPath(testFile: string, mockFile: string): string {
  const rel = relative(dirname(testFile), mockFile)
  return rel.startsWith('.') ? rel : `./${rel}`
}

// ─── Type definition collector ────────────────────────────────────────────────

async function readTsconfigAliases(cwd: string): Promise<Record<string, string[]>> {
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json']
  for (const name of candidates) {
    try {
      const raw = await readFile(join(cwd, name), 'utf-8')
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
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

// Find the actual file by trying common extensions on a base path.
async function resolveToFile(basePath: string): Promise<string | null> {
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
    try { await access(basePath + suffix); return basePath + suffix } catch { /* try next */ }
  }
  return null
}

// Extract exported interface/type/enum declarations via brace-depth tracking.
// Only captures the declarations themselves — not function bodies, classes, or constants.
function extractTypeDeclarations(code: string): string {
  const lines = code.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*export\s+(interface|type|enum)\s+\w+/.test(line)) {
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

const MAX_TYPE_FILES = 10
const MAX_TYPE_CHARS = 4000

// Scans a source file's imports and follows them transitively (BFS) to collect
// interface/type/enum declarations from any locally-defined types they reference.
// Stops at MAX_TYPE_FILES files or MAX_TYPE_CHARS characters to stay prompt-safe.
export async function collectTypeDefinitions(
  sourceCode: string,
  absoluteSourcePath: string,
  cwd: string,
): Promise<string | null> {
  const aliases = await readTsconfigAliases(cwd)

  // BFS: each entry is a file whose imports we still need to follow.
  // Start with the source file itself so we traverse its direct imports first.
  const toFollow: Array<{ code: string; absolutePath: string }> = [
    { code: sourceCode, absolutePath: absoluteSourcePath },
  ]
  // Mark the source file visited so we never re-process it as a type file.
  const visited = new Set<string>([absoluteSourcePath])

  const blocks: string[] = []
  let totalChars = 0

  while (toFollow.length > 0 && blocks.length < MAX_TYPE_FILES && totalChars < MAX_TYPE_CHARS) {
    const { code, absolutePath } = toFollow.shift()!

    for (const m of code.matchAll(/^import(?:\s+type)?\s[^'"]*['"]([^'"]+)['"]/gm)) {
      if (blocks.length >= MAX_TYPE_FILES || totalChars >= MAX_TYPE_CHARS) break

      const base = resolveLocalImport(m[1], absolutePath, cwd, aliases)
      if (!base) continue

      const file = await resolveToFile(base)
      if (!file || visited.has(file)) continue
      visited.add(file)

      let content: string
      try { content = await readFile(file, 'utf-8') } catch { continue }

      // Collect type declarations from this file (if any)
      const declarations = extractTypeDeclarations(content)
      if (declarations) {
        const block = `// from ${relative(cwd, file)}\n${declarations}`
        blocks.push(block)
        totalChars += block.length
      }

      // Always follow this file's imports too — it might re-export types from
      // deeper files even if it has no declarations of its own.
      toFollow.push({ code: content, absolutePath: file })
    }
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

  for (const m of sourceCode.matchAll(/^import(?:\s+type)?\s[^'"]*['"]([^'"]+)['"]/gm)) {
    const importPath = m[1]
    const base = resolveLocalImport(importPath, absoluteSourcePath, cwd, aliases)
    if (!base) continue  // skip node_modules

    const file = await resolveToFile(base)
    if (!file || seen.has(file)) continue
    seen.add(file)

    const rel = computeRelativeImport(absoluteTestFilePath, file)
    results.push(rel)
  }

  return results.length > 0 ? results : null
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

  const existingTestFile = await findExistingTestFile(sourceFilePath, cwd)
  const existingTestCode = existingTestFile ? await readFile(existingTestFile, 'utf-8') : null

  const suggestedTestFile =
    existingTestFile ?? join(cwd, await inferTestFilePath(sourceFilePath, cwd, env))

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

  const [packageDeps, tsconfigPaths, typeDefinitions, localImportPaths, reactMajorVersion] = await Promise.all([
    readPackageDeps(cwd),
    readTsconfigPaths(cwd),
    collectTypeDefinitions(sourceCode, absoluteSource, cwd),
    collectLocalImportPaths(sourceCode, absoluteSource, suggestedTestFile, cwd),
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
    reactMajorVersion,
  }
}
