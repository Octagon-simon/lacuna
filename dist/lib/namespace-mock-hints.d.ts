export declare function extractNamespaceImports(sourceCode: string): Map<string, {
    module: string;
    members: Set<string>;
}>;
/**
 * Guidance on the required top-level mock shape for every module the source namespace-imports.
 * In fix mode (testCode given) it only flags modules the test actually mocks — the high-signal case.
 * In generate mode it lists them proactively so the first attempt gets the shape right. Not gated on
 * the error kind: the failure this prevents is a WRONG-VALUE assertion, not a missing-field crash.
 */
export declare function buildNamespaceMockHint(sourceCode: string | null | undefined, testCode: string | null | undefined, _errorOutput: string | null): string | null;
export declare function buildHoistedMockOrderHint(errorOutput: string | null, testCode: string | null | undefined): string | null;
//# sourceMappingURL=namespace-mock-hints.d.ts.map