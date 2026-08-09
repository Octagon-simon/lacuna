# Lacuna Memory Layer — Design Sketch

## Problem

Every `generate`/`fix` call currently sends the model:
- full source + test file contents
- all mocking rules
- all framework/test-runner rules
- anything else "just in case" it's needed

This is redundant across calls — most of that context doesn't change file to file, and re-sending it every time wastes tokens and dilutes the prompt with irrelevant rules.

## Core idea

The model itself has no memory between API calls — that doesn't change. What we build is a **retrieval layer on our side**: a structured store of learned facts/rules, plus a retrieval step that picks only what's relevant to *this* file/error before building the prompt. Web search becomes the fallback when retrieval comes up empty, and successful fixes get written back into the store — so the system gets sharper over time instead of staying a static rules file.

Three pieces:
1. **Memory store** — structured, on-disk, categorized
2. **Retrieval** — tag/signature matching, deterministic to start
3. **Write-back** — successful generate/fix runs distill into new or updated memory entries

---

## 1. Memory store

### Scope: project-local vs global

| Scope | Location | Contents |
|---|---|---|
| Global (per install) | `~/.lacuna/memory/` | Framework conventions, common library mocking patterns, well-known error → fix mappings — reusable across any project |
| Project-local | `.lacuna/memory/` in the repo | This repo's shared-mock conventions, project-specific quirks, anything tied to `.lacuna.json` config |

Retrieval checks project-local first, falls back to global. Write-back defaults to project-local unless a rule looks framework-general (heuristic: same fix pattern seen across 2+ unrelated projects → promote to global — can be manual at first, automatic later).

### Directory layout

```
memory/
├── frameworks/
│   ├── vitest.json
│   ├── jest-expo.json
│   └── next.json
├── mocks/
│   ├── react-router-dom.json
│   ├── next-navigation.json
│   └── reanimated.json
├── fixes/
│   ├── <error-signature-hash>.json
│   └── ...
└── index.json          # lightweight lookup table (tags -> file paths)
```

### Entry schema

Every entry, regardless of category, shares a common envelope:

```json
{
  "id": "reanimated-mock-rntl-v14",
  "category": "mocks",
  "tags": ["react-native", "reanimated", "jest-expo", "rntl-v14"],
  "summary": "How to mock react-native-reanimated for RNTL v14 async tests",
  "rule": "Mock via jest-expo preset; do not manually mock useAnimatedStyle — it breaks act() timing. Use the official reanimated jest setup import instead.",
  "example": "// setup.ts\nimport 'react-native-reanimated/jestSetup';",
  "source": "learned",          // "learned" | "web" | "seed"
  "confidence": 0.8,             // rises with repeat successful use, or manual pin
  "hit_count": 4,
  "last_used": "2026-07-20T00:00:00Z",
  "created_from": {
    "error_signature": "TypeError: useAnimatedStyle is not a function",
    "run_id": "generate-8f2a1c"
  }
}
```

For `fixes/` entries specifically, the error signature is the primary retrieval key:

```json
{
  "id": "err-4471",
  "category": "fixes",
  "error_signature": "Cannot find module 'next/navigation' from test file",
  "tags": ["next", "vitest", "server-actions"],
  "rule": "Pre-mock next/navigation before importing the component under test; useRouter must be mocked in the test file's outer scope, not inside beforeEach.",
  "diff_pattern": "vi.mock('next/navigation', () => ({ useRouter: () => mockRouter }))",
  "source": "learned",
  "confidence": 0.9,
  "hit_count": 12
}
```

`error_signature` should be normalized (strip file paths, line numbers, variable names) so near-identical errors from different files collapse to the same entry. A simple approach: regex-strip paths/numbers, then hash.

### `index.json`

A flat tag → entry-id map, rebuilt on write, so retrieval doesn't have to scan every file:

```json
{
  "reanimated": ["reanimated-mock-rntl-v14"],
  "next/navigation": ["err-4471", "next-navigation-mock-basic"],
  "vitest": ["err-4471", "vitest-general-conventions"]
}
```

---

## 2. Retrieval

Start with deterministic tag/signature matching — no embeddings needed at this scale (dozens to low-hundreds of entries per project). Reach for a local vector index later only if keyword matching starts missing paraphrased error messages.

### Retrieval inputs (per file being processed)

- test runner (`vitest`, `jest`, etc.)
- framework (`react`, `next`, `react-native`, ...)
- imports/dependencies touched by the source file (from static parse, already done in `context.ts`)
- if this is a `fix` run: the normalized error signature
- project config (`mocksFile`, `ignore`, etc. — already available)

### Retrieval function (pseudocode)

```ts
function retrieveMemory(ctx: FileContext): MemoryEntry[] {
  const candidates = new Set<MemoryEntry>();

  // 1. Exact error match (fix runs) — highest priority
  if (ctx.errorSignature) {
    const normalized = normalizeError(ctx.errorSignature);
    candidates.add(...lookupBySignature(normalized));
  }

  // 2. Tag overlap: runner + framework + touched deps
  const tags = [ctx.testRunner, ctx.framework, ...ctx.dependencies];
  candidates.add(...lookupByTags(tags, index));

  // 3. Rank: confidence * recency-weighted hit_count, take top N
  return rank(candidates)
    .filter(e => e.confidence > MIN_CONFIDENCE)
    .slice(0, MAX_ENTRIES); // e.g. 5-8, to keep prompt lean
}
```

### Miss path

```ts
if (retrieveMemory(ctx).length === 0 || stillFailingAfterAttempt) {
  const searchResult = await webSearch(buildSearchQuery(ctx));
  const distilled = distillIntoRule(searchResult); // model call: summarize into a memory-entry shape
  attemptFix(ctx, distilled);
  if (success) writeBack(distilled, ctx);
}
```

`buildSearchQuery` should combine: library name + version, error message (cleaned), and runner — same instinct as "search specific, not broad."

---

## 3. Write-back

After any `generate` or `fix` run that ends in passing tests:

1. Diff what was actually used from memory vs. what was novel in the model's approach.
2. If the model's fix pattern differs from any existing entry for this tag/signature, either:
   - **update** the existing entry (bump `hit_count`, adjust `rule` if the new approach is more general), or
   - **create** a new entry if it's a genuinely distinct case.
3. Store `confidence` starting low (~0.5) for anything freshly learned from a single success; raise it on repeat hits, lower it if a later run using that entry fails.
4. Prune: entries with low confidence and no hits in N runs get flagged for review (not auto-deleted — surfacing "this hasn't proven useful" is safer than silently losing something).

This is the actual "learning" loop — memory isn't a hand-maintained rules file, it accumulates from real outcomes.

---

## 4. Integration points in the existing codebase

Based on `lacuna`'s current structure:

- **`agent/context.ts`** — this is where `retrieveMemory()` slots in. It already builds model context (source, tests, mocks, types); memory entries become another section of that context, retrieved instead of statically attached.
- **`agent/prompts/`** — prompt builders need a new section template for "relevant memory" vs. the current static rules blocks. Framework-specific static rules can likely be *replaced* by memory entries entirely over time (seed the store with today's static rules as `source: "seed"` entries to bootstrap).
- **`agent/loop.ts` / `fix-loop.ts`** — write-back hook goes here, after a run is confirmed passing, before moving to the next file.
- **`lib/typecheck.ts` / `lib/validate.ts`** — error signatures for the `fixes/` category should be normalized using whatever error-parsing already happens here.
- **New: `lib/memory/`** — store, retrieval, write-back, and the index maintenance logic. Config gets a new optional field, e.g. `"memory": { "enabled": true, "scope": "project" }`.

---

## Open questions for review

1. **Promotion global vs project-local** — manual only at first, or auto-promote after N successful cross-project hits? (Needs a way to detect "different project" — maybe hash of `package.json` deps signature.)
2. **Confidence decay** — should unused entries decay over time even without a failure, to keep the store from calcifying around outdated library versions?
3. **Prompt budget** — cap of 5-8 memory entries per call is a guess; needs real token-cost measurement against current static-rules-block size to know if this is actually a meaningful savings.
4. **Distillation model call** — writing a rule from a web search result or successful diff is itself a model call. Worth it, but adds a bit of latency/cost to the write-back path — maybe batch/async it rather than blocking the main loop.
5. **Conflicting entries** — two entries with overlapping tags but different rules (e.g. rule changed between library major versions). Needs a versioning or supersede mechanism, not just append.
