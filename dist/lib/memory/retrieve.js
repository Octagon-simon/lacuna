import { MIN_CONFIDENCE } from './types.js';
import { globalMemoryRoot } from './paths.js';
import { readEntry, readIndex, seedIfEmpty } from './store.js';
import { normalizeErrorSignature, errorSignatureHash } from './normalize.js';
import { detectPatternTags } from './pattern-tags.js';
import { decayStore } from './decay.js';
export { MIN_CONFIDENCE };
export const MAX_ENTRIES = 6;
// Auto-seed (src/lib/memory/seed-catalog.ts) and age-decay (decay.ts), each checked once per
// process before the first real lookup — not re-checked per file/retry (seedIfEmpty/decayStore
// are each idempotent via their own on-disk state, but a -w N parallel run or a large `fix`
// sweep shouldn't re-scan the whole store before every single file). This is what makes a
// brand-new `lacuna generate`/`fix` useful on day one without requiring `lacuna init` first —
// `init` also seeds explicitly for visibility, but this lazy path is what actually guarantees it
// regardless of which command a user reaches for.
let seedAttempted = false;
let decayAttempted = false;
// Recency bonus favors entries that have proven useful recently over ones that haven't been
// touched in a long time (a rule for a library version the project may have since upgraded
// past), without needing real decay/pruning machinery yet.
function recencyWeight(lastUsed) {
    if (!lastUsed)
        return 0.6;
    const days = (Date.now() - Date.parse(lastUsed)) / 86_400_000;
    if (!Number.isFinite(days))
        return 0.6;
    if (days <= 7)
        return 1.0;
    if (days <= 30)
        return 0.8;
    if (days <= 90)
        return 0.5;
    return 0.3;
}
function score(entry) {
    return entry.confidence * recencyWeight(entry.last_used) * Math.log2(2 + entry.hit_count);
}
function retrievalTags(ctx) {
    return [ctx.testRunner, ctx.framework, ...(ctx.dependencies ?? [])].filter((t) => Boolean(t));
}
// Deterministic tag/signature matching — no embeddings needed at "dozens to low-hundreds of
// entries" (design doc's own scale estimate). An exact fixes/<hash> hit is the highest-value
// signal the system has, so it's always considered first, ahead of tag-overlap candidates.
export async function retrieveMemory(config, ctx) {
    if (!config.memory.enabled)
        return [];
    if (!seedAttempted) {
        seedAttempted = true;
        await seedIfEmpty(globalMemoryRoot()).catch(() => { });
    }
    if (!decayAttempted) {
        decayAttempted = true;
        await decayStore(globalMemoryRoot()).catch(() => 0);
    }
    const root = globalMemoryRoot();
    const seen = new Set();
    const candidates = [];
    if (ctx.errorSignature) {
        const hash = errorSignatureHash(normalizeErrorSignature(ctx.errorSignature));
        const entry = await readEntry(root, 'fixes', hash);
        if (entry && !seen.has(entry.id)) {
            seen.add(entry.id);
            candidates.push(entry);
        }
    }
    const tags = retrievalTags(ctx);
    if (tags.length > 0) {
        const index = await readIndex(root);
        const keys = new Set();
        for (const tag of tags)
            for (const key of index[tag] ?? [])
                keys.add(key);
        for (const key of keys) {
            const slash = key.indexOf('/');
            if (slash === -1)
                continue;
            const category = key.slice(0, slash);
            const id = key.slice(slash + 1);
            // `fixes` entries are keyed to a specific error signature and only make sense once a real
            // error is being diagnosed (the exact-hash lookup above, or here via pattern tags detected
            // FROM that error in buildFixMemoryHint). Without an errorSignature, this is the ambient/
            // proactive retrieval used before any error exists (context.ts, shown to every file that
            // merely shares a runner tag) — a learned fix for one specific file's error has no business
            // being surfaced as generic context for an unrelated file just because both are 'jest'.
            if (category === 'fixes' && !ctx.errorSignature)
                continue;
            if (seen.has(id))
                continue;
            const entry = await readEntry(root, category, id);
            if (entry) {
                seen.add(entry.id);
                candidates.push(entry);
            }
        }
    }
    return candidates
        .filter(e => e.confidence > MIN_CONFIDENCE && !e.superseded_by)
        .sort((a, b) => score(b) - score(a))
        .slice(0, MAX_ENTRIES);
}
// A learned summary is banner junk when it's really captured runner output (a `====` separator
// run, a `> jest …`/`> vitest …` command echo, a `console.error/warn/log` line, a `PASS`/`FAIL`
// result header, or a `✕`/`✓` marker) rather than an actual error message — an older normalize
// pass let these through into `summary`, and surfacing them wastes prompt space and reads as
// noise. Skip such entries at render time so already-stored corrupt entries never reach the model
// (normalize.ts now strips this decoration up front so new entries don't hit it).
function isBannerJunkSummary(summary) {
    const s = summary.trim();
    return (/={6,}|-{6,}/.test(s) ||
        /(^|\s)>\s+(?:jest|vitest|mocha|npm|yarn|pnpm)\b/.test(s) ||
        /\bconsole\.(?:error|warn|log)\b/.test(s) ||
        /(^|\s)(?:PASS|FAIL)\b/.test(s) ||
        /[✕✓×]/.test(s));
}
export function renderMemorySection(entries) {
    const clean = entries.filter(e => !isBannerJunkSummary(e.summary));
    if (clean.length === 0)
        return null;
    const parts = ['RELEVANT LEARNED MEMORY (from prior runs — apply if relevant, don\'t force it):'];
    for (const e of clean) {
        parts.push(`  • ${e.summary}: ${e.rule}`);
        if (e.example)
            parts.push(`    e.g. ${e.example}`);
    }
    return parts.join('\n');
}
// Tag-based (frameworks/mocks) retrieval — computed once per file, no error signature yet.
// Used by context.ts as one more parallel FileContext collector.
export async function buildMemoryContext(config, ctx) {
    if (!config.memory.enabled)
        return null;
    const entries = await retrieveMemory(config, { ...ctx, errorSignature: null });
    return renderMemorySection(entries);
}
// Signature-based (fixes) retrieval — computed ONCE from the initial failure per file
// (never recomputed per retry, since by attempt 2+ errorOutput may just be internal retry
// guidance text with nothing real to key retrieval off of) and appended into the
// errorOutput/lastError string, not passed as a separate prompt-builder parameter — see the
// design plan's "Threading per-retry error hints" section for why. Also folds in pattern-based
// tags detected from the error text itself (pattern-tags.ts) — this is what makes retrieval
// precise (a `never`-type failure pulls only the never-type-mock entry) rather than merely
// runner-scoped (every jest project pulling every jest-tagged entry regardless of relevance).
export async function buildFixMemoryHint(config, errorOutput, _ctx) {
    if (!config.memory.enabled)
        return { text: null, coveredPatterns: [] };
    const patternTags = detectPatternTags(errorOutput);
    // Retrieve ONLY by what actually relates to THIS error: the exact error-signature hash and any
    // precise pattern tags detected in the error text. Deliberately NO fallback to the broad
    // testRunner/framework tag — tag matching is a UNION, so a runner tag pulls back EVERY `fixes`
    // entry sharing that runner regardless of relevance. A `fixes` entry surfaced purely because it
    // shares a runner ('vitest'/'jest') with the current file is, by construction, a fix learned for
    // a DIFFERENT error — pure noise. Live: a Mongoose DB-integration failure pulled six React-Native
    // hook-mocking rules from an unrelated repo just because both ran under the same runner, biasing
    // the model toward mock-shaped theories for an infra error no mock could touch. When no pattern
    // matches and no exact hash exists, surfacing NOTHING is the correct outcome. (`_ctx` is retained
    // for call-site/signature stability; its broad tags are intentionally no longer used here.)
    const entries = await retrieveMemory(config, { testRunner: '', dependencies: patternTags, errorSignature: errorOutput });
    const matchedTags = new Set(entries.flatMap(e => e.tags));
    const coveredPatterns = patternTags.filter(t => matchedTags.has(t));
    return { text: renderMemorySection(entries), coveredPatterns };
}
//# sourceMappingURL=retrieve.js.map