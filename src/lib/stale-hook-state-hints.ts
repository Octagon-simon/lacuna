// Error-driven hint for the two look-alike failures where an assertion on a hook's `result.current.X`
// receives a stale/absent value (null / false / undefined). They need OPPOSITE fixes, so this is
// source-aware:
//
//   1. X IS returned by the hook, but was read right after a SYNCHRONOUS state-changing call without
//      act() → the setState hasn't flushed to `result.current`, so it reads the stale value. FIX:
//      wrap the trigger in a synchronous `act(() => { … })` (from 'react'). (e.g. a hook that starts a collection
//      reads `startingId` right after `start()`.) waitFor does NOT help — the value is set
//      synchronously; there is nothing async to wait for.
//
//   2. X is NOT in the hook's return object (it's internal useState the hook uses but never returns)
//      → `result.current.X` is permanently undefined. FIX: delete the assertion and assert the
//      observable OUTCOME instead (the service the value was passed to). (e.g. an onboarding hook that asserts
//      `result.current.socialToken`, which the hook keeps in state but only returns `socialProvider`.)
//
// A general prompt rule for this gets drowned out among the many RNTL rules and contradicted by the
// "prefer waitFor over act" guidance; injected ON the exact failing error it is far more likely to land.

// `expect(result.current.<field>)...` with a stale/absent received value.
const STALE_CURRENT_RE = /result\.current\.([A-Za-z_$][\w$]*)/
const STALE_RECEIVED_RE = /Received:\s*(null|false|undefined)\b/i

// Does the hook's source RETURN `field` (a key in any `return { … }`), vs. only hold it in useState?
function hookReturnsField(sourceCode: string, field: string): boolean {
  const key = new RegExp(`(?:^|[{,\\s])${field}\\s*[,:}]`)
  for (let i = sourceCode.indexOf('return'); i !== -1; i = sourceCode.indexOf('return', i + 6)) {
    const braceStart = sourceCode.indexOf('{', i)
    if (braceStart === -1 || braceStart - i > 12) continue // not `return {`
    // scan to the matching brace (string/comment-naive, but hook return objects are simple)
    let depth = 0
    let end = braceStart
    for (; end < sourceCode.length; end++) {
      const c = sourceCode[end]
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) break }
    }
    const block = sourceCode.slice(braceStart, end + 1)
    if (key.test(block)) return true
  }
  return false
}

export function buildStaleHookStateHint(
  errorOutput: string | null,
  testCode: string | null | undefined,
  sourceCode: string | null | undefined,
): string | null {
  if (!errorOutput) return null
  const fieldMatch = STALE_CURRENT_RE.exec(errorOutput)
  if (!fieldMatch || !STALE_RECEIVED_RE.test(errorOutput)) return null
  const field = fieldMatch[1]

  const returned = sourceCode ? hookReturnsField(sourceCode, field) : true // assume returned if unknown

  if (!returned) {
    return (
      `STALE HOOK FIELD — \`${field}\` IS NOT RETURNED BY THE HOOK: the test asserts ` +
      `\`result.current.${field}\` but the hook keeps \`${field}\` in internal state and never returns it, so ` +
      `\`result.current.${field}\` is ALWAYS undefined. Do NOT add act() or waitFor — the field does not ` +
      `exist on the result. DELETE this assertion and instead assert the OBSERVABLE outcome that used ` +
      `\`${field}\` (e.g. the service it was passed to: \`expect(someService).toHaveBeenCalledWith(<the value>)\`), ` +
      `or assert a field the hook actually returns. Read the hook's \`return { … }\` and assert only those keys.`
    )
  }

  return (
    `STALE HOOK STATE — MISSING act(): the test reads \`result.current.${field}\` right after a ` +
    `state-changing call and got the stale value, because the synchronous setState hasn't been flushed ` +
    `to \`result.current\` yet. waitFor does NOT fix this (the value is set synchronously; there is nothing ` +
    `async to wait for). Wrap the TRIGGERING call in a SYNCHRONOUS act (from 'react', NOT from RNTL):\n` +
    `  import { act } from 'react';\n` +
    `  let p!: Promise<unknown>;\n` +
    `  act(() => { p = result.current.<method>(<args>); });   // flushes ${field}\n` +
    `  expect(result.current.${field}).toBe(<expected>);        // now up to date\n` +
    `  await act(async () => { <resolve the deferred>; await p; });  // settle the async part\n` +
    `For a purely-synchronous callback (no promise), just: act(() => { result.current.<method>(); }); then assert.`
  )
}
