// Filters a shared mock file to only the sections the failing test actually uses.
// Scans the test file's imports from the mock file, then returns:
//   - export declarations for those specific names
//   - vi.mock() blocks that reference any of those names
// Falls back to the full file if no imports can be detected.
// This prevents burning tokens on 40 unrelated service mocks when fixing a billing test.
export function filterMockFileForTest(mocksCode: string, testCode: string): string {
  // Extract mock variable names the test imports from the mock file
  const importedNames = new Set<string>()
  for (const m of testCode.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*mock[s]?[^'"]*['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name && /^\w+$/.test(name)) importedNames.add(name)
    }
  }

  if (importedNames.size === 0) return mocksCode

  const lines = mocksCode.split('\n')
  const include = new Set<number>()

  // Include export declaration lines for imported names
  for (let i = 0; i < lines.length; i++) {
    for (const name of importedNames) {
      if (new RegExp(`\\bexport\\b[^{\\n]*\\b${name}\\b`).test(lines[i])) {
        include.add(i)
      }
    }
  }

  // Include vi.mock() blocks that reference any imported name
  let i = 0
  while (i < lines.length) {
    if (/\bvi\.mock\(/.test(lines[i])) {
      const blockStart = i
      let depth = 0
      let j = i
      // Scan to the end of this mock call (balanced parens)
      while (j < lines.length) {
        for (const ch of lines[j]) {
          if (ch === '(') depth++
          if (ch === ')') depth--
        }
        j++
        if (depth === 0) break
      }
      const blockText = lines.slice(blockStart, j).join('\n')
      for (const name of importedNames) {
        if (new RegExp(`\\b${name}\\b`).test(blockText)) {
          for (let k = blockStart; k < j; k++) include.add(k)
          break
        }
      }
      i = j
      continue
    }
    i++
  }

  // Reconstruct, collapsing gaps to a single blank line
  const result: string[] = []
  let gapped = false
  for (let i = 0; i < lines.length; i++) {
    if (include.has(i)) {
      result.push(lines[i])
      gapped = false
    } else if (!gapped) {
      result.push('')
      gapped = true
    }
  }

  const filtered = result.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  // Safety: if filter stripped too aggressively, fall back to full file
  return filtered.length < 50 ? mocksCode : filtered
}

// Filters a shared mock file to sections relevant to the source file being tested.
// Used in generate prompts (no test file exists yet) — scans the source file's imports
// and returns vi.mock() blocks for those same module paths, plus any mock variables
// whose name matches the pattern mock<ImportedName> (e.g. WorkspacesClient → mockWorkspacesClient).
// This gives the AI the shapes of mocks it will need without sending the whole file.
export function filterMockFileForSource(mocksCode: string, sourceCode: string): string {
  // Extract module paths the source imports from
  const importedPaths = new Set<string>()
  for (const m of sourceCode.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
    importedPaths.add(m[1])
  }

  if (importedPaths.size === 0) return mocksCode

  const lines = mocksCode.split('\n')
  const include = new Set<number>()

  // Include vi.mock() blocks whose module path matches a source import
  let i = 0
  while (i < lines.length) {
    const mockMatch = lines[i].match(/\bvi\.mock\(\s*(['"])([^'"]+)\1/)
    if (mockMatch) {
      const mockedPath = mockMatch[2]
      const blockStart = i
      let depth = 0
      let j = i
      while (j < lines.length) {
        for (const ch of lines[j]) {
          if (ch === '(') depth++
          if (ch === ')') depth--
        }
        j++
        if (depth === 0) break
      }
      // Include if the mocked path is directly imported by the source, or the source
      // imports something from the same package (e.g. source imports WorkspacesClient
      // from '@/lib/client/services/index.client' → include index.client mock block)
      const relevant = [...importedPaths].some(p =>
        p === mockedPath || p.includes(mockedPath) || mockedPath.includes(p.split('/').pop() ?? '')
      )
      if (relevant) {
        for (let k = blockStart; k < j; k++) include.add(k)
      }
      i = j
      continue
    }
    i++
  }

  // Include export declarations for mock variables inferred from source imports.
  // e.g. source imports `getSession` → look for `mockGetSession` (capitalise the first letter
  // after the `mock` prefix to match the camelCase convention used in mock files).
  // Also try lowercase fallback (`mockgetSession`) in case the file uses it.
  const inferredNames = new Set<string>()
  for (const m of sourceCode.matchAll(/\bimport\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (!name) continue
      // Capitalised prefix: mock + GetSession
      inferredNames.add(`mock${name[0].toUpperCase()}${name.slice(1)}`)
      // Lowercase prefix fallback: mock + getSession
      inferredNames.add(`mock${name}`)
    }
  }
  for (let i = 0; i < lines.length; i++) {
    for (const name of inferredNames) {
      if (new RegExp(`\\bexport\\b[^{\\n]*\\b${name}\\b`).test(lines[i])) {
        include.add(i)
      }
    }
  }

  if (include.size === 0) return mocksCode

  const result: string[] = []
  let gapped = false
  for (let i = 0; i < lines.length; i++) {
    if (include.has(i)) {
      result.push(lines[i])
      gapped = false
    } else if (!gapped) {
      result.push('')
      gapped = true
    }
  }

  const filtered = result.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return filtered.length < 50 ? mocksCode : filtered
}

// Compresses a shared mock file before sending in a fix prompt.
// The generate prompt skips the raw file entirely (inventory + exports list suffices).
// Here we keep the file readable but strip multi-line vi.fn() implementations —
// the AI only needs to know the mock EXISTS and its name, not its JSX body.
export function compressMockFile(code: string): string {
  const lines = code.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Detect a multi-line vi.fn() body: `export const mockFoo = vi.fn(` that doesn't close on the same line.
    // These are icon/component mocks returning React.createElement — the AI only needs the name.
    const multiLineFn = line.match(/^(export const \w+) = vi\.fn\(/)
    if (multiLineFn) {
      const openParens = (line.match(/\(/g) ?? []).length
      const closeParens = (line.match(/\)/g) ?? []).length
      if (openParens > closeParens) {
        // Multi-line — scan forward to find the closing paren, then emit a collapsed form
        let depth = openParens - closeParens
        i++
        while (i < lines.length && depth > 0) {
          for (const ch of lines[i]) {
            if (ch === '(') depth++
            if (ch === ')') depth--
          }
          i++
        }
        result.push(`${multiLineFn[1]} = vi.fn()`)
        continue
      }
    }

    result.push(line)
    i++
  }

  // Collapse 3+ blank lines to 1
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Removes documentation dead-weight from source code before sending to the AI.
// Targets content that costs tokens but adds no signal for test generation:
// license headers, long JSDoc blocks, and excessive blank lines.
// Intentionally conservative: short JSDoc (≤6 lines) and all inline // comments are kept.
export function compressSource(source: string): string {
  let out = source

  // Strip license / copyright block comments at the very top of the file.
  // These are always before the first import and never describe testable behaviour.
  out = out.replace(/^(?:\/\*[\s\S]*?(?:license|copyright|\bMIT\b|\bApache\b|\bGPL\b|@license)[\s\S]*?\*\/\s*)+/i, '')

  // Strip block comments longer than 6 lines. Short ones (≤6 lines) describe
  // edge cases and error conditions worth keeping; long ones are @param/@example boilerplate.
  out = out.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.split('\n').length > 6 ? '' : match,
  )

  // Collapse 3+ consecutive blank lines to 1.
  out = out.replace(/\n{3,}/g, '\n\n')

  return out.trim()
}

// Generates a compact structural summary of a TypeScript/JavaScript source file.
// Large files are skeletonized: only the functions that need to be tested are expanded
// to their full implementation; everything else is collapsed to its signature.
// This cuts prompt size by 60–80% on large files without losing signal for the AI.

const SKELETON_THRESHOLD = 80  // lines; files at or below this are returned as-is

// ─── Block-end finder ────────────────────────────────────────────────────────
// Finds the line index of the closing } for a block that opens at startLine.
// Uses a simple state machine to skip braces inside string literals.

function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0
  let inString: '"' | "'" | '`' | null = null
  let escaped = false
  let opened = false

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i]
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]

      if (escaped) { escaped = false; continue }
      if (ch === '\\' && inString) { escaped = true; continue }

      if (inString) {
        if (ch === inString) inString = null
        continue
      }

      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue }
      if (ch === '{') { depth++; opened = true }
      if (ch === '}') {
        depth--
        if (opened && depth === 0) return i
      }
    }
  }

  return lines.length - 1
}

// ─── Declaration name extractor ──────────────────────────────────────────────
// Returns the identifier name from a top-level declaration line, or null if
// the line isn't a recognisable declaration.

function extractDeclaredName(line: string): string | null {
  const s = line.trim().replace(/^export\s+(default\s+)?/, '')

  // function name / async function name
  const fn = s.match(/^(?:async\s+)?function\s+(\w+)/)
  if (fn) return fn[1]

  // class Name
  const cl = s.match(/^class\s+(\w+)/)
  if (cl) return cl[1]

  // const/let/var name = (...) => or = function or = async (
  const cv = s.match(
    /^(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\(|function\b|\w+\s*=>)/,
  )
  if (cv) return cv[1]

  return null
}

// ─── Skeleton builder ─────────────────────────────────────────────────────────

export function shouldUseSkeleton(code: string): boolean {
  return code.split('\n').length > SKELETON_THRESHOLD
}

/**
 * Returns a skeletonized version of sourceCode.
 * expandFunctions: names of functions whose full body must be included (the uncovered ones).
 * If the file is short enough, returns the original code unchanged.
 */
export function buildSourceSkeleton(sourceCode: string, expandFunctions: string[] = []): string {
  if (!shouldUseSkeleton(sourceCode)) return sourceCode

  const lines = sourceCode.split('\n')
  const expandSet = new Set(expandFunctions)
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // ── Always keep verbatim ──────────────────────────────────────────────────
    if (
      !trimmed ||
      trimmed.startsWith('//') ||
      /^\/?\*/.test(trimmed) ||          // block comments
      trimmed.startsWith('import ') ||
      trimmed.startsWith('@') ||          // decorators
      /^export\s+(type|interface|enum)\b/.test(trimmed) ||
      /^(?:type|interface|enum)\s+\w/.test(trimmed)
    ) {
      result.push(line)
      i++
      continue
    }

    // ── Detect a block-opening declaration ────────────────────────────────────
    const name = extractDeclaredName(trimmed)
    const opensBlock = /\{/.test(trimmed) && !/^\s*\/\//.test(trimmed)

    if (name && opensBlock) {
      const blockEnd = findBlockEnd(lines, i)
      const bodyLines = blockEnd - i

      if (expandSet.has(name)) {
        // Full implementation — the AI needs this to write assertions
        result.push(...lines.slice(i, blockEnd + 1))
      } else {
        // Collapse: show the signature line with a stub body
        const sigLine = line.replace(/\{[\s\S]*/, '').trimEnd()
        result.push(
          `${sigLine}${sigLine.trimEnd().endsWith(')') || sigLine.trimEnd().endsWith('>') ? ' ' : ''}` +
          `{ /* ... (${bodyLines} line${bodyLines === 1 ? '' : 's'}) */ }`,
        )
      }

      i = blockEnd + 1
      continue
    }

    result.push(line)
    i++
  }

  return result.join('\n')
}
