// Public library surface for embedding lacuna's core inside another host (the VS Code /
// Antigravity extension embeds this rather than shelling out to the `lacuna` binary). This is the
// curated, stable entry point: import from `lacuna-cli` (this barrel → dist/index.js), not from
// deep `dist/agent/*` paths.
//
// Everything re-exported here is already used by the CLI commands, so it is battle-tested; this
// file only gives it a single, versioned name. Keep additions intentional — this is an API.
// ─── The two agentic entry points ─────────────────────────────────────────────
export { runAgentLoop, processGap } from './agent/loop.js';
export { runFixLoop, fixFile, discoverFailingTests, DiscoverFailingError } from './agent/fix-loop.js';
// ─── Config (drive a settings UI from the Zod schema's .describe() metadata) ────
export { loadConfig, ConfigSchema, mocksFileList, applyModelOverride, iterationCeiling } from './lib/config.js';
// ─── Environment detection (runner, coverage + test commands) ──────────────────
export { detectEnvironment } from './lib/detector.js';
// ─── Debug logging (per-file raw prompt/response logs) ─────────────────────────
// Env-aware resolver (LACUNA_DEBUG wins over config.debug) + the per-file path builder, so an
// embedder can surface WHERE the logs land — the CLI shows this in its command header; the
// extension logs it at run start so "I can't see the debug files" has an obvious answer.
export { resolveDebugBase, perFileDebugPath, debugLogPattern } from './agent/generator.js';
// ─── Fresh-project scaffolding (install deps + scaffold runner config/setup files) ─
// The extension bundles this and runs it in-process/standalone instead of shelling out to a
// published `lacuna-cli`, so setup works offline and needs no cross-package version coupling.
export { scaffoldProject, ensureTestRunnerSetup, readProjectMeta, findProjectRoot } from './lib/scaffold.js';
// ─── Coverage + gap discovery (drive the gaps sidebar tree + gutter decorations) ─
export { loadCoverage, coverageAgeSeconds, parseLcov, resolveLcovPath, extractGaps, filterTestableGaps, findUncoveredFiles, findTestFiles, formatCoverageSummary, } from './lib/coverage/index.js';
// Fresh, accurate scope-gap discovery (runs the coverage command, like the CLI) — an embedder
// that only reads the on-disk report gets a stale count. See lib/discover-gaps.ts.
export { discoverScopeGaps, DiscoverGapsError } from './lib/discover-gaps.js';
// ─── Memory store (back a "Lacuna Memory" browser directly, per handoff §3) ─────
export { readIndex, readEntry, deleteEntry, writeEntry, rebuildIndex, decayStore, MEMORY_CATEGORIES, globalMemoryRoot, } from './lib/memory/index.js';
//# sourceMappingURL=index.js.map