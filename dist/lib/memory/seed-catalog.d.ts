import type { MemoryEntry } from './types.js';
export type SeedEntryTemplate = Omit<MemoryEntry, 'created_at' | 'last_used' | 'hit_count'>;
export declare const SEED_ENTRIES: SeedEntryTemplate[];
//# sourceMappingURL=seed-catalog.d.ts.map