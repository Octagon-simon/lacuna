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
