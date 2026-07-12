// Shared E2E spec helpers/config (selectors, fixtures, page objects, api helpers).
//
// Specs in real projects centralise selectors and setup in imported files, e.g.
//   import { selectors } from '../helpers/test-config'
//   import { setupFundedBusinessAccount } from '../helpers/adminApiHelper.js'
// Without those files in context the model sees `selectors.emailInput` as an opaque token, so it
// mis-diagnoses failures (works the spec instead of the stale selector) and inlines/replaces the
// project's selectors against its convention. This module resolves a spec's LOCAL imports (the
// precise source of truth — no config, no guessing a directory) and reads them so the prompt can
// show them. It also splits a model response that updates one of those helper files (multi-file fix).

import { access, readFile } from 'fs/promises'
import { readTsconfigAliases, resolveLocalImport } from '../../agent/context.js'

export interface SpecHelperFile {
  path: string      // relative to cwd, e.g. e2e/helpers/test-config.ts
  content: string
}

const MAX_HELPER_FILES = 8
const MAX_HELPER_CHARS = 9000
const MAX_PER_FILE_CHARS = 4000

// Module specifiers from a spec's import/export-from statements.
function importSpecifiers(code: string): string[] {
  const specs: string[] = []
  const re = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?\bfrom\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) specs.push(m[1])
  return specs
}

// Resolve a local import base path to a real file. Handles the ESM-TS pattern where a TS source is
// imported with a `.js` extension (import './x.js' → x.ts), plus extensionless and /index forms.
async function resolveToFile(base: string): Promise<string | null> {
  const candidates: string[] = []
  const jsExt = base.match(/\.(js|jsx|mjs|cjs)$/)
  if (jsExt) {
    const noExt = base.slice(0, -jsExt[0].length)
    candidates.push(noExt + '.ts', noExt + '.tsx', base, noExt + '.jsx')
  } else {
    for (const e of ['.ts', '.tsx', '.js', '.jsx']) candidates.push(base + e)
    for (const e of ['.ts', '.tsx', '.js', '.jsx']) candidates.push(base + '/index' + e)
    candidates.push(base)
  }
  for (const c of candidates) {
    try { await access(c); return c } catch { /* next */ }
  }
  return null
}

function toRelative(cwd: string, abs: string): string {
  const prefix = cwd.endsWith('/') ? cwd : cwd + '/'
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs
}

// Read the local files a spec imports (selectors/helpers/page objects/fixtures), so the prompt can
// reuse them instead of treating them as opaque. Bare-package imports (@playwright/test, etc.) are
// skipped. Bounded in count and size.
export async function collectSpecHelpers(specCode: string, specAbs: string, cwd: string): Promise<SpecHelperFile[]> {
  const aliases = await readTsconfigAliases(cwd)
  const out: SpecHelperFile[] = []
  const seen = new Set<string>()
  let totalChars = 0

  for (const spec of importSpecifiers(specCode)) {
    if (out.length >= MAX_HELPER_FILES || totalChars >= MAX_HELPER_CHARS) break
    const base = resolveLocalImport(spec, specAbs, cwd, aliases)
    if (base === null) continue   // bare package (node_modules) — not a project helper
    const file = await resolveToFile(base)
    if (!file || file.includes('node_modules') || seen.has(file)) continue
    seen.add(file)
    let content = await readFile(file, 'utf-8').catch(() => null)
    if (content === null) continue
    if (content.length > MAX_PER_FILE_CHARS) content = content.slice(0, MAX_PER_FILE_CHARS) + '\n// …truncated'
    totalChars += content.length
    out.push({ path: toRelative(cwd, file), content })
  }
  return out
}

const HELPER_FILE_RE = /^\/\/\s*---HELPER_FILE:\s*(.+?)\s*---\s*$/

// Split a model response into the spec code and any updated helper files. The model may append
// sections like `// ---HELPER_FILE: e2e/helpers/test-config.ts---` to fix a selector at its source.
// Only paths that were in `allowedPaths` (the spec's own resolved imports) are honoured, so the
// model can never write an arbitrary file.
export function splitSpecAndHelpers(
  output: string,
  allowedPaths: string[],
): { spec: string; helpers: SpecHelperFile[] } {
  const lines = output.split('\n')
  const firstMarker = lines.findIndex((l) => HELPER_FILE_RE.test(l))
  if (firstMarker === -1) return { spec: output, helpers: [] }

  const allowed = new Set(allowedPaths)
  const spec = lines.slice(0, firstMarker).join('\n').trimEnd()
  const helpers: SpecHelperFile[] = []

  let current: { path: string; body: string[] } | null = null
  const flush = () => {
    if (current && allowed.has(current.path)) {
      helpers.push({ path: current.path, content: current.body.join('\n').trim() + '\n' })
    }
    current = null
  }
  for (let i = firstMarker; i < lines.length; i++) {
    const m = lines[i].match(HELPER_FILE_RE)
    if (m) { flush(); current = { path: m[1].trim(), body: [] } }
    else if (current) current.body.push(lines[i])
  }
  flush()
  return { spec, helpers }
}
