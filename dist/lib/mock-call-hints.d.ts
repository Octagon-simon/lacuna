/**
 * Build a "your mock is missing a method the source actually calls" hint, or null when it
 * doesn't apply.
 *
 * @param errorOutput  When provided (fix), gates on a missing-field-shaped error so the hint
 *                      doesn't pollute unrelated retries. When null (generate), always emits if
 *                      a mismatch is found — prevention beats repair.
 */
export declare function buildMockCallMismatchHint(sourceCode: string | null | undefined, testCode: string | null | undefined, errorOutput: string | null): string | null;
/**
 * Build a "these mock overrides never get restored, so they can leak into later tests" hint, or
 * null when it doesn't apply. Purely a test-file text analysis — mechanical, not model judgment,
 * so it's low false-positive risk by construction (only fires on a pattern actually present).
 */
export declare function buildMockLeakageHint(testCode: string | null | undefined): string | null;
//# sourceMappingURL=mock-call-hints.d.ts.map