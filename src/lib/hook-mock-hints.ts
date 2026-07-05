// Hook-mock completeness hints.
//
// A very common generated-test failure is a hook mock that returns only *some* of the
// fields the component destructures. e.g. the component does
//   const { berryBalance, refreshProfile, showToast, ... } = useApp()
// but the test's `(useApp as jest.Mock).mockReturnValue({ user, isAuthenticated })`
// omits the rest. Each missing field surfaces as ONE runtime error at render time
// (`refreshProfile is not a function`, then `Cannot read properties of undefined
// (reading 'toLocaleString')` on the next field, and so on). The fix loop feeds the
// model one error per retry, so an N-field gap needs N retries and usually exhausts
// the budget without ever converging.
//
// The remedy: read the component's destructuring of each mocked hook and hand the model
// the COMPLETE field set up front, so it can size the mock correctly in a single edit.

export interface HookDestructure {
  hook: string
  fields: string[]
}

// `const { a, b, c: d, e = f, ...rest } = useXxx(...)` — single or multi-line.
// `[^{}]` keeps the body flat (no nested destructuring), which is the norm for hooks and
// avoids the greedy-brace hazard of skipping past the real closer.
const HOOK_DESTRUCTURE = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(use[A-Z][A-Za-z0-9_]*)\s*\(/g

/**
 * Extract the field set the component destructures from each `useXxx()` hook.
 * Renamed fields (`refresh: refreshTx`) yield the SOURCE key (`refresh`) — that's what
 * the mock's return object must expose. Rest elements and defaults' RHS are ignored.
 */
export function extractHookDestructures(sourceCode: string): HookDestructure[] {
  const byHook = new Map<string, Set<string>>()
  for (const match of sourceCode.matchAll(HOOK_DESTRUCTURE)) {
    const body = match[1]
    const hook = match[2]
    const fields = byHook.get(hook) ?? new Set<string>()
    for (const raw of body.split(',')) {
      const part = raw.trim()
      if (!part || part.startsWith('...')) continue
      // `key: local` → key; `key = default` → key; plain `key` → key.
      const key = part.split(':')[0].split('=')[0].trim()
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) fields.add(key)
    }
    if (fields.size) byHook.set(hook, fields)
  }
  return [...byHook.entries()].map(([hook, fields]) => ({ hook, fields: [...fields] }))
}

/**
 * True when the error looks like a mock returned an object missing a field the component
 * reads — the class of failure a completeness hint addresses. Assertion/type errors are
 * excluded so the hint doesn't pollute unrelated retries.
 */
export function isMissingFieldError(errorOutput: string): boolean {
  return (
    /\bis not a function\b/.test(errorOutput) ||
    /Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '[^']+'\)/.test(errorOutput) ||
    /\b(?:undefined|null) is not an object \(evaluating '[^']+'\)/.test(errorOutput)
  )
}

/**
 * True for an interaction/query failure — an element that never appeared after an action
 * (waitFor timeout, "Unable to find"). In a component whose rendering is driven by mocked
 * hooks, this is very often an INCOMPLETE MOCK SHAPE: a missing sub-field (e.g. a guard reads
 * `activeProfile.kycVerified`, the mock omits it, so the press opens the wrong modal and the
 * awaited element never renders). Surfacing the full hook shape — including object sub-fields —
 * gives the model the fix without a crash to point at.
 */
export function isInteractionFailure(errorOutput: string): boolean {
  return (
    /Unable to find (?:an? )?(?:element|node)/i.test(errorOutput) ||
    /Exceeded timeout|timed out in `?waitFor`?|waitFor.*(?:timed out|exceeded)/i.test(errorOutput)
  )
}

// Sub-properties read off a destructured field: `field.prop` / `field?.prop` NOT followed by `(`
// (so method calls like `berryBalance.toLocaleString()` don't mark a number as an object). `length`
// is excluded so an array field isn't described as an object. Empty ⇒ field is a scalar/callback.
function subPropsOf(sourceCode: string, field: string): string[] {
  const found = new Set<string>()
  const re = new RegExp(`\\b${field}\\??\\.([A-Za-z_$][\\w$]*)\\b(?!\\s*\\()`, 'g')
  for (const m of sourceCode.matchAll(re)) {
    if (m[1] !== 'length') found.add(m[1])
  }
  return [...found]
}

/**
 * Build a "provide the whole hook shape" hint, or null when it doesn't apply.
 * Gated on: (1) the current error is a missing-field error, (2) the component destructures
 * from at least one hook that the test file references (i.e. mocks). Only such hooks are
 * listed, so we never tell the model to mock something it doesn't.
 */
export function buildHookMockHint(
  sourceCode: string | null | undefined,
  testCode: string | null | undefined,
  errorOutput: string | null,
): string | null {
  if (!sourceCode) return null
  // Fix path passes errorOutput → gate on a crash/interaction failure so the hint doesn't pollute
  // unrelated retries. Generate path passes null → always emit (prevention beats repair).
  if (errorOutput != null && !isMissingFieldError(errorOutput) && !isInteractionFailure(errorOutput)) return null

  const relevant = extractHookDestructures(sourceCode).filter(
    // When there's a test file, only list hooks it references (never suggest mocking something the
    // test doesn't). At generation the test doesn't exist yet, so list every destructured hook —
    // the test WILL have to mock them.
    ({ hook, fields }) => fields.length > 0 && (!testCode || testCode.includes(hook)),
  )
  if (relevant.length === 0) return null

  // Annotate object-shaped fields with the sub-properties the component reads, so the model mocks
  // `activeProfile: { kycVerified, kycStatus }` rather than a partial `{ kycStatus }` that trips a
  // `!activeProfile.kycVerified` guard.
  const render = (field: string): string => {
    const sub = subPropsOf(sourceCode, field)
    return sub.length ? `${field} { ${sub.join(', ')} }` : field
  }
  const lines = relevant.map(({ hook, fields }) => `  • ${hook}() → ${fields.map(render).join(', ')}`)
  return (
    'HOOK MOCK COMPLETENESS: The component under test destructures the fields below from these mocked hooks. ' +
    'Each hook mock (mockReturnValue/mockImplementation, in beforeEach AND in every per-test override) MUST return an object ' +
    'that includes ALL of that hook\'s listed fields — not just the one named in the current error. ' +
    'A field shown with `{ … }` is itself an OBJECT whose listed sub-fields the component reads (often in a guard like ' +
    '`if (!activeProfile.kycVerified) return`) — mock it as an object containing at least those sub-fields, never a partial ' +
    'object or undefined, or the component silently takes the wrong branch and an awaited element never renders. ' +
    'A missing field otherwise surfaces one at a time (as an "undefined"/"is not a function" error), so add the ENTIRE set now ' +
    'to resolve the whole cascade in a single edit. Use realistic values: numbers for fields used in arithmetic or `.toLocaleString()`, ' +
    '`jest.fn()` for callbacks, and objects (not undefined) for fields whose properties are read.\n' +
    lines.join('\n')
  )
}

/**
 * Ground assertions about callback outcomes (`expect(showToast).toHaveBeenCalledWith('…')`) in the
 * calls the component ACTUALLY makes. For each hook-provided function field, list the literal
 * first-arguments it's called with in the source. Prevents the model inventing a call the code
 * never makes — e.g. asserting `showToast('Withdrawal method added successfully','success')` when
 * the success path opens a modal and only the ERROR path toasts. Returns null when no such calls
 * exist. Ungated (grounding is always useful); testCode null at generation lists all hooks.
 */
export function buildCallbackOutcomeHint(
  sourceCode: string | null | undefined,
  testCode: string | null | undefined,
): string | null {
  if (!sourceCode) return null
  const hooks = extractHookDestructures(sourceCode).filter(({ hook }) => !testCode || testCode.includes(hook))
  const rows: string[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const { fields } of hooks) {
    for (const f of fields) {
      if (seen.has(f)) continue
      const args = new Set<string>()
      for (const m of sourceCode.matchAll(new RegExp(`\\b${f}\\s*\\(\\s*['"]([^'"\\n]+)['"]`, 'g'))) args.add(m[1])
      if (args.size === 0) continue
      seen.add(f)
      rows.push(`  • ${f}(...) — called only with first-arg: ${[...args].map(a => `'${a}'`).join(', ')}`)
      // Fix path (testCode present): flag any `expect(f).toHaveBeenCalledWith('X', …)` whose message
      // the source never emits — a fabricated assertion that can only be fixed by changing WHAT the
      // test verifies, which the model is otherwise reluctant to do.
      if (testCode) {
        for (const m of testCode.matchAll(new RegExp(`\\b${f}\\s*\\)\\s*\\.toHaveBeenCalledWith\\(\\s*['"]([^'"\\n]+)['"]`, 'g'))) {
          if (!args.has(m[1])) {
            warnings.push(`  ⚠️ A test asserts \`${f}\` was called with '${m[1]}', but the source NEVER calls \`${f}\` with that — the assertion is INVALID. The branch it targets does something else (opens a modal / updates state / navigates). This is a WRONG-PREMISE test: rename its it()/test() title to describe the real behavior and assert what that branch actually does, or delete it. Do not leave the impossible assertion.`)
          }
        }
      }
    }
  }
  if (rows.length === 0) return null

  const body =
    'CALLBACK OUTCOMES — assert only the calls the component ACTUALLY makes. The source invokes these ' +
    'hook-provided callbacks with the literal first-arguments below (some calls may also use dynamic ' +
    'messages). Do NOT assert a call with an invented message/arg the source never makes, and do NOT ' +
    'assume a success path fires a toast — check the source: a success branch often just navigates or ' +
    'opens a modal (assert THAT), while only the error branch toasts.\n' +
    rows.join('\n')
  return warnings.length ? `${body}\n${warnings.join('\n')}` : body
}
