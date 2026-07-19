import { dirname, join, relative } from 'path';
import { readFile, access } from 'fs/promises';
import { envForRunner, fileTestCommand, multiFileTestCommand, scopedTestCommand, sq, jestPath, detectJestTestPathFlag } from './detector.js';
// Quote a path for a `npm test -- <path>` argument. For Jest, the positional arg is a
// testPathPattern REGEX, not a literal path — so regex meta-chars (e.g. the parens in Expo
// Router's app/(tabs)/...) must be escaped or the path matches 0 files ("No tests found"),
// which lacuna then misreports as an empty/no-it() test file. sq() alone shell-quotes but
// does NOT escape the regex, so Jest still sees (tabs) as a capture group. Vitest/others
// treat the positional as a literal substring filter, so plain shell-quoting is correct.
function npmTestArg(env, rel) {
    return env.testRunner === 'jest' ? jestPath(rel) : sq(rel);
}
// Monorepo/workspace support: a test must run under ITS OWN package's config so the package's
// `setupFiles` (cleanup, jest-dom), `environment`, and projects apply — exactly like the
// developer's own `npm test`. Running a bare `npx vitest run <file>` from the repo root skips
// that setup (e.g. Testing Library's afterEach cleanup never fires → DOM leaks across tests →
// false failures). This module resolves the nearest package/config root for a target and builds
// the run command there, preferring the package's own `test` npm script, falling back to bare
// runner invocation. Coverage runs deliberately stay at the repo root (that report is what
// Codecov ingests) — this is only for test EXECUTION (pass/fail) runs.
//
// A monorepo can also MIX runners across packages (one package still on Jest, another migrated
// to Vitest) — trusting a single repo-wide `testRunner` config for every file is wrong, and
// forces users to drop a redundant .lacuna.json into every package just to say what's already
// on disk. So findTestRoot below resolves the ACTUAL runner for each file's own package from
// filesystem ground truth (its npm test script / config file / own deps), not just the cwd to
// run it from. `defaultRunner` (config.testRunner / auto-detected repo-wide default) is only used
// when nothing nearer to the file says otherwise.
async function exists(p) {
    try {
        await access(p);
        return true;
    }
    catch {
        return false;
    }
}
const CONFIG_RUNNER = {
    'vitest.config.ts': 'vitest', 'vitest.config.js': 'vitest', 'vitest.config.mjs': 'vitest',
    'vitest.config.mts': 'vitest', 'vitest.config.cjs': 'vitest',
    'vite.config.ts': 'vitest', 'vite.config.js': 'vitest', 'vite.config.mjs': 'vitest', 'vite.config.mts': 'vitest',
    'jest.config.ts': 'jest', 'jest.config.js': 'jest', 'jest.config.cjs': 'jest', 'jest.config.mjs': 'jest', 'jest.config.json': 'jest',
};
const CONFIG_NAMES = Object.keys(CONFIG_RUNNER);
// A clean, single-command npm test script unambiguously names its runner — returns which, or
// null for a compound/chained script (`&&`, `||`, `;`, `|`) or one that isn't a bare vitest/jest
// invocation (for those we can't safely append `-- <path>`, so fall back to a bare runner call).
function runnerFromCleanScript(script) {
    if (/[&|;]/.test(script))
        return null;
    const s = script.trim().replace(/^npx\s+/, '');
    if (/^vitest(\s+run)?(\s|$)/.test(s))
        return 'vitest';
    if (/^jest(\s|$)/.test(s))
        return 'jest';
    return null;
}
// Walk up from `fromDir` (absolute) to the nearest package/config root at or below `repoRoot`,
// resolving BOTH the cwd to run tests from and the runner that actually governs that package.
// Ground truth, closest wins: (1) a package.json `scripts.test` that cleanly invokes one runner
// → npm-test mode (2) a vitest.config.*/vite.config.*/jest.config.* file (3) vitest/jest listed
// in that package's own deps. Falls back to `repoRoot` / `defaultRunner` if nothing nearby says
// otherwise. Single-package repos whose root script is a clean runner resolve to root+npmTest —
// same effective behavior as before, just via `npm test`.
export async function findTestRoot(fromDir, repoRoot, defaultRunner) {
    let dir = fromDir;
    let fallbackCwd = null;
    let fallbackRunner = null;
    while (true) {
        const pkgPath = join(dir, 'package.json');
        if (await exists(pkgPath)) {
            let pkg = {};
            try {
                pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
            }
            catch { /* ignore */ }
            const script = pkg.scripts?.test;
            if (script) {
                const detected = runnerFromCleanScript(script);
                if (detected)
                    return { cwd: dir, npmTest: true, runner: detected };
            }
            if (!fallbackCwd) {
                fallbackCwd = dir; // a package boundary, just no clean test script
                const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
                if ('vitest' in deps)
                    fallbackRunner = 'vitest';
                else if ('jest' in deps || '@jest/core' in deps)
                    fallbackRunner = 'jest';
            }
        }
        if (!fallbackRunner) {
            for (const c of CONFIG_NAMES) {
                if (await exists(join(dir, c))) {
                    if (!fallbackCwd)
                        fallbackCwd = dir;
                    fallbackRunner = CONFIG_RUNNER[c];
                    break;
                }
            }
        }
        if (dir === repoRoot)
            break;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return { cwd: fallbackCwd ?? repoRoot, npmTest: false, runner: fallbackRunner ?? defaultRunner };
}
// Builds the DetectedEnvironment to actually use for a resolved TestRoot — identical to `base`
// unless findTestRoot discovered a DIFFERENT runner for this specific package, in which case we
// rebuild the runner-specific defaults (and, for Jest, re-probe the version-appropriate
// --testPathPattern(s) flag against THAT package's own install).
async function envForRoot(base, root) {
    if (root.runner === base.testRunner)
        return base;
    const fresh = envForRunner(root.runner);
    if (root.runner === 'jest')
        return { ...fresh, jestTestPathFlag: await detectJestTestPathFlag(root.cwd) };
    return fresh;
}
// Resolves the DetectedEnvironment that actually governs `absFile`'s own package — used to keep
// prompt-building (mock API choice, etc.) in sync with whatever runner will really execute the
// file, exactly like the ResolvedRun helpers below.
export async function resolveEnvForFile(env, absFile, repoRoot) {
    const root = await findTestRoot(dirname(absFile), repoRoot, env.testRunner);
    return envForRoot(env, root);
}
// Same as resolveEnvForFile but for a directory (a `generate <dir>` scope) rather than a file.
export async function resolveEnvForDir(env, absDir, repoRoot) {
    const root = await findTestRoot(absDir, repoRoot, env.testRunner);
    return envForRoot(env, root);
}
// Per-file verify/repair run (pass/fail only — never consumes coverage).
export async function resolveFileTestRun(env, absFile, repoRoot) {
    const root = await findTestRoot(dirname(absFile), repoRoot, env.testRunner);
    const fileEnv = await envForRoot(env, root);
    const rel = relative(root.cwd, absFile);
    if (root.npmTest) {
        const covOff = fileEnv.testRunner === 'vitest' ? ' --coverage.enabled=false' : '';
        return { command: `npm test -- ${npmTestArg(fileEnv, rel)}${covOff}`, cwd: root.cwd };
    }
    return { command: fileTestCommand(fileEnv, rel), cwd: root.cwd };
}
// Scoped failure-finding run (all tests under a directory).
export async function resolveScopeTestRun(env, absDir, repoRoot) {
    const root = await findTestRoot(absDir, repoRoot, env.testRunner);
    const fileEnv = await envForRoot(env, root);
    const rel = relative(root.cwd, absDir);
    if (root.npmTest)
        return { command: rel ? `npm test -- ${npmTestArg(fileEnv, rel)}` : 'npm test', cwd: root.cwd };
    return { command: (rel && scopedTestCommand(fileEnv, rel)) || fileEnv.testCommand, cwd: root.cwd };
}
// Incremental patch-coverage run for `generate --file <src> @diff`: run the ONE new test file
// under its own package (so the package's setup/env/globalSetup apply and the test actually
// executes), instrument ONLY the changed source, and force the lcov to a temp dir we control.
// This replaces `vitest related` for the single-target case, which (1) balloons to the whole
// suite when the source is transitively imported by a central app module, and (2) writes coverage
// to the package's own reportsDirectory (often customized) that lacuna's root reader never sees.
// Returns null for runners we can't scope this way — caller falls back to the old behavior.
export async function resolveIncrementalCoverageRun(env, absTestFile, absSourceFile, repoRoot, outDir) {
    const root = await findTestRoot(dirname(absTestFile), repoRoot, env.testRunner);
    const fileEnv = await envForRoot(env, root);
    if (fileEnv.testRunner !== 'vitest' && fileEnv.testRunner !== 'jest')
        return null;
    const relTest = relative(root.cwd, absTestFile);
    const relSrc = relative(root.cwd, absSourceFile);
    let covFlags;
    let bareRun;
    if (fileEnv.testRunner === 'vitest') {
        // Force coverage ON, narrowed to the changed source, reported as lcov into OUR temp dir —
        // overriding whatever custom provider/reporter/reportsDirectory the package config sets.
        covFlags = `--coverage --coverage.enabled=true --coverage.include=${sq(relSrc)} --coverage.reporter=lcov --coverage.reportsDirectory=${sq(outDir)}`;
        bareRun = `npx vitest run ${sq(relTest)}`;
    }
    else {
        covFlags = `--coverage --collectCoverageFrom=${sq(relSrc)} --coverageReporters=lcov --coverageDirectory=${sq(outDir)}`;
        bareRun = `npx jest ${sq(relTest)}`;
    }
    const command = root.npmTest ? `npm test -- ${npmTestArg(fileEnv, relTest)} ${covFlags}` : `${bareRun} ${covFlags}`;
    return { command, cwd: root.cwd };
}
// Multi-file run (pollution victim/polluter checks). Uses the shared package root only when ALL
// files live under it; otherwise falls back to a bare repo-root run so we never mis-scope.
export async function resolveMultiFileTestRun(env, absFiles, repoRoot) {
    const first = await findTestRoot(dirname(absFiles[0]), repoRoot, env.testRunner);
    const fileEnv = await envForRoot(env, first);
    const allUnder = absFiles.every((f) => f === first.cwd || f.startsWith(first.cwd + '/'));
    if (allUnder && first.npmTest) {
        const rels = absFiles.map((f) => npmTestArg(fileEnv, relative(first.cwd, f))).join(' ');
        return { command: `npm test -- ${rels}`, cwd: first.cwd };
    }
    if (allUnder) {
        return { command: multiFileTestCommand(fileEnv, absFiles.map((f) => relative(first.cwd, f))), cwd: first.cwd };
    }
    return { command: multiFileTestCommand(env, absFiles.map((f) => relative(repoRoot, f))), cwd: repoRoot };
}
//# sourceMappingURL=test-run.js.map