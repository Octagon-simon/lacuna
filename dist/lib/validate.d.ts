export declare function hasTestFunctions(code: string): boolean;
export declare function enrichNoTestsError(output: string): string;
export declare function isZeroTestsOutput(raw: string): boolean;
export declare function parsePassCount(output: string): number;
export declare function stripLeadingProse(code: string): {
    code: string;
    stripped: string | null;
};
export declare function mergeMocksContent(existing: string, incoming: string): string;
export declare function sanitizeMocksContent(raw: string): {
    code: string;
    stripped: boolean;
};
export declare function buildStructureBrokenMessage(initialError: string, currentError: string): string;
export declare function buildRegressionMessage(initialError: string, currentError: string, baselinePass: number, currentPass: number): string;
//# sourceMappingURL=validate.d.ts.map