import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findSourceFile, extractRelativeImportSpecifiers } from './fix-loop.js'

// Reproduces a layout that findSourceFile used to miss entirely: several
// scenario-suffixed test files under __tests__/ (Widget.test.tsx,
// WidgetRetryFlow.test.tsx, ...) that all cover a SINGLE sibling index.tsx,
// rather than each test file having its own same-named source file. The old
// filename-matching attempts (Foo.test.tsx -> Foo.tsx) can never find this;
// only reading the test's own import does.
async function makeFixture(): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'lacuna-fixloop-'))
  const componentDir = join(cwd, 'src/screens/Widget')
  const testsDir = join(componentDir, '__tests__')
  await mkdir(testsDir, { recursive: true })
  await writeFile(join(componentDir, 'index.tsx'), 'export const Widget = () => null\nexport default Widget\n')
  await writeFile(join(componentDir, 'WidgetActions.tsx'), 'export const WidgetActions = () => null\n')
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) }
}

test('extractRelativeImportSpecifiers pulls relative import paths, ignoring bare/aliased ones', () => {
  const code = `
import {render, screen} from '@testing-library/react';
import {describe, it} from 'vitest';
import widgetService from '@/services/widgetService';
import Widget from '../index';
import {useWidget, useUser} from '@/state';
`
  assert.deepEqual(extractRelativeImportSpecifiers(code), ['../index'])
})

test('findSourceFile resolves a scenario-suffixed test file to its sibling index.tsx via the import, when the filename heuristics would miss it', async () => {
  const { cwd, cleanup } = await makeFixture()
  try {
    const testCode = `
import {render, screen} from '@testing-library/react';
import Widget from '../index';
`
    const testFile = 'src/screens/Widget/__tests__/WidgetRetryFlow.test.tsx'
    const resolved = await findSourceFile(testFile, cwd, 'src', testCode)
    assert.equal(resolved, join(cwd, 'src/screens/Widget/index.tsx'))
  } finally {
    await cleanup()
  }
})

test('findSourceFile falls through to the old filename-matching behavior when there is no usable relative import', async () => {
  const { cwd, cleanup } = await makeFixture()
  try {
    // No testCode at all — mirrors call sites that haven't read the test file yet.
    const testFile = 'src/screens/Widget/__tests__/WidgetActions.test.tsx'
    const resolved = await findSourceFile(testFile, cwd, 'src')
    assert.equal(resolved, join(cwd, 'src/screens/Widget/WidgetActions.tsx'))
  } finally {
    await cleanup()
  }
})

test('findSourceFile does not resolve to a mocked/test file the test file imports', async () => {
  const { cwd, cleanup } = await makeFixture()
  try {
    const testsDir = join(cwd, 'src/screens/Widget/__tests__')
    await writeFile(join(testsDir, 'fixtures.ts'), 'export const mockUser = {}\n')
    const testCode = `
import {mockUser} from './fixtures';
import Widget from '../index';
`
    const testFile = 'src/screens/Widget/__tests__/WidgetPendingStatePersistence.test.tsx'
    const resolved = await findSourceFile(testFile, cwd, 'src', testCode)
    // Must skip './fixtures' (lives under __tests__) and land on the real component.
    assert.equal(resolved, join(cwd, 'src/screens/Widget/index.tsx'))
  } finally {
    await cleanup()
  }
})
