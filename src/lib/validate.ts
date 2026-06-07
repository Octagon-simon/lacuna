// Strip comments and string literals to avoid false positives inside quoted text.
function stripNonCode(code: string): string {
  return code
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, '""')
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, '""')
}

// Returns true if the code contains at least one executable test function.
// A file that only has describe() with no it()/test() inside is considered empty.
export function hasTestFunctions(code: string): boolean {
  const stripped = stripNonCode(code)
  return /\b(?:it|test)\s*(?:\.(?:each|concurrent|skip|only))?\s*\(/.test(stripped)
}

// If the runner output indicates "no tests found", replace it with a
// clear instruction so the AI knows exactly what went wrong.
export function enrichNoTestsError(output: string): string {
  if (!/no tests|0 tests?\b/i.test(output)) return output
  return (
    'ERROR: Vitest found 0 tests in this file. The file ran but had nothing to execute.\n\n' +
    'This means one of:\n' +
    '  1. You wrote only imports, types, or describe() blocks with no it()/test() inside\n' +
    '  2. A module import failed during collection — check the output below for an error\n' +
    '  3. Tests are inside a plain function that is never called\n\n' +
    'REQUIRED: Every test file must have at least one test like this:\n' +
    '  it(\'description\', () => {\n' +
    '    expect(result).toBe(expected)\n' +
    '  })\n\n' +
    'DO NOT wrap tests inside a function. Put them directly inside describe() or at the top level.\n\n' +
    'Original runner output:\n' +
    output
  )
}

// Returns true when the runner output shows that zero tests were collected.
// Distinct from hasTestFunctions (static check) — this checks actual runtime collection.
export function isZeroTestsOutput(raw: string): boolean {
  return /Tests:\s+0\s+total|no tests found|found 0 tests/i.test(raw)
}

// Extracts the number of passing tests from the runner summary footer.
// Targets the "Tests  N failed | M passed (total)" line specifically to avoid
// false matches from file-level headers like "(1 passed)" or test descriptions.
export function parsePassCount(output: string): number {
  // Prefer the Tests summary line: "Tests  1 failed | 15 passed (16)" or "Tests  15 passed (15)"
  const summaryLine = output.match(/^\s*Tests\b[^\n]*?(\d+)\s+passed/m)
  if (summaryLine) return parseInt(summaryLine[1], 10)
  // Fallback: any "N passed" in the output
  const m = output.match(/(\d+)\s+passed/)
  return m ? parseInt(m[1], 10) : 0
}

// Strips leading prose/thinking lines from generated code output.
// When a model bleeds reasoning into <code_output>, the file starts with fragments
// like ", nothing else." or "I'll write the test now." before the real code begins.
// Scans forward to the first valid TypeScript/code line and strips everything before it.
// Returns the cleaned code and whether anything was stripped.
export function stripLeadingProse(code: string): { code: string; stripped: string | null } {
  // Valid first lines for TypeScript/JS, Python, and Go — all languages lacuna supports.
  const VALID_START = /^\s*(import\b|export\b|const\b|let\b|var\b|function\b|class\b|describe\s*\(|it\s*\(|test\s*[(\s]|vi\.|jest\.|before(?:Each|All)\b|after(?:Each|All)\b|\/\/|\/\*|\*\s|type\s+\w|interface\s+\w|enum\s+\w|def\s+\w|async\s+def\s+\w|@\w|pytest\b|package\s+\w|func\s+\w|#)/

  const lines = code.split('\n')
  const firstCode = lines.findIndex(l => VALID_START.test(l))

  if (firstCode <= 0) return { code, stripped: null }  // starts correctly or no code found

  const leakedText = lines.slice(0, firstCode).join('\n').trim().slice(0, 120)
  return { code: lines.slice(firstCode).join('\n'), stripped: leakedText }
}

// Merges new mocks content with an existing mocks file without duplicating.
// Three cases:
//   1. Existing is empty → use incoming as-is
//   2. Incoming contains all existing exports (complete replacement) → use incoming
//   3. Incoming is partial → extract ONLY the new exports and append them
export function mergeMocksContent(existing: string, incoming: string): string {
  const existingNames = new Set(extractExportNames(existing))
  if (existingNames.size === 0) return incoming

  const incomingNames = extractExportNames(incoming)

  // Case 2: incoming is a superset — safe to replace entirely
  if (incomingNames.length > 0 && [...existingNames].every(n => incomingNames.includes(n))) {
    return incoming
  }

  // Case 3: incoming is partial — extract only truly new export declarations
  const newNames = new Set(incomingNames.filter(n => !existingNames.has(n)))
  if (newNames.size === 0) return existing  // nothing new, keep existing unchanged

  // Walk lines and capture blocks that belong to new exports.
  // Capturing starts on `export const/function/class X` where X is new,
  // and continues until the next export declaration (handles multi-line exports).
  const lines = incoming.split('\n')
  const toAppend: string[] = []
  let capturing = false

  for (const line of lines) {
    const exportMatch = line.match(/^\s*export\s+(?:const|let|var|function|async\s+function|class)\s+(\w+)/)
    if (exportMatch) {
      capturing = newNames.has(exportMatch[1])
    } else if (/^\s*import\b/.test(line)) {
      // Include import statements that are not already in the existing file
      if (!existing.includes(line.trim())) toAppend.push(line)
      capturing = false
      continue
    }
    if (capturing) toAppend.push(line)
  }

  const appended = toAppend.join('\n').trim()
  return appended ? existing.trimEnd() + '\n\n' + appended : existing
}

function extractExportNames(code: string): string[] {
  const names: string[] = []
  for (const m of code.matchAll(/^export\s+(?:const|let|var|function|class|async\s+function)\s+(\w+)/gm)) names.push(m[1])
  for (const m of code.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (alias && /^\w+$/.test(alias)) names.push(alias)
    }
  }
  return [...new Set(names)]
}

// Returns true when content is clearly prose/thinking rather than TypeScript.
// Conservative by design: any real code line (export, const, vi., import) means
// it's not prose, even if comments look sentence-like.
function isProseContent(content: string): boolean {
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return false

  // If ANY line looks like real TypeScript/JS code, it's not prose.
  // This prevents false positives on mock files with sentence-like comments.
  const hasCode = lines.some(l =>
    /^\s*(import\s|export\s+(const|let|function|class|default|type|interface)\s)/.test(l) ||
    /^\s*(const|let|var)\s+\w/.test(l) ||
    /^\s*vi\.|^\s*jest\./.test(l) ||
    /^\s*(beforeEach|afterEach|beforeAll|afterAll)\s*\(/.test(l)
  )
  if (hasCode) return false

  // No code found — check for thinking/reasoning patterns that confirm it's prose
  const thinkingPatterns = /\bI think\b|\bLet me\b|\bActually,?\s|\bBut wait\b|\bHmm,?\b/m.test(content)
  const bulletLines = lines.filter(l => /^[-*]\s/.test(l)).length

  return thinkingPatterns || bulletLines > 5
}

// Removes content that does not belong in a shared mock file.
// Strips: test blocks (describe/it/test/expect), framework config
// (defineConfig exports, vitest/jest config objects), whole-file prose,
// and trailing prose that appears after valid mock definitions.
export function sanitizeMocksContent(raw: string): { code: string; stripped: boolean } {
  // Prose/thinking detection — reject wholesale if content is not code
  if (isProseContent(raw)) return { code: '', stripped: true }

  // Reject if content looks like a framework config file
  const CONFIG_FILE_RE = /defineConfig\s*\(|module\.exports\s*=\s*\{[^}]*(?:test|resolve|plugins)\s*:/s
  if (CONFIG_FILE_RE.test(raw)) return { code: '', stripped: true }

  const TEST_START   = /^\s*(describe|it|test)\s*[.(]|^\s*expect\s*\(/
  const CONFIG_START = /^\s*export\s+default\s+(defineConfig\s*\(|\{)|^\s*module\.exports\s*=/

  const lines = raw.split('\n')
  const kept: string[] = []
  let depth = 0
  let inBlock = false
  let stripped = false

  for (const line of lines) {
    if (!inBlock && (TEST_START.test(line) || CONFIG_START.test(line))) {
      inBlock = true
      stripped = true
    }
    if (inBlock) {
      for (const ch of line) {
        if (ch === '{' || ch === '(') depth++
        else if (ch === '}' || ch === ')') { depth--; if (depth < 0) depth = 0 }
      }
      if (depth === 0) inBlock = false
      continue
    }
    kept.push(line)
  }

  // Truncate trailing prose that appears after valid mock definitions.
  // Pattern: valid exports → orphaned quote/bracket → bullet-point thinking.
  const CODE_LINE  = /^\s*(export\b|import\b|const\b|let\b|var\b|vi\.|jest\.|before(?:Each|All)|after(?:Each|All)|\/\/|\/\*)/
  const PROSE_LINE = /^\s*["'`]\s*$|^\s*[-*]\s+[A-Za-z]|^\s{1,8}-\s+[A-Z]/
  let foundCode = false
  let truncateAt = -1
  for (let i = 0; i < kept.length; i++) {
    if (CODE_LINE.test(kept[i])) { foundCode = true; truncateAt = -1 }
    else if (foundCode && PROSE_LINE.test(kept[i]) && truncateAt === -1) { truncateAt = i }
  }
  if (truncateAt !== -1) {
    kept.splice(truncateAt)
    stripped = true
  }

  const result = kept.join('\n').trim()
  // Reject content that is only comments/whitespace — no real code to add to the mock file.
  const hasRealCode = result.split('\n').some(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('/*') && !l.trim().startsWith('*'))
  if (!hasRealCode) return { code: '', stripped: true }
  return { code: result, stripped }
}

// Merges duplicate vi.mock() calls for the same module path into one.
// The model sometimes emits two vi.mock('lucide-react', ...) blocks when a component
// imports many icons — the second overrides the first, silently dropping exports.
// Only merges simple `() => ({...})` factories; complex factories (async imports,
// function-body returns) are left untouched.
export function deduplicateViMocks(code: string): string {
  interface Block {
    start: number
    end: number
    module: string
    objectBody: string | null  // null = complex factory, skip merging
  }

  const blocks: Block[] = []
  let pos = 0

  while (pos < code.length) {
    // Match either vi.mock( or jest.mock(
    const viIdx = code.indexOf('vi.mock(', pos)
    const jestIdx = code.indexOf('jest.mock(', pos)
    let idx: number
    let prefixLen: number
    if (viIdx === -1 && jestIdx === -1) break
    if (viIdx === -1) { idx = jestIdx; prefixLen = 10 }
    else if (jestIdx === -1) { idx = viIdx; prefixLen = 8 }
    else if (viIdx < jestIdx) { idx = viIdx; prefixLen = 8 }
    else { idx = jestIdx; prefixLen = 10 }

    const afterOpen = idx + prefixLen
    const q = code[afterOpen]
    if (q !== "'" && q !== '"' && q !== '`') { pos = idx + 1; continue }
    const nameEnd = code.indexOf(q, afterOpen + 1)
    if (nameEnd === -1) { pos = idx + 1; continue }
    const moduleName = code.slice(afterOpen + 1, nameEnd)

    // Find the full call extent via paren depth
    let depth = 0
    let callEnd = -1
    for (let i = idx + prefixLen - 1; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') { depth--; if (depth === 0) { callEnd = i + 1; break } }
    }
    if (callEnd === -1) { pos = idx + 1; continue }

    // Only merge factories that use the () => ({...}) form — the paren-wrapped object
    // literal pattern. Function-body factories (` () => { return {...} }`) are skipped.
    const factoryRe = /,\s*\(\s*\)\s*=>\s*\(\s*\{/
    if (!factoryRe.test(code.slice(nameEnd + 1, callEnd))) {
      blocks.push({ start: idx, end: callEnd, module: moduleName, objectBody: null })
      pos = callEnd
      continue
    }

    // First { after the module name is the object literal opening brace
    let braceStart = -1
    for (let i = nameEnd + 1; i < callEnd; i++) {
      if (code[i] === '{') { braceStart = i; break }
    }
    if (braceStart === -1) { pos = callEnd; continue }

    // Track brace depth to find matching }
    let braceDepth = 0
    let braceEnd = -1
    for (let i = braceStart; i < callEnd; i++) {
      if (code[i] === '{') braceDepth++
      else if (code[i] === '}') { braceDepth--; if (braceDepth === 0) { braceEnd = i; break } }
    }
    if (braceEnd === -1) { pos = callEnd; continue }

    blocks.push({ start: idx, end: callEnd, module: moduleName, objectBody: code.slice(braceStart + 1, braceEnd) })
    pos = callEnd
  }

  // Group by module — only process groups where every occurrence has a simple factory
  const byModule = new Map<string, Block[]>()
  for (const b of blocks) {
    const arr = byModule.get(b.module) ?? []
    arr.push(b)
    byModule.set(b.module, arr)
  }

  const toProcess = [...byModule.entries()].filter(
    ([, list]) => list.length > 1 && list.every(b => b.objectBody !== null)
  )
  if (toProcess.length === 0) return code

  const edits: Array<{ start: number; end: number; text: string }> = []

  for (const [module, list] of toProcess) {
    // Normalize each body: split into lines, trim, re-indent uniformly at 2 spaces.
    const allLines: string[] = []
    for (const b of list) {
      const lines = b.objectBody!.split('\n').map(l => l.trim()).filter(Boolean)
      for (const line of lines) {
        allLines.push('  ' + (line.endsWith(',') ? line : line + ','))
      }
    }

    // Deduplicate keys across all merged bodies: when the same property appears in
    // multiple vi.mock() calls, keep only the last occurrence. This matches Vitest's
    // own override semantics (last vi.mock wins) and avoids duplicate-key objects.
    const keyLastIdx = new Map<string, number>()
    for (let i = 0; i < allLines.length; i++) {
      const m = allLines[i].match(/^\s*(\w+)\s*:/)
      if (m) keyLastIdx.set(m[1], i)
    }
    const deduped = allLines.filter((line, i) => {
      const m = line.match(/^\s*(\w+)\s*:/)
      return m ? keyLastIdx.get(m[1]) === i : true
    })

    const mockPrefix = code.slice(list[0].start, list[0].start + 4) === 'jest' ? 'jest' : 'vi'
    const merged = `${mockPrefix}.mock('${module}', () => ({\n${deduped.join('\n')}\n}))`
    edits.push({ start: list[0].start, end: list[0].end, text: merged })

    for (let i = 1; i < list.length; i++) {
      let removeStart = list[i].start
      if (removeStart > 0 && code[removeStart - 1] === '\n') removeStart--
      edits.push({ start: removeStart, end: list[i].end, text: '' })
    }
  }

  edits.sort((a, b) => b.start - a.start)
  let result = code
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return result
}

const RULE_DIVIDER = '─'.repeat(60)

// Retry message when a fix attempt caused Vitest to collect 0 tests —
// the model likely broke an import. Anchors the model to the original error.
// Error from the broken fix is placed FIRST so it appears in the terminal display
// (which caps at ~15 lines) before the rules boilerplate.
export function buildStructureBrokenMessage(initialError: string, currentError: string): string {
  return (
    `⚠ CRITICAL — Your fix broke the file structure: 0 tests collected.\n` +
    `An import is failing or all test functions were removed.\n\n` +
    `Error from your attempted fix:\n` +
    `${RULE_DIVIDER}\n` +
    `${currentError}\n` +
    `${RULE_DIVIDER}\n\n` +
    `Original failing test error (what you were supposed to fix):\n` +
    `${RULE_DIVIDER}\n` +
    `${initialError}\n` +
    `${RULE_DIVIDER}\n\n` +
    `RULES:\n` +
    `- Do NOT change any imports unless the import itself caused the original failure\n` +
    `- Do NOT restructure the describe block or rename other tests\n` +
    `- ONLY fix the specific assertion that was originally failing`
  )
}

// Retry message when a fix attempt reduced the number of passing tests —
// the model broke previously-passing tests while trying to fix one.
// Current errors placed FIRST for the same display reason.
export function buildRegressionMessage(
  initialError: string,
  currentError: string,
  baselinePass: number,
  currentPass: number,
): string {
  return (
    `⚠ REGRESSION — Your fix broke passing tests: ${baselinePass} passing before, now only ${currentPass}.\n\n` +
    `Current errors:\n` +
    `${RULE_DIVIDER}\n` +
    `${currentError}\n` +
    `${RULE_DIVIDER}\n\n` +
    `Original failing test error:\n` +
    `${RULE_DIVIDER}\n` +
    `${initialError}\n` +
    `${RULE_DIVIDER}\n\n` +
    `Do NOT modify tests that were already passing.\n` +
    `ONLY fix the test that was originally failing.`
  )
}
