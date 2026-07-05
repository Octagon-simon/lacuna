// Service / API mock completeness hints.
//
// A component that loads data through a service module — `await WalletService.getBanks()`,
// `WalletService.getWithdrawalMethod().then(setMethod)` — is normally tested with that module
// mocked: `jest.mock('@/services', () => ({ WalletService: { getBanks: jest.fn(), … } }))`.
// A BARE `jest.fn()` returns `undefined`. So `await fn()` yields undefined (and `fn().then(…)`
// throws on `undefined.then`), the state it should populate stays empty, and the component takes
// the wrong branch — e.g. `if (!withdrawalMethod) openBankSetup()` — so the element the test
// awaits after an interaction never renders and the test times out. This surfaces which mocked
// methods are consumed asynchronously so the model mocks them with `mockResolvedValue(...)`.

import { isMissingFieldError, isInteractionFailure } from './hook-mock-hints.js'

// `await Ident.method(` — awaited service call.
const AWAITED_CALL = /\bawait\s+([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g
// `Ident.method(...).then(` — promise-chained service call (args kept on one statement).
const THENED_CALL = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\([^;]*?\)\s*\.then\b/g

// Built-in globals whose async methods (`Promise.all`, `JSON`, `Object.*`) are never mocked —
// excluded so they're not mistaken for a service object.
const BUILTINS = new Set([
  'Promise', 'Object', 'Array', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Date', 'Map',
  'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Reflect', 'Proxy', 'RegExp', 'Error', 'React',
])

// A capitalised, non-hook, non-builtin identifier — the convention for a service/API/client
// object. Used to filter when there's no test file to cross-reference (generation time).
function looksLikeService(ident: string): boolean {
  return /^[A-Z]/.test(ident) && !/^use[A-Z]/.test(ident) && !BUILTINS.has(ident)
}

/** Map of service identifier → set of methods the component consumes asynchronously. */
export function extractAsyncServiceCalls(sourceCode: string): Map<string, Set<string>> {
  const byIdent = new Map<string, Set<string>>()
  const add = (ident: string, method: string) => {
    const s = byIdent.get(ident) ?? new Set<string>()
    s.add(method)
    byIdent.set(ident, s)
  }
  for (const m of sourceCode.matchAll(AWAITED_CALL)) add(m[1], m[2])
  for (const m of sourceCode.matchAll(THENED_CALL)) add(m[1], m[2])
  return byIdent
}

/**
 * Build a "resolve your async service mocks" hint, or null when it doesn't apply.
 *
 * @param errorOutput  When provided (fix), gates on a missing-field / interaction failure so the
 *                     hint doesn't pollute unrelated retries. When null (generate), always emits
 *                     if async service calls are found — prevention beats repair.
 * @param testCode     When provided, only services the test references are listed (never suggest
 *                     mocking something the test doesn't). When null, falls back to the naming
 *                     convention (`looksLikeService`).
 */
export function buildServiceMockHint(
  sourceCode: string | null | undefined,
  testCode: string | null | undefined,
  errorOutput: string | null,
): string | null {
  if (!sourceCode) return null
  if (errorOutput != null && !isMissingFieldError(errorOutput) && !isInteractionFailure(errorOutput)) return null

  const calls = extractAsyncServiceCalls(sourceCode)
  const rows: string[] = []
  for (const [ident, methods] of calls) {
    if (BUILTINS.has(ident)) continue
    const referenced = testCode ? testCode.includes(ident) : looksLikeService(ident)
    if (!referenced) continue
    rows.push(`  • ${ident}: ${[...methods].join(', ')}`)
  }
  if (rows.length === 0) return null

  return (
    'SERVICE / API MOCK COMPLETENESS: The component consumes these mocked methods asynchronously ' +
    '(`await` or `.then`), and their resolved value drives what renders:\n' +
    rows.join('\n') + '\n' +
    'A bare `jest.fn()` / `vi.fn()` returns undefined — `await` then yields undefined (and `.then` throws on ' +
    '`undefined.then`), so the state they should populate stays empty and the component takes the WRONG branch ' +
    '(e.g. "no withdrawal method → open bank setup"), leaving the element a test awaits after an interaction ' +
    'unrendered → timeout. In EVERY test that reaches one of these paths, give the method a resolved value: ' +
    '`.mockResolvedValue(<data>)` for the success path (data whose fields match the literals the test asserts), ' +
    'or `.mockRejectedValue(new Error(...))` for an error-path test. Then await the resulting UI with `findBy*` / ' +
    '`waitFor` before asserting. Bare `jest.fn()` is only safe for fire-and-forget callbacks whose return is ignored.'
  )
}
