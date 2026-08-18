# Follow-up: Agentic escape hatches for lacuna

Status: **proposal / deferred** — to revisit. Not scheduled.
Context: prompted by comparing lacuna's architecture to a CAMEL-AI/eigent-style autonomous multi-agent "workforce."

---

## The core distinction

- **Eigent (CAMEL-AI)** is an *autonomous* system: a Workforce coordinator decomposes a task and dispatches parallel tool-calling worker agents (`ChatAgent`/`ListenChatAgent`) with MCP toolkits (browser, terminal, file, search). **The LLM decides the control flow** at each step.
- **Lacuna** is a *deterministic pipeline* where the LLM is a narrow component: discover gaps → build grounded context (skeleton, render-vocab, memory) → generate → run tests → parse → **~40 specialized detectors** → fix/regenerate with keep-best → verify → format. The LLM only does three narrow jobs (generate, fix, distill a memory rule). **The intelligence is in the orchestration + detectors, not an autonomous planner.**

"Convert lacuna to an agent" = give the LLM tools and let *it* drive the loop instead of the state machine.

## Gain vs. loss of a full conversion

**Gain:** flexibility on the long tail (novel failures the detectors don't recognize); less orchestration code; natural multi-file/cross-cutting reasoning; a conversational surface.

**Lose (the expensive part):**
- **Determinism / reproducibility** — the property that makes lacuna CI-safe.
- **Every detector guarantee** — instant, deterministic gates (e.g. `detectEnvironmentLimitation` bailing in 0 extra iterations, keep-best never dropping a passing test, subject-integrity, memory precision) become "hopefully the model checks."
- **Cost & latency** — an agentic tool-loop is typically 5–20× the tokens/wall-clock per file; reintroduces exactly the "burned all iterations / wouldn't stop" failure modes we've been engineering out.
- **Convergence control** — the iteration budget + oscillation detection + keep-best exist *because* unbounded loops thrash.
- **The embedded VS Code story** — a self-contained ~11MB library vs. a heavier, statefuller agent runtime (planner, tool sandbox, MCP servers).

## Recommendation: keep the pipeline, add scoped escape hatches — don't invert control

The deterministic pipeline is lacuna's moat. Don't hand the loop to an autonomous agent. Instead drop a **bounded agent into the specific slots where determinism has no answer**:

### 1. Read-only "diagnostician" sub-agent, triggered on detector-exhaustion (highest value)
- **Trigger:** after N attempts with no recognized detector signature AND no progress (oscillation / repeated identical error). This is exactly where lacuna currently gives up in `fixFile`.
- **Tools (read-only):** `readFile`, `grep`, `readConfig` (incl. `vitest.config.ts` / `jest.config.js` / `globalSetup`).
- **Job:** *classify* the blocker and return a **structured verdict**, not free edits — one of: `environment-limitation` (name the offending setup file), `unrelated-file-crash`, `real-source-bug`, or `test-fixable` (+ at most one bounded suggested edit).
- **Why it fits:** the very failure that motivated this (a globalSetup DB-host guard) would be solved instantly by an agent that can *read `vitest.config.ts`* and conclude "un-patchable from the test file." It **augments** the detectors (deterministic-first, agent-on-exhaustion), never replaces them.
- **Slots into:** the give-up path of `fixFile` (`src/agent/fix-loop.ts`), right where `detectEnvironmentLimitation` / `detectUnrelatedFileCrash` already short-circuit. Keep it behind a config flag (default off initially), bounded to one call, read-only.

### 2. Multi-file coordinator — only for the mocks-file + dependents case
- The one place lacuna's single-file model is genuinely weak: a fix that needs the shared mocks file + a helper + N tests changed together.
- Keep it **behind keep-best verification** so it still cannot regress.

### 3. Keep the LLM narrow everywhere the pipeline already works (the 90% case).

## Net
This buys the agent's flexibility on the long tail while preserving determinism, cost control, and every detector guarantee for the common case. A full Workforce conversion would trade lacuna's biggest asset (a trustworthy deterministic pipeline) for eigent's biggest liability (nondeterministic, expensive, hard-to-bound loops).

## Suggested first step when revisited
Prototype **#1** as a read-only, single-call, flag-gated diagnostician invoked at `fixFile` exhaustion; measure how often its verdict is correct vs. the current detectors on real dogfood failures before giving it any write capability.
