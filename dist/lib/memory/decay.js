import { readdir } from 'fs/promises';
import { join } from 'path';
import { MEMORY_CATEGORIES, MIN_CONFIDENCE } from './types.js';
import { readEntry, writeEntry, withMemoryLock } from './store.js';
// Confidence only moves today on a recorded success/failure outcome (writeback.ts) — an entry
// nobody has hit in months just sits frozen at whatever it last was, even though the library
// version it was learned against may have moved on. This is a lighter, age-only signal: it
// doesn't remove anything (matches the design's "surface, don't silently lose" stance — a
// decayed-to-zero entry stays visible via `lacuna memory list`, just stops being retrieved
// per retrieveMemory's `confidence > MIN_CONFIDENCE` filter).
export const AGE_DECAY_STEP = 0.05;
export const DECAY_INTERVAL_DAYS = 30;
function daysSince(iso, now) {
    return (now.getTime() - Date.parse(iso)) / 86_400_000;
}
export function needsDecay(entry, now) {
    if (entry.confidence <= 0)
        return false;
    const last = entry.last_decayed_at ?? entry.last_used ?? entry.created_at;
    return daysSince(last, now) > DECAY_INTERVAL_DAYS;
}
export function decayEntry(entry, now) {
    return {
        ...entry,
        confidence: Math.round(Math.max(0, entry.confidence - AGE_DECAY_STEP) * 1000) / 1000,
        last_decayed_at: now.toISOString(),
    };
}
// Soft floor: retrieveMemory excludes confidence <= MIN_CONFIDENCE, and outcome-based scoring
// can only ever move an entry that gets retrieved — so once an entry crosses the floor it was
// permanently unreachable, with no way back regardless of how much time passed. This recovers it
// SLOWLY, capped well short of seed confidence: time alone only clears the retrieval floor again,
// it doesn't erase the reason the entry was penalized — further improvement past the ceiling
// requires a real, attributed success (writeback.ts's recordTagMatchOutcome/recordFixOutcome).
export const RECOVERY_STEP = 0.05;
export const RECOVERY_CEILING = 0.35; // just clears retrieveMemory's strict `> MIN_CONFIDENCE` filter
export function needsRecovery(entry, now) {
    if (entry.confidence > MIN_CONFIDENCE)
        return false;
    const last = entry.last_decayed_at ?? entry.last_used ?? entry.created_at;
    return daysSince(last, now) > DECAY_INTERVAL_DAYS;
}
export function recoverEntry(entry, now) {
    return {
        ...entry,
        confidence: Math.round(Math.min(RECOVERY_CEILING, entry.confidence + RECOVERY_STEP) * 1000) / 1000,
        last_decayed_at: now.toISOString(),
    };
}
// Full scan of every category dir under `root`, decaying (and persisting) any entry due for it.
// Cheap at "dozens to low-hundreds of entries" scale — same reasoning as store.ts's full
// rebuildIndex on every write. Returns the count actually changed, for `lacuna memory decay`'s
// user-facing output.
export async function decayStore(root) {
    return withMemoryLock(async () => {
        const now = new Date();
        let changed = 0;
        for (const category of MEMORY_CATEGORIES) {
            let files;
            try {
                files = (await readdir(join(root, category))).filter(f => f.endsWith('.json'));
            }
            catch {
                continue;
            }
            for (const file of files) {
                const id = file.slice(0, -'.json'.length);
                const entry = await readEntry(root, category, id);
                if (!entry)
                    continue;
                if (needsRecovery(entry, now)) {
                    await writeEntry(root, recoverEntry(entry, now));
                    changed++;
                }
                else if (needsDecay(entry, now)) {
                    await writeEntry(root, decayEntry(entry, now));
                    changed++;
                }
            }
        }
        return changed;
    });
}
//# sourceMappingURL=decay.js.map