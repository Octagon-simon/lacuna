export type TestRunner = 'jest' | 'vitest' | 'pytest' | 'mocha' | 'go-test' | 'phpunit' | 'pest' | 'rspec' | 'cargo-test' | 'dotnet-test' | 'gradle-test' | 'maven-test' | 'swift-test' | 'unknown';
export type Language = 'typescript' | 'javascript' | 'python' | 'go' | 'php' | 'ruby' | 'rust' | 'csharp' | 'java' | 'swift' | 'unknown';
export interface DetectedEnvironment {
    testRunner: TestRunner;
    language: Language;
    testFilePattern: string;
    coverageCommand: string;
    testCommand: string;
}
export declare function envForRunner(runner: string): DetectedEnvironment;
export declare function fileTestCommand(env: DetectedEnvironment, testFilePath: string): string;
export declare function detectEnvironment(cwd?: string, configRunner?: string): Promise<DetectedEnvironment>;
//# sourceMappingURL=detector.d.ts.map