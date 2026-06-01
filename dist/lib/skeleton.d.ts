export declare function shouldUseSkeleton(code: string): boolean;
/**
 * Returns a skeletonized version of sourceCode.
 * expandFunctions: names of functions whose full body must be included (the uncovered ones).
 * If the file is short enough, returns the original code unchanged.
 */
export declare function buildSourceSkeleton(sourceCode: string, expandFunctions?: string[]): string;
//# sourceMappingURL=skeleton.d.ts.map