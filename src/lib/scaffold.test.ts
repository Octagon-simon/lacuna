import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ensureTestScripts } from './scaffold.js'

const noop = () => {}

async function withPkg(pkg: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lacuna-scaffold-'))
  try {
    await writeFile(join(dir, 'package.json'), pkg)
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
const readScripts = async (dir: string) =>
  JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')).scripts

test('adds test + test:cov to a package.json with no scripts', async () => {
  await withPkg('{\n  "name": "x"\n}\n', async (dir) => {
    await ensureTestScripts(dir, 'vitest', noop)
    assert.deepEqual(await readScripts(dir), { test: 'vitest run', 'test:cov': 'vitest run --coverage' })
  })
})

test("replaces npm's placeholder test script", async () => {
  const pkg = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }, null, 2)
  await withPkg(pkg, async (dir) => {
    await ensureTestScripts(dir, 'jest', noop)
    const s = await readScripts(dir)
    assert.equal(s.test, 'jest')
    assert.equal(s['test:cov'], 'jest --coverage')
  })
})

test('never clobbers a real runner test script, but still adds test:cov', async () => {
  const pkg = JSON.stringify({ scripts: { test: 'vitest run --silent' } }, null, 2)
  await withPkg(pkg, async (dir) => {
    await ensureTestScripts(dir, 'vitest', noop)
    const s = await readScripts(dir)
    assert.equal(s.test, 'vitest run --silent') // untouched
    assert.equal(s['test:cov'], 'vitest run --coverage')
  })
})

test('leaves a non-runner test script alone and parks the runner under test:<runner>', async () => {
  const pkg = JSON.stringify({ scripts: { test: 'eslint .' } }, null, 2)
  await withPkg(pkg, async (dir) => {
    await ensureTestScripts(dir, 'vitest', noop)
    const s = await readScripts(dir)
    assert.equal(s.test, 'eslint .') // preserved
    assert.equal(s['test:vitest'], 'vitest run')
    assert.equal(s['test:cov'], 'vitest run --coverage')
  })
})

test('is idempotent — a second run changes nothing', async () => {
  await withPkg('{"name":"x"}\n', async (dir) => {
    await ensureTestScripts(dir, 'vitest', noop)
    const first = await readFile(join(dir, 'package.json'), 'utf-8')
    await ensureTestScripts(dir, 'vitest', noop)
    const second = await readFile(join(dir, 'package.json'), 'utf-8')
    assert.equal(first, second)
  })
})

test('preserves tab indentation', async () => {
  await withPkg('{\n\t"name": "x"\n}\n', async (dir) => {
    await ensureTestScripts(dir, 'vitest', noop)
    const raw = await readFile(join(dir, 'package.json'), 'utf-8')
    assert.match(raw, /\n\t"scripts"/) // tab-indented, not 2-space
  })
})

test('no package.json → no throw, no file created', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lacuna-scaffold-'))
  try {
    await ensureTestScripts(dir, 'vitest', noop) // must not throw
    await assert.rejects(() => readFile(join(dir, 'package.json'), 'utf-8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
