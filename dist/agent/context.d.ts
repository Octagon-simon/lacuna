import type { DetectedEnvironment } from '../lib/detector.js';
import type { LacunaConfig } from '../lib/config.js';
export interface FileContext {
    sourceFile: string;
    sourceCode: string;
    existingTestFile: string | null;
    existingTestCode: string | null;
    suggestedTestFile: string;
    sourceImportPath: string | null;
    mocksCode: string | null;
    mocksImportPath: string | null;
    setupFileCode: string | null;
    packageDeps: string | null;
    tsconfigPaths: string | null;
    typeDefinitions: string | null;
    localImportPaths: string[] | null;
    localImportContents: string | null;
    reactMajorVersion: number | null;
}
export declare function computeRelativeImport(fromFile: string, toFile: string): string;
export declare function findFileByName(dir: string, filename: string, depth?: number, maxDepth?: number): Promise<string | null>;
export declare function findExistingTestFile(sourceFile: string, cwd: string, sourceDirs?: string[]): Promise<string | null>;
export interface ModuleSpecifier {
    path: string;
    names: string[] | null;
}
export declare function collectTypeDefinitions(sourceCode: string, absoluteSourcePath: string, cwd: string): Promise<string | null>;
export declare function collectLocalImportPaths(sourceCode: string, absoluteSourcePath: string, absoluteTestFilePath: string, cwd: string): Promise<string[] | null>;
export declare function collectUsedSymbolsContext(sourceCode: string, absoluteSourcePath: string, cwd: string): Promise<string | null>;
export declare function detectReactMajorVersion(cwd: string): Promise<number | null>;
export declare function buildFixFileContext(absTestPath: string, cwd: string, config?: LacunaConfig): Promise<Pick<FileContext, 'mocksCode' | 'mocksImportPath' | 'setupFileCode' | 'packageDeps' | 'tsconfigPaths'>>;
export declare function buildFileContext(sourceFilePath: string, cwd: string, env: DetectedEnvironment, config?: LacunaConfig): Promise<FileContext>;
//# sourceMappingURL=context.d.ts.map