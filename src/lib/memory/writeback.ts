import type { LacunaConfig } from '../config.js'
import type { MemoryEntry } from './types.js'
import { globalMemoryRoot } from './paths.js'
import { readEntry, writeEntry, withMemoryLock } from './store.js'
import { normalizeErrorSignature, errorSignatureHash } from './normalize.js'
import { detectPatternTags, PATTERN_TAGS } from './pattern-tags.js'
import { createProvider } from '../providers/index.js'

const SUCCESS_BUMP = 0.1
const FAILURE_DECAY = 0.2   // steeper than the bump — an unhelpful rule should lose trust faster than it gains it
const NEW_ENTRY_CONFIDENCE = 0.5
const MAX_RULE_CHARS = 800
const DISTILL_MAX_TOKENS = 150

function nowIso(): string {
  return new Date().toISOString()
}

function clamp01(n: number): number {
  // Rounded to avoid float-precision noise (0.6 - 0.2 -> 0.39999999999999997) compounding into
  // an ever-messier value across many success/failure updates on the same entry.
  return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000
}

// Coarse, fully deterministic "distillation" — the fallback when config.memory.distill is off,
// or the model call below fails/times out. Surfaces the import/mock lines that changed between
// the pre-fix and post-fix test file content, which is usually exactly the part of a fix that
// generalizes to the next occurrence of the same error signature.
function deriveMechanicalRule(diffBefore: string | null, diffAfter: string): string {
  // const\s+\w+\s*(?::[^=]+)?=\s* allows an optional TS type annotation between the variable
  // name and `=` (e.g. `const mock: jest.Mock<Promise<T>> = jest.fn()`) — without this, exactly
  // the fix pattern this session's own work produces (annotate the mock variable with jest.Mock<T>
  // instead of passing generics to jest.fn() itself) never matches, since the annotation sits
  // between the name and the assignment.
  const relevantLine = (l: string) => /^\s*(import|jest\.mock|vi\.mock|const\s+\w+\s*(?::[^=]+)?=\s*jest\.(fn|mocked)|const\s+\w+\s*(?::[^=]+)?=\s*vi\.(fn|mocked))/.test(l)
  const afterLines = diffAfter.split('\n').filter(relevantLine)
  const beforeSet = new Set((diffBefore ?? '').split('\n').filter(relevantLine).map(l => l.trim()))
  const changed = afterLines.filter(l => !beforeSet.has(l.trim()))
  const picked = (changed.length > 0 ? changed : afterLines).join('\n')
  return picked.slice(0, MAX_RULE_CHARS) || 'See diff_pattern.'
}

// One small, tightly-capped model call to turn a newly-learned fix into a cleaner rule than the
// raw mechanical diff. lacuna is a short-lived CLI process, so this is a synchronous await at
// write-back time rather than a detached "fire and forget" background call — a promise kicked
// off right before the command exits risks being killed mid-flight before it ever writes the
// refined rule. The cost is bounded: only on genuinely NEW entries (not every success), one
// small call (150 tokens), and it always falls back to the mechanical rule on any error/timeout
// — never blocks or fails the write-back itself.
async function distillRule(config: LacunaConfig, mechanicalRule: string, diffBefore: string | null, diffAfter: string): Promise<string> {
  try {
    const provider = createProvider(config)
    const system = 'You turn a before/after test-file diff into a ONE OR TWO SENTENCE reusable rule for fixing the same class of error in the future. Be concise and generic — do not reference this specific file, variable names, or project. Output ONLY the rule text, no preamble.'
    const user = `BEFORE:\n${(diffBefore ?? '(new file)').slice(0, 1200)}\n\nAFTER:\n${diffAfter.slice(0, 1200)}\n\nMechanical diff (fallback, for reference only): ${mechanicalRule}`
    const result = await provider.generate([{ role: 'user', content: user }], system, undefined, DISTILL_MAX_TOKENS, 0.2)
    const cleaned = result.trim()
    return cleaned.length > 0 && cleaned.length < MAX_RULE_CHARS ? cleaned : mechanicalRule
  } catch {
    return mechanicalRule
  }
}

const PATTERN_TAG_SET = new Set(PATTERN_TAGS.map(p => p.tag))

// Bumps/decays confidence + hit_count/last_used for entries that were RETRIEVED (tag-matched,
// frameworks/mocks categories) and shown as ambient context for a file whose outcome is now known.
//
// Per-entry attribution, not a flat file-wide outcome: an entry shown via a broad runner tag
// (e.g. 'jest') may have nothing to do with why THIS particular file passed or failed — scoring
// every shown entry with the whole file's result punishes/rewards entries that were never
// actually relevant. Instead, diff the entry's OWN pattern tag(s) against what pattern-tags.ts
// detects in the first error (attempt 1) versus the final error (give-up, or none on success):
//   - entry's pattern still present in the FINAL error  -> penalize (its guidance didn't help)
//   - entry's pattern was present at the START but gone by the end -> credit (plausibly helped)
//   - entry's pattern never appeared in this file's error at all -> untouched (not tested by
//     this file — leave it to age-decay/manual review, not this file's unrelated result)
// hit_count/last_used still update unconditionally — a retrieval happened either way; only
// confidence movement is now conditional on an attributable signal.
export async function recordTagMatchOutcome(config: LacunaConfig, entries: MemoryEntry[], firstError: string | null, finalError: string | null): Promise<void> {
  if (!config.memory.enabled || entries.length === 0) return
  const firstPatterns = new Set(detectPatternTags(firstError ?? ''))
  const finalPatterns = new Set(detectPatternTags(finalError ?? ''))
  const root = globalMemoryRoot()
  await withMemoryLock(async () => {
    for (const stale of entries) {
      const fresh = await readEntry(root, stale.category, stale.id)
      if (!fresh) continue
      const ownPatterns = fresh.tags.filter(t => PATTERN_TAG_SET.has(t))
      let delta = 0
      if (ownPatterns.some(t => finalPatterns.has(t))) {
        delta = -FAILURE_DECAY
      } else if (ownPatterns.some(t => firstPatterns.has(t))) {
        delta = SUCCESS_BUMP
      }
      await writeEntry(root, {
        ...fresh,
        confidence: delta !== 0 ? clamp01(fresh.confidence + delta) : fresh.confidence,
        hit_count: fresh.hit_count + 1,
        last_used: nowIso(),
      })
    }
  })
}

export interface FixOutcomeParams {
  errorSignature: string   // raw (un-normalized) failure text — normalized/hashed here
  tags: string[]
  outcome: 'success' | 'failure'
  diffBefore: string | null
  diffAfter: string
}

// Create-vs-update for the `fixes` category: an exact error_signature hash match already
// existing -> update in place (bump/decay + broaden tags); no match on a SUCCESS -> create a
// new entry. A failure with no existing entry has nothing to write back — there's no proven
// fix yet to record.
export async function recordFixOutcome(config: LacunaConfig, params: FixOutcomeParams): Promise<void> {
  if (!config.memory.enabled) return
  const root = globalMemoryRoot()
  const normalized = normalizeErrorSignature(params.errorSignature)
  const hash = errorSignatureHash(normalized)
  // Precise tags (pattern-tags.ts), same mechanism the seed catalog and fix-time retrieval use —
  // a learned entry should be just as precisely retrievable as a seeded one, not just tagged by
  // runner name.
  const patternTags = detectPatternTags(params.errorSignature)

  // A plain read needs no mutual exclusion (no write in flight can corrupt it, worst case is a
  // rare TOCTOU where two processes both see "no existing entry" for a brand-new signature at
  // the same instant and each write their own valid first-occurrence entry — not a crash, just
  // one overwriting the other's otherwise-equally-valid data). Checking this BEFORE the
  // potentially-slow distillation call below means we never do that call at all for the common
  // "just bump an existing entry" case, and — critically — never hold the cross-process lock
  // for the duration of a network call, which would otherwise block every other concurrent
  // `lacuna` process on this machine for as long as the model takes to respond.
  const existingPeek = await readEntry(root, 'fixes', hash)

  if (!existingPeek && params.outcome === 'success') {
    // Genuinely new entry — do the (possibly slow) rule derivation OUTSIDE the lock.
    const mechanicalRule = deriveMechanicalRule(params.diffBefore, params.diffAfter)
    const rule = config.memory.distill
      ? await distillRule(config, mechanicalRule, params.diffBefore, params.diffAfter)
      : mechanicalRule
    await withMemoryLock(async () => {
      // Re-check inside the lock in case another process created it in the meantime — an
      // update (bump) is strictly cheaper and more correct than clobbering a real entry with
      // this stale "new" one.
      const nowExisting = await readEntry(root, 'fixes', hash)
      if (nowExisting) {
        await writeEntry(root, {
          ...nowExisting,
          confidence: clamp01(nowExisting.confidence + SUCCESS_BUMP),
          hit_count: nowExisting.hit_count + 1,
          last_used: nowIso(),
          tags: Array.from(new Set([...nowExisting.tags, ...params.tags, ...patternTags])),
        })
        return
      }
      await writeEntry(root, buildNewFixEntry(hash, normalized, rule, params.tags, patternTags))
    })
    return
  }

  if (!existingPeek) return // failure, no existing entry — nothing proven to record yet

  // Fast path: bump/decay an existing entry. Quick file I/O only, fine to hold the lock for.
  await withMemoryLock(async () => {
    const fresh = await readEntry(root, 'fixes', hash)
    if (!fresh) return // deleted between the peek and here — nothing to update
    const delta = params.outcome === 'success' ? SUCCESS_BUMP : -FAILURE_DECAY
    await writeEntry(root, {
      ...fresh,
      confidence: clamp01(fresh.confidence + delta),
      hit_count: fresh.hit_count + 1,
      last_used: nowIso(),
      tags: Array.from(new Set([...fresh.tags, ...params.tags, ...patternTags])),
    })
  })
}

function buildNewFixEntry(hash: string, normalized: string, rule: string, tags: string[], patternTags: string[]): MemoryEntry {
  return {
    id: hash,
    category: 'fixes',
    error_signature: hash,
    tags: Array.from(new Set([...tags, ...patternTags])),
    summary: normalized.slice(0, 120),
    rule,
    source: 'learned',
    confidence: NEW_ENTRY_CONFIDENCE,
    hit_count: 1,
    last_used: nowIso(),
    created_at: nowIso(),
    created_from: { error_signature: normalized },
  }
}
