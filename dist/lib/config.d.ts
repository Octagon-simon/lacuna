import { z } from 'zod';
export declare const ConfigSchema: z.ZodObject<{
    testRunner: z.ZodOptional<z.ZodEnum<["jest", "vitest", "pytest", "mocha", "go-test", "phpunit", "pest", "rspec", "cargo-test", "dotnet-test", "gradle-test", "maven-test", "swift-test"]>>;
    coverageFormat: z.ZodDefault<z.ZodEnum<["lcov", "json-summary", "cobertura"]>>;
    coverageDir: z.ZodDefault<z.ZodString>;
    sourceDir: z.ZodEffects<z.ZodDefault<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>>, string[], string | string[] | undefined>;
    threshold: z.ZodDefault<z.ZodNumber>;
    maxIterations: z.ZodDefault<z.ZodNumber>;
    coverageTimeout: z.ZodDefault<z.ZodNumber>;
    testDir: z.ZodOptional<z.ZodString>;
    ignore: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    mocksFile: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>>;
    setupFile: z.ZodOptional<z.ZodString>;
    provider: z.ZodDefault<z.ZodEnum<["anthropic", "openai-compatible"]>>;
    model: z.ZodDefault<z.ZodString>;
    baseURL: z.ZodDefault<z.ZodString>;
    apiKeyEnv: z.ZodDefault<z.ZodString>;
    maxTokens: z.ZodDefault<z.ZodNumber>;
    testCommand: z.ZodOptional<z.ZodString>;
    testEnv: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    debug: z.ZodOptional<z.ZodBoolean>;
    format: z.ZodDefault<z.ZodBoolean>;
    nodeEnvRouting: z.ZodDefault<z.ZodBoolean>;
    memory: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        distill: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        distill: boolean;
    }, {
        enabled?: boolean | undefined;
        distill?: boolean | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    coverageFormat: "lcov" | "json-summary" | "cobertura";
    coverageDir: string;
    sourceDir: string[];
    threshold: number;
    maxIterations: number;
    coverageTimeout: number;
    ignore: string[];
    provider: "anthropic" | "openai-compatible";
    model: string;
    baseURL: string;
    apiKeyEnv: string;
    maxTokens: number;
    testEnv: Record<string, string>;
    format: boolean;
    nodeEnvRouting: boolean;
    memory: {
        enabled: boolean;
        distill: boolean;
    };
    testRunner?: "jest" | "vitest" | "pytest" | "mocha" | "go-test" | "phpunit" | "pest" | "rspec" | "cargo-test" | "dotnet-test" | "gradle-test" | "maven-test" | "swift-test" | undefined;
    testDir?: string | undefined;
    mocksFile?: string | string[] | undefined;
    setupFile?: string | undefined;
    testCommand?: string | undefined;
    debug?: boolean | undefined;
}, {
    testRunner?: "jest" | "vitest" | "pytest" | "mocha" | "go-test" | "phpunit" | "pest" | "rspec" | "cargo-test" | "dotnet-test" | "gradle-test" | "maven-test" | "swift-test" | undefined;
    coverageFormat?: "lcov" | "json-summary" | "cobertura" | undefined;
    coverageDir?: string | undefined;
    sourceDir?: string | string[] | undefined;
    threshold?: number | undefined;
    maxIterations?: number | undefined;
    coverageTimeout?: number | undefined;
    testDir?: string | undefined;
    ignore?: string[] | undefined;
    mocksFile?: string | string[] | undefined;
    setupFile?: string | undefined;
    provider?: "anthropic" | "openai-compatible" | undefined;
    model?: string | undefined;
    baseURL?: string | undefined;
    apiKeyEnv?: string | undefined;
    maxTokens?: number | undefined;
    testCommand?: string | undefined;
    testEnv?: Record<string, string> | undefined;
    debug?: boolean | undefined;
    format?: boolean | undefined;
    nodeEnvRouting?: boolean | undefined;
    memory?: {
        enabled?: boolean | undefined;
        distill?: boolean | undefined;
    } | undefined;
}>;
export declare function iterationCeiling(maxIterations: number): number;
export type LacunaConfig = z.infer<typeof ConfigSchema> & {
    apiKey?: string;
};
export declare function mocksFileList(config: Pick<LacunaConfig, 'mocksFile'>): string[];
export declare function applyModelOverride(config: LacunaConfig, model: string): void;
export declare function loadConfig(cwd?: string): Promise<LacunaConfig>;
//# sourceMappingURL=config.d.ts.map