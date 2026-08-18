// Test-runner scaffolding — the non-interactive half of `lacuna init`: detect the project's
// frameworks, install the runner + testing-library deps, and scaffold runner config / setup files.
// Extracted from commands/init.ts so it can be imported as a LIBRARY (no @oclif/@inquirer deps) —
// the VS Code extension bundles this and runs it directly (out/scaffold.js) instead of shelling out
// to a published `lacuna-cli`, so the two packages have no runtime version coupling.
import { writeFile, readFile, access, mkdir } from 'fs/promises'
import { join, dirname, resolve } from 'path'
import { execSync } from 'child_process'
import chalk from 'chalk'
import { detectEnvironment } from './detector.js'

// Returns the absolute path of the first `names` entry found at `cwd`, or null if none exist.
// Used before scaffolding a runner config so we don't create e.g. jest.config.js next to an
// already-existing jest.config.ts — checking only the one canonical filename missed every
// other valid extension (.ts/.cjs/.mjs/.json) and duplicated the config.
async function findExistingConfig(cwd: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const p = resolve(cwd, name)
    try { await access(p); return p } catch { /* try next */ }
  }
  return null
}

// When we skip scaffolding because a runner config already exists, that config is untouched —
// we never parse or rewrite an arbitrary existing jest/vitest config (too risky: TS config files
// can contain any expression, and a naive rewrite could corrupt it the way a bad JSON-comment
// strip once corrupted tsconfig aliases). But lacuna's coverage-reading step has a hard
// requirement the config must satisfy: an lcov reporter writing into `coverageDir` (from
// .lacuna.json, 'coverage' by default). Neither is passed on the CLI — `npx jest --coverage` /
// `npx vitest run --coverage` rely entirely on the project's own config for the reporter list
// and output directory. If the existing config doesn't already produce lcov there, every
// subsequent `lacuna generate`/`analyze` run will fail at "Could not read coverage report",
// exactly like the vitest custom-reporter-filename issue this session fixed downstream — except
// this case has no report to fall back to at all. Do a best-effort text scan (not a real
// parser) and warn loudly with the exact keys to add, rather than failing silently later.
function warnIfMissingLcovCoverage(configPath: string, configText: string, coverageDir: string, kind: 'jest' | 'vitest', log: (msg: string) => void): void {
  const hasLcov = /lcov/i.test(configText)
  const dirKey = kind === 'jest' ? 'coverageDirectory' : 'reportsDirectory'
  const hasDirKey = new RegExp(dirKey).test(configText)
  if (hasLcov && hasDirKey) return
  const reporterHint = kind === 'jest'
    ? `coverageReporters: ['lcov', 'text-summary'],\n  coverageDirectory: '${coverageDir}',`
    : `coverage: { provider: 'v8', reporter: ['lcov', 'text-summary'], reportsDirectory: '${coverageDir}' }`
  log(chalk.yellow(`  ⚠ ${configPath} exists but doesn't appear to configure an lcov reporter${hasDirKey ? '' : ` or ${dirKey}`}.`))
  log(chalk.yellow(`    lacuna reads coverage from ${coverageDir}/lcov.info after every run — without this, "generate"/"analyze" will fail`))
  log(chalk.yellow(`    with "Could not read coverage report". Add to your ${kind} config:`))
  log(chalk.dim(`      ${reporterHint}`))
}

// A pre-existing jest.config.js/ts for a React Native/Expo project that uses "@/" imports (the
// Expo Router default template ships it in tsconfig.json) but has no moduleNameMapper for it
// fails EVERY file that imports via the alias with "Cannot find module '@/...'" before a single
// test runs — the exact symptom live-reproduced this session on a real Expo SDK 57 project.
// Best-effort text scan (not a real parser), mirrors warnIfMissingLcovCoverage's pattern.
async function warnIfMissingAliasMapper(configPath: string, configText: string, cwd: string, log: (msg: string) => void): Promise<void> {
  if (/moduleNameMapper/.test(configText)) return
  const raw = await readFile(join(cwd, 'tsconfig.json'), 'utf-8').catch(() => null)
  if (!raw) return
  const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  let paths: Record<string, string[]> | undefined
  try {
    paths = (JSON.parse(cleaned) as { compilerOptions?: { paths?: Record<string, string[]> } }).compilerOptions?.paths
  } catch { return }
  if (!paths?.['@/*'] && !paths?.['@']) return
  log(chalk.yellow(`  ⚠ ${configPath} exists but has no moduleNameMapper, even though tsconfig.json declares a "@/" path alias.`))
  log(chalk.yellow(`    Every test file that imports via "@/..." will fail with "Cannot find module" before a single test runs. Add:`))
  log(chalk.dim(`      moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' }`))
}

interface ProjectMeta {
  isReact: boolean
  isReactNative: boolean
  isExpo: boolean
  isNextJs: boolean
  isTypeScript: boolean
  isVue: boolean
  isAngular: boolean
  isSvelte: boolean
  isNestJs: boolean
}

export async function readProjectMeta(cwd: string): Promise<ProjectMeta> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const all = { ...pkg.dependencies, ...pkg.devDependencies }
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
    }
  } catch {
    return { isReact: false, isReactNative: false, isExpo: false, isNextJs: false, isTypeScript: false, isVue: false, isAngular: false, isSvelte: false, isNestJs: false }
  }
}

type InstallState =
  | 'declared'       // in package.json — fully set up
  | 'undeclared'     // in node_modules but NOT in package.json — CI will fail without declaring it
  | 'missing'        // not found anywhere

async function checkPackageInstallState(pkg: string, cwd: string): Promise<InstallState> {
  // Check package.json first — the source of truth for declared dependencies
  try {
    const json = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8')) as Record<string, Record<string, string> | undefined>
    const all = {
      ...json['dependencies'],
      ...json['devDependencies'],
      ...json['peerDependencies'],
      ...json['optionalDependencies'],
    }
    if (pkg in all) return 'declared'
  } catch { /* fall through */ }

  // Check node_modules — present but undeclared means it was installed on a different
  // branch or manually, and won't survive a fresh CI checkout
  try {
    await access(join(cwd, 'node_modules', pkg))
    return 'undeclared'
  } catch { /* not found */ }

  return 'missing'
}

// Convenience wrapper used for checking individual extra packages (setupFilePackages)
async function isPackageInstalled(pkg: string, cwd: string): Promise<boolean> {
  return (await checkPackageInstallState(pkg, cwd)) !== 'missing'
}

// Resolves the jest version range that a preset (e.g. jest-expo) declares as its
// peer dependency, so we install a compatible jest rather than whatever is latest.
// Falls back to bare 'jest' if the lookup fails (offline, registry unavailable, etc).
function resolveJestVersionForPreset(preset: string, cwd: string): { pkg: string; warned: boolean } {
  // 1. Check if preset is already installed locally — no network needed
  try {
    const localPkg = JSON.parse(execSync(`cat node_modules/${preset}/package.json 2>/dev/null`, { cwd, encoding: 'utf-8', stdio: 'pipe' }))
    const range: string | undefined = localPkg?.peerDependencies?.jest
    const major = range?.match(/\d+/)?.[0]
    if (major) return { pkg: `jest@${major}`, warned: false }
  } catch { /* not installed yet */ }

  // 2. Fall back to npm registry lookup
  try {
    const out = execSync(`npm info ${preset} peerDependencies.jest 2>/dev/null`, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()
    const cleaned = out.replace(/^['"]|['"]$/g, '')
    const major = cleaned.match(/\d+/)?.[0]
    if (major) return { pkg: `jest@${major}`, warned: false }
  } catch { /* registry unreachable */ }

  // 3. Could not resolve — warn so the user knows to check manually
  return { pkg: 'jest', warned: true }
}

async function writeFileWithDir(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

// Reads tsconfig.json and returns the filesystem path that "@/*" maps to.
// e.g. "@/*": ["./*"] → "."   "@/*": ["./src/*"] → "./src"
// Falls back to "." (project root) when tsconfig is absent or has no @/* mapping.
async function resolveAtAlias(cwd: string): Promise<string> {
  try {
    const raw = await readFile(join(cwd, 'tsconfig.json'), 'utf-8')
    // Strip comments before parsing (tsconfig allows them)
    const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    const tsconfig = JSON.parse(cleaned) as { compilerOptions?: { paths?: Record<string, string[]> } }
    const paths = tsconfig.compilerOptions?.paths ?? {}
    // Look for @/* or @ entry
    const entry = paths['@/*'] ?? paths['@']
    if (entry?.[0]) {
      // Strip trailing /* to get the base directory
      return entry[0].replace(/\/\*$/, '') || '.'
    }
  } catch { /* tsconfig missing or unparseable — use default */ }
  return '.'
}

// Walk up from startDir until we find a directory containing package.json.
// This ensures lacuna init works correctly even when run from a subdirectory.
export async function findProjectRoot(startDir: string): Promise<string> {
  let dir = resolve(startDir)
  while (true) {
    try {
      await access(join(dir, 'package.json'))
      return dir
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return startDir // reached filesystem root, fall back
      dir = parent
    }
  }
}

function buildSetupFileContent(variant: 'react' | 'react-native' | 'vue' | 'svelte' | 'angular' | 'nest' | 'nextjs', runner: string, isExpo = false, hasReanimated = false, hasWorklets = false): string {
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
  ].join('\n')

  const jestCleanup = [
    ``,
    `// ── Mock cleanup ──────────────────────────────────────────────────────────`,
    `// Runs after every test to prevent mock state leaking across test files.`,
    `afterEach(() => {`,
    `  jest.restoreAllMocks()`,
    `  jest.clearAllMocks()`,
    `})`,
  ].join('\n')

  const cleanup = runner === 'vitest' ? vitestCleanup : jestCleanup

  if (variant === 'react-native') {
    // react-native-worklets (reanimated v4's separated native multithreading engine) has no
    // native runtime in Jest, so the real module throws installing its worklets bridge
    // ("Cannot read properties of undefined (reading 'loadUnpackers')"). Must be mocked BEFORE
    // react-native-reanimated, since reanimated's own mock still requires it internally.
    // Live-reproduced: a real Expo SDK 57 + reanimated v4 project hit exactly this crash with
    // no mock present at all — `lacuna init` was scaffolding a setup file with no reanimated
    // guidance whatsoever, even though reanimated is one of the most common RN/Expo deps.
    const workletsMocks = hasWorklets ? [
      ``,
      `// react-native-worklets — reanimated v4's native multithreading engine. Must be mocked`,
      `// BEFORE react-native-reanimated below (its mock still requires this internally).`,
      `jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'))`,
    ] : []
    const reanimatedMocks = hasReanimated ? [
      ``,
      `// Reanimated — no native runtime in Jest, use its own official mock.`,
      `jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'))`,
    ] : []
    const expoMocks = isExpo ? [
      ``,
      `// ── Expo module mocks ─────────────────────────────────────────────────────`,
      `// Expo's "winter" runtime (SDK 54+) lazily installs a global.fetch backed by a REAL`,
      `// native module (ExpoFetchModule, via expo-modules-core's requireNativeModule) the`,
      `// first time anything reads fetch/Response/Request — there's no native runtime in`,
      `// Jest, so requireNativeModule resolves to undefined and the first access throws`,
      `// "Cannot read properties of undefined (reading 'NativeResponse')" deep inside`,
      `// node_modules/expo/src/winter/fetch/FetchResponse.ts. This is infrastructure, not`,
      `// anything a test file can fix — mock the exact native module boundary once here so`,
      `// every test file is unblocked, instead of each one hitting (and failing to explain)`,
      `// the same crash independently. Live-reproduced: 18+ test files in one real Expo SDK`,
      `// 57 project all crashed identically here before this mock was added.`,
      `jest.mock('expo/src/winter/fetch/ExpoFetchModule', () => ({`,
      `  ExpoFetchModule: {`,
      `    NativeResponse: class {},`,
      `    NativeRequest: class {},`,
      `    unstable_createBlobData: jest.fn(async () => ''),`,
      `  },`,
      `}))`,
      ``,
      `jest.mock('expo-constants', () => ({`,
      `  default: { expoConfig: { name: 'App', slug: 'app' } },`,
      `}))`,
      ``,
      `jest.mock('expo-router', () => ({`,
      `  useRouter: jest.fn(() => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() })),`,
      `  useLocalSearchParams: jest.fn(() => ({})),`,
      `  usePathname: jest.fn(() => '/'),`,
      `  useSegments: jest.fn(() => []),`,
      `  Link: jest.fn(({ children }: { children: React.ReactNode }) => children),`,
      `  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },`,
      `}))`,
      ``,
      `jest.mock('expo-status-bar', () => ({`,
      `  StatusBar: jest.fn(() => null),`,
      `}))`,
    ] : []

    return [
      `// React Native / Expo test setup`,
      `import React from 'react'`,
      ``,
      `// ── Native module mocks ───────────────────────────────────────────────────`,
      `// These modules rely on native code that is unavailable in the Jest environment.`,
      ``,
      `// Safe area context — provides insets/frame for components that use useSafeAreaInsets`,
      `jest.mock('react-native-safe-area-context', () => ({`,
      `  SafeAreaProvider: jest.fn(({ children }: { children: React.ReactNode }) => children),`,
      `  SafeAreaView: jest.fn(({ children }: { children: React.ReactNode }) => children),`,
      `  useSafeAreaInsets: jest.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 })),`,
      `  useSafeAreaFrame: jest.fn(() => ({ x: 0, y: 0, width: 390, height: 844 })),`,
      `}))`,
      ...workletsMocks,
      ...reanimatedMocks,
      ``,
      `// Gesture handler — required by react-navigation and many UI libraries`,
      `jest.mock('react-native-gesture-handler', () => {`,
      `  const RN = jest.requireActual('react-native')`,
      `  return {`,
      `    ...RN,`,
      `    GestureHandlerRootView: jest.fn(({ children }: { children: React.ReactNode }) => children),`,
      `    PanGestureHandler: jest.fn(({ children }: { children: React.ReactNode }) => children),`,
      `    TapGestureHandler: jest.fn(({ children }: { children: React.ReactNode }) => children),`,
      `    Swipeable: jest.fn(({ children }: { children: React.ReactNode }) => children),`,
      `  }`,
      `})`,
      ``,
      `// AsyncStorage — native async key-value store`,
      `jest.mock('@react-native-async-storage/async-storage', () =>`,
      `  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock')`,
      `)`,
      ``,
      `// React Navigation — mock the navigation hooks to avoid needing a real NavigationContainer`,
      `jest.mock('@react-navigation/native', () => ({`,
      `  ...jest.requireActual('@react-navigation/native'),`,
      `  useNavigation: jest.fn(() => ({ navigate: jest.fn(), goBack: jest.fn(), push: jest.fn(), replace: jest.fn() })),`,
      `  useRoute: jest.fn(() => ({ params: {} })),`,
      `  useFocusEffect: jest.fn((cb: () => void) => cb()),`,
      `  useIsFocused: jest.fn(() => true),`,
      `}))`,
      ...expoMocks,
      jestCleanup,
    ].join('\n') + '\n'
  }

  if (variant === 'angular') {
    return `import 'jest-preset-angular/setup-jest'\n` + jestCleanup + '\n'
  }

  if (variant === 'nest') {
    return `// NestJS test setup — no DOM environment needed\n` + jestCleanup + '\n'
  }

  if (variant === 'vue') {
    return `import '@testing-library/jest-dom'\n` + cleanup + '\n'
  }

  if (variant === 'svelte') {
    return `import '@testing-library/jest-dom'\n` + cleanup + '\n'
  }

  const lines = [`import '@testing-library/jest-dom'`]

  if (variant === 'nextjs') {
    lines.push(
      ``,
      `// ── Next.js global mocks ──────────────────────────────────────────────────`,
      `// These run before every test so individual test files don't need to mock them.`,
      ``,
      `import { vi, beforeEach, afterEach } from 'vitest'`,
      ``,
      `// next/navigation — useRouter, usePathname, etc. are server-side and fail in jsdom`,
      `vi.mock('next/navigation', () => ({`,
      `  useRouter:       vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() })),`,
      `  usePathname:     vi.fn(() => '/'),`,
      `  useSearchParams: vi.fn(() => new URLSearchParams()),`,
      `  useParams:       vi.fn(() => ({})),`,
      `  redirect:        vi.fn(),`,
      `  notFound:        vi.fn(),`,
      `}))`,
      ``,
      `// next/headers — server-only, throws in jsdom`,
      `vi.mock('next/headers', () => ({`,
      `  cookies: vi.fn(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn(), has: vi.fn(), getAll: vi.fn(() => []) })),`,
      `  headers: vi.fn(() => new Headers()),`,
      `}))`,
      ``,
      `// next/cache — no-ops in tests`,
      `vi.mock('next/cache', () => ({`,
      `  revalidatePath:  vi.fn(),`,
      `  revalidateTag:   vi.fn(),`,
      `  unstable_cache:  vi.fn((fn: () => unknown) => fn),`,
      `}))`,
      ``,
      `// next/image — uses Next.js image optimization which breaks in jsdom`,
      `vi.mock('next/image', () => ({`,
      `  default: vi.fn(({ src, alt, ...props }: Record<string, unknown>) => null),`,
      `}))`,
      ``,
      `// next/font — font loading tries to fetch/read files at import time, fails in tests`,
      `// Add any fonts your project uses that aren't listed here`,
      `vi.mock('next/font/google', () => new Proxy({}, {`,
      `  get: (_: object, fontName: string) =>`,
      `    () => ({ className: \`font-\${fontName.toLowerCase()}\`, style: { fontFamily: fontName } }),`,
      `}))`,
      `vi.mock('next/font/local', () => ({`,
      `  default: vi.fn(() => ({ className: 'font-local', style: { fontFamily: 'local' } })),`,
      `}))`,
      vitestCleanup,
    )
  } else {
    // plain react
    lines.push(cleanup)
  }

  return lines.join('\n') + '\n'
}

// The `test` / `test:cov` scripts each runner should have. `test` is the fast, no-coverage run (the
// inner loop and what `npm test` / CI call); `test:cov` opts into coverage — matching the scaffolded
// config where coverage is off by default. These are what `lacuna` and CI rely on; without them a
// project "works" until the first `npm test` / pipeline, then breaks.
function desiredTestScripts(runner: string): Record<string, string> {
  switch (runner) {
    case 'vitest': return { test: 'vitest run', 'test:cov': 'vitest run --coverage' }
    case 'jest':   return { test: 'jest', 'test:cov': 'jest --coverage' }
    case 'mocha':  return { test: 'mocha', 'test:cov': 'c8 --reporter=lcov mocha' }
    default:       return {}
  }
}

// `npm init`'s placeholder test script — not a real command, safe to replace.
const NPM_PLACEHOLDER_TEST = /^echo\s+["']?Error: no test specified["']?\s*&&\s*exit\s+1$/

// Preserve the file's own indentation (2-space, 4-space, or tabs) so we don't reformat the whole
// package.json just to add two scripts.
function detectJsonIndent(raw: string): string | number {
  const m = raw.match(/\n([ \t]+)"/)
  return m ? m[1] : 2
}

// Idempotently ensure package.json has the runner's test scripts. Adds `test` if missing (or if it's
// npm's placeholder), adds `test:cov` if missing, and NEVER clobbers a real user-authored script.
// This is the step whose absence "breaks tomorrow" — the scaffold used to only PRINT a suggestion.
// Exported for tests.
export async function ensureTestScripts(cwd: string, runner: string, log: (msg: string) => void): Promise<void> {
  const desired = desiredTestScripts(runner)
  if (Object.keys(desired).length === 0) return

  const pkgPath = join(cwd, 'package.json')
  let raw: string
  try { raw = await readFile(pkgPath, 'utf-8') } catch { return } // no package.json → nothing to wire
  let pkg: { scripts?: Record<string, string> } & Record<string, unknown>
  try { pkg = JSON.parse(raw) } catch {
    log(chalk.yellow('  ⚠ package.json is not valid JSON — add test scripts manually: ' + JSON.stringify(desired)))
    return
  }

  const scripts = (pkg.scripts && typeof pkg.scripts === 'object') ? pkg.scripts : {}
  const added: string[] = []

  const currentTest = typeof scripts.test === 'string' ? scripts.test.trim() : ''
  if (!currentTest || NPM_PLACEHOLDER_TEST.test(currentTest)) {
    if (scripts.test !== desired.test) { scripts.test = desired.test; added.push('test') }
  } else if (currentTest && !/\b(vitest|jest|mocha)\b/.test(currentTest)) {
    // A real but non-runner `test` script (e.g. a lint alias) — don't clobber it, but surface it so
    // the user knows `npm test` won't run the suite the runner config expects.
    log(chalk.yellow(`  ⚠ Existing "test" script doesn't run ${runner}: ${currentTest}`))
    log(chalk.dim(`    Left it untouched. Added the runner as "test:${runner}" instead.`))
    if (!scripts[`test:${runner}`]) { scripts[`test:${runner}`] = desired.test; added.push(`test:${runner}`) }
  }
  if (!scripts['test:cov']) { scripts['test:cov'] = desired['test:cov']; added.push('test:cov') }

  if (added.length === 0) {
    log(chalk.dim('  package.json test scripts already present — skipping.'))
    return
  }
  pkg.scripts = scripts
  const newline = raw.endsWith('\n') ? '\n' : ''
  await writeFile(pkgPath, JSON.stringify(pkg, null, detectJsonIndent(raw)) + newline)
  log(chalk.green(`  ✓ Added package.json script${added.length > 1 ? 's' : ''}: ${added.join(', ')}`))
}

export async function ensureTestRunnerSetup(
  runner: string,
  sourceDir: string,
  cwd: string,
  log: (msg: string) => void,
  yes = false,
  // Interactive install consent, injected by the CLI (inquirer). Omitted by library callers, who
  // pass yes=true — so this module carries no @inquirer dependency and bundles cleanly.
  confirmInstall?: (message: string) => Promise<boolean>,
  // Where to put the setup file, overriding the framework default. Wired from the caller's
  // configured `setupFile` (e.g. the VS Code panel / .lacuna.json) so the scaffolded file lands where
  // config says it will — otherwise the panel writes `test/setup.ts` while the scaffold creates
  // `src/test/setup.ts`, and the two silently disagree.
  setupFileOverride?: string,
): Promise<string | undefined> {
  if (['pytest', 'go-test'].includes(runner)) return undefined

  const NON_NODE_RUNNERS = ['phpunit', 'pest', 'rspec', 'cargo-test', 'dotnet-test', 'gradle-test', 'maven-test', 'swift-test']
  if (NON_NODE_RUNNERS.includes(runner)) {
    log(chalk.dim(`\n  ${runner} detected — skipping Node.js dependency setup.`))
    log(chalk.yellow(`  ⚠ Coverage analysis (lacuna analyze) requires LCOV output from your test runner.`))
    const hints: Record<string, string> = {
      phpunit:      'Add <logging><junit .../><coverage clover="..."/></logging> to phpunit.xml, or use --coverage-clover and convert with phpunit-coverage-lcov.',
      pest:         'Run pest --coverage --coverage-lcov coverage/lcov.info (requires Xdebug or PCOV).',
      rspec:        'Add gem "simplecov-lcov" to your Gemfile and configure SimpleCov::Formatter::LcovFormatter in spec_helper.rb.',
      'cargo-test': 'Install cargo-llvm-cov (cargo install cargo-llvm-cov) then run: cargo llvm-cov --lcov --output-path coverage/lcov.info',
      'dotnet-test':'Install coverlet: dotnet add package coverlet.collector — then run: dotnet test --collect:"XPlat Code Coverage" and convert the XML to LCOV with reportgenerator.',
      'gradle-test':'Add the JaCoCo plugin to build.gradle and run ./gradlew jacocoTestReport — then convert the XML report to LCOV with lcov-gradle-plugin or reportgenerator.',
      'maven-test': 'Add jacoco-maven-plugin to pom.xml and run mvn jacoco:report — then convert the XML to LCOV with reportgenerator.',
      'swift-test': 'Run swift test --enable-code-coverage then: llvm-cov export -format lcov .build/debug/<target>.xctest > coverage/lcov.info',
    }
    const hint = hints[runner]
    if (hint) log(chalk.dim(`  How to get LCOV: ${hint}`))
    log(chalk.dim(`  lacuna generate --file <path> works without coverage — it generates tests for a single file directly.\n`))
    return undefined
  }

  const meta = await readProjectMeta(cwd)
  const installState = await checkPackageInstallState(runner, cwd)

  // ── Determine packages to install ─────────────────────────────────────────

  const basePackages: string[] = []
  const setupFilePackages: string[] = []

  if (runner === 'vitest') {
    basePackages.push('vitest', '@vitest/coverage-v8')
    if (meta.isReactNative) {
      // RN with vitest: warn but proceed, add @testing-library/react-native
      log(chalk.yellow('\n  ⚠ Vitest is not recommended for React Native — Metro transforms are incompatible out of the box.'))
      log(chalk.dim('  Consider Jest, which is the official test runner for React Native and Expo.'))
      setupFilePackages.push('@testing-library/react-native')
    } else if (meta.isVue) {
      basePackages.push('jsdom', '@vitejs/plugin-vue')
      setupFilePackages.push('@testing-library/vue', '@testing-library/jest-dom', '@testing-library/user-event')
    } else if (meta.isSvelte) {
      basePackages.push('jsdom', '@sveltejs/vite-plugin-svelte')
      setupFilePackages.push('@testing-library/svelte', '@testing-library/jest-dom')
    } else if (meta.isReact) {
      basePackages.push('jsdom')
      setupFilePackages.push('@testing-library/react', '@testing-library/jest-dom', '@testing-library/user-event')
    }
    // @vitejs/plugin-react is NOT needed for Vitest — esbuild handles JSX/TSX natively.
  } else if (runner === 'jest') {
    if (meta.isReactNative) {
      // Use the jest version that the preset actually supports — resolved at init time
      // so this stays correct when jest-expo bumps its peer dep in the future.
      const rnPreset = meta.isExpo ? 'jest-expo' : '@react-native/jest-preset'
      const { pkg: jestPkg, warned } = resolveJestVersionForPreset(rnPreset, cwd)
      if (warned) {
        log(chalk.yellow(`  ⚠ Could not resolve compatible jest version for ${rnPreset}. Installing latest — if tests fail with version mismatch errors, pin jest to the version in ${rnPreset}'s peerDependencies.`))
      }
      const jestMajor = jestPkg.includes('@') ? jestPkg.split('@')[1] : ''
      basePackages.push(jestPkg, jestMajor ? `@types/jest@${jestMajor}` : '@types/jest')
    } else if (meta.isTypeScript) {
      basePackages.push('jest', '@types/jest', 'ts-jest')
    } else {
      basePackages.push('jest', '@types/jest')
    }
    if (meta.isReactNative) {
      // Don't add jest-environment-jsdom for RN
      const rnPreset = meta.isExpo ? 'jest-expo' : 'react-native'
      if (rnPreset === 'jest-expo') basePackages.push('jest-expo')
      setupFilePackages.push('@testing-library/react-native')
    } else if (meta.isAngular) {
      basePackages.push('jest-preset-angular')
      setupFilePackages.push('@types/jest')
    } else if (meta.isNestJs) {
      // NestJS: no DOM environment needed
      setupFilePackages.push('@nestjs/testing')
    } else if (meta.isVue) {
      basePackages.push('jest-environment-jsdom')
      setupFilePackages.push('@testing-library/vue', '@testing-library/jest-dom', '@testing-library/user-event')
    } else if (meta.isSvelte) {
      basePackages.push('jest-environment-jsdom')
      setupFilePackages.push('@testing-library/svelte', '@testing-library/jest-dom', 'svelte-jeste')
    } else if (meta.isReact) {
      basePackages.push('jest-environment-jsdom')
      setupFilePackages.push('@testing-library/react', '@testing-library/jest-dom', '@testing-library/user-event')
    }
  } else if (runner === 'mocha') {
    basePackages.push('mocha', 'c8')
    if (meta.isTypeScript) basePackages.push('@types/mocha', 'ts-node')
  }

  // Determine setup file path based on framework
  const defaultSetupPath = (() => {
    if (meta.isReactNative || meta.isExpo) return `test/setup.ts`
    if (meta.isNextJs) return `test/setup.ts`
    if (meta.isAngular) return `test/setup.ts`
    if (meta.isNestJs) return undefined  // NestJS doesn't need a DOM setup file
    if (meta.isReact || meta.isVue || meta.isSvelte) return `${sourceDir}/test/setup.ts`
    return undefined
  })()
  // Honor a caller-configured setup path, but only for a framework that actually gets a setup file —
  // an override can't invent meaningful setup content for a plain-TS/NestJS project that has none.
  const setupFilePath = defaultSetupPath ? (setupFileOverride?.trim() || defaultSetupPath) : undefined

  // ── Install missing packages ───────────────────────────────────────────────

  if (installState === 'missing') {
    const allPackages = [...basePackages, ...setupFilePackages]
    log(chalk.yellow(`\n  ${runner} is not installed.`))
    log(chalk.dim(`  Packages: ${allPackages.join(', ')}`))

    const doInstall = yes ? true : confirmInstall ? await confirmInstall(`Install ${runner} and dependencies?`) : true
    if (!doInstall) {
      log(chalk.dim(`  Skipped. Install manually: npm install -D ${allPackages.join(' ')}`))
    } else {
      log(chalk.dim(`\n  Installing packages...`))
      try {
        execSync(`npm install -D ${allPackages.join(' ')}`, { cwd, stdio: 'inherit' })
      } catch {
        log(chalk.red(`  Install failed. Run manually: npm install -D ${allPackages.join(' ')}`))
      }
    }
  } else if (installState === 'undeclared') {
    // Package exists in node_modules but is NOT declared in package.json.
    // This usually means it was installed on a different branch and won't survive
    // a fresh CI checkout — node_modules is not committed to git.
    const allPackages = [...basePackages, ...setupFilePackages]
    log(chalk.yellow(`\n  ${runner} was found in node_modules but is not declared in package.json.`))
    log(chalk.dim(`  This works locally but will break CI — a fresh checkout won't have node_modules.`))

    const doAdd = yes ? true : confirmInstall ? await confirmInstall(`Add ${allPackages.join(', ')} to package.json? (recommended for CI)`) : true
    if (!doAdd) {
      log(chalk.dim(`  Skipped. Add manually: npm install -D ${allPackages.join(' ')}`))
    } else {
      log(chalk.dim(`\n  Adding to package.json...`))
      try {
        execSync(`npm install -D ${allPackages.join(' ')}`, { cwd, stdio: 'inherit' })
      } catch {
        log(chalk.red(`  Failed. Run manually: npm install -D ${allPackages.join(' ')}`))
      }
    }
  } else if ((meta.isNextJs || meta.isReact) && setupFilePackages.length > 0) {
    // Runner is installed — check if the extra testing-library packages are present.
    // Must use a for-loop: Array.filter ignores async callbacks (the Promise is always truthy).
    const missing: string[] = []
    for (const p of setupFilePackages) {
      if (!(await isPackageInstalled(p, cwd))) missing.push(p)
    }
    if (missing.length > 0) {
      log(chalk.dim(`\n  Installing missing test dependencies: ${missing.join(', ')}`))
      try {
        execSync(`npm install -D ${missing.join(' ')}`, { cwd, stdio: 'inherit' })
      } catch {
        log(chalk.yellow(`  Could not install: ${missing.join(', ')} — add them manually if needed`))
      }
    }
  }

  // ── Create setup file ──────────────────────────────────────────────────────

  let createdSetupFile: string | undefined
  if (setupFilePath) {
    const absSetup = join(cwd, setupFilePath)
    try {
      await access(absSetup)
      log(chalk.dim(`  ${setupFilePath} already exists — skipping.`))
      createdSetupFile = setupFilePath
    } catch {
      const setupVariant = (meta.isReactNative || meta.isExpo) ? 'react-native'
        : meta.isNextJs ? 'nextjs'
        : meta.isAngular ? 'angular'
        : meta.isNestJs ? 'nest'
        : meta.isVue ? 'vue'
        : meta.isSvelte ? 'svelte'
        : 'react'
      const hasReanimated = (meta.isReactNative || meta.isExpo) && await isPackageInstalled('react-native-reanimated', cwd)
      const hasWorklets = (meta.isReactNative || meta.isExpo) && await isPackageInstalled('react-native-worklets', cwd)
      const setupContent = buildSetupFileContent(setupVariant, runner, meta.isExpo, hasReanimated, hasWorklets)
      await writeFileWithDir(absSetup, setupContent)
      log(chalk.green(`  ✓ Created ${setupFilePath}`))
      if (meta.isNextJs) {
        log(chalk.dim(`    Includes global mocks for next/navigation, next/headers, next/cache`))
        // Create the empty module that the server-only alias points to.
        // Without this file, Vitest crashes when any source file imports 'server-only'.
        const emptyModulePath = resolve(cwd, 'test/empty-module.ts')
        try {
          await access(emptyModulePath)
        } catch {
          await writeFileWithDir(emptyModulePath, 'export default {}\n')
          log(chalk.green(`  ✓ Created test/empty-module.ts`))
          log(chalk.dim(`    Used as the server-only alias target in vitest.config.ts`))
        }
      }
      createdSetupFile = setupFilePath
    }
  }

  // ── Create runner config ───────────────────────────────────────────────────

  if (runner === 'vitest') {
    // Always resolve to an absolute path so the config is never created inside
    // a subdirectory regardless of how cwd was derived.
    const configPath = resolve(cwd, 'vitest.config.ts')
    const existing = await findExistingConfig(cwd, [
      'vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.mts', 'vitest.config.cjs',
      'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts',
    ])
    if (existing) {
      log(chalk.dim(`  ${existing} already exists — skipping.`))
      const existingText = await readFile(existing, 'utf-8').catch(() => '')
      warnIfMissingLcovCoverage(existing, existingText, 'coverage', 'vitest', log)
    } else {
      const setupLine = createdSetupFile
        ? `\n    setupFiles: ['./${createdSetupFile}'],`
        : ''
      const envLine = (meta.isReact || meta.isVue || meta.isSvelte) ? `\n    environment: 'jsdom',` : ''
      // Next.js uses @/ as the root alias. Read the actual target from tsconfig.json
      // to stay consistent with whatever the project has configured.
      // No React plugin needed: Vitest uses esbuild which handles JSX/TSX natively.
      const aliasTarget = meta.isNextJs ? await resolveAtAlias(cwd) : null
      // Next.js: add server-only alias so Vitest doesn't crash on Next.js server-only imports.
      // server-only is a Next.js guard that throws at build time if server code leaks to the client;
      // in Vitest it just needs to resolve to something harmless.
      const serverOnlyAlias = meta.isNextJs
        ? `,\n      'server-only': path.resolve(__dirname, './test/empty-module.ts')`
        : ''
      const aliasBlock = aliasTarget
        ? `\n  resolve: {\n    alias: { '@': path.resolve(__dirname, '${aliasTarget}')${serverOnlyAlias} },\n  },`
        : ''
      const pathImport = aliasTarget ? `import path from 'path'\n` : ''
      const vuePlugin = meta.isVue ? `\nimport vue from '@vitejs/plugin-vue'` : ''
      const sveltePlugin = meta.isSvelte ? `\nimport { svelte } from '@sveltejs/vite-plugin-svelte'` : ''
      const pluginsBlock = meta.isVue
        ? `\n  plugins: [vue()],`
        : meta.isSvelte
        ? `\n  plugins: [svelte({ hot: !process.env.VITEST })],`
        : ''
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
        `      // Coverage instrumentation + report generation is the biggest single cost in a`,
        `      // large suite. Keep it OFF for the inner loop (plain \`vitest run\`); opt in with the`,
        `      // \`test:cov\` script or \`--coverage\` when you actually need a report.`,
        `      enabled: false,`,
        `      provider: 'v8',`,
        `      reporter: ['lcov', 'text-summary'],`,
        `      reportsDirectory: './coverage',`,
        `    },`,
        `  },`,
        `})`,
        ``,
      ].join('\n')
      await writeFile(configPath, content)
      log(chalk.green(`  ✓ Created vitest.config.ts at project root`))
    }

  } else if (runner === 'jest') {
    const configPath = resolve(cwd, 'jest.config.js')
    const existing = await findExistingConfig(cwd, [
      'jest.config.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json',
    ])
    if (existing) {
      log(chalk.dim(`  ${existing} already exists — skipping.`))
      const existingText = await readFile(existing, 'utf-8').catch(() => '')
      warnIfMissingLcovCoverage(existing, existingText, 'coverage', 'jest', log)
      if (meta.isReactNative) await warnIfMissingAliasMapper(existing, existingText, cwd, log)
    } else {
      const setupLine = createdSetupFile
        ? `\n  setupFilesAfterEnv: ['<rootDir>/${createdSetupFile}'],`
        : ''
      const needsJsdom = (meta.isReact || meta.isVue || meta.isSvelte) && !meta.isReactNative && !meta.isAngular && !meta.isNestJs
      const envLine = needsJsdom ? `\n  testEnvironment: 'jsdom',` : ''
      // React Native / Expo: babel-preset-expo already handles TypeScript — don't override transform
      // or it replaces the preset's JS transform and setup.js files fail to parse.
      const tsLines = meta.isTypeScript && !meta.isReactNative
        ? `\n  transform: { '^.+\\\\.tsx?$': 'ts-jest' },`
        : ''
      const rnPreset = meta.isExpo ? 'jest-expo' : 'react-native'
      const presetLine = meta.isReactNative ? `\n  preset: '${rnPreset}',` : ''
      const transformIgnoreLine = meta.isReactNative
        ? `\n  transformIgnorePatterns: ['node_modules/(?!(.pnpm/[^/]*/node_modules/)?(react-native(-[^/]+)?|@react-native|@react-navigation|expo(-[^/]+)?|@expo|@testing-library)/)'],`
        : ''
      const angularPreset = meta.isAngular ? `\n  preset: 'jest-preset-angular',` : ''
      // React Native/Expo projects overwhelmingly use "@/" as their root import alias (Expo
      // Router's default template ships it in tsconfig.json) — without a moduleNameMapper for
      // it, jest fails EVERY file that imports via the alias with "Cannot find module '@/...'",
      // even though the exact same code resolves fine under Metro/babel-plugin-module-resolver.
      // Live-reproduced: a real Expo SDK 57 project had no moduleNameMapper at all and every
      // single test file importing via "@/" failed before running a single assertion.
      const aliasTarget = meta.isReactNative ? await resolveAtAlias(cwd) : null
      const aliasDir = aliasTarget && aliasTarget !== '.' ? aliasTarget.replace(/^\.\//, '') + '/' : ''
      const moduleNameMapperLine = aliasTarget
        ? `\n  moduleNameMapper: { '^@/(.*)$': '<rootDir>/${aliasDir}$1' },`
        : ''
      const content = [
        `/** @type {import('jest').Config} */`,
        `module.exports = {${presetLine}${angularPreset}${envLine}${tsLines}${transformIgnoreLine}${moduleNameMapperLine}${setupLine}`,
        `  coverageReporters: ['lcov', 'text-summary'],`,
        `  coverageDirectory: 'coverage',`,
        `}`,
        ``,
      ].join('\n')
      await writeFile(configPath, content)
      log(chalk.green(`  ✓ Created jest.config.js`))
    }

  } else if (runner === 'mocha') {
    const configPath = resolve(cwd, '.mocharc.json')
    try {
      await access(configPath)
      log(chalk.dim(`  .mocharc.json already exists — skipping.`))
    } catch {
      const content = JSON.stringify({
        spec: `${sourceDir}/**/*.test.{ts,js}`,
        require: meta.isTypeScript ? ['ts-node/register'] : [],
      }, null, 2) + '\n'
      await writeFile(configPath, content)
      log(chalk.green(`  ✓ Created .mocharc.json`))
    }
  }

  // ── Ensure npm test scripts ────────────────────────────────────────────────
  // The scaffold used to only PRINT these — so a project could have deps + config + setup file yet
  // no `test`/`test:cov`, and break on the first `npm test`/CI/`lacuna` coverage run. Now written
  // idempotently (won't clobber a real user script).
  await ensureTestScripts(cwd, runner, log)

  return createdSetupFile
}

// ─── High-level entry ──────────────────────────────────────────────────────────

export interface ScaffoldOptions {
  cwd: string
  /**
   * Runner to scaffold. Omit (or pass '' / 'auto') to auto-detect — mirrors the settings panel's
   * "(auto-detect)" option, which writes no `testRunner` to .lacuna.json. When auto-detecting we
   * probe the project and fall back to vitest for a JS/TS project so the scaffold NEVER silently
   * no-ops the way it did when a missing runner short-circuited the whole flow.
   */
  runner?: string
  sourceDir: string
  /** Setup-file path from the caller's config (e.g. `.lacuna.json` setupFile). Overrides the
   * framework default so the scaffolded file matches what config records. */
  setupFile?: string
  /** Sink for progress lines (defaults to console.log). npm-install output streams via stdio:inherit regardless. */
  log?: (msg: string) => void
}

// Runners this scaffold knows how to install/configure. Detection can also return non-Node runners
// (pytest, go-test, …) that have nothing to `npm install`; those are handled by resolveRunner.
const NODE_RUNNERS = new Set(['vitest', 'jest', 'mocha'])

/**
 * Resolve the runner to scaffold when the caller didn't pin one (auto-detect). Prefers a runner
 * already present in the project (detectEnvironment reads package.json / lockfiles / configs); for a
 * fresh JS/TS project where nothing is installed yet, detection returns 'unknown' and we fall back
 * to vitest — the same default the CLI's `init` uses non-interactively.
 */
async function resolveRunner(cwd: string, requested: string | undefined, log: (msg: string) => void): Promise<string> {
  const pinned = requested?.trim()
  if (pinned && pinned !== 'auto') return pinned
  const env = await detectEnvironment(cwd)
  if (env.testRunner !== 'unknown') {
    log(chalk.dim(`Detected ${env.testRunner} — scaffolding for it.`))
    return env.testRunner
  }
  log(chalk.dim('No test runner detected — defaulting to vitest.'))
  return 'vitest'
}

/**
 * Install deps + scaffold runner config/setup files for `runner` under `cwd` — the whole
 * `init --scaffold-only` side-effect, callable in-process. Never writes .lacuna.json (the caller
 * owns config). Non-interactive: install prompts are auto-accepted. When `runner` is omitted it is
 * auto-detected (see resolveRunner); a resolved non-Node runner (pytest, go, …) is a no-op here.
 */
export async function scaffoldProject(opts: ScaffoldOptions): Promise<{ createdSetupFile?: string; runner: string }> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const runner = await resolveRunner(opts.cwd, opts.runner, log)
  if (!NODE_RUNNERS.has(runner)) {
    log(chalk.dim(`${runner} needs no Node dependency setup — nothing to scaffold.`))
    return { runner }
  }
  const createdSetupFile = await ensureTestRunnerSetup(runner, opts.sourceDir, opts.cwd, log, true, undefined, opts.setupFile)
  return { createdSetupFile, runner }
}
