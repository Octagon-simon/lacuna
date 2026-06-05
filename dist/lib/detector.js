import { readFile } from 'fs/promises';
import { join } from 'path';
const RUNNER_DEFAULTS = {
    vitest: {
        testRunner: 'vitest',
        language: 'typescript',
        testFilePattern: '**/*.{test,spec}.{ts,tsx,js,jsx}',
        coverageCommand: 'npx vitest run --coverage',
        testCommand: 'npx vitest run',
    },
    jest: {
        testRunner: 'jest',
        language: 'typescript',
        testFilePattern: '**/*.{test,spec}.{ts,tsx,js,jsx}',
        coverageCommand: 'npx jest --coverage',
        testCommand: 'npx jest',
    },
    mocha: {
        testRunner: 'mocha',
        language: 'javascript',
        testFilePattern: '**/*.{test,spec}.{js,mjs}',
        coverageCommand: 'npx nyc mocha',
        testCommand: 'npx mocha',
    },
    pytest: {
        testRunner: 'pytest',
        language: 'python',
        testFilePattern: 'test_*.py',
        coverageCommand: 'python -m pytest --cov --cov-report=lcov',
        testCommand: 'python -m pytest',
    },
    'go-test': {
        testRunner: 'go-test',
        language: 'go',
        testFilePattern: '*_test.go',
        coverageCommand: 'go test ./... -coverprofile=coverage/lcov.info',
        testCommand: 'go test ./...',
    },
    phpunit: {
        testRunner: 'phpunit',
        language: 'php',
        testFilePattern: '**/*Test.php',
        coverageCommand: './vendor/bin/phpunit --coverage-clover coverage/clover.xml',
        testCommand: './vendor/bin/phpunit',
    },
    pest: {
        testRunner: 'pest',
        language: 'php',
        testFilePattern: '**/*.test.php',
        coverageCommand: './vendor/bin/pest --coverage --coverage-clover coverage/clover.xml',
        testCommand: './vendor/bin/pest',
    },
    rspec: {
        testRunner: 'rspec',
        language: 'ruby',
        testFilePattern: 'spec/**/*_spec.rb',
        coverageCommand: 'bundle exec rspec',
        testCommand: 'bundle exec rspec',
    },
    'cargo-test': {
        testRunner: 'cargo-test',
        language: 'rust',
        testFilePattern: 'src/**/*.rs',
        coverageCommand: 'cargo tarpaulin --out Lcov --output-dir coverage',
        testCommand: 'cargo test',
    },
    'dotnet-test': {
        testRunner: 'dotnet-test',
        language: 'csharp',
        testFilePattern: '**/*Tests.cs',
        coverageCommand: 'dotnet test --collect:"XPlat Code Coverage"',
        testCommand: 'dotnet test',
    },
    'gradle-test': {
        testRunner: 'gradle-test',
        language: 'java',
        testFilePattern: 'src/test/**/*Test.java',
        coverageCommand: './gradlew test jacocoTestReport',
        testCommand: './gradlew test',
    },
    'maven-test': {
        testRunner: 'maven-test',
        language: 'java',
        testFilePattern: 'src/test/**/*Test.java',
        coverageCommand: 'mvn test jacoco:report',
        testCommand: 'mvn test',
    },
    'swift-test': {
        testRunner: 'swift-test',
        language: 'swift',
        testFilePattern: '**/*Tests.swift',
        coverageCommand: 'swift test --enable-code-coverage',
        testCommand: 'swift test',
    },
};
export function envForRunner(runner) {
    return (RUNNER_DEFAULTS[runner] ?? {
        testRunner: 'unknown',
        language: 'unknown',
        testFilePattern: '**/*.test.*',
        coverageCommand: '',
        testCommand: '',
    });
}
// Run multiple test files in a single invocation, with the victim always last.
// Forces sequential execution in a single thread with shared module registry so that
// state pollution (module singletons, globals, localStorage) from earlier files is
// visible to the victim — required for bisect to reproduce ordering failures.
export function multiFileTestCommand(env, files) {
    const fileList = files.join(' ');
    switch (env.testRunner) {
        case 'vitest':
            // --poolOptions.threads.singleThread=true: all files run in one worker thread (shared globals)
            // --no-isolate: all files share the same module registry (shared module singletons)
            return `npx vitest run --poolOptions.threads.singleThread=true --no-isolate ${fileList}`;
        case 'jest':
            return `npx jest --runInBand ${fileList}`;
        case 'mocha':
            return `npx mocha ${fileList}`;
        default:
            return fileTestCommand(env, files[files.length - 1]);
    }
}
export function fileTestCommand(env, testFilePath) {
    switch (env.testRunner) {
        case 'vitest': return `npx vitest run ${testFilePath}`;
        case 'jest': return `npx jest --testPathPattern=${testFilePath}`;
        case 'mocha': return `npx mocha ${testFilePath}`;
        case 'pytest': return `python -m pytest ${testFilePath} -v`;
        case 'go-test': {
            const dir = testFilePath.includes('/') ? testFilePath.replace(/\/[^/]+$/, '') : '.';
            return `go test ./${dir}/...`;
        }
        case 'phpunit': return `./vendor/bin/phpunit ${testFilePath}`;
        case 'pest': return `./vendor/bin/pest ${testFilePath}`;
        case 'rspec': return `bundle exec rspec ${testFilePath}`;
        case 'cargo-test': return `cargo test`;
        case 'dotnet-test': return `dotnet test --filter "${testFilePath.replace(/.*\//, '').replace(/Tests\.cs$/, '')}"`;
        case 'gradle-test': return `./gradlew test --tests "${testFilePath.replace(/.*\//, '').replace(/Test\.java$/, '')}"`;
        case 'maven-test': return `mvn test -Dtest="${testFilePath.replace(/.*\//, '').replace(/Test\.java$/, '')}"`;
        case 'swift-test': return `swift test --filter "${testFilePath.replace(/.*\//, '').replace(/Tests\.swift$/, '')}"`;
        default: return `${env.testCommand} ${testFilePath}`;
    }
}
export async function detectEnvironment(cwd = process.cwd(), configRunner) {
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
    };
}
//# sourceMappingURL=detector.js.map