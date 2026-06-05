import { Command } from '@oclif/core';
import { writeFile, readFile, access, mkdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { execSync } from 'child_process';
import { select, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { detectEnvironment } from '../lib/detector.js';
import { PRESETS } from '../lib/providers/index.js';
async function readProjectMeta(cwd) {
    try {
        const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
        const all = { ...pkg.dependencies, ...pkg.devDependencies };
        return {
            isReact: 'react' in all && !('react-native' in all),
            isReactNative: 'react-native' in all,
            isExpo: 'expo' in all,
            isNextJs: 'next' in all,
            isTypeScript: 'typescript' in all,
            isVue: 'vue' in all,
            isAngular: '@angular/core' in all,
            isSvelte: 'svelte' in all,
            isNestJs: '@nestjs/core' in all,
        };
    }
    catch {
        return { isReact: false, isReactNative: false, isExpo: false, isNextJs: false, isTypeScript: false, isVue: false, isAngular: false, isSvelte: false, isNestJs: false };
    }
}
async function checkPackageInstallState(pkg, cwd) {
    // Check package.json first — the source of truth for declared dependencies
    try {
        const json = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
        const all = {
            ...json['dependencies'],
            ...json['devDependencies'],
            ...json['peerDependencies'],
            ...json['optionalDependencies'],
        };
        if (pkg in all)
            return 'declared';
    }
    catch { /* fall through */ }
    // Check node_modules — present but undeclared means it was installed on a different
    // branch or manually, and won't survive a fresh CI checkout
    try {
        await access(join(cwd, 'node_modules', pkg));
        return 'undeclared';
    }
    catch { /* not found */ }
    return 'missing';
}
// Convenience wrapper used for checking individual extra packages (setupFilePackages)
async function isPackageInstalled(pkg, cwd) {
    return (await checkPackageInstallState(pkg, cwd)) !== 'missing';
}
async function writeFileWithDir(filePath, content) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
}
// Reads tsconfig.json and returns the filesystem path that "@/*" maps to.
// e.g. "@/*": ["./*"] → "."   "@/*": ["./src/*"] → "./src"
// Falls back to "." (project root) when tsconfig is absent or has no @/* mapping.
async function resolveAtAlias(cwd) {
    try {
        const raw = await readFile(join(cwd, 'tsconfig.json'), 'utf-8');
        // Strip comments before parsing (tsconfig allows them)
        const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const tsconfig = JSON.parse(cleaned);
        const paths = tsconfig.compilerOptions?.paths ?? {};
        // Look for @/* or @ entry
        const entry = paths['@/*'] ?? paths['@'];
        if (entry?.[0]) {
            // Strip trailing /* to get the base directory
            return entry[0].replace(/\/\*$/, '') || '.';
        }
    }
    catch { /* tsconfig missing or unparseable — use default */ }
    return '.';
}
// Walk up from startDir until we find a directory containing package.json.
// This ensures lacuna init works correctly even when run from a subdirectory.
async function findProjectRoot(startDir) {
    let dir = resolve(startDir);
    while (true) {
        try {
            await access(join(dir, 'package.json'));
            return dir;
        }
        catch {
            const parent = dirname(dir);
            if (parent === dir)
                return startDir; // reached filesystem root, fall back
            dir = parent;
        }
    }
}
function buildSetupFileContent(variant, runner) {
    // Mock cleanup — prevents spy state from leaking across tests and test files.
    // beforeEach: restores any globalThis spies left by previous files in the same worker
    //             (works in concert with restoreMocks: true in vitest.config.ts)
    // afterEach:  belt-and-suspenders cleanup within the file
    const vitestCleanup = [
        ``,
        `// ── Mock cleanup ──────────────────────────────────────────────────────────`,
        `// restoreMocks/clearMocks in vitest.config.ts handle this automatically,`,
        `// but explicit hooks here guard against any gaps.`,
        `// vi is available globally (globals: true in vitest.config.ts).`,
        ``,
        `beforeEach(() => {`,
        `  vi.restoreAllMocks()`,
        `})`,
        ``,
        `afterEach(() => {`,
        `  vi.restoreAllMocks()`,
        `  vi.clearAllMocks()`,
        `})`,
    ].join('\n');
    const jestCleanup = [
        ``,
        `// ── Mock cleanup ──────────────────────────────────────────────────────────`,
        `// Runs after every test to prevent mock state leaking across test files.`,
        `afterEach(() => {`,
        `  jest.restoreAllMocks()`,
        `  jest.clearAllMocks()`,
        `})`,
    ].join('\n');
    const cleanup = runner === 'vitest' ? vitestCleanup : jestCleanup;
    if (variant === 'react-native') {
        return [
            `// React Native / Expo test setup`,
            `// @testing-library/react-native matchers`,
            `import '@testing-library/react-native/extend-expect'`,
            ``,
            `import { jest } from '@jest/globals'`,
            ``,
            `// Silence the native animated warning in tests`,
            `jest.mock('react-native/Libraries/Animated/NativeAnimatedHelper')`,
            jestCleanup,
        ].join('\n') + '\n';
    }
    if (variant === 'angular') {
        return `import 'jest-preset-angular/setup-jest'\n` + jestCleanup + '\n';
    }
    if (variant === 'nest') {
        return `// NestJS test setup — no DOM environment needed\n` + jestCleanup + '\n';
    }
    if (variant === 'vue') {
        return `import '@testing-library/jest-dom'\n` + cleanup + '\n';
    }
    if (variant === 'svelte') {
        return `import '@testing-library/jest-dom'\n` + cleanup + '\n';
    }
    const lines = [`import '@testing-library/jest-dom'`];
    if (variant === 'nextjs') {
        lines.push(``, `// ── Next.js global mocks ──────────────────────────────────────────────────`, `// These run before every test so individual test files don't need to mock them.`, ``, `import { vi } from 'vitest'`, ``, `// next/navigation — useRouter, usePathname, etc. are server-side and fail in jsdom`, `vi.mock('next/navigation', () => ({`, `  useRouter:       vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() })),`, `  usePathname:     vi.fn(() => '/'),`, `  useSearchParams: vi.fn(() => new URLSearchParams()),`, `  useParams:       vi.fn(() => ({})),`, `  redirect:        vi.fn(),`, `  notFound:        vi.fn(),`, `}))`, ``, `// next/headers — server-only, throws in jsdom`, `vi.mock('next/headers', () => ({`, `  cookies: vi.fn(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn(), has: vi.fn(), getAll: vi.fn(() => []) })),`, `  headers: vi.fn(() => new Headers()),`, `}))`, ``, `// next/cache — no-ops in tests`, `vi.mock('next/cache', () => ({`, `  revalidatePath:  vi.fn(),`, `  revalidateTag:   vi.fn(),`, `  unstable_cache:  vi.fn((fn: () => unknown) => fn),`, `}))`, ``, `// next/image — uses Next.js image optimization which breaks in jsdom`, `vi.mock('next/image', () => ({`, `  default: vi.fn(({ src, alt, ...props }: Record<string, unknown>) => null),`, `}))`, ``, `// next/font — font loading tries to fetch/read files at import time, fails in tests`, `// Add any fonts your project uses that aren't listed here`, `vi.mock('next/font/google', () => new Proxy({}, {`, `  get: (_: object, fontName: string) =>`, `    () => ({ className: \`font-\${fontName.toLowerCase()}\`, style: { fontFamily: fontName } }),`, `}))`, `vi.mock('next/font/local', () => ({`, `  default: vi.fn(() => ({ className: 'font-local', style: { fontFamily: 'local' } })),`, `}))`, vitestCleanup);
    }
    else {
        // plain react
        lines.push(cleanup);
    }
    return lines.join('\n') + '\n';
}
async function ensureTestRunnerSetup(runner, sourceDir, cwd, log) {
    if (['pytest', 'go-test'].includes(runner))
        return undefined;
    const NON_NODE_RUNNERS = ['phpunit', 'pest', 'rspec', 'cargo-test', 'dotnet-test', 'gradle-test', 'maven-test', 'swift-test'];
    if (NON_NODE_RUNNERS.includes(runner)) {
        log(chalk.dim(`\n  ${runner} detected — skipping Node.js dependency setup.`));
        log(chalk.yellow(`  ⚠ Coverage analysis (lacuna analyze) requires LCOV output from your test runner.`));
        const hints = {
            phpunit: 'Add <logging><junit .../><coverage clover="..."/></logging> to phpunit.xml, or use --coverage-clover and convert with phpunit-coverage-lcov.',
            pest: 'Run pest --coverage --coverage-lcov coverage/lcov.info (requires Xdebug or PCOV).',
            rspec: 'Add gem "simplecov-lcov" to your Gemfile and configure SimpleCov::Formatter::LcovFormatter in spec_helper.rb.',
            'cargo-test': 'Install cargo-llvm-cov (cargo install cargo-llvm-cov) then run: cargo llvm-cov --lcov --output-path coverage/lcov.info',
            'dotnet-test': 'Install coverlet: dotnet add package coverlet.collector — then run: dotnet test --collect:"XPlat Code Coverage" and convert the XML to LCOV with reportgenerator.',
            'gradle-test': 'Add the JaCoCo plugin to build.gradle and run ./gradlew jacocoTestReport — then convert the XML report to LCOV with lcov-gradle-plugin or reportgenerator.',
            'maven-test': 'Add jacoco-maven-plugin to pom.xml and run mvn jacoco:report — then convert the XML to LCOV with reportgenerator.',
            'swift-test': 'Run swift test --enable-code-coverage then: llvm-cov export -format lcov .build/debug/<target>.xctest > coverage/lcov.info',
        };
        const hint = hints[runner];
        if (hint)
            log(chalk.dim(`  How to get LCOV: ${hint}`));
        log(chalk.dim(`  lacuna generate --file <path> works without coverage — it generates tests for a single file directly.\n`));
        return undefined;
    }
    const meta = await readProjectMeta(cwd);
    const installState = await checkPackageInstallState(runner, cwd);
    // ── Determine packages to install ─────────────────────────────────────────
    const basePackages = [];
    const setupFilePackages = [];
    if (runner === 'vitest') {
        basePackages.push('vitest', '@vitest/coverage-v8');
        if (meta.isReactNative) {
            // RN with vitest: warn but proceed, add @testing-library/react-native
            log(chalk.yellow('\n  ⚠ Vitest is not recommended for React Native — Metro transforms are incompatible out of the box.'));
            log(chalk.dim('  Consider Jest, which is the official test runner for React Native and Expo.'));
            setupFilePackages.push('@testing-library/react-native');
        }
        else if (meta.isVue) {
            basePackages.push('jsdom', '@vitejs/plugin-vue');
            setupFilePackages.push('@testing-library/vue', '@testing-library/jest-dom', '@testing-library/user-event');
        }
        else if (meta.isSvelte) {
            basePackages.push('jsdom', '@sveltejs/vite-plugin-svelte');
            setupFilePackages.push('@testing-library/svelte', '@testing-library/jest-dom');
        }
        else if (meta.isReact) {
            basePackages.push('jsdom');
            setupFilePackages.push('@testing-library/react', '@testing-library/jest-dom', '@testing-library/user-event');
        }
        // @vitejs/plugin-react is NOT needed for Vitest — esbuild handles JSX/TSX natively.
    }
    else if (runner === 'jest') {
        if (meta.isTypeScript) {
            basePackages.push('jest', '@types/jest', 'ts-jest');
        }
        else {
            basePackages.push('jest');
        }
        if (meta.isReactNative) {
            // Don't add jest-environment-jsdom for RN
            const rnPreset = meta.isExpo ? 'jest-expo' : 'react-native';
            if (rnPreset === 'jest-expo')
                basePackages.push('jest-expo');
            setupFilePackages.push('@testing-library/react-native');
        }
        else if (meta.isAngular) {
            basePackages.push('jest-preset-angular');
            setupFilePackages.push('@types/jest');
        }
        else if (meta.isNestJs) {
            // NestJS: no DOM environment needed
            setupFilePackages.push('@nestjs/testing');
        }
        else if (meta.isVue) {
            basePackages.push('jest-environment-jsdom');
            setupFilePackages.push('@testing-library/vue', '@testing-library/jest-dom', '@testing-library/user-event');
        }
        else if (meta.isSvelte) {
            basePackages.push('jest-environment-jsdom');
            setupFilePackages.push('@testing-library/svelte', '@testing-library/jest-dom', 'svelte-jeste');
        }
        else if (meta.isReact) {
            basePackages.push('jest-environment-jsdom');
            setupFilePackages.push('@testing-library/react', '@testing-library/jest-dom', '@testing-library/user-event');
        }
    }
    else if (runner === 'mocha') {
        basePackages.push('mocha', 'c8');
        if (meta.isTypeScript)
            basePackages.push('@types/mocha', 'ts-node');
    }
    // Determine setup file path based on framework
    const setupFilePath = (() => {
        if (meta.isReactNative || meta.isExpo)
            return `test/setup.ts`;
        if (meta.isNextJs)
            return `test/setup.ts`;
        if (meta.isAngular)
            return `test/setup.ts`;
        if (meta.isNestJs)
            return undefined; // NestJS doesn't need a DOM setup file
        if (meta.isReact || meta.isVue || meta.isSvelte)
            return `${sourceDir}/test/setup.ts`;
        return undefined;
    })();
    // ── Install missing packages ───────────────────────────────────────────────
    if (installState === 'missing') {
        const allPackages = [...basePackages, ...setupFilePackages];
        log(chalk.yellow(`\n  ${runner} is not installed.`));
        log(chalk.dim(`  Packages: ${allPackages.join(', ')}`));
        const doInstall = await confirm({ message: `Install ${runner} and dependencies?`, default: true });
        if (!doInstall) {
            log(chalk.dim(`  Skipped. Install manually: npm install -D ${allPackages.join(' ')}`));
        }
        else {
            log(chalk.dim(`\n  Installing packages...`));
            try {
                execSync(`npm install -D ${allPackages.join(' ')}`, { cwd, stdio: 'inherit' });
            }
            catch {
                log(chalk.red(`  Install failed. Run manually: npm install -D ${allPackages.join(' ')}`));
            }
        }
    }
    else if (installState === 'undeclared') {
        // Package exists in node_modules but is NOT declared in package.json.
        // This usually means it was installed on a different branch and won't survive
        // a fresh CI checkout — node_modules is not committed to git.
        const allPackages = [...basePackages, ...setupFilePackages];
        log(chalk.yellow(`\n  ${runner} was found in node_modules but is not declared in package.json.`));
        log(chalk.dim(`  This works locally but will break CI — a fresh checkout won't have node_modules.`));
        const doAdd = await confirm({
            message: `Add ${allPackages.join(', ')} to package.json? (recommended for CI)`,
            default: true,
        });
        if (!doAdd) {
            log(chalk.dim(`  Skipped. Add manually: npm install -D ${allPackages.join(' ')}`));
        }
        else {
            log(chalk.dim(`\n  Adding to package.json...`));
            try {
                execSync(`npm install -D ${allPackages.join(' ')}`, { cwd, stdio: 'inherit' });
            }
            catch {
                log(chalk.red(`  Failed. Run manually: npm install -D ${allPackages.join(' ')}`));
            }
        }
    }
    else if ((meta.isNextJs || meta.isReact) && setupFilePackages.length > 0) {
        // Runner is installed — check if the extra testing-library packages are present.
        // Must use a for-loop: Array.filter ignores async callbacks (the Promise is always truthy).
        const missing = [];
        for (const p of setupFilePackages) {
            if (!(await isPackageInstalled(p, cwd)))
                missing.push(p);
        }
        if (missing.length > 0) {
            log(chalk.dim(`\n  Installing missing test dependencies: ${missing.join(', ')}`));
            try {
                execSync(`npm install -D ${missing.join(' ')}`, { cwd, stdio: 'inherit' });
            }
            catch {
                log(chalk.yellow(`  Could not install: ${missing.join(', ')} — add them manually if needed`));
            }
        }
    }
    // ── Create setup file ──────────────────────────────────────────────────────
    let createdSetupFile;
    if (setupFilePath) {
        const absSetup = join(cwd, setupFilePath);
        try {
            await access(absSetup);
            log(chalk.dim(`  ${setupFilePath} already exists — skipping.`));
            createdSetupFile = setupFilePath;
        }
        catch {
            const setupVariant = (meta.isReactNative || meta.isExpo) ? 'react-native'
                : meta.isNextJs ? 'nextjs'
                    : meta.isAngular ? 'angular'
                        : meta.isNestJs ? 'nest'
                            : meta.isVue ? 'vue'
                                : meta.isSvelte ? 'svelte'
                                    : 'react';
            const setupContent = buildSetupFileContent(setupVariant, runner);
            await writeFileWithDir(absSetup, setupContent);
            log(chalk.green(`  ✓ Created ${setupFilePath}`));
            if (meta.isNextJs) {
                log(chalk.dim(`    Includes global mocks for next/navigation, next/headers, next/cache`));
                // Create the empty module that the server-only alias points to.
                // Without this file, Vitest crashes when any source file imports 'server-only'.
                const emptyModulePath = resolve(cwd, 'test/empty-module.ts');
                try {
                    await access(emptyModulePath);
                }
                catch {
                    await writeFileWithDir(emptyModulePath, 'export default {}\n');
                    log(chalk.green(`  ✓ Created test/empty-module.ts`));
                    log(chalk.dim(`    Used as the server-only alias target in vitest.config.ts`));
                }
            }
            createdSetupFile = setupFilePath;
        }
    }
    // ── Create runner config ───────────────────────────────────────────────────
    if (runner === 'vitest') {
        // Always resolve to an absolute path so the config is never created inside
        // a subdirectory regardless of how cwd was derived.
        const configPath = resolve(cwd, 'vitest.config.ts');
        try {
            await access(configPath);
            log(chalk.dim(`  vitest.config.ts already exists at ${configPath} — skipping.`));
        }
        catch {
            const setupLine = createdSetupFile
                ? `\n    setupFiles: ['./${createdSetupFile}'],`
                : '';
            const envLine = (meta.isReact || meta.isVue || meta.isSvelte) ? `\n    environment: 'jsdom',` : '';
            // Next.js uses @/ as the root alias. Read the actual target from tsconfig.json
            // to stay consistent with whatever the project has configured.
            // No React plugin needed: Vitest uses esbuild which handles JSX/TSX natively.
            const aliasTarget = meta.isNextJs ? await resolveAtAlias(cwd) : null;
            // Next.js: add server-only alias so Vitest doesn't crash on Next.js server-only imports.
            // server-only is a Next.js guard that throws at build time if server code leaks to the client;
            // in Vitest it just needs to resolve to something harmless.
            const serverOnlyAlias = meta.isNextJs
                ? `,\n      'server-only': path.resolve(__dirname, './test/empty-module.ts')`
                : '';
            const aliasBlock = aliasTarget
                ? `\n  resolve: {\n    alias: { '@': path.resolve(__dirname, '${aliasTarget}')${serverOnlyAlias} },\n  },`
                : '';
            const pathImport = aliasTarget ? `import path from 'path'\n` : '';
            const vuePlugin = meta.isVue ? `\nimport vue from '@vitejs/plugin-vue'` : '';
            const sveltePlugin = meta.isSvelte ? `\nimport { svelte } from '@sveltejs/vite-plugin-svelte'` : '';
            const pluginsBlock = meta.isVue
                ? `\n  plugins: [vue()],`
                : meta.isSvelte
                    ? `\n  plugins: [svelte({ hot: !process.env.VITEST })],`
                    : '';
            const content = [
                `${pathImport}${vuePlugin}${sveltePlugin}import { defineConfig } from 'vitest/config'`,
                ``,
                `export default defineConfig({${aliasBlock}${pluginsBlock}`,
                `  test: {`,
                `    globals: true,${envLine}${setupLine}`,
                `    // Restore and clear all mocks automatically before each test.`,
                `    // restoreMocks runs at the Vitest worker level and can restore globalThis spies`,
                `    // that the module-level vi instance cannot see — preventing cross-file contamination`,
                `    // when multiple test files share the same worker thread.`,
                `    restoreMocks: true,`,
                `    clearMocks: true,`,
                `    coverage: {`,
                `      provider: 'v8',`,
                `      reporter: ['lcov', 'text-summary'],`,
                `      reportsDirectory: './coverage',`,
                `    },`,
                `  },`,
                `})`,
                ``,
            ].join('\n');
            await writeFile(configPath, content);
            log(chalk.green(`  ✓ Created vitest.config.ts at project root`));
        }
        log(chalk.dim(`\n  Add to package.json scripts: "test": "vitest run --coverage"`));
    }
    else if (runner === 'jest') {
        const configPath = resolve(cwd, 'jest.config.js');
        try {
            await access(configPath);
            log(chalk.dim(`  jest.config.js already exists — skipping.`));
        }
        catch {
            const setupLine = createdSetupFile
                ? `\n  setupFilesAfterFramework: ['<rootDir>/${createdSetupFile}'],`
                : '';
            const needsJsdom = (meta.isReact || meta.isVue || meta.isSvelte) && !meta.isReactNative && !meta.isAngular && !meta.isNestJs;
            const envLine = needsJsdom ? `\n  testEnvironment: 'jsdom',` : '';
            const tsLines = meta.isTypeScript
                ? `\n  transform: { '^.+\\\\.tsx?$': 'ts-jest' },`
                : '';
            const rnPreset = meta.isExpo ? 'jest-expo' : 'react-native';
            const presetLine = meta.isReactNative ? `\n  preset: '${rnPreset}',` : '';
            const transformIgnoreLine = meta.isReactNative
                ? `\n  transformIgnorePatterns: ['node_modules/(?!(react-native|@react-native|@react-navigation|expo|@expo|@testing-library)/)',],`
                : '';
            const angularPreset = meta.isAngular ? `\n  preset: 'jest-preset-angular',` : '';
            const content = [
                `/** @type {import('jest').Config} */`,
                `module.exports = {${presetLine}${angularPreset}${envLine}${tsLines}${transformIgnoreLine}${setupLine}`,
                `  coverageReporters: ['lcov', 'text-summary'],`,
                `  coverageDirectory: 'coverage',`,
                `}`,
                ``,
            ].join('\n');
            await writeFile(configPath, content);
            log(chalk.green(`  ✓ Created jest.config.js`));
        }
        log(chalk.dim(`\n  Add to package.json scripts: "test": "jest --coverage"`));
    }
    else if (runner === 'mocha') {
        const configPath = resolve(cwd, '.mocharc.json');
        try {
            await access(configPath);
            log(chalk.dim(`  .mocharc.json already exists — skipping.`));
        }
        catch {
            const content = JSON.stringify({
                spec: `${sourceDir}/**/*.test.{ts,js}`,
                require: meta.isTypeScript ? ['ts-node/register'] : [],
            }, null, 2) + '\n';
            await writeFile(configPath, content);
            log(chalk.green(`  ✓ Created .mocharc.json`));
        }
        log(chalk.dim(`\n  Add to package.json scripts: "test": "c8 --reporter=lcov mocha"`));
    }
    return createdSetupFile;
}
export default class Init extends Command {
    static description = 'Interactive setup wizard — configure lacuna for your project';
    static examples = ['$ lacuna init'];
    async run() {
        const cwd = await findProjectRoot(process.cwd());
        if (cwd !== process.cwd()) {
            this.log(chalk.dim(`  (running from ${process.cwd()} — using project root: ${cwd})\n`));
        }
        const configPath = join(cwd, '.lacuna.json');
        try {
            await access(configPath);
            const overwrite = await confirm({
                message: '.lacuna.json already exists. Overwrite it?',
                default: false,
            });
            if (!overwrite) {
                this.log('Keeping existing config.');
                return;
            }
        }
        catch { /* file doesn't exist — proceed */ }
        this.log(chalk.bold('\nlacuna init\n'));
        const env = await detectEnvironment();
        // ── Model / provider ──────────────────────────────────────────────────────
        const presetKey = await select({
            message: 'Which model do you want to use?',
            choices: [
                ...Object.entries(PRESETS).map(([key, p]) => ({ value: key, name: p.label })),
            ],
        });
        let preset = PRESETS[presetKey];
        if (presetKey === 'custom') {
            preset = {
                ...preset,
                baseURL: await input({ message: 'Base URL (e.g. https://api.example.com/v1):' }),
                model: await input({ message: 'Model name:' }),
                apiKeyEnv: await input({ message: 'API key env var name:', default: 'LLM_API_KEY' }),
                apiKeyHint: '',
            };
        }
        else if (presetKey === 'openrouter') {
            const orModel = await input({ message: 'OpenRouter model (leave blank for default):', default: preset.model });
            preset = { ...preset, model: orModel };
        }
        else if (presetKey === 'ollama') {
            const ollamaModel = await input({ message: 'Ollama model name:', default: 'llama3.2' });
            preset = { ...preset, model: ollamaModel };
        }
        // ── Test runner ───────────────────────────────────────────────────────────
        const detectedRunner = env.testRunner !== 'unknown' ? env.testRunner : undefined;
        const testRunner = await select({
            message: 'Test runner:',
            choices: [
                { value: 'vitest', name: `vitest${detectedRunner === 'vitest' ? ' (detected)' : ''}` },
                { value: 'jest', name: `jest${detectedRunner === 'jest' ? ' (detected)' : ''}` },
                { value: 'mocha', name: `mocha${detectedRunner === 'mocha' ? ' (detected)' : ''}` },
                { value: 'pytest', name: `pytest${detectedRunner === 'pytest' ? ' (detected)' : ''}` },
                { value: 'go-test', name: `go test${detectedRunner === 'go-test' ? ' (detected)' : ''}` },
                { value: 'phpunit', name: `phpunit${detectedRunner === 'phpunit' ? ' (detected)' : ''}` },
                { value: 'pest', name: `pest (PHP)${detectedRunner === 'pest' ? ' (detected)' : ''}` },
                { value: 'rspec', name: `rspec (Ruby)${detectedRunner === 'rspec' ? ' (detected)' : ''}` },
                { value: 'cargo-test', name: `cargo test (Rust)${detectedRunner === 'cargo-test' ? ' (detected)' : ''}` },
                { value: 'dotnet-test', name: `dotnet test (C#)${detectedRunner === 'dotnet-test' ? ' (detected)' : ''}` },
                { value: 'gradle-test', name: `gradle test (Java/Kotlin)${detectedRunner === 'gradle-test' ? ' (detected)' : ''}` },
                { value: 'maven-test', name: `mvn test (Java)${detectedRunner === 'maven-test' ? ' (detected)' : ''}` },
                { value: 'swift-test', name: `swift test (Swift)${detectedRunner === 'swift-test' ? ' (detected)' : ''}` },
            ],
            default: detectedRunner ?? 'vitest',
        });
        // ── Source directory ──────────────────────────────────────────────────────
        const sourceDir = await input({
            message: 'Source directory (where your source files live):',
            default: 'src',
        });
        // ── Test runner setup (install + config + setup file) ─────────────────────
        const createdSetupFile = await ensureTestRunnerSetup(testRunner, sourceDir, cwd, (msg) => this.log(msg));
        // ── Setup file (if not created above) ────────────────────────────────────
        let setupFile = createdSetupFile;
        if (!setupFile) {
            const hasSetup = await confirm({
                message: 'Do you have a test setup file (e.g. vitest.setup.ts / jest.setup.ts)?',
                default: false,
            });
            if (hasSetup) {
                setupFile = await input({
                    message: 'Path to setup file:',
                    default: `${sourceDir}/test/setup.ts`,
                });
            }
        }
        // ── Mocks file ────────────────────────────────────────────────────────────
        const hasMocks = await confirm({
            message: 'Do you have (or want) a shared mock file for all tests?',
            default: true,
        });
        let mocksFile;
        if (hasMocks) {
            mocksFile = await input({
                message: 'Path to shared mock file:',
                default: `${sourceDir}/test/mocks.ts`,
            });
        }
        // ── Coverage threshold ────────────────────────────────────────────────────
        const thresholdStr = await input({ message: 'Coverage threshold (%):', default: '80' });
        const threshold = parseInt(thresholdStr, 10);
        // ── Build config ──────────────────────────────────────────────────────────
        const config = {
            provider: preset.provider,
            model: preset.model,
            apiKeyEnv: preset.apiKeyEnv || undefined,
            testRunner: testRunner,
            coverageFormat: 'lcov',
            coverageDir: 'coverage',
            sourceDir: [sourceDir],
            threshold,
            maxIterations: 3,
        };
        if (preset.baseURL)
            config.baseURL = preset.baseURL;
        if (mocksFile)
            config.mocksFile = mocksFile;
        if (setupFile)
            config.setupFile = setupFile;
        const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
        await writeFile(configPath, JSON.stringify(clean, null, 2) + '\n');
        // ── Summary ───────────────────────────────────────────────────────────────
        this.log(chalk.green('\n✓ Created .lacuna.json\n'));
        this.log(chalk.bold('Setup summary:'));
        this.log(`  Model:      ${chalk.cyan(preset.model)} via ${preset.provider}`);
        this.log(`  Runner:     ${chalk.cyan(testRunner)}`);
        this.log(`  Source dir: ${chalk.cyan(sourceDir)}`);
        this.log(`  Threshold:  ${threshold}%`);
        if (setupFile)
            this.log(`  Setup file: ${chalk.cyan(setupFile)}`);
        if (mocksFile)
            this.log(`  Mocks file: ${chalk.cyan(mocksFile)}`);
        if (preset.apiKeyEnv) {
            const keySet = process.env[preset.apiKeyEnv];
            const keyStatus = keySet ? chalk.green('set ✓') : chalk.red('NOT set ✗');
            this.log(`  API key:    ${chalk.dim(preset.apiKeyEnv)} — ${keyStatus}`);
            if (!keySet) {
                this.log(chalk.yellow(`\n  Get your key: ${preset.apiKeyHint}`));
                this.log(chalk.dim(`  Then run: export ${preset.apiKeyEnv}=your-key-here`));
            }
        }
        else {
            this.log(`  API key:    ${chalk.dim('none (local model)')}`);
        }
        this.log(`\nNext steps:`);
        this.log(`  ${chalk.cyan('lacuna analyze')}   — see coverage gaps`);
        this.log(`  ${chalk.cyan('lacuna generate')}  — fill them with AI-generated tests\n`);
    }
}
//# sourceMappingURL=init.js.map