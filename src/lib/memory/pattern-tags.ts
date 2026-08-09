// Precise retrieval tags derived from the shape of a real error, not just the test runner name.
// Without this, EVERY jest-tagged entry surfaces for every jest failure regardless of whether
// it's actually relevant (e.g. a wrong-arity jest.fn<> entry showing up for an unrelated
// incomplete-mock error) — wasting prompt space and diluting the signal. A `never`-type failure
// should pull only the never-type-mock entry.
//
// These regexes are DELIBERATELY COPIED from src/agent/prompts/index.ts's detectTypeScriptErrors
// rather than imported from it. That function is an already-verified, delicate system — this
// session's own post-mortem found a "universal" jest.fn<T>() claim there was wrong for a real
// @types/jest version and had to be corrected against actual tsc output. Refactoring it to
// import from lib/memory for a DRY-ness win isn't worth the regression risk; this module copies
// the same patterns independently and is safe to get slightly out of sync with — it only ever
// affects which memory entries get retrieved, never what detectTypeScriptErrors itself renders.
export interface PatternTag {
  tag: string
  test: (errorOutput: string) => boolean
}

// Exported individually (rather than left as inline string literals) so consumers outside this
// module — specifically detectTypeScriptErrors's coveredPatterns gating in
// src/agent/prompts/index.ts — reference the tag through an import, not a re-typed literal. A
// rename here then becomes a compile error at every call site instead of a silent mismatch.
export const TAG_NEVER_TYPE_MOCK = 'never-type-mock'
export const TAG_INCOMPLETE_MOCK = 'incomplete-mock'
export const TAG_UNSAFE_CAST = 'unsafe-cast'
export const TAG_RESERVED_WORD_IMPORT = 'reserved-word-import'
export const TAG_ENUM_COLLISION = 'enum-collision'
export const TAG_SIGNATURE_NARROWING = 'signature-narrowing'
export const TAG_WRONG_ARITY_JEST_FN = 'wrong-arity-jest-fn'
export const TAG_TOP_LEVEL_AWAIT = 'top-level-await'
export const TAG_REPEATED_ERROR_MULTIPLE_LOCATIONS = 'repeated-error-multiple-locations'

export const PATTERN_TAGS: PatternTag[] = [
  { tag: TAG_NEVER_TYPE_MOCK, test: e => /is not assignable to parameter of type 'never'/.test(e) },
  { tag: TAG_INCOMPLETE_MOCK, test: e => /is missing the following properties from type/.test(e) },
  { tag: TAG_UNSAFE_CAST, test: e => /TS2352[\s\S]*may be a mistake/.test(e) },
  { tag: TAG_RESERVED_WORD_IMPORT, test: e => /TS1003/.test(e) && /\{[^}]*\bdefault\b[^}]*\}\s*from/.test(e) },
  { tag: TAG_ENUM_COLLISION, test: e => /Type '(\w+)\.\w+' is not assignable to type '\1'/.test(e) },
  { tag: TAG_SIGNATURE_NARROWING, test: e => /Types of parameters '(\w+)' and '\1' are incompatible/.test(e) },
  { tag: TAG_WRONG_ARITY_JEST_FN, test: e => /(TS2743|TS2558)/.test(e) && /jest\.fn</.test(e) },
  { tag: TAG_TOP_LEVEL_AWAIT, test: e => /TS1378/.test(e) },
  // Not tied to any one TS code — the SAME error message recurring across 2+ diagnostics is the
  // systemic-repeat pattern regardless of what triggered it. Threshold of 2 matches the same
  // "systemic, not separate" grouping already shipped in prompts/index.ts's detectTypeScriptErrors
  // (byReqType/neverMismatches use `lines.length >= 2` for the identical judgment call).
  { tag: TAG_REPEATED_ERROR_MULTIPLE_LOCATIONS, test: e => {
    const messages = [...e.matchAll(/error TS\d+:\s*([^\n]+)/g)].map(m => m[1].trim())
    const counts = new Map<string, number>()
    for (const msg of messages) counts.set(msg, (counts.get(msg) ?? 0) + 1)
    return [...counts.values()].some(c => c >= 2)
  } },
]

export function detectPatternTags(errorOutput: string): string[] {
  return PATTERN_TAGS.filter(p => p.test(errorOutput)).map(p => p.tag)
}
