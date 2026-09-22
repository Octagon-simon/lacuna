import { z } from 'zod';
export declare const FrameworksEntrySchema: z.ZodObject<{
    id: z.ZodString;
    tags: z.ZodArray<z.ZodString, "many">;
    summary: z.ZodString;
    rule: z.ZodString;
    example: z.ZodOptional<z.ZodString>;
    source: z.ZodEnum<["learned", "web", "seed"]>;
    confidence: z.ZodNumber;
    hit_count: z.ZodNumber;
    last_used: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    last_decayed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    created_from: z.ZodOptional<z.ZodObject<{
        error_signature: z.ZodOptional<z.ZodString>;
        run_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }>>;
} & {
    category: z.ZodLiteral<"frameworks">;
}, "strip", z.ZodTypeAny, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    category: "frameworks";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
}, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    category: "frameworks";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
}>;
export declare const MocksEntrySchema: z.ZodObject<{
    id: z.ZodString;
    tags: z.ZodArray<z.ZodString, "many">;
    summary: z.ZodString;
    rule: z.ZodString;
    example: z.ZodOptional<z.ZodString>;
    source: z.ZodEnum<["learned", "web", "seed"]>;
    confidence: z.ZodNumber;
    hit_count: z.ZodNumber;
    last_used: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    last_decayed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    created_from: z.ZodOptional<z.ZodObject<{
        error_signature: z.ZodOptional<z.ZodString>;
        run_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }>>;
} & {
    category: z.ZodLiteral<"mocks">;
}, "strip", z.ZodTypeAny, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    category: "mocks";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
}, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    category: "mocks";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
}>;
export declare const FixesEntrySchema: z.ZodObject<{
    id: z.ZodString;
    tags: z.ZodArray<z.ZodString, "many">;
    summary: z.ZodString;
    rule: z.ZodString;
    example: z.ZodOptional<z.ZodString>;
    source: z.ZodEnum<["learned", "web", "seed"]>;
    confidence: z.ZodNumber;
    hit_count: z.ZodNumber;
    last_used: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    last_decayed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    created_from: z.ZodOptional<z.ZodObject<{
        error_signature: z.ZodOptional<z.ZodString>;
        run_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }>>;
} & {
    category: z.ZodLiteral<"fixes">;
    error_signature: z.ZodString;
    diff_pattern: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    error_signature: string;
    category: "fixes";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
    diff_pattern?: string | undefined;
}, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    error_signature: string;
    category: "fixes";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
    diff_pattern?: string | undefined;
}>;
export declare const MemoryEntrySchema: z.ZodDiscriminatedUnion<"category", [z.ZodObject<{
    id: z.ZodString;
    tags: z.ZodArray<z.ZodString, "many">;
    summary: z.ZodString;
    rule: z.ZodString;
    example: z.ZodOptional<z.ZodString>;
    source: z.ZodEnum<["learned", "web", "seed"]>;
    confidence: z.ZodNumber;
    hit_count: z.ZodNumber;
    last_used: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    last_decayed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    created_from: z.ZodOptional<z.ZodObject<{
        error_signature: z.ZodOptional<z.ZodString>;
        run_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }>>;
} & {
    category: z.ZodLiteral<"frameworks">;
}, "strip", z.ZodTypeAny, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    category: "frameworks";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
}, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    category: "frameworks";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    tags: z.ZodArray<z.ZodString, "many">;
    summary: z.ZodString;
    rule: z.ZodString;
    example: z.ZodOptional<z.ZodString>;
    source: z.ZodEnum<["learned", "web", "seed"]>;
    confidence: z.ZodNumber;
    hit_count: z.ZodNumber;
    last_used: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    last_decayed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    created_from: z.ZodOptional<z.ZodObject<{
        error_signature: z.ZodOptional<z.ZodString>;
        run_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }>>;
} & {
    category: z.ZodLiteral<"mocks">;
}, "strip", z.ZodTypeAny, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    category: "mocks";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
}, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    category: "mocks";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
}>, z.ZodObject<{
    id: z.ZodString;
    tags: z.ZodArray<z.ZodString, "many">;
    summary: z.ZodString;
    rule: z.ZodString;
    example: z.ZodOptional<z.ZodString>;
    source: z.ZodEnum<["learned", "web", "seed"]>;
    confidence: z.ZodNumber;
    hit_count: z.ZodNumber;
    last_used: z.ZodNullable<z.ZodString>;
    created_at: z.ZodString;
    last_decayed_at: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    created_from: z.ZodOptional<z.ZodObject<{
        error_signature: z.ZodOptional<z.ZodString>;
        run_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }, {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    }>>;
} & {
    category: z.ZodLiteral<"fixes">;
    error_signature: z.ZodString;
    diff_pattern: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    error_signature: string;
    category: "fixes";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
    diff_pattern?: string | undefined;
}, {
    id: string;
    tags: string[];
    summary: string;
    rule: string;
    source: "learned" | "web" | "seed";
    confidence: number;
    hit_count: number;
    last_used: string | null;
    created_at: string;
    error_signature: string;
    category: "fixes";
    example?: string | undefined;
    last_decayed_at?: string | null | undefined;
    superseded_by?: string | null | undefined;
    created_from?: {
        error_signature?: string | undefined;
        run_id?: string | undefined;
    } | undefined;
    diff_pattern?: string | undefined;
}>]>;
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export type FixesEntry = z.infer<typeof FixesEntrySchema>;
export type MemoryCategory = MemoryEntry['category'];
export declare const MEMORY_CATEGORIES: MemoryCategory[];
export declare const MIN_CONFIDENCE = 0.3;
export type MemoryIndex = Record<string, string[]>;
//# sourceMappingURL=types.d.ts.map