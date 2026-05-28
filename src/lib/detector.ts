import { readFile } from 'fs/promises'
import { join } from 'path'

export type TestRunner = 'jest' | 'vitest' | 'pytest' | 'mocha' | 'go-test' | 'unknown'
export type Language = 'typescript' | 'javascript' | 'python' | 'go' | 'unknown'

export interface DetectedEnvironment {
  testRunner: TestRunner
  language: Language
  testFilePattern: string
  coverageCommand: string
  testCommand: string
}

const RUNNER_DEFAULTS: Record<Exclude<TestRunner, 'unknown'>, DetectedEnvironment> = {
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
}

export function envForRunner(runner: string): DetectedEnvironment {
  return (
    RUNNER_DEFAULTS[runner as Exclude<TestRunner, 'unknown'>] ?? {
      testRunner: 'unknown' as TestRunner,
      language: 'unknown' as Language,
      testFilePattern: '**/*.test.*',
      coverageCommand: '',
      testCommand: '',
    }
  )
}

export function fileTestCommand(env: DetectedEnvironment, testFilePath: string): string {
  switch (env.testRunner) {
    case 'vitest': return `npx vitest run ${testFilePath}`
    case 'jest':   return `npx jest --testPathPattern=${testFilePath}`
    case 'mocha':  return `npx mocha ${testFilePath}`
    case 'pytest': return `python -m pytest ${testFilePath} -v`
    case 'go-test': {
      const dir = testFilePath.includes('/') ? testFilePath.replace(/\/[^/]+$/, '') : '.'
      return `go test ./${dir}/...`
    }
    default: return `${env.testCommand} ${testFilePath}`
  }
}

export async function detectEnvironment(
  cwd: string = process.cwd(),
  configRunner?: string,
): Promise<DetectedEnvironment> {
  // config always wins over auto-detection
  if (configRunner && configRunner !== 'unknown') {
    return envForRunner(configRunner)
  }

  let pkg: Record<string, unknown> = {}
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf-8')
    pkg = JSON.parse(raw)
  } catch { /* not a Node project */ }

  const deps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  }

  if ('vitest' in deps) return RUNNER_DEFAULTS.vitest
  if ('jest' in deps || '@jest/core' in deps) return RUNNER_DEFAULTS.jest
  if ('mocha' in deps) return RUNNER_DEFAULTS.mocha

  try {
    await readFile(join(cwd, 'pytest.ini'), 'utf-8')
    return RUNNER_DEFAULTS.pytest
  } catch { /* not pytest */ }

  try {
    await readFile(join(cwd, 'pyproject.toml'), 'utf-8')
    return RUNNER_DEFAULTS.pytest
  } catch { /* not Python */ }

  try {
    await readFile(join(cwd, 'go.mod'), 'utf-8')
    return RUNNER_DEFAULTS['go-test']
  } catch { /* not Go */ }

  return {
    testRunner: 'unknown',
    language: 'unknown',
    testFilePattern: '**/*.test.*',
    coverageCommand: '',
    testCommand: '',
  }
}
