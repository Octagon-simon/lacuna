import { Command, Flags, Args } from '@oclif/core';
import { writeFile, stat } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { detectEnvironment, scopedCoverageCommand } from '../lib/detector.js';
import { runCommand } from '../lib/runner.js';
import { startCoverageSpinner } from '../lib/coverage-spinner.js';
import { loadCoverage, extractGaps, filterTestableGaps, findUncoveredFiles, findTestFiles, isWithinDir, narrowGapsToDiff, computePatchCoverage, missingChangedFileGaps } from '../lib/coverage/index.js';
import { resolveDiffScope, countChangedLines, scopeDiffToDir, GitDiffError } from '../lib/git-diff.js';
import { reportTerminal, buildJsonReport, buildMarkdownReport, getExitCode } from '../lib/reporter.js';
const EMPTY_REPORT = { files: [], totalLineRate: 0, totalFunctionRate: 0 };
export default class Analyze extends Command {
    static description = 'Analyze test coverage and show gaps — no files are changed';
    static examples = [
        '$ lacuna analyze',
        '$ lacuna analyze src/payments',
        '$ lacuna analyze @diff:origin/main',
        '$ lacuna analyze @diff packages/api',
        '$ lacuna analyze --threshold 90',
        '$ lacuna analyze --format json',
        '$ lacuna analyze --format markdown',
    ];
    // Two optional positionals, order-independent: a directory to scope the analysis to (a scoped
    // run only walks/instruments that subtree, so a brand-new folder reports in seconds), and/or
    // @diff[:<ref>] for read-only patch-coverage analysis of the lines changed vs the base ref.
    // Combining them — `analyze @diff packages/api` — reports patch coverage of just the changed
    // lines inside that folder.
    static args = {
        path: Args.string({
            description: 'Directory to scope to, or @diff[:<ref>] for patch coverage (default: whole project)',
            required: false,
        }),
        scope: Args.string({
            description: 'Directory to scope @diff to, when the first arg is @diff (e.g. `analyze @diff packages/api`)',
            required: false,
        }),
    };
    static flags = {
        threshold: Flags.integer({
            char: 't',
            description: 'Minimum coverage percentage',
        }),
        format: Flags.string({
            char: 'F',
            description: 'Output format',
            options: ['terminal', 'json', 'markdown'],
            default: 'terminal',
        }),
        output: Flags.string({
            char: 'o',
            description: 'Write report to file instead of stdout',
        }),
        verbose: Flags.boolean({
            char: 'v',
            description: 'Show uncovered line numbers per file',
            default: false,
        }),
    };
    async run() {
        const { args, flags } = await this.parse(Analyze);
        const config = await loadConfig();
        if (config.testEnv)
            Object.assign(process.env, config.testEnv);
        const env = await detectEnvironment(process.cwd(), config.testRunner);
        if (config.testCommand)
            env.testCommand = config.testCommand;
        const threshold = flags.threshold ?? config.threshold;
        const cwd = process.cwd();
        // Resolve the two optional positionals in either order: the @diff[:<ref>] token enters
        // read-only patch-coverage mode (not a filesystem path — no stat); a plain path scopes the
        // analysis to a directory (a file is accepted but scoped to its parent dir — single files
        // are a `lacuna generate --file` concern). Both together = patch coverage within the dir.
        const isDiffToken = (s) => s === '@diff' || (s?.startsWith('@diff:') ?? false);
        let diffToken;
        let dirArg;
        for (const a of [args.path, args.scope]) {
            if (!a)
                continue;
            if (isDiffToken(a)) {
                if (diffToken)
                    this.error('Pass @diff only once.');
                diffToken = a;
            }
            else {
                if (dirArg)
                    this.error(`Unexpected extra argument: ${a}`);
                dirArg = a;
            }
        }
        let scopeDir;
        let diffScope;
        if (dirArg) {
            const abs = resolve(cwd, dirArg);
            try {
                scopeDir = (await stat(abs)).isDirectory() ? abs : dirname(abs);
            }
            catch {
                this.error(`Path not found: ${dirArg}`);
            }
        }
        if (diffToken) {
            const ref = diffToken === '@diff' ? undefined : diffToken.slice('@diff:'.length);
            try {
                diffScope = await resolveDiffScope(cwd, ref);
            }
            catch (err) {
                this.error(err instanceof GitDiffError ? err.message : String(err));
            }
            // `@diff <dir>`: keep only changed files under the directory before any downstream work.
            if (scopeDir && diffScope)
                diffScope = scopeDiffToDir(diffScope, scopeDir);
        }
        const scopeRel = scopeDir ? scopeDir.replace(cwd + '/', '') : undefined;
        // Scoped coverage keeps the run cheap; null (runner unsupported) → full command + post-filter.
        // In diff mode use the FULL command even when scoped to a dir: patch coverage must match what
        // Codecov measured (a dir-scoped run executes only a subset of the tests that cover the file).
        const coverageCommand = (scopeRel && !diffScope && scopedCoverageCommand(env, scopeRel)) || env.coverageCommand;
        if (flags.format === 'terminal') {
            this.log(chalk.bold('\nlacuna analyze\n'));
        }
        if (env.testRunner === 'unknown') {
            this.warn('Could not detect test runner. Run `lacuna init` to configure.');
            this.exit(2);
        }
        if (flags.format === 'terminal') {
            this.log(`${chalk.dim('Detected:')}  ${chalk.cyan(env.testRunner)} (${env.language})`);
            if (diffScope)
                this.log(`${chalk.dim('Scope:')}     ${chalk.cyan(`diff vs ${diffScope.baseRef}${scopeRel ? ` under ${scopeRel}` : ''} (${diffScope.changed.size} changed file(s), ${countChangedLines(diffScope.changed)} line(s))`)}`);
            else if (scopeRel)
                this.log(`${chalk.dim('Scope:')}     ${chalk.cyan(scopeRel)}`);
            this.log(`${chalk.dim('Threshold:')} ${threshold}%\n`);
        }
        // Docs-only diff: nothing to analyze, and that's a pass — don't run the suite at all.
        if (diffScope && diffScope.changed.size === 0) {
            this.log(chalk.green(`No changed source files in the diff vs ${diffScope.baseRef} — nothing to cover.\n`));
            this.exit(0);
        }
        // Check if there are any test files before running the coverage command
        const existingTests = await findTestFiles(cwd, {}, config, scopeDir);
        const hasTests = existingTests.length > 0;
        let report = EMPTY_REPORT;
        if (!hasTests) {
            if (flags.format === 'terminal') {
                const where = scopeRel ? ` under ${scopeRel}` : '';
                this.log(chalk.dim(`  No test files yet${where} — scanning source files for coverage gaps.\n`));
            }
        }
        else {
            // Keep the spinner label short — the scoped coverage command can be very long and would
            // wrap across several terminal rows. The full command is still shown via --verbose runners.
            const runLabel = scopeRel
                ? `  Running coverage under ${scopeRel}...`
                : '  Running test suite to collect coverage...';
            const spinner = startCoverageSpinner(chalk.dim(runLabel), env.testRunner);
            const result = await runCommand(coverageCommand, cwd, config.coverageTimeout * 1000, spinner.onLine);
            spinner.stop();
            if (result.timedOut) {
                this.log(chalk.red(`\nTest suite timed out after ${config.coverageTimeout}s.`));
                this.log(chalk.yellow('\nThis usually means a test has an open handle (unclosed server, timer, or connection).'));
                this.log(chalk.dim(`\nIncrease the timeout in .lacuna.json: { "coverageTimeout": ${config.coverageTimeout * 2} }`));
                this.exit(2);
            }
            // bail if suites crashed on load (test files exist but zero tests ran)
            const combined = result.stdout + result.stderr;
            if (/Tests:\s+0 total/i.test(combined)) {
                this.log(chalk.red('\nYour test suites are failing before any tests run.'));
                this.log(chalk.yellow('\nThis usually means:'));
                this.log('  • A missing environment variable (check .env / .env.test)');
                this.log('  • A broken import or missing module');
                this.log('  • A setup file failing (DB connection, mock config, etc.)\n');
                this.log(chalk.dim('Run this to see the actual error:'));
                this.log(chalk.cyan(`  ${env.testCommand} 2>&1 | head -80`));
                this.exit(2);
            }
            // partial failures are fine — coverage is still collected for passing tests
            try {
                report = await loadCoverage(config, cwd);
            }
            catch {
                this.log(chalk.red(`Could not read coverage report from ./${config.coverageDir}/\n`));
                this.log(chalk.yellow('Make sure your vitest config has coverage enabled:'));
                this.log(chalk.dim('  // vitest.config.ts'));
                this.log(chalk.dim('  test: { coverage: { reporter: ["lcov", "text-summary"] } }'));
                this.exit(2);
            }
        }
        // When scoped, include below-threshold files that already have a test so the report shows
        // every gap in the folder (partially-covered files too), not just files with no test at all.
        // Diff mode ignores the per-file threshold (101 keeps every file with any uncovered line):
        // a 94%-covered file can still have uncovered CHANGED lines — the patch-coverage case.
        const rawGaps = await filterTestableGaps(extractGaps(report, diffScope ? 101 : threshold), config.ignore, { includeExisting: !!scopeDir || !!diffScope });
        let gaps = scopeDir
            ? rawGaps.filter((g) => isWithinDir(g.filePath.startsWith('/') ? g.filePath : join(cwd, g.filePath), scopeDir))
            : rawGaps;
        // append files that never appeared in the coverage report (never imported by any test)
        const untouchedFiles = await findUncoveredFiles(report, config.sourceDir, cwd, config.ignore, scopeDir);
        const existingPaths = new Set(gaps.map((g) => g.filePath));
        let untouchedCount = 0;
        for (const g of untouchedFiles) {
            if (!existingPaths.has(g.filePath)) {
                gaps.push(g);
                untouchedCount++;
            }
        }
        // Diff mode: keep only gaps in changed files, narrowed to the changed-and-uncovered lines,
        // and measure patch coverage (Codecov semantics) over the same changed-line set.
        let patchCoveragePct;
        if (diffScope) {
            const reportPaths = new Set(report.files.map((f) => (f.path.startsWith('/') ? f.path : join(cwd, f.path))));
            // Changed files in neither the report nor the gap set (existing test file that never
            // ran) still count — their changed lines are fully uncovered, not silently 100%.
            gaps.push(...await missingChangedFileGaps(diffScope.changed, report, gaps, cwd, config.ignore));
            gaps = narrowGapsToDiff(gaps, diffScope.changed, report, cwd);
            const outsideReport = new Set(gaps.map((g) => (g.filePath.startsWith('/') ? g.filePath : join(cwd, g.filePath)))
                .filter((p) => !reportPaths.has(p)));
            untouchedCount = outsideReport.size;
            patchCoveragePct = computePatchCoverage(report, diffScope.changed, cwd, outsideReport).pct;
        }
        const coveragePct = report.totalLineRate * 100;
        const functionCoveragePct = report.totalFunctionRate * 100;
        // untouched files are not in the LCOV report so they don't pull down coveragePct,
        // but they're real gaps — a project with 122 untested files shouldn't show PASS.
        // Diff mode passes on the patch coverage of the changed lines, like Codecov's patch gate.
        const passed = patchCoveragePct !== undefined
            ? patchCoveragePct >= threshold
            : coveragePct >= threshold && untouchedCount === 0;
        const input = {
            type: 'analyze',
            threshold,
            untouchedCount,
            analyze: {
                testRunner: env.testRunner,
                language: env.language,
                threshold,
                coveragePct,
                functionCoveragePct,
                gaps,
                untouchedCount,
                passed,
                scope: scopeRel,
                patchCoveragePct,
                diffBase: diffScope?.baseRef,
            },
        };
        if (flags.format === 'json') {
            const out = JSON.stringify(buildJsonReport(input), null, 2);
            if (flags.output) {
                await writeFile(flags.output, out, 'utf-8');
                this.log(`Report written to ${flags.output}`);
            }
            else {
                this.log(out);
            }
        }
        else if (flags.format === 'markdown') {
            const out = buildMarkdownReport(input);
            if (flags.output) {
                await writeFile(flags.output, out, 'utf-8');
                this.log(`Report written to ${flags.output}`);
            }
            else {
                this.log(out);
            }
        }
        else {
            reportTerminal(input);
            if (flags.verbose && gaps.length > 0) {
                for (const gap of gaps) {
                    if (gap.uncoveredLines.length > 0) {
                        const short = gap.filePath.replace(process.cwd() + '/', '');
                        this.log(chalk.dim(`  ${short} lines: ${gap.uncoveredLines.slice(0, 20).join(', ')}${gap.uncoveredLines.length > 20 ? '…' : ''}`));
                    }
                }
            }
        }
        this.exit(getExitCode(input));
    }
}
//# sourceMappingURL=analyze.js.map