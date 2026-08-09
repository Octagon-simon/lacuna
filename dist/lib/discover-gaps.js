import { join } from 'path';
import { scopedCoverageCommand } from './detector.js';
import { runCommand } from './runner.js';
import { loadCoverage, extractGaps, filterTestableGaps, findUncoveredFiles, findTestFiles, isWithinDir, } from './coverage/index.js';
import { detectJestConfigConflict, detectJestValidationError, parsePassCount } from './validate.js';
const EMPTY_REPORT = { files: [], totalLineRate: 0, totalFunctionRate: 0 };
export class DiscoverGapsError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DiscoverGapsError';
    }
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
export async function discoverScopeGaps(config, env, cwd, scopeDir, onLine) {
    const scopeRel = scopeDir ? scopeDir.replace(cwd + '/', '').replace(/\/+$/, '') : undefined;
    const coverageCommand = (scopeRel && scopedCoverageCommand(env, scopeRel)) || env.coverageCommand;
    const abs = (p) => (p.startsWith('/') ? p : join(cwd, p));
    const inScope = (p) => !scopeDir || isWithinDir(abs(p), scopeDir);
    const existingTests = await findTestFiles(cwd, {}, config, scopeDir);
    const hasTests = existingTests.length > 0;
    let report = EMPTY_REPORT;
    let ranSuite = false;
    if (hasTests) {
        const result = await runCommand(coverageCommand, cwd, config.coverageTimeout * 1000, onLine);
        ranSuite = true;
        const combined = result.stdout + result.stderr;
        if (result.timedOut) {
            throw new DiscoverGapsError(`Coverage run timed out after ${config.coverageTimeout}s — a test likely leaks an open handle. ` +
                `Raise coverageTimeout in .lacuna.json.`);
        }
        const configConflict = detectJestConfigConflict(combined);
        if (configConflict)
            throw new DiscoverGapsError(`Jest never ran any tests — no coverage report exists to read.\n\n${configConflict}`);
        const validationError = detectJestValidationError(combined);
        if (validationError)
            throw new DiscoverGapsError(validationError);
        if (/Tests:\s+0 total/i.test(combined) && parsePassCount(combined) === 0) {
            throw new DiscoverGapsError('Your test suites are failing before any tests run — no coverage was collected.');
        }
        try {
            report = await loadCoverage(config, cwd);
        }
        catch {
            throw new DiscoverGapsError(`Could not read the coverage report from ./${config.coverageDir}/ — check your runner's coverage config.`);
        }
    }
    // 1. Below-threshold files that already have tests (kept via includeExisting), scope-filtered.
    const belowThreshold = (await filterTestableGaps(extractGaps(report, config.threshold), config.ignore, { includeExisting: true, cwd }))
        .map((g) => ({ ...g, filePath: abs(g.filePath) }))
        .filter((g) => inScope(g.filePath));
    // 2. Files that never appeared in the report (findUncoveredFiles walks the scope + filters).
    const untouched = await findUncoveredFiles(report, config.sourceDir, cwd, config.ignore, scopeDir);
    const seen = new Set(belowThreshold.map((g) => g.filePath));
    const gaps = [...belowThreshold];
    for (const g of untouched)
        if (!seen.has(g.filePath))
            gaps.push(g);
    return { gaps, coverageBefore: report.totalLineRate * 100, ranSuite };
}
//# sourceMappingURL=discover-gaps.js.map