import type { LacunaConfig } from '../config.js';
import type { MemoryEntry } from './types.js';
export declare function recordTagMatchOutcome(config: LacunaConfig, entries: MemoryEntry[], firstError: string | null, finalError: string | null): Promise<void>;
export interface FixOutcomeParams {
    errorSignature: string;
    tags: string[];
    outcome: 'success' | 'failure';
    diffBefore: string | null;
    diffAfter: string;
}
export declare function recordFixOutcome(config: LacunaConfig, params: FixOutcomeParams): Promise<void>;
//# sourceMappingURL=writeback.d.ts.map