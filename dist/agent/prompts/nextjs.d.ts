export interface NextJsAnalysis {
    hasNavigation: boolean;
    hasHeaders: boolean;
    hasCache: boolean;
    clientModules: string[];
    serverModules: string[];
    sessionProviders: string[];
}
export declare function analyzeNextJs(sourceCode: string): NextJsAnalysis;
export declare function buildNextJsGuidance(a: NextJsAnalysis, mockApi: string, hasFnStyleMockApi?: boolean): string | null;
export declare function detectNextJsImportError(errorOutput: string, mockApi?: string, hasFnStyleMockApi?: boolean): string | null;
//# sourceMappingURL=nextjs.d.ts.map