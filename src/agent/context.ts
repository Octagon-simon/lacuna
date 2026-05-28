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

  const [packageDeps, tsconfigPaths] = await Promise.all([
    readPackageDeps(cwd),
    readTsconfigPaths(cwd),
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
  }
}
