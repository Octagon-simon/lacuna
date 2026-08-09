export declare function filterMockFileForTest(mocksCode: string, testCode: string): string;
export declare function filterMockFileForSource(mocksCode: string, sourceCode: string): string;
export declare function compressMockFile(code: string): string;
export declare function compressSource(source: string): string;
export declare function shouldUseSkeleton(code: string): boolean;
/**
 * Returns a skeletonized version of sourceCode.
 * expandFunctions: names of functions whose full body must be included (the uncovered ones).
 * expandLines: 1-based line numbers that MUST stay visible — the enclosing block of any such
 *   line is kept expanded (recursing into classes so only the target method survives, its
 *   siblings collapse). This is the reliable path when the coverage report names functions
 *   anonymously (`(anonymous_23)`) or when the target lives inside a class method — name
 *   matching alone then expands nothing and the whole class collapses to an empty shell.
 * If the file is short enough, returns the original code unchanged.
 */
export declare function buildSourceSkeleton(sourceCode: string, expandFunctions?: string[], expandLines?: number[]): string;
//# sourceMappingURL=skeleton.d.ts.map