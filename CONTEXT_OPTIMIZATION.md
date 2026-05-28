# Context Optimization — Implementation Plan

## Problem
The agent passes entire source files, full conversation histories, and raw terminal output
into every prompt. On large files this causes:
- Context bloat that degrades model reasoning quality
- Rapid token budget drain
- The model spending attention on irrelevant passing-test output during retries

## Three Targeted Fixes

### 1. Source File Skeleton (`src/lib/skeleton.ts`)
**Problem:** Full 400-line source files are sent even when only 2 functions need tests.
**Fix:** For files over 80 lines, generate a skeleton:
- Keep all imports, types, interfaces, enums, and top-level comments verbatim
- For functions/classes NOT in the uncovered list: collapse body to `{ /* ... (N lines) */ }`
- For functions IN the uncovered list: include full implementation
- Result: 60-80% context reduction on large files while preserving all signal

Files changed: `src/lib/skeleton.ts` (new), `src/agent/prompts.ts`

---

### 2. Smart Error Extraction (`src/lib/extract-error.ts`)
**Problem:** `(stdout + stderr).slice(0, 3000)` includes passing-test noise, timing headers,
and summary lines. The model has to find the actual failure buried in irrelevant output.
**Fix:** Filter the runner output to keep only:
- Failing test names and file paths
- Assertion error messages (Expected/Received)
- Stack frames pointing to project files (not node_modules)
- TypeScript error lines
Strip: passing ✓ lines, RUN header, Start/Duration footer, summary counts

Files changed: `src/lib/extract-error.ts` (new), `src/agent/fix-loop.ts`, `src/agent/loop.ts`

---

### 3. Retry Context Trimming (`src/agent/generator.ts`)
**Problem:** `history[]` grows with each retry. By attempt 3 the model is reasoning over
original prompt + two full code attempts + two error outputs — pure noise after the first.
**Fix:** On each retry, trim history to 3 messages:
1. The original user prompt (has all context: source, mocks, deps, paths)
2. The latest assistant response (current state of the test file)
3. The new error message

Caps memory at O(1) regardless of iteration count.

Files changed: `src/agent/generator.ts`

---

## Status
- [x] `src/lib/skeleton.ts`
- [x] `src/lib/extract-error.ts`
- [x] `src/agent/generator.ts` — retry trim
- [x] `src/agent/prompts.ts` — use skeleton in generate + fix prompts
- [x] `src/agent/fix-loop.ts` — use smart error extraction
- [x] `src/agent/loop.ts` — use smart error extraction
- [x] `project-map.md` — update
