import type { LacunaConfig } from '../config.js'
import type { MemoryEntry } from './types.js'
import { MIN_CONFIDENCE } from './types.js'
import { globalMemoryRoot } from './paths.js'
import { readEntry, readIndex, seedIfEmpty } from './store.js'
import { normalizeErrorSignature, errorSignatureHash } from './normalize.js'
import { detectPatternTags } from './pattern-tags.js'
import { decayStore } from './decay.js'

export { MIN_CONFIDENCE }
export const MAX_ENTRIES = 6

// Auto-seed (src/lib/memory/seed-catalog.ts) and age-decay (decay.ts), each checked once per
// process before the first real lookup — not re-checked per file/retry (seedIfEmpty/decayStore
// are each idempotent via their own on-disk state, but a -w N parallel run or a large `fix`
// sweep shouldn't re-scan the whole store before every single file). This is what makes a
// brand-new `lacuna generate`/`fix` useful on day one without requiring `lacuna init` first —
// `init` also seeds explicitly for visibility, but this lazy path is what actually guarantees it
// regardless of which command a user reaches for.
let seedAttempted = false
let decayAttempted = false

export interface RetrievalContext {
  testRunner: string
  framework?: string | null
  dependencies?: string[]
  errorSignature?: string | null // set only when retrieving for a fix/retry (fixes category)
}

// Recency bonus favors entries that have proven useful recently over ones that haven't been
// touched in a long time (a rule for a library version the project may have since upgraded
// past), without needing real decay/pruning machinery yet.
function recencyWeight(lastUsed: string | null): number {
  if (!lastUsed) return 0.6
  const days = (Date.now() - Date.parse(lastUsed)) / 86_400_000
  if (!Number.isFinite(days)) return 0.6
  if (days <= 7) return 1.0
  if (days <= 30) return 0.8
  if (days <= 90) return 0.5
  return 0.3
}

function score(entry: MemoryEntry): number {
  return entry.confidence * recencyWeight(entry.last_used) * Math.log2(2 + entry.hit_count)
}

function retrievalTags(ctx: RetrievalContext): string[] {
  return [ctx.testRunner, ctx.framework, ...(ctx.dependencies ?? [])].filter((t): t is string => Boolean(t))
}

// Deterministic tag/signature matching — no embeddings needed at "dozens to low-hundreds of
// entries" (design doc's own scale estimate). An exact fixes/<hash> hit is the highest-value
// signal the system has, so it's always considered first, ahead of tag-overlap candidates.
export async function retrieveMemory(config: LacunaConfig, ctx: RetrievalContext): Promise<MemoryEntry[]> {
  if (!config.memory.enabled) return []
  if (!seedAttempted) {
    seedAttempted = true
    await seedIfEmpty(globalMemoryRoot()).catch(() => {})
  }
  if (!decayAttempted) {
    decayAttempted = true
    await decayStore(globalMemoryRoot()).catch(() => 0)
  }
  const root = globalMemoryRoot()
  const seen = new Set<string>()
  const candidates: MemoryEntry[] = []

  if (ctx.errorSignature) {
    const hash = errorSignatureHash(normalizeErrorSignature(ctx.errorSignature))
    const entry = await readEntry(root, 'fixes', hash)
    if (entry && !seen.has(entry.id)) {
      seen.add(entry.id)
      candidates.push(entry)
    }
  }

  const tags = retrievalTags(ctx)
  if (tags.length > 0) {
    const index = await readIndex(root)
    const keys = new Set<string>()
    for (const tag of tags) for (const key of index[tag] ?? []) keys.add(key)
    for (const key of keys) {
      const slash = key.indexOf('/')
      if (slash === -1) continue
      const category = key.slice(0, slash) as MemoryEntry['category']
      const id = key.slice(slash + 1)
      // `fixes` entries are keyed to a specific error signature and only make sense once a real
      // error is being diagnosed (the exact-hash lookup above, or here via pattern tags detected
      // FROM that error in buildFixMemoryHint). Without an errorSignature, this is the ambient/
      // proactive retrieval used before any error exists (context.ts, shown to every file that
      // merely shares a runner tag) — a learned fix for one specific file's error has no business
      // being surfaced as generic context for an unrelated file just because both are 'jest'.
      if (category === 'fixes' && !ctx.errorSignature) continue
      if (seen.has(id)) continue
      const entry = await readEntry(root, category, id)
      if (entry) {
        seen.add(entry.id)
        candidates.push(entry)
      }
    }
  }

  return candidates
    .filter(e => e.confidence > MIN_CONFIDENCE && !e.superseded_by)
    .sort((a, b) => score(b) - score(a))
    .slice(0, MAX_ENTRIES)
}

export function renderMemorySection(entries: MemoryEntry[]): string | null {
  if (entries.length === 0) return null
  const parts = ['RELEVANT LEARNED MEMORY (from prior runs — apply if relevant, don\'t force it):']
  for (const e of entries) {
    parts.push(`  • ${e.summary}: ${e.rule}`)
    if (e.example) parts.push(`    e.g. ${e.example}`)
  }
  return parts.join('\n')
}

// Tag-based (frameworks/mocks) retrieval — computed once per file, no error signature yet.
// Used by context.ts as one more parallel FileContext collector.
export async function buildMemoryContext(config: LacunaConfig, ctx: RetrievalContext): Promise<string | null> {
  if (!config.memory.enabled) return null
  const entries = await retrieveMemory(config, { ...ctx, errorSignature: null })
  return renderMemorySection(entries)
}

export interface FixMemoryHint {
  text: string | null
  // Pattern tags that had at least one matching entry ACTUALLY returned by retrieveMemory (i.e.
  // it already passed the confidence threshold, the MAX_ENTRIES cap, and the superseded_by
  // exclusion) — not merely "detected in the error text". detectTypeScriptErrors
  // (agent/prompts/index.ts) uses this to suppress its own hardcoded static explanation for a
  // pattern ONLY when memory has confirmed coverage, so a decayed/deleted/capped-out entry never
  // causes guidance to silently disappear.
  coveredPatterns: string[]
}

// Signature-based (fixes) retrieval — computed ONCE from the initial failure per file
// (never recomputed per retry, since by attempt 2+ errorOutput may just be internal retry
// guidance text with nothing real to key retrieval off of) and appended into the
// errorOutput/lastError string, not passed as a separate prompt-builder parameter — see the
// design plan's "Threading per-retry error hints" section for why. Also folds in pattern-based
// tags detected from the error text itself (pattern-tags.ts) — this is what makes retrieval
// precise (a `never`-type failure pulls only the never-type-mock entry) rather than merely
// runner-scoped (every jest project pulling every jest-tagged entry regardless of relevance).
export async function buildFixMemoryHint(config: LacunaConfig, errorOutput: string, ctx: Omit<RetrievalContext, 'errorSignature'>): Promise<FixMemoryHint> {
  if (!config.memory.enabled) return { text: null, coveredPatterns: [] }
  const patternTags = detectPatternTags(errorOutput)
  // Tag matching in retrieveMemory is a UNION (any matching tag includes the entry), not an
  // intersection — merging precise pattern tags alongside the broad testRunner/framework tags
  // would still pull back every entry tagged for that runner regardless of relevance (defeating
  // the entire point of pattern-based tagging). When a pattern IS detected, use ONLY the pattern
  // tags; fall back to the broader runner/framework signal only when nothing more specific
  // matched (the seed catalog's pattern-tagged entries already carry their own runner tags too,
  // e.g. 'unsafe-cast' + 'jest' + 'vitest', so dropping the ctx-level runner filter here doesn't
  // lose runner relevance where it actually matters).
  const entries = await retrieveMemory(config, patternTags.length > 0
    ? { testRunner: '', dependencies: patternTags, errorSignature: errorOutput }
    : { ...ctx, errorSignature: errorOutput })
  const matchedTags = new Set(entries.flatMap(e => e.tags))
  const coveredPatterns = patternTags.filter(t => matchedTags.has(t))
  return { text: renderMemorySection(entries), coveredPatterns }
}
