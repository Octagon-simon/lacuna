import type { DetectedEnvironment } from '../lib/detector.js'
import { buildSourceSkeleton, shouldUseSkeleton } from '../lib/skeleton.js'

// Extracts module names that are already globally mocked in the setup file.
// Used to tell the agent "don't mock these again" to avoid double-mock conflicts.
function extractGlobalNextMocks(setupCode: string): string[] {
  const mocked: string[] = []
  for (const m of setupCode.matchAll(/vi\.mock\(['"]([^'"]+)['"]/g)) {
    mocked.push(m[1])
  }
  return [...new Set(mocked)]
}

// ─── Next.js import analyser ─────────────────────────────────────────────────
// Detects Next.js-specific imports that Vitest cannot resolve without mocking.

interface NextJsAnalysis {
  hasNavigation: boolean           // next/navigation (useRouter, usePathname, etc.)
  hasHeaders: boolean              // next/headers (cookies, headers — server-only)
  hasCache: boolean                // next/cache (unstable_cache, revalidatePath, etc.)
  clientModules: string[]          // imports ending in .client — Next.js client boundary
  serverModules: string[]          // imports ending in .server — Next.js server boundary
  sessionProviders: string[]       // imports from */providers/*session* or useSession patterns
}

function analyzeNextJs(sourceCode: string): NextJsAnalysis {
  const hasNavigation = /from\s+['"]next\/navigation['"]/.test(sourceCode)
  const hasHeaders    = /from\s+['"]next\/headers['"]/.test(sourceCode)
  const hasCache      = /from\s+['"]next\/cache['"]/.test(sourceCode)

  const clientModules: string[] = []
  for (const m of sourceCode.matchAll(/from\s+['"]([^'"]+\.client)['"]/g)) clientModules.push(m[1])

  const serverModules: string[] = []
  for (const m of sourceCode.matchAll(/from\s+['"]([^'"]+\.server)['"]/g)) serverModules.push(m[1])

  const sessionProviders: string[] = []
  for (const m of sourceCode.matchAll(/from\s+['"]([^'"]*(?:session|auth)[^'"]*)['"]/gi)) {
    const p = m[1]
    if (!p.startsWith('next-auth') && !p.startsWith('@auth')) sessionProviders.push(p)
  }

  return { hasNavigation, hasHeaders, hasCache, clientModules, serverModules, sessionProviders }
}

function buildNextJsGuidance(a: NextJsAnalysis): string | null {
  if (!a.hasNavigation && !a.hasHeaders && !a.hasCache && !a.clientModules.length && !a.serverModules.length && !a.sessionProviders.length) return null

  const lines: string[] = [
    'NEXT.JS MOCKING (critical — Vitest cannot resolve these modules without explicit mocks):',
  ]

  if (a.hasNavigation) {
    lines.push(
      "Mock next/navigation — required for any component that uses useRouter, usePathname, useSearchParams, or useParams (skip if already listed as globally mocked above):",
      "  vi.mock('next/navigation', () => ({",
      "    useRouter:       vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() })),",
      "    usePathname:     vi.fn(() => '/'),",
      "    useSearchParams: vi.fn(() => new URLSearchParams()),",
      "    useParams:       vi.fn(() => ({})),",
      "    redirect:        vi.fn(),",
      "  }))",
    )
  }

  if (a.hasHeaders) {
    lines.push(
      "Mock next/headers — it is server-only and will throw in Vitest:",
      "  vi.mock('next/headers', () => ({",
      "    cookies:  vi.fn(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn(), has: vi.fn() })),",
      "    headers:  vi.fn(() => new Headers()),",
      "  }))",
    )
  }

  if (a.hasCache) {
    lines.push(
      "Mock next/cache — revalidatePath, revalidateTag, unstable_cache are no-ops in tests:",
      "  vi.mock('next/cache', () => ({",
      "    revalidatePath:  vi.fn(),",
      "    revalidateTag:   vi.fn(),",
      "    unstable_cache:  vi.fn((fn: () => unknown) => fn),",
      "  }))",
    )
  }

  if (a.clientModules.length > 0) {
    lines.push(
      `The source imports .client boundary files that Vitest cannot resolve: ${a.clientModules.join(', ')}`,
      "Mock each one by its EXACT import path as it appears in the source file. Export every function the source uses as a vi.fn():",
      ...a.clientModules.map(p => `  vi.mock('${p}', () => ({ /* each exported function: myFn: vi.fn() */ }))`),
      "Do not try to import the real .client file — it will always fail in Vitest.",
    )
  }

  if (a.serverModules.length > 0) {
    lines.push(
      `The source imports .server boundary files that Vitest cannot resolve: ${a.serverModules.join(', ')}`,
      "Mock each one the same way as .client files:",
      ...a.serverModules.map(p => `  vi.mock('${p}', () => ({ /* each exported function: myFn: vi.fn() */ }))`),
    )
  }

  if (a.sessionProviders.length > 0) {
    lines.push(
      `The source imports session/auth providers: ${a.sessionProviders.join(', ')}`,
      "Mock them and return a controlled session object:",
      `  vi.mock('${a.sessionProviders[0]}', () => ({`,
      "    useSession: vi.fn(() => ({ user: { id: 'user-1', email: 'test@example.com' }, status: 'authenticated' })),",
      "    getSession: vi.fn(() => Promise.resolve({ user: { id: 'user-1' } })),",
      "  }))",
    )
  }

  lines.push(
    "If Vitest still reports 'Failed to resolve import', the mock path does not exactly match the import in the source. Copy it character-for-character.",
  )

  return lines.join('\n')
}

// ─── Network dependency analyser ─────────────────────────────────────────────
// Scans source code and returns guidance the AI must follow to avoid real requests.

interface NetworkAnalysis {
  usesAxios: boolean
  usesFetch: boolean
  usesCustomInstance: boolean   // axios.create() detected — direct vi.mock('axios') won't work
  apiModuleImports: string[]    // local imports from api/service/request directories
}

// Matches both directory-level patterns (/api/, /services/) and file-level names
// (../../lib/api, ../apiClient, ./httpService) so axios instance files aren't missed.
const API_IMPORT_RE = /\/(?:api|services?|requests?|http|client|network)\/|\/(?:api|axios|http|request)(?:Client|Config|Instance|Service|Helper)?(?:\/|$)|[/.]api(?:[./]|$)/i

function analyzeNetworkDeps(sourceCode: string): NetworkAnalysis {
  const usesAxios = /\baxios\b/.test(sourceCode)
  const usesFetch = /\bfetch\s*\(/.test(sourceCode)
  const usesCustomInstance = /axios\.create\s*\(/.test(sourceCode)

  // Collect local imports from paths that look like API/service modules
  const apiModuleImports: string[] = []
  for (const m of sourceCode.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const path = m[1]
    if (API_IMPORT_RE.test(path)) {
      apiModuleImports.push(path)
    }
  }

  return { usesAxios, usesFetch, usesCustomInstance, apiModuleImports }
}

// Detects thinking-bleed parse errors: model wrote reasoning inside <code_output>
// causing the file to start with prose instead of TypeScript.
function detectThinkingBleed(errorOutput: string): string | null {
  // Vitest/esbuild parse errors at line 1 with non-code content are a strong signal
  const parseErr = errorOutput.match(/PARSE_ERROR|Unexpected token|SyntaxError.*\b1:\d+\b/)
  if (!parseErr) return null
  // Check if the error context shows non-TypeScript at the file start
  const contextLine = errorOutput.match(/^\s*1\s*[│|]\s*(.+)/m)
  if (!contextLine) return null
  const firstLine = contextLine[1].trim()
  // If first line looks like prose (no import/export/const/vi./etc.)
  if (/^(import|export|const|let|var|\/\/|\/\*|describe|it\s*\(|test\s*\(|vi\.|jest\.)/.test(firstLine)) return null
  return [
    `THINKING BLEED DETECTED — your previous response had reasoning text inside <code_output>.`,
    `The file started with: "${firstLine.slice(0, 80)}"`,
    `This is not valid TypeScript and caused a parse error at line 1.`,
    `RULE: finish ALL reasoning inside <thinking> first. Once <code_output> opens, the very first character must be valid code — an import, function definition, comment (//, #), or similar construct for the project's language.`,
    `Do NOT continue thinking inside <code_output> under any circumstances.`,
  ].join('\n')
}

// Scans error output for Next.js import resolution failures (Failed to resolve import).
function detectNextJsImportError(errorOutput: string): string | null {
  const failedImport = errorOutput.match(/Failed to resolve import "([^"]+)"/)
  if (!failedImport) return null

  const importPath = failedImport[1]
  const isAlias = importPath.startsWith('@/')
  const isClient = importPath.endsWith('.client')
  const isServer = importPath.endsWith('.server')
  const isNextInternal = importPath.startsWith('next/')
  const isProviderOrSession = /session|auth|provider/i.test(importPath)

  if (!isAlias && !isClient && !isServer && !isNextInternal && !isProviderOrSession) return null

  const lines = [
    `IMPORT RESOLUTION ERROR — Vitest cannot resolve "${importPath}".`,
  ]

  if (isAlias) {
    lines.push(
      `The "@/" alias is not configured in vitest.config.ts — you cannot fix this by changing the test file.`,
      `WORKAROUND: use the pre-computed relative paths from LOCAL IMPORT PATHS in your vi.mock() calls instead of "@/" paths.`,
      `  WRONG:   vi.mock('@/components/ui/button', ...)`,
      `  CORRECT: vi.mock('../../../components/ui/button', ...)  ← use the relative path from LOCAL IMPORT PATHS`,
      `Do NOT attempt to add resolve aliases inside the test file — that does not work.`,
      `Do NOT switch import statements to relative paths — only vi.mock() calls need to change.`,
    )
  } else if (isClient || isServer) {
    lines.push(
      `This is a Next.js ${isClient ? 'client' : 'server'} boundary file. Vitest never resolves these — mock it with the exact import path from the source file:`,
      `  vi.mock('${importPath}', () => ({`,
      `    // each function the source imports: myFn: vi.fn()`,
      `  }))`,
    )
  } else if (isNextInternal) {
    lines.push(
      `${importPath} is a Next.js internal that does not work in Vitest. Mock it:`,
      `  vi.mock('${importPath}', () => ({ /* relevant exports as vi.fn() */ }))`,
    )
  } else if (isProviderOrSession) {
    lines.push(
      `This looks like a session or auth provider that Vitest cannot resolve. Mock it:`,
      `  vi.mock('${importPath}', () => ({`,
      `    useSession: vi.fn(() => ({ user: { id: 'user-1', email: 'test@example.com' }, status: 'authenticated' })),`,
      `  }))`,
    )
  }

  return lines.join('\n')
}

// Scans error output for an unhandled rejection caused by mockRejectedValueOnce.
// Vitest surfaces this as a top-level "Unhandled Rejection" or "Vitest caught N unhandled error(s)"
// even when the component catches the error internally — the test never awaited the error state.
function detectUnhandledRejection(errorOutput: string): string | null {
  const hasUnhandled = /unhandled\s+(promise\s+)?rejection|vitest caught \d+ unhandled/i.test(errorOutput)
  const hasRejectedMock = /mockRejectedValue(Once)?/.test(errorOutput)

  if (!hasUnhandled && !hasRejectedMock) return null

  return [
    'UNHANDLED REJECTION DETECTED — a mockRejectedValueOnce (or mockRejectedValue) promise is escaping the test scope.',
    'The component may catch the error internally, but Vitest still requires the rejection to be resolved inside the test.',
    'Required fix: after the action that triggers the rejection, await the resulting error state:',
    "  await waitFor(() => expect(screen.getByText(/error text/i)).toBeInTheDocument())",
    'This chains the rejection inside the test scope. Without it, Vitest flags it as unhandled even if the UI handles it correctly.',
  ].join('\n')
}

// Scans error output for signs that a real HTTP request leaked through.
function detectRealRequestInError(errorOutput: string): string | null {
  const hasRealUrl = /https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(errorOutput)
  const hasHttpStatus = /\bstatus:\s*[45]\d\d\b/.test(errorOutput)
  const hasNetworkError = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network\s+error/i.test(errorOutput)

  if (!hasRealUrl && !hasHttpStatus && !hasNetworkError) return null

  const lines = [
    'REAL HTTP REQUEST DETECTED — the test is hitting the actual network. This is the root cause of the failure.',
    'A mock is either missing entirely or applied at the wrong level. Fix this before anything else.',
  ]

  const urlMatch = errorOutput.match(/https?:\/\/[^\s,'")\]}]+/)
  if (urlMatch) lines.push(`Intercepted URL: ${urlMatch[0]}`)

  lines.push(
    'Required fix: find which module the source file imports for its API calls and mock THAT module.',
    "vi.mock('axios') does NOT intercept axios.create() instances — you must mock the module that exports the instance or the service layer above it.",
  )

  return lines.join('\n')
}

function buildNetworkMockingGuidance(analysis: NetworkAnalysis, sourceFile: string): string | null {
  if (!analysis.usesAxios && !analysis.usesFetch && analysis.apiModuleImports.length === 0) {
    return null
  }

  const lines: string[] = [
    'NETWORK MOCKING (critical — a real HTTP request reaching the network is a test bug):',
  ]

  if (analysis.apiModuleImports.length > 0) {
    lines.push(
      `The source file imports from API/service modules: ${analysis.apiModuleImports.join(', ')}`,
      `Mock THOSE modules, not the underlying HTTP client:`,
      `  vi.mock('${analysis.apiModuleImports[0]}', () => ({ myFn: vi.fn() }))`,
      `This is the most reliable approach — it intercepts at the contract boundary regardless of which HTTP client is used underneath.`,
    )
  }

  if (analysis.usesCustomInstance) {
    lines.push(
      `The source creates a custom axios instance (axios.create()). vi.mock('axios') alone WILL NOT intercept calls made through a custom instance.`,
      `Instead: mock the module that exports the axios instance, or mock the API service module that wraps it.`,
    )
  } else if (analysis.usesAxios && analysis.apiModuleImports.length === 0) {
    lines.push(
      `The source imports axios directly. Mock it with: vi.mock('axios') and set return values with axios.get.mockResolvedValue({ data: ... })`,
    )
  }

  if (analysis.usesFetch) {
    lines.push(
      `The source uses fetch. Mock it with: vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(data)))`,
    )
  }

  lines.push(
    `If you see a real URL (e.g. https://...) or a 401/403/network error in the test output, your mock is missing or at the wrong module level. Fix it before the test can pass.`,
  )

  return lines.join('\n')
}

// Extract exported names from a mocks file so the AI sees a concrete inventory.
function parseMockExports(code: string): string[] {
  const names: string[] = []
  // export const/let/var/function/class/async function name
  for (const m of code.matchAll(/^export\s+(?:const|let|var|function|class|async\s+function)\s+(\w+)/gm)) {
    names.push(m[1])
  }
  // export { name1, name2 as alias2, ... }
  for (const m of code.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (alias && /^\w+$/.test(alias)) names.push(alias)
    }
  }
  // export default identifier
  const defM = code.match(/^export\s+default\s+(\w+)/m)
  if (defM) names.push(`default (${defM[1]})`)
  return [...new Set(names)]
}

export function buildSystemPrompt(env: DetectedEnvironment): string {
  return `You are a senior QA engineer with 10+ years of experience writing production test suites for ${env.language} projects. You use ${env.testRunner} and you take testing seriously.

Your tests catch real bugs. You think about what could go wrong — null inputs, empty arrays, async race conditions, error boundaries, permission checks, off-by-one errors — and you write assertions that would actually fail if the code broke. You never write a test just to hit a coverage number.

RULES — follow every one:
1. Write tests that verify real behavior: correctness, edge cases, boundary values, and error handling. Never write empty or trivial assertions (e.g. expect(true).toBe(true)).
2. Match the EXACT import style shown in the existing test file or PROJECT TEST EXAMPLES. If none exists, use the style from the source file.
3. Use path aliases from the PROJECT TYPESCRIPT CONFIG section in IMPORT statements (e.g. "@/components/Button" not "../../components/Button").
   EXCEPTION — vi.mock() call paths: use the exact same path string that appears in the SOURCE FILE'S import statement.
   If a LOCAL IMPORT PATHS section is provided, use those pre-computed relative paths in vi.mock() calls — they are the fallback when aliases cannot be resolved by Vitest.
   Never second-guess the pre-computed paths. Never convert them back to @/ aliases in vi.mock() calls.
4. Only import from packages listed in PROJECT DEPENDENCIES. Do not invent packages that are not listed.
5. When a SHARED MOCK FILE is provided, its exported names are listed under "Available exports". Before writing the test, go through that list and identify every mock that relates to what the source file does (by name, type, or domain). Import and use ALL of those mocks. Never re-create inline vi.fn() / jest.fn() for anything already exported from the mocks file.
   CRITICAL — never rename or change the casing of existing mock exports. If the mocks file has mockValidationError, use exactly mockValidationError — do NOT change it to MockValidationError or any other variant. Renaming an existing mock breaks every test that already imports it by the original name.
6. If you need a mock that is missing from the shared mock file, add it to that file AND import it in the test. Return BOTH files separated by exactly one line containing only: // ---MOCKS_FILE---
7. If a SHARED MOCK FILE (does not exist yet) section is shown — create it for any mocks you need and return it using the // ---MOCKS_FILE--- separator.
   CRITICAL — the mocks file must contain ONLY: vi.fn()/jest.fn() mock definitions, vi.mock() module stubs, shared mock objects/constants, and beforeEach reset hooks. NEVER write describe(), it(), test(), or expect() calls in the mocks file. Those belong exclusively in the test file. A mocks file that contains test blocks will break the entire test suite.
8. If a TEST SETUP FILE is shown, assume its globals and matchers are already available (e.g. expect(...).toBeInTheDocument()). Do NOT import or re-declare them.
9. TypeScript type safety: all test code must compile without type errors.
   - Check PROJECT TYPESCRIPT CONFIG for strict flags — if strict or noImplicitAny is set, every value must be properly typed.
   - Never use "as any", "@ts-ignore", or "@ts-expect-error" to suppress type errors. Use proper types or generics instead.
   - For vi.fn() / jest.fn(), either let TypeScript infer the type from context or type it explicitly: vi.fn<Parameters<typeof fn>, ReturnType<typeof fn>>().
   - Use ReturnType<>, Parameters<>, and other utility types to derive mock types from the real function signatures rather than guessing.
   - When accessing optional properties, handle null/undefined correctly — do not assume they exist if the type says otherwise.
10. Every test file MUST contain at least one it() or test() call with real assertions. A file with only imports, describe() blocks, types, or helper functions is invalid and will be rejected. If you cannot write meaningful tests, write a minimal test that exercises the simplest exported function.
11. Structure ALL output using exactly these two XML blocks — nothing before, nothing after:
    <thinking>
    1. WHAT IS NEEDED: What functions/behaviors are untested or broken?
    2. COMPONENT RENDER MAP (React components only): Before writing any assertion, list what is in the DOM in each relevant state (idle / loading / error / success). Read the JSX — check every ternary, &&, and switch — to determine whether a button is disabled vs unmounted, what text changes, what elements appear. Never assume a button is disabled during loading without verifying this in the JSX.
    3. WHY IT FAILED (retries only): What is the structural root cause — wrong mock level, missing await, bad import path, type mismatch?
    4. PLAN: List the exact steps you will take before writing a single line of code.
    </thinking>
    <code_output>
    // complete test file here
    </code_output>
    CRITICAL: Once you open <code_output>, ALL remaining output must be code. Never continue reasoning, writing bullet points,
    or restating the problem inside <code_output>. If you are still uncertain, finish your reasoning inside <thinking> first,
    then commit to a solution and write only code inside <code_output>. Thinking inside <code_output> corrupts the output file.
12. Inside <code_output>: do NOT wrap in markdown code fences.
13. Inside <code_output>: output ONLY the test file content (or test file // ---MOCKS_FILE--- mocks file).
    If you use // ---MOCKS_FILE---, everything AFTER the separator is the mocks file. The mocks file must contain ONLY:
    vi.fn()/jest.fn() mock definitions, vi.mock() module stubs, shared constants, and beforeEach resets.
    NEVER put describe(), it(), test(), or expect() calls after the separator — those belong BEFORE it, in the test file.
    Writing test blocks in the mocks section corrupts the shared mock file for every other test in the project.
14. NEVER output vitest.config.ts, jest.config.js, or any framework configuration. If an import cannot be resolved,
    fix it by mocking it with vi.mock() — NOT by modifying the test runner configuration. You cannot modify config
    files from here, and outputting them will cause the entire mocks file to be discarded.

A good test suite you write will have:
- A happy-path test that confirms the main behavior works
- At least one edge-case test per function (empty input, zero, null, boundary values)
- Error-path tests for any function that throws, rejects, or returns an error state
- Async tests properly awaited — never fire-and-forget
- Clear, descriptive test names that read like a spec ("returns null when user is not authenticated")

Common failure causes to avoid:
- Wrong import paths (use aliases, not relative ../../ paths if the project uses aliases)
- Importing from test utils that are not in the dependency list
- Mocking modules that are already mocked in the setup file
- Using browser globals without jsdom (only use them if the setup file configures jsdom)
- Forgetting to await async functions
- React 18 act() async rule: ALWAYS await act() when it wraps async code — \`await act(async () => { ... })\`. Never store an unawaited act() call in a variable like \`const promise = act(async () => ...)\` without immediately awaiting it. Unawaited act() calls cause React state updates to leak into subsequent tests, producing cascading timeout failures and "Cannot read properties of null" errors in unrelated tests.
- vi.mock() paths are relative to the TEST FILE, not the source file. If the test is at src/features/auth/__tests__/Login.test.tsx and you need to mock src/components/Button, the mock path is ../../../components/Button — count directories from the TEST file's location, not the source file's.
- Loading state architecture: before asserting that a button is disabled during loading, check whether the component hides the button entirely and replaces it with a spinner. If the button is unmounted during loading rather than disabled, \`getByText("Submit")\` will throw — test for the spinner instead, or use \`queryByText("Submit")\` with a null assertion.
- Unhandled promise rejections: when testing error paths with mockRejectedValueOnce, the rejection must be fully resolved inside the test. After triggering the action, always use await waitFor(() => expect(errorElement).toBeInTheDocument()) to tie the rejection to the test scope. Never let a rejected mock promise go unawaited — Vitest will flag it as an unhandled error even if the component catches it internally.
- Real HTTP requests: NEVER let a real network call reach the internet. If you see a real URL (https://...), a 401/403 error, or a network timeout in test output, your mock is missing or at the wrong level. Every function that calls an API must be mocked before the test runs.
- Barrel file vi.mock() resolution: if a module is exported from a barrel/index file (e.g. src/components/index.ts re-exports Foo from ./Foo), mock the DIRECT file path, not the barrel. vi.mock('../components') mocks the barrel but the component may import directly from '../components/Foo' — making the mock miss. Always mock the specific module the source file actually imports. If unsure, mock both the direct file AND the barrel.

Test file pattern for this project: ${env.testFilePattern}

You MUST wrap your reasoning inside <thinking> tags and your complete file output inside <code_output> tags. Do not output anything outside of these two tags.`
}

export function buildGeneratePrompt(args: {
  sourceFile: string
  sourceCode: string
  existingTestCode: string | null
  uncoveredFunctions: string[]
  uncoveredLines: number[]
  env: DetectedEnvironment
  sourceImportPath?: string | null
  mocksCode?: string | null
  mocksImportPath?: string | null
  setupFileCode?: string | null
  packageDeps?: string | null
  tsconfigPaths?: string | null
  typeDefinitions?: string | null
  localImportPaths?: string[] | null
  reactMajorVersion?: number | null
  projectMemory?: string | null
}): string {
  const {
    sourceFile,
    sourceCode,
    existingTestCode,
    uncoveredFunctions,
    uncoveredLines,
    sourceImportPath,
    mocksCode,
    mocksImportPath,
    setupFileCode,
    packageDeps,
    tsconfigPaths,
    typeDefinitions,
    localImportPaths,
    reactMajorVersion,
    projectMemory,
  } = args

  const parts: string[] = []

  if (projectMemory) {
    parts.push(projectMemory)
    parts.push('')
  }

  if (packageDeps) {
    parts.push('PROJECT DEPENDENCIES (only import from these):')
    parts.push('```')
    parts.push(packageDeps)
    parts.push('```')
  }

  if (reactMajorVersion !== null && reactMajorVersion !== undefined && reactMajorVersion >= 18) {
    parts.push(`\nREACT ${reactMajorVersion} DETECTED — act() async rule: every act(async () => { ... }) call MUST be awaited. Never assign an unawaited act() to a variable. Unawaited act() leaks state updates into subsequent tests, causing cascading failures and null-read errors in unrelated tests.`)
  }

  if (tsconfigPaths) {
    parts.push('\nPROJECT TYPESCRIPT CONFIG (strict flags, target, and path aliases — follow these exactly):')
    parts.push(tsconfigPaths)
  }

  if (localImportPaths && localImportPaths.length > 0) {
    parts.push('\nLOCAL IMPORT PATHS (pre-computed relative to the test file — use EXACTLY these strings in vi.mock() calls, even if the source file uses @/ aliases. Vitest resolves vi.mock() paths relative to the test file, not via tsconfig aliases. Do NOT convert these back to @/ paths in vi.mock(). Do NOT recount directory levels yourself.):')
    for (const p of localImportPaths) parts.push(`  ${p}`)
  }

  if (typeDefinitions) {
    parts.push('\nTYPE DEFINITIONS (exported from files the source imports — use these exact shapes, do NOT invent properties or guess types):')
    parts.push('```typescript')
    parts.push(typeDefinitions)
    parts.push('```')
  }

  if (setupFileCode) {
    const nextMocked = extractGlobalNextMocks(setupFileCode)
    const setupNote = nextMocked.length > 0
      ? `\nTEST SETUP FILE (already loaded before every test — do NOT import it again):\nThe following modules are ALREADY mocked globally in this setup file — do NOT add vi.mock() for them in the test: ${nextMocked.join(', ')}`
      : `\nTEST SETUP FILE (already loaded before every test — do NOT import it again):`
    parts.push(setupNote)
    parts.push('```')
    parts.push(setupFileCode)
    parts.push('```')
  }

  if (mocksImportPath) {
    if (mocksCode) {
      const exports = parseMockExports(mocksCode)
      parts.push(`\nSHARED MOCK FILE (import from: '${mocksImportPath}')`)
      if (exports.length > 0) {
        parts.push(`Available exports: ${exports.join(', ')}`)
        parts.push(`↑ Before writing the test, identify which of these match the source file's domain and import every relevant one. Do NOT create inline mocks for anything already in this list.\n↑ NAMES ARE FROZEN — use each export exactly as spelled above. Never rename, recase, or restructure an existing mock (e.g. do not change mockFoo → MockFoo or const → class). Renaming breaks every other test that imports the original name.`)
      }
      parts.push('```')
      parts.push(mocksCode)
      parts.push('```')
    } else {
      parts.push(`\nSHARED MOCK FILE (does not exist yet) — create it if you need mocks, return it via the // ---MOCKS_FILE--- separator. Path: '${mocksImportPath}'\n⚠ Mocks file must contain ONLY vi.fn()/vi.mock() definitions and beforeEach resets — NEVER describe/it/test/expect blocks.`)
    }
  }

  const networkGuidance = buildNetworkMockingGuidance(analyzeNetworkDeps(sourceCode), sourceFile)
  if (networkGuidance) parts.push(`\n${networkGuidance}`)

  const nextGuidance = buildNextJsGuidance(analyzeNextJs(sourceCode))
  if (nextGuidance) parts.push(`\n${nextGuidance}`)

  const displaySource = buildSourceSkeleton(sourceCode, uncoveredFunctions)
  const skeletonized = shouldUseSkeleton(sourceCode)
  parts.push(`\nSOURCE FILE: ${sourceFile}${skeletonized ? ' (large file — bodies of already-covered functions collapsed; uncovered functions shown in full)' : ''}`)
  if (sourceImportPath) {
    parts.push(`SOURCE FILE IMPORT PATH: when importing the source in your test file, use exactly: '${sourceImportPath}'`)
  }
  parts.push('```')
  parts.push(displaySource)
  parts.push('```')

  if (existingTestCode) {
    parts.push('\nEXISTING TEST FILE (preserve all existing tests, only add new ones):')
    parts.push('```')
    parts.push(existingTestCode)
    parts.push('```')
  } else {
    parts.push('\nNo existing test file — create one from scratch.')
  }

  if (uncoveredFunctions.length > 0) {
    parts.push(`\nUNCOVERED FUNCTIONS (must write tests for these): ${uncoveredFunctions.join(', ')}`)
  }

  if (uncoveredLines.length > 0) {
    parts.push(`\nUNCOVERED LINES: ${uncoveredLines.slice(0, 30).join(', ')}${uncoveredLines.length > 30 ? '…' : ''}`)
  }

  parts.push('\nWrite the complete test file now.')

  return parts.join('\n')
}

export function buildFixPrompt(args: {
  testFile: string
  testCode: string
  sourceFile: string | null
  sourceCode: string | null
  sourceImportPath?: string | null
  errorOutput: string
  mocksCode?: string | null
  mocksImportPath?: string | null
  setupFileCode?: string | null
  packageDeps?: string | null
  tsconfigPaths?: string | null
  typeDefinitions?: string | null
  localImportPaths?: string[] | null
  reactMajorVersion?: number | null
  projectMemory?: string | null
}): string {
  const { testFile, testCode, sourceFile, sourceCode, sourceImportPath, errorOutput, mocksCode, mocksImportPath, setupFileCode, packageDeps, tsconfigPaths, typeDefinitions, localImportPaths, reactMajorVersion, projectMemory } = args
  const parts: string[] = []

  parts.push('Your job is to fix a failing test file. Do NOT rewrite it from scratch — preserve every existing test and only change what is necessary to make them pass.')
  parts.push('')

  if (projectMemory) {
    parts.push(projectMemory)
    parts.push('')
  }

  if (packageDeps) {
    parts.push('PROJECT DEPENDENCIES (only import from these):')
    parts.push('```')
    parts.push(packageDeps)
    parts.push('```')
  }

  if (reactMajorVersion !== null && reactMajorVersion !== undefined && reactMajorVersion >= 18) {
    parts.push(`\nREACT ${reactMajorVersion} DETECTED — act() async rule: every act(async () => { ... }) call MUST be awaited. Never assign an unawaited act() to a variable. Unawaited act() leaks state updates into subsequent tests, causing cascading failures and null-read errors in unrelated tests.`)
  }

  if (tsconfigPaths) {
    parts.push('\nPROJECT TYPESCRIPT CONFIG:')
    parts.push(tsconfigPaths)
  }

  if (localImportPaths && localImportPaths.length > 0) {
    parts.push('\nLOCAL IMPORT PATHS (pre-computed relative to the test file — use EXACTLY these strings in vi.mock() calls, even if the source file uses @/ aliases. Vitest resolves vi.mock() paths relative to the test file, not via tsconfig aliases. Do NOT convert these back to @/ paths in vi.mock(). Do NOT recount directory levels yourself.):')
    for (const p of localImportPaths) parts.push(`  ${p}`)
  }

  if (typeDefinitions) {
    parts.push('\nTYPE DEFINITIONS (exported from files the source imports — use these exact shapes, do NOT invent properties or guess types):')
    parts.push('```typescript')
    parts.push(typeDefinitions)
    parts.push('```')
  }

  if (setupFileCode) {
    parts.push('\nTEST SETUP FILE (already loaded — do NOT import it again):')
    parts.push('```')
    parts.push(setupFileCode)
    parts.push('```')
  }

  if (mocksImportPath) {
    if (mocksCode) {
      const exports = parseMockExports(mocksCode)
      parts.push(`\nSHARED MOCK FILE (import from: '${mocksImportPath}')`)
      if (exports.length > 0) {
        parts.push(`Available exports: ${exports.join(', ')}`)
        parts.push(`↑ Check this list against the source file — import every relevant mock. Do NOT create inline mocks for anything already exported here.`)
      }
      parts.push('```')
      parts.push(mocksCode)
      parts.push('```')
    } else {
      parts.push(`\nSHARED MOCK FILE (does not exist yet) — create it if you need mocks, return it via the // ---MOCKS_FILE--- separator. Path: '${mocksImportPath}'\n⚠ Mocks file must contain ONLY vi.fn()/vi.mock() definitions and beforeEach resets — NEVER describe/it/test/expect blocks.`)
    }
  }

  if (sourceFile && sourceCode) {
    const networkGuidance = buildNetworkMockingGuidance(analyzeNetworkDeps(sourceCode), sourceFile)
    if (networkGuidance) parts.push(`\n${networkGuidance}`)

    const nextGuidance = buildNextJsGuidance(analyzeNextJs(sourceCode))
    if (nextGuidance) parts.push(`\n${nextGuidance}`)

    // For fix: skeleton with no function expansion — the test already tells the AI
    // which function matters; showing signatures is enough to understand the API.
    const FIX_SKELETON_THRESHOLD = 150
    const displaySource = sourceCode.split('\n').length > FIX_SKELETON_THRESHOLD
      ? buildSourceSkeleton(sourceCode, [])
      : sourceCode
    const fixSkeletonized = displaySource !== sourceCode
    parts.push(`\nSOURCE FILE (what is being tested): ${sourceFile}${fixSkeletonized ? ' (large file — function bodies collapsed to signatures)' : ''}`)
    if (sourceImportPath) {
      parts.push(`SOURCE FILE IMPORT PATH: when importing the source in the test file, use exactly: '${sourceImportPath}'`)
    }
    parts.push('```')
    parts.push(displaySource)
    parts.push('```')
  }

  parts.push(`\nFAILING TEST FILE: ${testFile}`)
  parts.push('```')
  parts.push(testCode)
  parts.push('```')

  parts.push('\nFAILURE OUTPUT:')
  parts.push('```')
  parts.push(errorOutput.slice(0, 3000))
  parts.push('```')

  const realRequestWarning = detectRealRequestInError(errorOutput)
  if (realRequestWarning) parts.push(`\n⚠️  ${realRequestWarning}`)

  const rejectionWarning = detectUnhandledRejection(errorOutput)
  if (rejectionWarning) parts.push(`\n⚠️  ${rejectionWarning}`)

  const nextImportWarning = detectNextJsImportError(errorOutput)
  if (nextImportWarning) parts.push(`\n⚠️  ${nextImportWarning}`)

  const bleedWarning = detectThinkingBleed(errorOutput)
  if (bleedWarning) parts.push(`\n⚠️  ${bleedWarning}`)

  // Detect wrong mock pattern: test uses vi.mock('axios') but source uses axios.create()
  const testHasAxiosMock = /vi\.mock\(['"]axios['"]\)/.test(testCode)
  const sourceHasCustomInstance = sourceCode != null && /axios\.create\s*\(/.test(sourceCode)
  if (testHasAxiosMock && sourceHasCustomInstance) {
    parts.push(
      "\n⚠️  WRONG MOCK PATTERN: The test mocks 'axios' directly but the source file uses axios.create().",
      "vi.mock('axios') cannot intercept a custom axios instance.",
      'You must mock the module that exports the axios instance, or mock the service/API module the source imports.',
    )
  }

  parts.push('\nCommon causes to check:')
  parts.push('- Wrong import path (use path aliases, not deep relative paths)')
  parts.push('- Mock not set up correctly (check the shared mock file)')
  parts.push('- Asserting on the wrong value or using the wrong matcher')
  parts.push('- Async code not awaited')
  parts.push('- Component/function API changed — check the source file')
  parts.push('- Unhandled rejection: if the error output says "Unhandled Rejection" or "Vitest caught 1 unhandled error", a mockRejectedValueOnce promise is escaping the test scope. Fix by adding await waitFor(() => expect(errorElement).toBeInTheDocument()) after the triggering action, so the rejection is fully resolved inside the test.')

  parts.push('\nReturn your response in the required <thinking> + <code_output> format.')

  return parts.join('\n')
}

export interface FailedAttempt {
  attemptNumber: number
  hypothesis: string    // extracted from <thinking> block of the previous attempt
  failureReason: string // filtered error output from extract-error.ts
}

export function buildRetryPrompt(failureOutput: string, failedAttempts: FailedAttempt[] = []): string {
  const parts: string[] = []

  if (failedAttempts.length > 0) {
    parts.push(`You have already attempted to fix this ${failedAttempts.length} time(s). Do NOT repeat these failed approaches:`)
    for (const a of failedAttempts) {
      const hyp = a.hypothesis ? `Planned: [${a.hypothesis.slice(0, 300)}]` : '(no plan recorded)'
      parts.push(`- Attempt ${a.attemptNumber}: ${hyp} → failed with: ${a.failureReason.slice(0, 300)}`)
    }
    parts.push('')
  }

  parts.push(`The tests failed. Error output:`)
  parts.push('```')
  parts.push(failureOutput.slice(0, 3000))
  parts.push('```')

  const realRequestWarning = detectRealRequestInError(failureOutput)
  if (realRequestWarning) parts.push(`\n⚠️  ${realRequestWarning}`)

  const rejectionWarning = detectUnhandledRejection(failureOutput)
  if (rejectionWarning) parts.push(`\n⚠️  ${rejectionWarning}`)

  const nextImportWarning = detectNextJsImportError(failureOutput)
  if (nextImportWarning) parts.push(`\n⚠️  ${nextImportWarning}`)

  const bleedWarning = detectThinkingBleed(failureOutput)
  if (bleedWarning) parts.push(`\n⚠️  ${bleedWarning}`)

  parts.push('')
  parts.push('Common causes:')
  parts.push('- Wrong import path — check the path aliases and dependency list from the original prompt')
  parts.push('- Missing mock — if a module needs mocking, add it to the shared mock file')
  parts.push('- Wrong vi.mock() path: mock paths are relative to the TEST FILE, not the source file. Count up from the test file\'s directory to reach the mocked module — if the test is in src/features/x/__tests__/ and mocks src/components/, that is ../../../components/, not ../components/.')
  parts.push('- Barrel file mock miss: if a module is re-exported from a barrel/index file, mocking the barrel (vi.mock(\'../components\')) will NOT intercept imports of the direct file (\'../components/Foo\'). Mock the specific file the source actually imports. If unsure, mock both.')
  parts.push('- Wrong API — use only methods that exist in the installed version of the library')
  parts.push('- Type error — make sure the types match what the source file exports')
  parts.push('- React 18 act() async: every act(async () => ...) MUST be awaited. Unawaited act() calls cause state to leak across tests, producing "Cannot read properties of null" or timeout failures in unrelated tests. Fix: add await before every act() call that wraps async code.')
  parts.push('- Loading state — if the error is "Unable to find element" on a Submit/Save button, the component likely unmounts the button during loading rather than disabling it. Assert on the spinner or loading indicator instead.')
  parts.push('- Unhandled rejection ("Vitest caught 1 unhandled error" / "Unhandled Rejection"): a mockRejectedValueOnce promise is escaping the test scope. After the action that triggers the rejection, add: await waitFor(() => expect(screen.getByText(/error/i)).toBeInTheDocument()) — this keeps the rejection chained inside the test so Vitest doesn\'t treat it as unhandled. The component may already catch the error internally, but the test still needs to await the resulting state change.')
  parts.push('')
  parts.push('Fix the issue and return your response in the required <thinking> + <code_output> format.')

  return parts.join('\n')
}
