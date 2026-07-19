import { readFile } from 'fs/promises';
import { join } from 'path';
import { runCommand } from './runner.js';
const RUNNER_DEFAULTS = {
    vitest: {
        testRunner: 'vitest',
        language: 'typescript',
        testFilePattern: '**/*.{test,spec}.{ts,tsx,js,jsx}',
        coverageCommand: 'npx vitest run --coverage',
        testCommand: 'npx vitest run',
        jestTestPathFlag: '',
    },
    jest: {
        testRunner: 'jest',
        language: 'typescript',
        testFilePattern: '**/*.{test,spec}.{ts,tsx,js,jsx}',
        coverageCommand: 'npx jest --coverage',
        testCommand: 'npx jest',
        jestTestPathFlag: '--testPathPatterns',
    },
    mocha: {
        testRunner: 'mocha',
        language: 'javascript',
        testFilePattern: '**/*.{test,spec}.{js,mjs}',
        coverageCommand: 'npx nyc mocha',
        testCommand: 'npx mocha',
        jestTestPathFlag: '',
    },
    pytest: {
        testRunner: 'pytest',
        language: 'python',
        testFilePattern: 'test_*.py',
        coverageCommand: 'python -m pytest --cov --cov-report=lcov',
        testCommand: 'python -m pytest',
        jestTestPathFlag: '',
    },
    'go-test': {
        testRunner: 'go-test',
        language: 'go',
        testFilePattern: '*_test.go',
        coverageCommand: 'go test ./... -coverprofile=coverage/lcov.info',
        testCommand: 'go test ./...',
        jestTestPathFlag: '',
    },
    phpunit: {
        testRunner: 'phpunit',
        language: 'php',
        testFilePattern: '**/*Test.php',
        coverageCommand: './vendor/bin/phpunit --coverage-clover coverage/clover.xml',
        testCommand: './vendor/bin/phpunit',
        jestTestPathFlag: '',
    },
    pest: {
        testRunner: 'pest',
        language: 'php',
        testFilePattern: '**/*.test.php',
        coverageCommand: './vendor/bin/pest --coverage --coverage-clover coverage/clover.xml',
        testCommand: './vendor/bin/pest',
        jestTestPathFlag: '',
    },
    rspec: {
        testRunner: 'rspec',
        language: 'ruby',
        testFilePattern: 'spec/**/*_spec.rb',
        coverageCommand: 'bundle exec rspec',
        testCommand: 'bundle exec rspec',
        jestTestPathFlag: '',
    },
    'cargo-test': {
        testRunner: 'cargo-test',
        language: 'rust',
        testFilePattern: 'src/**/*.rs',
        coverageCommand: 'cargo tarpaulin --out Lcov --output-dir coverage',
        testCommand: 'cargo test',
        jestTestPathFlag: '',
    },
    'dotnet-test': {
        testRunner: 'dotnet-test',
        language: 'csharp',
        testFilePattern: '**/*Tests.cs',
        coverageCommand: 'dotnet test --collect:"XPlat Code Coverage"',
        testCommand: 'dotnet test',
        jestTestPathFlag: '',
    },
    'gradle-test': {
        testRunner: 'gradle-test',
        language: 'java',
        testFilePattern: 'src/test/**/*Test.java',
        coverageCommand: './gradlew test jacocoTestReport',
        testCommand: './gradlew test',
        jestTestPathFlag: '',
    },
    'maven-test': {
        testRunner: 'maven-test',
        language: 'java',
        testFilePattern: 'src/test/**/*Test.java',
        coverageCommand: 'mvn test jacoco:report',
        testCommand: 'mvn test',
        jestTestPathFlag: '',
    },
    'swift-test': {
        testRunner: 'swift-test',
        language: 'swift',
        testFilePattern: '**/*Tests.swift',
        coverageCommand: 'swift test --enable-code-coverage',
        testCommand: 'swift test',
        jestTestPathFlag: '',
    },
};
export function envForRunner(runner) {
    return (RUNNER_DEFAULTS[runner] ?? {
        testRunner: 'unknown',
        language: 'unknown',
        testFilePattern: '**/*.test.*',
        coverageCommand: '',
        testCommand: '',
        jestTestPathFlag: '',
    });
}
// Wrap a shell argument in single quotes so that parentheses, spaces, and other
// shell-special characters in file paths (e.g. Expo Router's app/(tabs)/...) are
// treated as literals by /bin/sh. Escapes any embedded single-quote with '\''.
export function sq(path) {
    return `'${path.replace(/'/g, "'\\''")}'`;
}
// Escape regex meta-characters in a file path so it can be used as a literal
// match in Jest's --testPathPattern(s) (or a bare positional arg, which Jest also
// treats as a testPathPatterns regex). Without this, app/(tabs)/... becomes a
// regex capturing group that matches "app/tabs/..." (no parens) — 0 matches.
export function jestPath(path) {
    return sq(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
// Run multiple test files in a single invocation, with the victim always last.
// Forces sequential execution in a single thread with shared module registry so that
// state pollution (module singletons, globals, localStorage) from earlier files is
// visible to the victim — required for bisect to reproduce ordering failures.
export function multiFileTestCommand(env, files) {
    switch (env.testRunner) {
        case 'vitest': {
            const fileList = files.map(sq).join(' ');
            // --poolOptions.threads.singleThread=true: all files run in one worker thread (shared globals)
            // --no-isolate: all files share the same module registry (shared module singletons)
            // --coverage.enabled=false: bisect runs don't need coverage and it only adds the tmp-dir race.
            return `npx vitest run --poolOptions.threads.singleThread=true --no-isolate --coverage.enabled=false ${fileList}`;
        }
        case 'jest':
            return `npx jest --runInBand ${files.map(jestPath).join(' ')}`;
        case 'mocha':
            return `npx mocha ${files.map(sq).join(' ')}`;
        default:
            return fileTestCommand(env, files[files.length - 1]);
    }
}
// Builds a coverage command scoped to a single directory so a scoped analyze/generate doesn't
// instrument and run the whole repo (the 15-minute cost). Returns null for runners where we
// can't reliably narrow both the executed tests AND the instrumented files — the caller then
// falls back to the full coverageCommand and post-filters the report to the scope.
export function scopedCoverageCommand(env, relDir) {
    const dir = relDir.replace(/\/+$/, '');
    const q = sq(dir);
    switch (env.testRunner) {
        case 'vitest':
            // positional narrows which test files run; --coverage.include narrows instrumentation.
            return `npx vitest run ${q} --coverage --coverage.include=${sq(dir + '/**')}`;
        case 'jest':
            return `npx jest --coverage ${env.jestTestPathFlag}=${jestPath(dir)} --collectCoverageFrom=${sq(dir + '/**/*.{js,jsx,ts,tsx}')}`;
        default:
            return null;
    }
}
// Coverage command that runs only the tests RELATED to one source file (import-graph walk:
// every test file that transitively imports it), with instrumentation narrowed to that file.
// Reproduces the file's per-suite coverage in seconds instead of the full-suite cost — used by
// `generate @diff --file <src>`. Null for runners without related-test support → full command.
export function relatedCoverageCommand(env, relFile) {
    switch (env.testRunner) {
        case 'vitest':
            return `npx vitest related ${sq(relFile)} --run --coverage --coverage.include=${sq(relFile)}`;
        case 'jest':
            return `npx jest --findRelatedTests ${sq(relFile)} --coverage --collectCoverageFrom=${sq(relFile)}`;
        default:
            return null;
    }
}
// Like scopedCoverageCommand but for a plain test run (no instrumentation) — used by
// `lacuna fix <dir>` to only run the tests under a directory. Returns null for runners we
// can't narrow by directory; the caller falls back to the full testCommand + post-filter.
export function scopedTestCommand(env, relDir) {
    const dir = relDir.replace(/\/+$/, '');
    switch (env.testRunner) {
        case 'vitest': return `npx vitest run ${sq(dir)}`;
        case 'jest': return `npx jest ${env.jestTestPathFlag}=${jestPath(dir)}`;
        default: return null;
    }
}
export function fileTestCommand(env, testFilePath) {
    const q = sq(testFilePath);
    switch (env.testRunner) {
        // --coverage.enabled=false: per-file repair/verify runs never consume coverage, and when a
        // project enables coverage by default, N parallel `vitest run <file>` workers race on the
        // shared coverage tmp dir (ENOENT lstat '<reportsDir>/.tmp'). Disabling it avoids the race
        // and skips needless instrumentation.
        case 'vitest': return `npx vitest run ${q} --coverage.enabled=false`;
        case 'jest': return `npx jest ${env.jestTestPathFlag}=${jestPath(testFilePath)}`;
        case 'mocha': return `npx mocha ${q}`;
        case 'pytest': return `python -m pytest ${q} -v`;
        case 'go-test': {
            const dir = testFilePath.includes('/') ? testFilePath.replace(/\/[^/]+$/, '') : '.';
            return `go test ./${dir}/...`;
        }
        case 'phpunit': return `./vendor/bin/phpunit ${q}`;
        case 'pest': return `./vendor/bin/pest ${q}`;
        case 'rspec': return `bundle exec rspec ${q}`;
        case 'cargo-test': return `cargo test`;
        case 'dotnet-test': return `dotnet test --filter "${testFilePath.replace(/.*\//, '').replace(/Tests\.cs$/, '')}"`;
        case 'gradle-test': return `./gradlew test --tests "${testFilePath.replace(/.*\//, '').replace(/Test\.java$/, '')}"`;
        case 'maven-test': return `mvn test -Dtest="${testFilePath.replace(/.*\//, '').replace(/Test\.java$/, '')}"`;
        case 'swift-test': return `swift test --filter "${testFilePath.replace(/.*\//, '').replace(/Tests\.swift$/, '')}"`;
        default: return `${env.testCommand} ${q}`;
    }
}
// Jest hard-removed the singular `--testPathPattern` CLI flag in v30 (deprecated since
// 29.4) — every invocation with the old name now exits with a CLI usage error before
// running a single test ("Option \"testPathPattern\" was replaced by \"--testPathPatterns\"").
// We can't hardcode either form since plenty of projects are still on Jest <30, where the
// plural flag isn't recognized at all. Ask the actually-installed binary which major it is
// (once per run, cached on the DetectedEnvironment) and pick accordingly.
export async function detectJestTestPathFlag(cwd) {
    const result = await runCommand('npx jest --version', cwd, 15_000);
    const match = /^(\d+)\./.exec(result.stdout.trim());
    const major = match ? Number(match[1]) : NaN;
    return Number.isFinite(major) && major < 30 ? '--testPathPattern' : '--testPathPatterns';
}
export async function detectEnvironment(cwd = process.cwd(), configRunner) {
    const env = await resolveEnvironment(cwd, configRunner);
    if (env.testRunner === 'jest')
        return { ...env, jestTestPathFlag: await detectJestTestPathFlag(cwd) };
    return env;
}
async function resolveEnvironment(cwd, configRunner) {
    // config always wins over auto-detection
    if (configRunner && configRunner !== 'unknown') {
        return envForRunner(configRunner);
    }
    let pkg = {};
    try {
        const raw = await readFile(join(cwd, 'package.json'), 'utf-8');
        pkg = JSON.parse(raw);
    }
    catch { /* not a Node project */ }
    const deps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
    };
    if ('vitest' in deps)
        return RUNNER_DEFAULTS.vitest;
    if ('jest' in deps || '@jest/core' in deps)
        return RUNNER_DEFAULTS.jest;
    if ('mocha' in deps)
        return RUNNER_DEFAULTS.mocha;
    try {
        await readFile(join(cwd, 'pytest.ini'), 'utf-8');
        return RUNNER_DEFAULTS.pytest;
    }
    catch { /* not pytest */ }
    try {
        await readFile(join(cwd, 'pyproject.toml'), 'utf-8');
        return RUNNER_DEFAULTS.pytest;
    }
    catch { /* not Python */ }
    try {
        await readFile(join(cwd, 'go.mod'), 'utf-8');
        return RUNNER_DEFAULTS['go-test'];
    }
    catch { /* not Go */ }
    try {
        await readFile(join(cwd, 'Cargo.toml'), 'utf-8');
        return RUNNER_DEFAULTS['cargo-test'];
    }
    catch { /* not Rust */ }
    try {
        const gemfile = await readFile(join(cwd, 'Gemfile'), 'utf-8');
        if (/\brspec\b/.test(gemfile))
            return RUNNER_DEFAULTS.rspec;
    }
    catch { /* not Ruby */ }
    try {
        const composer = await readFile(join(cwd, 'composer.json'), 'utf-8');
        const composerJson = JSON.parse(composer);
        const composerDeps = { ...(composerJson.require ?? {}), ...(composerJson['require-dev'] ?? {}) };
        if ('pestphp/pest' in composerDeps)
            return RUNNER_DEFAULTS.pest;
        if ('phpunit/phpunit' in composerDeps)
            return RUNNER_DEFAULTS.phpunit;
        return RUNNER_DEFAULTS.phpunit; // default to phpunit for any PHP project
    }
    catch { /* not PHP */ }
    try {
        await readFile(join(cwd, 'Directory.Build.props'), 'utf-8');
        return RUNNER_DEFAULTS['dotnet-test'];
    }
    catch { /* not .NET */ }
    // Also detect .csproj / .sln as C# indicators
    try {
        const { readdir } = await import('fs/promises');
        const entries = await readdir(cwd);
        if (entries.some(e => e.endsWith('.csproj') || e.endsWith('.sln')))
            return RUNNER_DEFAULTS['dotnet-test'];
    }
    catch { /* not C# */ }
    try {
        await readFile(join(cwd, 'build.gradle'), 'utf-8');
        return RUNNER_DEFAULTS['gradle-test'];
    }
    catch { /* not Gradle */ }
    try {
        await readFile(join(cwd, 'build.gradle.kts'), 'utf-8');
        return RUNNER_DEFAULTS['gradle-test'];
    }
    catch { /* not Gradle Kotlin */ }
    try {
        await readFile(join(cwd, 'pom.xml'), 'utf-8');
        return RUNNER_DEFAULTS['maven-test'];
    }
    catch { /* not Maven */ }
    try {
        await readFile(join(cwd, 'Package.swift'), 'utf-8');
        return RUNNER_DEFAULTS['swift-test'];
    }
    catch { /* not Swift */ }
    return {
        testRunner: 'unknown',
        language: 'unknown',
        testFilePattern: '**/*.test.*',
        coverageCommand: '',
        testCommand: '',
        jestTestPathFlag: '',
    };
}
//# sourceMappingURL=detector.js.map