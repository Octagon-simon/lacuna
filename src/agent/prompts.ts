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

// ─── React Native detector & guidance ───────────────────────────────────────

function detectReactNative(packageDeps: string | null): boolean {
  if (!packageDeps) return false
  return /\breact-native\b/.test(packageDeps) || /\bexpo\b/.test(packageDeps)
}

function buildReactNativeGuidance(): string {
  return [
    'REACT NATIVE PROJECT — use @testing-library/react-native, not @testing-library/react.',
    "- Import render, screen, fireEvent, waitFor from '@testing-library/react-native'",
    '- No document, window, or localStorage globals — they do not exist in React Native',
    "- Mock react-native modules with vi.mock('react-native', ...) or jest.mock('react-native', ...)",
    '- Mock navigation: if @react-navigation/native is used, mock useNavigation, useRoute',
    '- Mock expo-router if present: mock useRouter, useLocalSearchParams, Link',
    '- Use fireEvent.press() not fireEvent.click() for Pressable/TouchableOpacity',
    '- Async state: use waitFor() from @testing-library/react-native, not from @testing-library/react',
  ].join('\n')
}

// ─── Vue detector & guidance ─────────────────────────────────────────────────

function detectVue(packageDeps: string | null): boolean {
  if (!packageDeps) return false
  return /\bvue\b/.test(packageDeps)
}

function buildVueGuidance(): string {
  return [
    'VUE PROJECT — use @testing-library/vue for component tests.',
    "- Import render, screen, fireEvent, waitFor from '@testing-library/vue'",
    "- Import userEvent from '@testing-library/user-event'",
    '- Wrap async user interactions with await userEvent.setup() and await act()',
  ].join('\n')
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

// Surfaces TypeScript compiler errors in a form the model can act on directly.
// Philosophy: tsc output is already the fix instruction — our job is to make sure
// the model reads it literally rather than overriding it with framework conventions.
// Two layers:
//   1. Extract structured info from the error text for the highest-value patterns
//      (member lists, suggestions, mismatched types) so the model doesn't have to hunt.
//   2. Generic pass-through for everything else — the compiler already said what's wrong.
function detectTypeScriptErrors(errorOutput: string): string | null {
  if (!/error TS\d+:/.test(errorOutput)) return null

  const parts: string[] = [
    'TYPESCRIPT ERRORS — treat each compiler message as an exact instruction, not a hint:',
    'The TypeScript compiler tells you precisely what is wrong and usually what the fix is.',
    'Do NOT override it with framework conventions or assumptions.',
  ]

  // TS1378: top-level await — only specific branch because the fix is structural
  if (/TS1378/.test(errorOutput)) {
    parts.push(
      '• Top-level await (TS1378): move ALL await calls inside it()/test()/beforeEach()/etc.',
      '  WRONG: const result = await fn();',
      '  RIGHT: it("desc", async () => { const result = await fn(); });',
    )
  }

  // Wrong member name — extract the actual member list TypeScript printed inline.
  // Covers TS2339, TS2551, TS2561 and any variant with "does not exist on/in type '{...}'"
  const propErrors = [...errorOutput.matchAll(/'(\w+)' does not exist (?:on|in) type '\{([^']+)\}'/g)]
  if (propErrors.length > 0) {
    parts.push('• Wrong member name — the actual available members are:')
    const seen = new Set<string>()
    for (const m of propErrors) {
      const wrongProp = m[1]
      const available = [...m[2].matchAll(/(\w+)\s*[?]?\s*:/g)].map(p => p[1]).filter(p => p !== 'type')
      const key = wrongProp + available.join()
      if (seen.has(key)) continue
      seen.add(key)
      parts.push(`  '${wrongProp}' → not valid. Use one of: ${available.slice(0, 12).join(', ')}${available.length > 12 ? ' …' : ''}`)
    }
  }

  // Compiler suggestions — TypeScript already provides the answer
  const suggestions = [...new Set([...errorOutput.matchAll(/Did you mean(?: to write)? '(\w+)'\?/g)].map(m => m[1]))]
  if (suggestions.length > 0) {
    parts.push(`• Compiler suggestion: use ${suggestions.map(s => `'${s}'`).join(', ')}`)
  }

  // Type mismatch — extract what was passed vs what was required
  const typeMismatches = [...errorOutput.matchAll(/Argument of type '([^']+)' is not assignable to parameter of type '([^']+)'/g)]
  if (typeMismatches.length > 0) {
    for (const m of typeMismatches) {
      parts.push(`• Type mismatch: passed '${m[1].slice(0, 80)}', required '${m[2].slice(0, 80)}'`)
    }
    parts.push('  (use null not undefined for nullable values; check TYPE DEFINITIONS for the required shape)')
  }

  // Generic pass-through for all other TS errors — list them so the model reads each one
  // rather than guessing. No special handling needed: the message IS the instruction.
  const otherErrors = [...errorOutput.matchAll(/error (TS(?!1378|2339|2551|2561|2345)\d+): ([^\n]+)/g)]
  if (otherErrors.length > 0) {
    parts.push('• Additional compiler errors — read each one and apply the exact fix it describes:')
    const seen = new Set<string>()
    for (const m of otherErrors) {
      const msg = `${m[1]}: ${m[2].slice(0, 120)}`
      if (seen.has(msg)) continue
      seen.add(msg)
      parts.push(`  ${msg}`)
    }
  }

  return parts.join('\n')
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
  const isServerOnly = importPath === 'server-only'
  const isAlias = importPath.startsWith('@/')
  const isClient = importPath.endsWith('.client')
  const isServer = importPath.endsWith('.server')
  const isNextInternal = importPath.startsWith('next/')
  const isProviderOrSession = /session|auth|provider/i.test(importPath)

  if (!isServerOnly && !isAlias && !isClient && !isServer && !isNextInternal && !isProviderOrSession) return null

  const lines = [
    `IMPORT RESOLUTION ERROR — Vitest cannot resolve "${importPath}".`,
  ]

  if (isServerOnly) {
    lines.push(
      `"server-only" is a Next.js build guard — it throws intentionally when server code is loaded in a non-server context.`,
      `This is a CONFIGURATION issue, not something fixable in the test file. Two options:`,
      `  OPTION A (preferred): Add an alias in vitest.config.ts that maps "server-only" to an empty module:`,
      `    alias: { 'server-only': path.resolve(__dirname, './test/empty-module.ts') }`,
      `    and create test/empty-module.ts containing: export default {}`,
      `  OPTION B: Mock the entire module that imports server-only (the hook or service) so Vitest never resolves its dependency tree.`,
      `Do NOT try to mock "server-only" directly in the test file — vi.mock('server-only') is too late; the import is resolved before mocks run.`,
    )
  } else if (isAlias) {
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
      `This is a Next.js ${isClient ? 'client' : 'server'} boundary file. Vitest never resolves these.`,
      `If the source file IMPORTS this module directly, mock it with the exact import path:`,
      `  vi.mock('${importPath}', () => ({ myFn: vi.fn() }))`,
      ``,
      `If the failing source is a HOOK that internally imports *.client services (which chain into many other server-only modules),`,
      `use the complete self-replacement strategy — mock the entire hook, not its sub-dependencies:`,
      `  const mockState = vi.hoisted(() => ({ data: [], loading: false, error: null }))`,
      `  vi.mock('../useMyHook', () => ({`,
      `    useMyHook: () => mockState,`,
      `  }))`,
      `This bypasses the entire dependency tree and tests the component contract, not the hook internals.`,
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
  const isJS = env.language === 'typescript' || env.language === 'javascript' || env.language === 'unknown'
  const isTS = env.language === 'typescript'
  const isVitest = env.testRunner === 'vitest'
  const isJSRunner = env.testRunner === 'jest' || env.testRunner === 'vitest' || env.testRunner === 'mocha'

  // ── Thinking template ────────────────────────────────────────────────────────
  const mockAuditStep = isJS ? `
    2. MOCK AUDIT — do this before writing a single line of test code:
       a) IMPORT INVENTORY: List every import in the source file. For each client/service/hook, find every method it calls (grep for Client.method() patterns). Mock exactly those methods — nothing more, nothing less. Mocking a method the source never calls is useless; missing a method the source DOES call is a silent failure.
       b) RESPONSE ENVELOPE: At each Client.method() call site, check how the return value is consumed. If the source guards with \`if (res.success)\` or destructures \`{ success, data }\`, the mock MUST return that envelope — NOT a raw array. \`mockResolvedValue([...])\` when the hook expects \`{ success: true, data: [...] }\` produces silently empty state with no error. Pattern: \`const ok = (data: unknown) => ({ success: true, data })\`.
       c) RETURN FIELD ENUMERATION: Find the hook's \`return { ... }\` statement. List every key. Only write assertions for fields that actually appear there. A field not in the return statement is always undefined — asserting it produces a vacuous test that passes and fails for the wrong reasons.
       d) LOADING TRIGGER MAP: Not all data loads on mount. For each piece of state, find what populates it. If a function like loadResults(classId) must be called explicitly (user selects something), the mount test will never see that data. Map: state → function that populates it → when that function is triggered.
       e) FIXTURE FIELD NAMES: Read the source's selector logic — every .find(), .filter(), and property access. Field names in fixture data must match what the source reads, not what sounds reasonable. \`is_active\` and \`is_current\` are both plausible; only one will pass the filter. Read the source.
       f) MOCK STRUCTURE — object vs factory: when the source imports a client/service as a module export and calls it as \`SomeClient.method()\`, the mock must be a plain object \`{ SomeClient: { method: vi.fn() } }\`. If you mock it as \`vi.fn().mockReturnValue({ method: vi.fn() })\`, SomeClient.method is undefined at runtime — the mock replaced a singleton with a callable that the source never calls. The mock structure must match how the source uses the import, not how you'd design an API.
       g) DATA TRANSFORMATIONS: Before writing any assertion about the shape of loaded data, read every .map(), .filter(), and mutation the hook applies to the raw API response. If the hook does \`.map(s => ({ ...s, selected: true, status: 'promoted' }))\`, the fixture assertion must expect the TRANSFORMED shape, not the raw API fixture. Keep two separate fixtures: the raw API response (for mockResolvedValue) and the expected hook output (for assertions).
       h) USEEFFECT COMPOUND SIDE EFFECTS: For each useEffect, read its dependency array AND every state setter it calls. Some effects reset sibling state as a side effect (e.g. fetchSourceClasses always calls setSelectedSourceClassId('')). Setting state that triggers such an effect will silently undo other state you set in the same act(). Map the full chain: which state changes trigger which effects, and what those effects do to other state — before writing any test that sets multiple state values.
       HOOK STATE SYNC: If the test mocks a hook or function that returns an object (e.g. useClasses(), useUsers()), compare its CURRENT return signature in the source against the mocked return object in the test. If any properties are missing, renamed, or stale, realign the mock FIRST — before touching any assertions.
       UNCONDITIONAL CRASH CHECK: Look at the very top of the component body — what fields are destructured and used BEFORE any conditional render (e.g. totalRevenue.toLocaleString(), sessions.length)? Every one of those fields MUST be present in the mock return value or ALL tests will crash immediately.
       MOCK PROP INTERFACE: When mocking a child component (e.g. EmptyState, Modal), check how the PARENT calls it — what prop names does the JSX pass? Use those exact names in the mock, not the names from the child's own prop type definition.
    3. COMPONENT RENDER MAP (React/Vue components only): Before writing any assertion, list what is in the DOM in each relevant state (idle / loading / error / success). Read the template/JSX — check every ternary, &&, and conditional — to determine whether a button is disabled vs unmounted, what text changes, what elements appear.
       GUARD CLAUSE AUDIT: Identify every conditional render guard in the component (e.g. payments.length > 0, isLoading, hasPermission). A test that provides data violating a guard will never find the element — the guard hides it. Match mock data to the guard condition required by each test.
       STALE TEST AUDIT: Check whether any existing test asserts UI or behavior that the current source no longer has. DELETE those tests — do not try to make the component pass a test for features it no longer has.` : `
    2. DEPENDENCY AUDIT: List every external dependency the source calls. For each one, determine what needs to be mocked and what return value the code expects. Read every call site — don't infer the expected shape from the type name.
    3. DATA FIXTURE AUDIT: Read the source's selector logic — every filter, find, and field access. Fixture data field names must match what the source reads exactly.`

  const thinkingTemplate = `
    1. WHAT IS NEEDED: What functions/behaviors are untested or broken?${mockAuditStep}
    4. WHY IT FAILED (retries only): Errors cascade — a compile error hides a resolution error which hides a wiring error which hides a logic error. Fix the first layer and expect a new error to surface. What layer are we on now?
    5. PLAN: List the exact steps you will take before writing a single line of code.`

  // ── JS/TS-specific rules ─────────────────────────────────────────────────────
  const jsRules = isJS ? `
3. Use path aliases from the PROJECT TYPESCRIPT CONFIG section in IMPORT statements (e.g. "@/components/Button" not "../../components/Button").
   EXCEPTION — mock call paths: use the exact same path string that appears in the SOURCE FILE'S import statement.
   If a LOCAL IMPORT PATHS section is provided, use those pre-computed relative paths in mock calls — they are the fallback when aliases cannot be resolved by the test runner.
   Never second-guess the pre-computed paths. Never convert them back to @/ aliases in mock calls.
4. Only import from packages listed in PROJECT DEPENDENCIES. Do not invent packages that are not listed.
5. When a SHARED MOCK FILE is provided, its exported names are listed under "Available exports". Before writing the test, go through that list and identify every mock that relates to what the source file does. Import and use ALL of those mocks. Never re-create inline vi.fn() / jest.fn() for anything already exported from the mocks file.
   CRITICAL — never rename or change the casing of existing mock exports.
6. If you need a mock that is missing from the shared mock file, add it to that file AND import it in the test. Return BOTH files separated by exactly one line containing only: // ---MOCKS_FILE---
7. If a SHARED MOCK FILE (does not exist yet) section is shown — create it for any mocks you need and return it using the // ---MOCKS_FILE--- separator.
   CRITICAL — the mocks file must contain ONLY: vi.fn()/jest.fn() mock definitions, vi.mock() module stubs, shared mock objects/constants, and beforeEach reset hooks. NEVER write describe(), it(), test(), or expect() calls in the mocks file.
8. If a TEST SETUP FILE is shown, assume its globals and matchers are already available. Do NOT import or re-declare them.` : `
3. Use the project's import conventions as shown in the source file and existing tests.
4. Only import from packages listed in PROJECT DEPENDENCIES. Do not invent packages that are not listed.`

  const tsRule = isTS ? `
9. TypeScript type safety: all test code must compile without type errors. The TypeScript compiler is the authority — its error messages are exact instructions, not hints.
   - Use EXACT property/member names from the TYPE DEFINITIONS section and source code. Do not apply naming conventions: if a hook returns { loading, users }, do NOT write isLoading or isUsers.
   - Import enums, constants, interfaces, and types from the project's existing files. Do NOT redeclare them inline or invent lookalike values.
   - Never use "as any", "@ts-ignore", or "@ts-expect-error" to suppress type errors.
   - For vi.fn() / jest.fn(), either let TypeScript infer the type from context or type it explicitly: vi.fn<Parameters<typeof fn>, ReturnType<typeof fn>>().
   - Use ReturnType<>, Parameters<>, and other utility types to derive mock types from real function signatures.
   - When accessing optional properties, handle null/undefined correctly.` : ''

  const ruleCount = isTS ? 10 : (isJS ? 9 : 6)

  // ── JS/Vitest-specific output format rules ───────────────────────────────────
  const jsOutputRules = isJS ? `
${ruleCount + 2}. Inside <code_output>: output ONLY the test file content (or test file // ---MOCKS_FILE--- mocks file).
    If you use // ---MOCKS_FILE---, everything AFTER the separator is the mocks file. The mocks file must contain ONLY:
    vi.fn()/jest.fn() mock definitions, vi.mock() module stubs, shared constants, and beforeEach resets.
    NEVER put describe(), it(), test(), or expect() calls after the separator.
${ruleCount + 3}. NEVER output vitest.config.ts, jest.config.js, or any framework configuration. If an import cannot be resolved,
    fix it by mocking it with vi.mock() — NOT by modifying the test runner configuration.` : ''

  // ── Common failure causes — universal ────────────────────────────────────────
  const universalCauses = `- Wrong import paths (use the project's conventions — aliases where configured, relative paths otherwise)
- Importing from test utilities that are not in the dependency list
- Mocking modules that are already mocked in the setup file
- Forgetting to await async functions
- Real HTTP requests: NEVER let a real network call reach the internet. Every function that calls an API must be mocked before the test runs.
- Error surface mismatch: before writing any error-path test, find the catch block. Does it set state, call a notification, or just log silently? Test only what is actually observable from outside.
- Code drift — assert what the code ACTUALLY does: before writing any assertion, re-read the relevant section of the source. If it catches an error and returns null, assert null — not a rejection.`

  // ── Common failure causes — JS/Jest/Vitest only ───────────────────────────────
  const jsCauses = isJSRunner ? `
- vi.mock() / jest.mock() paths are relative to the TEST FILE, not the source file. Count directories from the test file's location, not the source file's.
- Missing mock is the silent killer: if expect(mockFn).toHaveBeenCalled() fails but the code path is clearly reached, the mock declaration is missing or uses the wrong path. The real implementation ran instead.
- Response envelope mismatch (silent empty state): if a hook guards \`if (res.success)\` or destructures \`{ success, data }\`, mocking with a raw array means .success is undefined and state is never populated — silently. Trace each call site individually — different clients in the same hook often have different shapes (one returns \`{ data: [] }\`, another \`{ success, data: { items: [] } }\` with nested access). Never assume a uniform envelope across the whole hook.
- Barrel file mock miss: mocking a barrel/index file (vi.mock('../components')) will NOT intercept imports of the direct file ('../components/Foo'). Mock the specific module the source actually imports.` : ''

  const vitestCauses = isVitest ? `
- Never use require() in Vitest: Vitest runs files as ESM — dynamic require() fails at transform time. Always use static ES import + vi.mocked().
- Shared mock file factory syntax: \`vi.mock('../service', async () => await import('../../test/mocks'))\` — synchronous factory cannot import external files in Vitest.
- vi.hoisted() for shared mock references: when a mock object is created inside vi.mock() AND configured in beforeEach, use vi.hoisted() so both closures reference the same object instance.
- Complete hook self-replacement for *.client-importing hooks: when a hook imports *.client services that chain into browser/server-only modules, mock the entire hook — \`vi.mock('../useMyHook', () => ({ useMyHook: vi.fn() }))\` — rather than each sub-dependency.
- server-only resolution in Next.js: \`Failed to resolve import "server-only"\` is a config issue, not a test issue. Add an alias in vitest.config.ts: \`'server-only': path.resolve(__dirname, './test/empty-module.ts')\` and create that file with \`export default {}\`.
- Top-level await (TS1378): NEVER use \`await\` at the top level of a test file. Every \`await\` must be inside an async callback: \`it("...", async () => { ... })\`.
- NEVER call vi.spyOn(global, ...) or vi.spyOn(globalThis, ...) at module level (outside beforeEach/beforeAll). Each Vitest file has its own vi registry. A module-level spy is installed on the shared worker globalThis but setup-file afterEach cleanup (vi.restoreAllMocks) uses a different vi instance and cannot remove it — the spy persists after the file ends and poisons the next file that runs in the same worker. Always create global spies inside beforeEach so they are fresh per test and properly cleaned up:
  WRONG: const mockFetch = vi.spyOn(global, 'fetch');  // module level — breaks other files
  RIGHT: let mockFetch: ReturnType<typeof vi.spyOn>;
         beforeEach(() => { mockFetch = vi.spyOn(global, 'fetch'); });
- Never write two vi.mock() calls for the same module path in the same file. The second call silently overrides the first — exports from the first mock are lost. If a module exports many things (e.g. lucide-react icons), list them all in a single vi.mock() factory:
  WRONG: vi.mock('lucide-react', () => ({ Search: () => null }))  ...later...  vi.mock('lucide-react', () => ({ Plus: () => null }))
  RIGHT: vi.mock('lucide-react', () => ({ Search: () => null, Plus: () => null }))` : ''

  // ── Common failure causes — React/Vue (JS component tests) only ───────────────
  const reactCauses = isJSRunner ? `
- React 18 act() async rule: ALWAYS await act() when it wraps async code. Unawaited act() calls cause state to leak across tests, producing "Cannot read properties of null" failures in unrelated tests.
- Loading state architecture: before asserting a button is disabled during loading, check whether the component unmounts it entirely. If unmounted, getByText("Submit") throws — test for the spinner instead.
- Unhandled promise rejections: after triggering an action with mockRejectedValueOnce, always await the resulting state change with waitFor() so the rejection is resolved inside the test scope.
- getByText / getByTestId ambiguity: generic strings and reused icon components often appear multiple times on a complex page. Use getAllByText(...)[0], getByRole, or within(container).getByText(...) to scope queries.
- Functional state updater assertions: when a component calls setState with an updater function (e.g. setPage(p => p + 1)), toHaveBeenCalledWith(3) always fails. Capture the updater and call it: \`const fn = mockSetPage.mock.calls[0][0]; expect(fn(2)).toBe(3)\`.
- React 18 act() warning in hook tests: wrap async mock resolutions in \`await act(async () => {})\` at the end of the test to flush pending state updates before the test exits.` : ''

  // ── Good test suite checklist ────────────────────────────────────────────────
  const hookSuiteNote = isJSRunner
    ? `\n- For hooks: cover mutations (save, update, delete) and derived/computed state — not just the initial-load lifecycle. Mutations and derived state are where real bugs hide.`
    : ''

  return `You are a senior QA engineer with 10+ years of experience writing production test suites for ${env.language} projects. You use ${env.testRunner} and you take testing seriously.

Your tests catch real bugs. You think about what could go wrong — null inputs, empty arrays, async race conditions, error boundaries, permission checks, off-by-one errors — and you write assertions that would actually fail if the code broke. You never write a test just to hit a coverage number.

RULES — follow every one:
1. Write tests that verify real behavior: correctness, edge cases, boundary values, and error handling. Never write empty or trivial assertions (e.g. expect(true).toBe(true)).
2. Match the EXACT import style shown in the existing test file or PROJECT TEST EXAMPLES. If none exists, use the style from the source file.${jsRules}${tsRule}
${ruleCount}. Every test file MUST contain at least one it() or test() call with real assertions. A file with only imports, describe() blocks, types, or helper functions is invalid and will be rejected.
${ruleCount + 1}. Structure ALL output using exactly these two XML blocks — nothing before, nothing after:
    <thinking>${thinkingTemplate}
    </thinking>
    <code_output>
    // complete test file here
    </code_output>
    CRITICAL: Once you open <code_output>, ALL remaining output must be code. Finish ALL reasoning inside <thinking> first.
${ruleCount + 2 <= ruleCount + 1 ? '' : `${ruleCount + 2}. Inside <code_output>: do NOT wrap in markdown code fences.`}${jsOutputRules}

A good test suite you write will have:
- A happy-path test that confirms the main behavior works
- At least one edge-case test per function (empty input, zero, null, boundary values)
- Error-path tests for any function that throws, rejects, or returns an error state — but ONLY assert the observable effect. Read the catch block first: does it set state, call a notification, or just log? Test only what's observable.
- Async tests properly awaited — never fire-and-forget${hookSuiteNote}
- Clear, descriptive test names that read like a spec ("returns null when user is not authenticated")

Common failure causes to avoid:
${universalCauses}${jsCauses}${vitestCauses}${reactCauses}

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

  if (detectReactNative(packageDeps ?? null)) parts.push(`\n${buildReactNativeGuidance()}`)
  else if (detectVue(packageDeps ?? null)) parts.push(`\n${buildVueGuidance()}`)

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

  if (detectReactNative(packageDeps ?? null)) parts.push(`\n${buildReactNativeGuidance()}`)
  else if (detectVue(packageDeps ?? null)) parts.push(`\n${buildVueGuidance()}`)

  if (sourceFile && sourceCode) {
    const networkGuidance = buildNetworkMockingGuidance(analyzeNetworkDeps(sourceCode), sourceFile)
    if (networkGuidance) parts.push(`\n${networkGuidance}`)

    const nextGuidance = buildNextJsGuidance(analyzeNextJs(sourceCode))
    if (nextGuidance) parts.push(`\n${nextGuidance}`)

    // For fix: show the full source so the AI can see exact return shapes, field names,
    // and mock structure. Only skeleton truly enormous files to stay within token limits.
    const FIX_SKELETON_THRESHOLD = 600
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

  const tsErrorWarning = detectTypeScriptErrors(errorOutput)
  if (tsErrorWarning) parts.push(`\n⚠️  ${tsErrorWarning}`)

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

export function buildPollutionFixPrompt(args: {
  pollutorFile: string
  pollutorCode: string
  victimFile: string
  victimCode: string
  victimError: string
  env: DetectedEnvironment
}): string {
  const { pollutorFile, pollutorCode, victimFile, victimCode, victimError } = args
  const parts: string[] = []

  parts.push('This test file corrupts shared state and causes another test file to fail when run afterwards.')
  parts.push('Your job: add afterEach() or afterAll() cleanup to reset whatever global state this file mutates.')
  parts.push('')
  parts.push('Rules:')
  parts.push('- DO NOT remove, rewrite, or alter any existing test logic or assertions')
  parts.push('- ONLY add cleanup hooks — nothing else')
  parts.push('- The fix must be minimal: add the smallest afterEach/afterAll that resets the leaked state')
  parts.push('')

  parts.push(`POLLUTING FILE (add cleanup here): ${pollutorFile}`)
  parts.push('```')
  parts.push(pollutorCode)
  parts.push('```')
  parts.push('')

  parts.push(`VICTIM FILE (fails when run after the polluting file): ${victimFile}`)
  parts.push('```')
  parts.push(victimCode)
  parts.push('```')
  parts.push('')

  parts.push('ERROR the victim gets when run after this file:')
  parts.push('```')
  parts.push(victimError.slice(0, 2000))
  parts.push('```')
  parts.push('')

  parts.push('HOW TO DIAGNOSE:')
  parts.push("1. Read the victim's error — what value is null/undefined/wrong, or what element is missing?")
  parts.push('2. Search the polluting file for where that thing is set or modified (localStorage, window properties, module singletons, mock state, React context, timers, environment variables)')
  parts.push('3. Add afterEach (or afterAll) in the polluting file to reset exactly that thing')
  parts.push('')
  parts.push('Common cleanup patterns:')
  parts.push('  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })')
  parts.push('  afterEach(() => { localStorage.clear(); sessionStorage.clear() })')
  parts.push('  afterEach(() => { delete (window as any).myProperty })')
  parts.push('  afterEach(() => { myModuleSingleton.reset() })')
  parts.push('  afterEach(() => { vi.useRealTimers() })')
  parts.push('')
  parts.push('Return the complete modified polluting file in the required <thinking> + <code_output> format.')

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
      let hypContext = a.hypothesis
      if (hypContext) {
        const planMatch = hypContext.match(/(?:4\.\s*WHY IT FAILED|5\.\s*PLAN)[\s\S]*/i)
        if (planMatch) {
          hypContext = planMatch[0]
        } else if (hypContext.length > 800) {
          hypContext = '...' + hypContext.slice(-800)
        }
      }
      
      const hyp = hypContext ? `[${hypContext.slice(0, 1000)}]` : '(no plan recorded)'
      parts.push(`- Attempt ${a.attemptNumber} Reasoning: ${hyp}\n  Failed with: ${a.failureReason.slice(0, 800)}`)
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

  const tsErrorWarning = detectTypeScriptErrors(failureOutput)
  if (tsErrorWarning) parts.push(`\n⚠️  ${tsErrorWarning}`)

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
