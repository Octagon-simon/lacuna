import { mkdir, readFile, writeFile, rename, readdir, unlink, access, open, stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { MEMORY_CATEGORIES, MemoryEntrySchema } from './types.js';
import { entryPath, indexPath, globalMemoryRoot } from './paths.js';
import { SEED_ENTRIES } from './seed-catalog.js';
// Serializes access WITHIN this process (mirrors validate.ts's withMocksLock — same
// one-at-a-time promise-chain pattern). On its own this does NOT protect the store: since
// memory is a single global store (~/.lacuna/memory, not project-scoped — see paths.ts),
// running lacuna on several projects at once means several SEPARATE processes writing to the
// SAME store concurrently, which this in-process chain has no visibility into. The
// cross-process lockfile below (acquireCrossProcessLock) is what actually protects that case;
// this promise chain just avoids two writes from the SAME process interleaving pointlessly.
let memoryLock = Promise.resolve();
const LOCK_STALE_MS = 30_000; // a lock older than this is assumed abandoned by a crashed process
const LOCK_MAX_RETRIES = 100;
const LOCK_RETRY_DELAY_MS = 50; // *100 retries ≈ 5s worst-case wait, generous for a full index rebuild
// Cross-process mutual exclusion via exclusive file creation ('wx' fails with EEXIST if the
// file already exists) — the same technique git (.git/index.lock) and npm/yarn use for their
// own lockfiles, and needs no new dependency. A process that holds the lock writes its own PID
// into the file (useful for manual debugging, not read back programmatically) and the file's
// mtime doubles as a staleness clock: if some earlier process crashed while holding the lock
// (killed mid-write, no chance to clean up), a lock older than LOCK_STALE_MS is broken rather
// than left to deadlock every future run forever.
async function acquireCrossProcessLock(root) {
    const lockPath = join(root, '.lock');
    try {
        await mkdir(root, { recursive: true });
    }
    catch {
        return async () => { }; // can't even create the root — fail open, in-process chain still applies
    }
    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
        try {
            const handle = await open(lockPath, 'wx');
            await handle.writeFile(String(process.pid));
            await handle.close();
            return async () => { await unlink(lockPath).catch(() => { }); };
        }
        catch (err) {
            if (err.code !== 'EEXIST') {
                return async () => { }; // unexpected fs error — fail open rather than block memory entirely
            }
            try {
                const st = await stat(lockPath);
                if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
                    await unlink(lockPath).catch(() => { });
                    continue; // retry immediately — the stale lock is gone
                }
            }
            catch { /* lock vanished between the EEXIST and this stat (its holder just released it) — retry */ }
            await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY_MS));
        }
    }
    // Exhausted retries (another process has held the lock for the whole ~5s window, or is
    // itself stuck) — fail open rather than hang the agent loop indefinitely. Worst case reverts
    // to the old "later full-rebuild wins" behavior for this one operation, never corruption.
    return async () => { };
}
export function withMemoryLock(fn) {
    const run = memoryLock.then(async () => {
        const release = await acquireCrossProcessLock(globalMemoryRoot());
        try {
            return await fn();
        }
        finally {
            await release();
        }
    });
    memoryLock = run.then(() => { }, () => { });
    return run;
}
async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}
// All I/O here is fail-soft by design: a missing/unwritable $HOME (real risk in some CI
// containers — this is the first homedir() use in the codebase) must degrade to "no memory
// this run", never throw into the agent loop the way a real generate/fix failure would.
export async function readEntry(root, category, id) {
    try {
        const raw = await readFile(entryPath(root, category, id), 'utf-8');
        const parsed = MemoryEntrySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
// Atomic write (tmp file + rename) so a crash mid-write never leaves a truncated/corrupt entry
// for the next run to trip over. Rebuilds the index afterward so tag lookups stay consistent.
export async function writeEntry(root, entry) {
    const path = entryPath(root, entry.category, entry.id);
    try {
        await ensureDir(dirname(path));
        const tmp = join(dirname(path), `.${entry.id}.${randomUUID()}.tmp`);
        await writeFile(tmp, JSON.stringify(entry, null, 2), 'utf-8');
        await rename(tmp, path);
        await rebuildIndex(root);
    }
    catch {
        /* best-effort — never crash the agent for memory-store I/O */
    }
}
// Full rescan of every category directory under `root`. Simplest correct option at "dozens to
// low-hundreds of entries per scope" (the design doc's own scale estimate) — incremental
// patching would need to correctly retract stale tags when an entry's tags change on update,
// a second failure mode for no measurable benefit at this scale. Write-back is infrequent
// (once per confirmed-passing file, not per token/attempt), so a full rescan on every write
// is cheap relative to the model call that triggered it.
export async function rebuildIndex(root) {
    try {
        const index = {};
        for (const category of MEMORY_CATEGORIES) {
            const dir = join(root, category);
            let files;
            try {
                files = (await readdir(dir)).filter(f => f.endsWith('.json'));
            }
            catch {
                continue; // category dir doesn't exist yet — nothing to index
            }
            for (const file of files) {
                const id = file.slice(0, -'.json'.length);
                const entry = await readEntry(root, category, id);
                if (!entry)
                    continue;
                const key = `${category}/${id}`;
                for (const tag of entry.tags) {
                    if (!index[tag])
                        index[tag] = [];
                    if (!index[tag].includes(key))
                        index[tag].push(key);
                }
            }
        }
        await ensureDir(root);
        const tmp = join(root, `.index.${randomUUID()}.tmp`);
        await writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
        await rename(tmp, indexPath(root));
    }
    catch {
        /* best-effort */
    }
}
export async function readIndex(root) {
    try {
        const raw = await readFile(indexPath(root), 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
function seededMarkerPath(root) {
    return join(root, '.seeded');
}
// Legacy stores (seeded before this per-ID tracking existed) have a bare ISO-timestamp string as
// their sentinel content, not JSON — JSON.parse on that throws, which is how this tells the two
// formats apart. Returns null for "no sentinel data usable" (either no sentinel file at all, or
// a legacy bare-timestamp one) — NOT the same as "never seeded", see isLegacySentinel below.
async function readSentinelData(root) {
    try {
        const raw = await readFile(seededMarkerPath(root), 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && Array.isArray(parsed.seededIds) ? parsed : null;
    }
    catch {
        return null;
    }
}
async function isSeeded(root) {
    try {
        await access(seededMarkerPath(root));
        return true;
    }
    catch {
        return false;
    }
}
async function writeSentinelData(root, data) {
    try {
        await ensureDir(root);
        await writeFile(seededMarkerPath(root), JSON.stringify(data), 'utf-8');
    }
    catch {
        /* best-effort — if the sentinel can't be written, worst case we reseed everything again next
           time (harmless, writeEntry overwrites by id) rather than silently never seeding */
    }
}
// Populates a brand-new store with SEED_ENTRIES (src/lib/memory/seed-catalog.ts) the first time
// memory is used, so day-one retrieval isn't empty — see the design plan's "auto-seed on empty
// store" phase. ALSO reconciles an already-seeded store against the current catalog: any entry
// SEED_ENTRIES has gained since this store was last seeded gets added, without touching entries
// the user has since edited or deleted (their ID stays recorded in seededIds either way). Safe to
// call from multiple places (the lazy per-process check in retrieve.ts AND the explicit
// `lacuna init` step). Wrapped in withMemoryLock so concurrent -w N workers in the same process
// don't race to seed/reconcile twice.
export async function seedIfEmpty(root) {
    return withMemoryLock(async () => {
        const existing = await readSentinelData(root);
        const legacySentinelPresent = existing === null && (await isSeeded(root));
        const seededIds = new Set(existing?.seededIds ?? []);
        if (legacySentinelPresent) {
            // One-time migration: a legacy sentinel can't tell us which IDs it originally covered, so
            // conservatively treat every catalog ID that already has a file on disk as "already
            // offered" (don't touch it) — this avoids reviving anything deleted UNDER THE OLD sentinel.
            // Only genuinely NEW catalog entries (no file present) get added below, exactly once, after
            // which this store carries the new per-ID sentinel and behaves precisely from then on.
            for (const template of SEED_ENTRIES) {
                if (await readEntry(root, template.category, template.id))
                    seededIds.add(template.id);
            }
        }
        const missing = SEED_ENTRIES.filter(t => !seededIds.has(t.id));
        if (missing.length === 0) {
            if (legacySentinelPresent)
                await writeSentinelData(root, { seededAt: new Date().toISOString(), seededIds: [...seededIds] });
            return 0;
        }
        const now = new Date().toISOString();
        for (const template of missing) {
            await writeEntry(root, { ...template, created_at: now, last_used: null, hit_count: 0 });
            seededIds.add(template.id);
        }
        await writeSentinelData(root, { seededAt: now, seededIds: [...seededIds] });
        return missing.length;
    });
}
// Zero-confidence entries are flagged, never auto-deleted (surfacing "this hasn't proven
// useful" is safer than silently losing something — matches the design doc's stance).
// Exposed for a future `lacuna memory` review command; unused by Phase 1's write path itself.
export async function deleteEntry(root, category, id) {
    try {
        await unlink(entryPath(root, category, id));
        await rebuildIndex(root);
    }
    catch {
        /* best-effort */
    }
}
//# sourceMappingURL=store.js.map