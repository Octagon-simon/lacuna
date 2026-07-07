export interface DiffScope {
    baseRef: string;
    mergeBase: string;
    changed: Map<string, Set<number>>;
}
export declare class GitDiffError extends Error {
}
export declare function resolveDiffScope(cwd: string, explicitRef?: string): Promise<DiffScope>;
export declare function parseUnifiedDiff(diffOutput: string, cwd: string): Map<string, Set<number>>;
export declare function scopeDiffToDir(scope: DiffScope, absDir: string): DiffScope;
export declare function countChangedLines(changed: Map<string, Set<number>>): number;
//# sourceMappingURL=git-diff.d.ts.map