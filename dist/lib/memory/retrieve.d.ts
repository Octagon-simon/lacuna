import type { LacunaConfig } from '../config.js';
import type { MemoryEntry } from './types.js';
import { MIN_CONFIDENCE } from './types.js';
export { MIN_CONFIDENCE };
export declare const MAX_ENTRIES = 6;
export interface RetrievalContext {
    testRunner: string;
    framework?: string | null;
    dependencies?: string[];
    errorSignature?: string | null;
}
export declare function retrieveMemory(config: LacunaConfig, ctx: RetrievalContext): Promise<MemoryEntry[]>;
export declare function renderMemorySection(entries: MemoryEntry[]): string | null;
export declare function buildMemoryContext(config: LacunaConfig, ctx: RetrievalContext): Promise<string | null>;
export interface FixMemoryHint {
    text: string | null;
    coveredPatterns: string[];
}
export declare function buildFixMemoryHint(config: LacunaConfig, errorOutput: string, _ctx: Omit<RetrievalContext, 'errorSignature'>): Promise<FixMemoryHint>;
//# sourceMappingURL=retrieve.d.ts.map