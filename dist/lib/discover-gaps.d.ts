import type { LacunaConfig } from './config.js';
import type { DetectedEnvironment } from './detector.js';
import type { CoverageGap } from './coverage/index.js';
export declare class DiscoverGapsError extends Error {
    constructor(message: string);
}
export interface ScopeGapsResult {
    gaps: CoverageGap[];
    coverageBefore: number;
    ranSuite: boolean;
}
/**
 * Discover the testable coverage gaps under an optional scope directory — the SAME way `lacuna
 * analyze` and `runAgentLoop` do: run the (scoped) coverage command fresh, read the report, and
 * union below-threshold-with-tests files (extractGaps) with never-tested files (findUncoveredFiles).
 *
 * This exists because an embedder (the VS Code extension) that merely READS the on-disk report gets
 * a stale/partial answer — the report is only accurate right after a fresh run. Reading a stale
 * report made the extension's gap count disagree with the CLI (e.g. 2 vs the real 12). Callers that
 * need an accurate count (a run's cost-disclosure confirmation, the gaps sidebar) use this; it runs
 * the suite, so it is not free — surface a progress indicator.
 *
 * All returned filePaths are absolute. Throws DiscoverGapsError with an actionable message when the
 * suite can't produce a readable report (jest config conflict, zero tests, unreadable lcov).
 */
export declare function discoverScopeGaps(config: LacunaConfig, env: DetectedEnvironment, cwd: string, scopeDir?: string, onLine?: (line: string) => void): Promise<ScopeGapsResult>;
//# sourceMappingURL=discover-gaps.d.ts.map