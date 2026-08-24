/** Map of service identifier → set of methods the component consumes asynchronously. */
export declare function extractAsyncServiceCalls(sourceCode: string): Map<string, Set<string>>;
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
export declare function buildServiceMockHint(sourceCode: string | null | undefined, testCode: string | null | undefined, errorOutput: string | null): string | null;
//# sourceMappingURL=service-mock-hints.d.ts.map