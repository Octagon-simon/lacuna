import type { MemoryEntry } from './types.js';
export declare const AGE_DECAY_STEP = 0.05;
export declare const DECAY_INTERVAL_DAYS = 30;
export declare function needsDecay(entry: MemoryEntry, now: Date): boolean;
export declare function decayEntry(entry: MemoryEntry, now: Date): MemoryEntry;
export declare const RECOVERY_STEP = 0.05;
export declare const RECOVERY_CEILING = 0.35;
export declare function needsRecovery(entry: MemoryEntry, now: Date): boolean;
export declare function recoverEntry(entry: MemoryEntry, now: Date): MemoryEntry;
export declare function decayStore(root: string): Promise<number>;
//# sourceMappingURL=decay.d.ts.map