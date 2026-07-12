export declare function hasTestFunctions(code: string): boolean;
export declare function hasPlaceholderBodies(code: string): boolean;
export declare function isZeroTestsOutput(raw: string): boolean;
export declare function enrichNoTestsError(extracted: string, rawOutput?: string, runner?: string): string;
export declare function parsePassCount(output: string): number;
export declare function parseFailCount(output: string): number;
export declare function extractFailureRegion(output: string, maxChars?: number): string;
export declare function stripLeadingProse(code: string): {
    code: string;
    stripped: string | null;
};
export declare function mergeMocksContent(existing: string, incoming: string): string;
export declare function sanitizeMocksContent(raw: string): {
    code: string;
    stripped: boolean;
};
export declare function typeImportOriginalCalls(code: string): string;
export declare function replaceUnsafeFunctionType(code: string): string;
export declare function dedupeImports(code: string): string;
export declare function ensureMockedImports(code: string): string;
export declare function deduplicateViMocks(code: string): string;
export declare function buildStructureBrokenMessage(initialError: string, currentError: string): string;
export declare function buildRegressionMessage(initialError: string, currentError: string, baselinePass: number, currentPass: number): string;
export declare function buildUnhandledErrorMessage(currentError: string, passCount: number): string;
export declare function processExitLeakGuidance(output: string): string;
export type PatchOpType = 'REPLACE_TEST' | 'DELETE_TEST' | 'ADD_AFTER_DESCRIBE' | 'ADD_IMPORT' | 'ADD_AFTER_IMPORTS' | 'REPLACE';
export interface PatchOperation {
    type: PatchOpType;
    anchor: string;
    content: string;
}
export declare function parsePatch(patchOutput: string): PatchOperation[];
export declare function applyPatch(existingCode: string, ops: PatchOperation[]): string | null;
export declare function dedupeTestBlocks(code: string): string;
export declare function tryApplyPatch(existingCode: string, patchOutput: string): string | null;
export interface PatchApplyOk {
    ok: true;
    result: string;
}
export interface PatchApplyFail {
    ok: false;
    failedOp: PatchOperation | null;
    opsCount: number;
}
export declare function tryApplyPatchWithDiag(existingCode: string, patchOutput: string): PatchApplyOk | PatchApplyFail;
export type MockPatchOpType = 'REPLACE' | 'APPEND_EXPORT' | 'ADD_TO_BEFOREEACH';
export interface MockPatchOperation {
    type: MockPatchOpType;
    oldText: string;
    newText: string;
}
export declare function parseMocksPatch(patchOutput: string): MockPatchOperation[];
export declare function applyMocksPatch(existing: string, ops: MockPatchOperation[]): {
    result: string;
    failedOps: MockPatchOperation[];
};
export declare function tryApplyMocksPatch(existing: string, patchOutput: string): {
    result: string;
    failedOps: MockPatchOperation[];
} | null;
//# sourceMappingURL=validate.d.ts.map