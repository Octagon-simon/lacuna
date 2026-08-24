// Mock/source call-shape hints — found by dogfooding lacuna's own `fix` command against a real
// production project's stubborn failing test files. Two DIFFERENT patterns recurred repeatedly
// across independent files, each evidenced multiple times, not guessed at:
//
// 1. A test mocks a factory's return object with methods that don't match what the source
//    actually calls on it (`findByIdAndUpdate` vs. the real `.updateById()`; `deleteMany` vs.
//    `.findOneAndDelete()`; `.create` vs. `.addLog()`). detectMockShapeMismatch (prompts/index.ts)
//    only catches the subset that actually throws "X is not a function" at runtime — most of
//    these didn't throw, they just silently drove the wrong branch or a wrong assertion.
// 2. `jest.clearAllMocks()` clears call history but NOT a previously-set `.mockResolvedValue()`/
//    `.mockReturnValue()`, so one test's override silently leaks into every later test that
//    doesn't re-set the same mock — this was the CONFIRMED root cause of a real OOM crash
//    (a stale truthy mock fed an unbounded recursive retry loop in the source).
//
// Neither of these needs to resolve jest.mock() import paths to a real file on disk — both are
// fully determinable from sourceCode + testCode alone, mirroring service-mock-hints.ts's own
// `buildServiceMockHint(sourceCode, testCode, errorOutput)` shape and wiring.
import { isMissingFieldError } from './hook-mock-hints.js';
import { findCallEnd } from './validate.js';
// Scoped to this codebase's (and the dogfooding project's) common DI convention:
// createXxxRepo().methodName(...) — matches service-mock-hints.ts's own naming-convention
// heuristic (`looksLikeService`'s `/^[A-Z]/`) rather than trying to catch every possible call shape.
const FACTORY_METHOD_CALL = /\b(create[A-Z]\w*)\s*\(\s*\)\s*\.(\w+)\s*\(/g;
/**
 * Build a "your mock is missing a method the source actually calls" hint, or null when it
 * doesn't apply.
 *
 * @param errorOutput  When provided (fix), gates on a missing-field-shaped error so the hint
 *                      doesn't pollute unrelated retries. When null (generate), always emits if
 *                      a mismatch is found — prevention beats repair.
 */
export function buildMockCallMismatchHint(sourceCode, testCode, errorOutput) {
    if (!sourceCode || !testCode)
        return null;
    if (errorOutput != null && !isMissingFieldError(errorOutput))
        return null;
    const mismatches = new Map(); // factory -> methods the source calls that no mock provides
    for (const [, factory, method] of sourceCode.matchAll(FACTORY_METHOD_CALL)) {
        // Loose but robust: does this exact method name appear ANYWHERE in the test file as a mocked
        // object property key? False negatives (the name coincidentally used elsewhere) are safe —
        // worst case we just don't flag it; false positives are what we're avoiding.
        if (new RegExp(`\\b${method}\\s*:`).test(testCode))
            continue;
        if (!mismatches.has(factory))
            mismatches.set(factory, new Set());
        mismatches.get(factory).add(method);
    }
    if (mismatches.size === 0)
        return null;
    const rows = [...mismatches].map(([factory, methods]) => `  • ${factory}() → .${[...methods].join('(), .')}()`);
    return ("MOCK/SOURCE METHOD MISMATCH: the source calls these methods on a mocked factory's result, but no mock in this test file provides them as an object property:\n" +
        rows.join('\n') + '\n' +
        'The mocked object needs a method with this EXACT name (as a jest.fn()/vi.fn() stub) — check the real class/repo this factory returns for its actual method names, do not guess or reuse a similar-sounding one from a different file.\n' +
        "Two related shapes of the same problem: if the mocked class defines the method as an instance field (`method = jest.fn()`) but the test accesses it via `.prototype.method`, the override never applies — hoist a shared jest.fn() and assign it to both the field and `.prototype`. If the source chains a call off the mocked method (e.g. `.findOne(...).lean()`), a bare `.mockResolvedValue(...)` isn't chainable — return an object whose `.lean()`/`.select()` etc. themselves resolve the value.");
}
const MOCK_OVERRIDE_CALL = /\b([A-Za-z_$][\w$]*)\.(mockResolvedValue|mockReturnValue|mockImplementation)\s*\(/g;
// Extracts every "not-Once" mock-override call (`ident.mockResolvedValue(...)` etc.) that occurs
// directly inside the block spanning [start, end) — used once for the shared beforeEach/
// beforeAll body and once per it()/test() block, so a leak can be told apart from a legitimate
// per-test override that's ALSO restored in the shared setup.
function overriddenIdentsIn(code, start, end) {
    const idents = new Set();
    const region = code.slice(start, end);
    for (const m of region.matchAll(MOCK_OVERRIDE_CALL))
        idents.add(m[1]);
    return idents;
}
/**
 * Build a "these mock overrides never get restored, so they can leak into later tests" hint, or
 * null when it doesn't apply. Purely a test-file text analysis — mechanical, not model judgment,
 * so it's low false-positive risk by construction (only fires on a pattern actually present).
 */
export function buildMockLeakageHint(testCode) {
    if (!testCode)
        return null;
    const usesClearNotReset = /\bclearAllMocks\s*\(\s*\)/.test(testCode) && !/\bresetAllMocks\s*\(\s*\)/.test(testCode);
    if (!usesClearNotReset)
        return null;
    // Gather every override restored somewhere in a shared beforeEach/beforeAll block. Matches only
    // up to the CALL's own opening paren (mirroring the it()/test() pattern below, and dedupeScope's
    // identical convention) — findCallEnd expects to start AT an opening `(` and tracks paren depth
    // together with any nested braces in the arrow body, not the other way around.
    const restored = new Set();
    const sharedSetupRe = /\b(?:beforeEach|beforeAll)\s*\(/g;
    for (const m of testCode.matchAll(sharedSetupRe)) {
        const parenIdx = m.index + m[0].length - 1;
        const end = findCallEnd(testCode, parenIdx);
        if (end === -1)
            continue;
        for (const ident of overriddenIdentsIn(testCode, m.index, end))
            restored.add(ident);
    }
    // Gather every override set inside an it()/test() block that ISN'T also restored above.
    const leaked = new Set();
    const testBlockRe = /\b(?:it|test)\s*\(/g;
    for (const m of testCode.matchAll(testBlockRe)) {
        const parenIdx = m.index + m[0].length - 1;
        const end = findCallEnd(testCode, parenIdx);
        if (end === -1)
            continue;
        for (const ident of overriddenIdentsIn(testCode, m.index, end)) {
            if (!restored.has(ident))
                leaked.add(ident);
        }
    }
    if (leaked.size === 0)
        return null;
    return ('MOCK STATE LEAKAGE RISK: jest.clearAllMocks() clears call history but NOT a previously-set .mockResolvedValue()/.mockReturnValue()/.mockImplementation() — these mocks are overridden inside an it()/test() block but never restored in a shared beforeEach/beforeAll, so an earlier test\'s override can silently leak into later ones:\n' +
        [...leaked].map(n => `  • ${n}`).join('\n') + '\n' +
        'Either restore each of these to a safe default in beforeEach, or use .mockResolvedValueOnce()/.mockReturnValueOnce()/.mockImplementationOnce() instead of the non-Once form when a test only needs a ONE-TIME override.');
}
//# sourceMappingURL=mock-call-hints.js.map