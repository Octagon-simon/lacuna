import type { MemoryEntry, MemoryCategory, MemoryIndex } from './types.js';
export declare function withMemoryLock<T>(fn: () => Promise<T>): Promise<T>;
export declare function readEntry(root: string, category: MemoryCategory, id: string): Promise<MemoryEntry | null>;
export declare function writeEntry(root: string, entry: MemoryEntry): Promise<void>;
export declare function rebuildIndex(root: string): Promise<void>;
export declare function readIndex(root: string): Promise<MemoryIndex>;
export declare function seedIfEmpty(root: string): Promise<number>;
export declare function deleteEntry(root: string, category: MemoryCategory, id: string): Promise<void>;
//# sourceMappingURL=store.d.ts.map