import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseCoverageFinal } from './istanbul.js'

// A minimal, real-shaped istanbul coverage-final.json: one file with a covered statement (line 6)
// and an uncovered one (line 20), one executed function and one not.
const FIXTURE = {
  '/proj/src/foo.ts': {
    path: '/proj/src/foo.ts',
    statementMap: {
      '0': { start: { line: 6, column: 2 }, end: { line: 6, column: 20 } },
      '1': { start: { line: 20, column: 4 }, end: { line: 22, column: null } },
    },
    s: { '0': 3, '1': 0 },
    fnMap: {
      '0': { name: 'used', decl: { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } }, line: 5 },
      '1': { name: 'dead', decl: { start: { line: 19, column: 0 }, end: { line: 19, column: 10 } }, line: 19 },
    },
    f: { '0': 3, '1': 0 },
    branchMap: {},
    b: {},
  },
}

async function withFixture<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'lacuna-istanbul-'))
  try {
    await mkdir(join(dir, 'coverage'), { recursive: true })
    await writeFile(join(dir, 'coverage', 'coverage-final.json'), JSON.stringify(FIXTURE))
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('parseCoverageFinal maps istanbul statements to line hits (covered + uncovered)', async () => {
  await withFixture(async (dir) => {
    const report = await parseCoverageFinal('coverage', dir)
    assert.equal(report.files.length, 1)
    const f = report.files[0]
    assert.equal(f.path, '/proj/src/foo.ts')
    // line 6 executed (hit 3), line 20 not (hit 0)
    assert.deepEqual(f.lines.find((l) => l.line === 6), { line: 6, hit: 3 })
    assert.deepEqual(f.lines.find((l) => l.line === 20), { line: 20, hit: 0 })
    assert.equal(f.lineRate, 0.5)
  })
})

test('parseCoverageFinal carries function names + hit counts', async () => {
  await withFixture(async (dir) => {
    const report = await parseCoverageFinal('coverage', dir)
    const fns = report.files[0].functions
    assert.deepEqual(fns.find((fn) => fn.name === 'used'), { name: 'used', line: 5, hit: 3 })
    assert.deepEqual(fns.find((fn) => fn.name === 'dead'), { name: 'dead', line: 19, hit: 0 })
    assert.equal(report.files[0].functionRate, 0.5)
  })
})

test('parseCoverageFinal throws on an empty report (so loadCoverage falls through)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lacuna-istanbul-'))
  try {
    await mkdir(join(dir, 'coverage'), { recursive: true })
    await writeFile(join(dir, 'coverage', 'coverage-final.json'), '{}')
    await assert.rejects(() => parseCoverageFinal('coverage', dir), /empty/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
