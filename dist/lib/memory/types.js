import { z } from 'zod';
// Common envelope shared by every memory entry regardless of category. `created_at` is a
// necessary addition beyond the original design sketch (lacuna-memory-design.md) — needed to
// reason about entry age for future decay/pruning even though Phase 1 doesn't decay on age alone.
const EnvelopeBase = z.object({
    id: z.string(),
    tags: z.array(z.string()),
    summary: z.string(),
    rule: z.string(),
    example: z.string().optional(),
    source: z.enum(['learned', 'web', 'seed']),
    confidence: z.number().min(0).max(1),
    hit_count: z.number().int().min(0),
    last_used: z.string().nullable(),
    created_at: z.string(),
    // Both .optional() (not required-with-default): entries already on disk before this field
    // existed (including this session's own real seed entries in ~/.lacuna/memory/) must still
    // parse cleanly with MemoryEntrySchema.safeParse without a migration step.
    last_decayed_at: z.string().nullable().optional(), // decay.ts's age-based confidence decay
    superseded_by: z.string().nullable().optional(), // set via `lacuna memory supersede` — excluded from retrieval
    created_from: z.object({
        error_signature: z.string().optional(),
        run_id: z.string().optional(),
    }).optional(),
});
export const FrameworksEntrySchema = EnvelopeBase.extend({ category: z.literal('frameworks') });
export const MocksEntrySchema = EnvelopeBase.extend({ category: z.literal('mocks') });
// error_signature also doubles as the entry's filename stem (fixes/<error_signature>.json) —
// see paths.ts/store.ts — so an exact-match lookup is a direct file read, not an index scan.
export const FixesEntrySchema = EnvelopeBase.extend({
    category: z.literal('fixes'),
    error_signature: z.string(),
    diff_pattern: z.string().optional(),
});
export const MemoryEntrySchema = z.discriminatedUnion('category', [
    FrameworksEntrySchema,
    MocksEntrySchema,
    FixesEntrySchema,
]);
export const MEMORY_CATEGORIES = ['frameworks', 'mocks', 'fixes'];
// Defined here (a leaf module with no deps on retrieve.ts/decay.ts) rather than in retrieve.ts,
// where it conceptually belongs — decay.ts's soft-floor recovery needs this same threshold, and
// retrieve.ts already imports decayStore from decay.ts, so decay.ts importing MIN_CONFIDENCE back
// from retrieve.ts would cycle. retrieve.ts re-exports it so its own public API is unchanged.
export const MIN_CONFIDENCE = 0.3;
//# sourceMappingURL=types.js.map