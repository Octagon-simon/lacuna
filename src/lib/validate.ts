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

// Returns true when the code contains placeholder test bodies — e.g. `{ // body }`.
// A placeholder passes vitest (no assertions = no failures) but produces zero value.
export function hasPlaceholderBodies(code: string): boolean {
  // Match an opening brace, optional whitespace/newline, a // comment that looks like
  // a placeholder, then closing brace. Catches: { // body }, { // TODO }, { // implement }.
  return /\{\s*\/\/\s*(body|todo|implement(?:ation)?|placeholder|stub|fill\s*in|your\s*code)\s*\}/i.test(code)
}

// Returns true when the runner output shows that zero tests were collected.
// Distinct from hasTestFunctions (static check) — this checks actual runtime collection.
// Handles:
//   - Vitest summary "Tests  0 total" or "Tests  no tests"
//   - Jest summary "Tests: 0 total"
//   - Common "no tests found" / "found 0 tests" messages
// NOTE: Vitest per-file listing lines like "foo.test.ts (0 test)" are NOT zero-test
// signals — that interim count updates as tests resolve; the summary line is authoritative.
// We do NOT match bare "0 test" (with word boundary) because of that false-positive.
//
// AUTHORITATIVE COUNT GUARD: if the summary reports ANY passed or failed test, tests WERE
// collected — even if a failing test's name or assertion message happens to contain the
// phrase "no tests found" / "found 0 tests". Those substrings are unanchored and would
// otherwise false-positive on a run like "11 failed | 17 passed (28)". The pass/fail counts
// come from the authoritative Tests summary line, so they override the substring match.
export function isZeroTestsOutput(raw: string): boolean {
  if (parsePassCount(raw) > 0 || parseFailCount(raw) > 0) return false
  return /Tests:?\s+(?:0\s+total|no tests)\b|no tests? found|found 0 tests/i.test(raw)
}

// If the runner output indicates "no tests found", replace it with a clear instruction
// so the AI knows exactly what went wrong. The zero-tests decision is made on `rawOutput`
// (the full runner output, which still carries the authoritative Tests summary line);
// `extracted` is the already-trimmed failure text that gets returned/appended. Callers that
// only have one string can omit `rawOutput` — it defaults to `extracted`.
export function enrichNoTestsError(extracted: string, rawOutput: string = extracted): string {
  if (!isZeroTestsOutput(rawOutput)) return extracted
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
    extracted
  )
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

// Extracts the number of failing tests from the runner summary footer.
// Anchored to the "Tests  N failed | M passed" line specifically — the word "failed"
// appears in too many noise lines (per-test FAIL markers, stack frames) to match loosely.
// Used alongside parsePassCount to prove tests were actually collected.
export function parseFailCount(output: string): number {
  const summaryLine = output.match(/^\s*Tests\b[^\n]*?(\d+)\s+failed/m)
  return summaryLine ? parseInt(summaryLine[1], 10) : 0
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

// ---------------------------------------------------------------------------
// Patch-mode support
// ---------------------------------------------------------------------------

export type PatchOpType = 'REPLACE_TEST' | 'DELETE_TEST' | 'ADD_AFTER_DESCRIBE' | 'ADD_IMPORT' | 'ADD_AFTER_IMPORTS' | 'REPLACE'

export interface PatchOperation {
  type: PatchOpType
  anchor: string   // for REPLACE_TEST/DELETE_TEST/ADD_AFTER_DESCRIBE: test/describe name;
                   // for REPLACE: exact old text to find (multi-line)
  content: string  // replacement/addition content (empty string for DELETE_TEST)
}

// Parses the model's patch output into a list of PatchOperation objects.
//
// Most operations have the form:
//   // @@@ TYPE: "anchor"
//   <content lines>
//   // @@@ END
//
// REPLACE is different — it uses a WITH delimiter instead of an inline anchor:
//   // @@@ REPLACE:
//   <exact existing text to find, verbatim>
//   // @@@ WITH:
//   <replacement text>
//   // @@@ END
export function parsePatch(patchOutput: string): PatchOperation[] {
  const ops: PatchOperation[] = []
  const lines = patchOutput.split('\n')
  // Capture the anchor either quoted ("name") or unquoted (name).
  // Group 2 = quoted text, group 3 = unquoted text. DeepSeek and other models
  // often drop the double-quotes, so we accept both forms.
  const headerRe = /^\/\/ @@@ (REPLACE_TEST|DELETE_TEST|ADD_AFTER_DESCRIBE|ADD_IMPORT|ADD_AFTER_IMPORTS|REPLACE):\s*(?:"([^"]*)"|(.*\S))?/
  const withRe = /^\/\/ @@@ WITH:\s*$/
  const endRe = /^\/\/ @@@ END\s*$/

  let i = 0
  while (i < lines.length) {
    const m = headerRe.exec(lines[i])
    if (!m) { i++; continue }

    const type = m[1] as PatchOpType
    i++

    if (type === 'REPLACE') {
      // Read old text until // @@@ WITH:
      const oldLines: string[] = []
      while (i < lines.length && !withRe.test(lines[i]) && !endRe.test(lines[i])) {
        oldLines.push(lines[i])
        i++
      }
      if (!withRe.test(lines[i] ?? '')) { i++; continue } // malformed — skip
      i++ // skip // @@@ WITH:
      const newLines: string[] = []
      while (i < lines.length && !endRe.test(lines[i])) {
        newLines.push(lines[i])
        i++
      }
      i++ // skip // @@@ END
      let anchor = oldLines.join('\n')
      let content = newLines.join('\n')
      if (anchor.startsWith('\n')) anchor = anchor.slice(1)
      if (anchor.endsWith('\n')) anchor = anchor.slice(0, -1)
      if (content.startsWith('\n')) content = content.slice(1)
      if (content.endsWith('\n')) content = content.slice(0, -1)
      ops.push({ type, anchor, content })
    } else {
      const anchor = (m[2] ?? m[3] ?? '').trim()  // quoted OR unquoted; ADD_IMPORT/ADD_AFTER_IMPORTS have no anchor
      const contentLines: string[] = []
      while (i < lines.length && !endRe.test(lines[i])) {
        contentLines.push(lines[i])
        i++
      }
      i++ // skip // @@@ END
      let content = contentLines.join('\n')
      if (content.startsWith('\n')) content = content.slice(1)
      if (content.endsWith('\n')) content = content.slice(0, -1)
      ops.push({ type, anchor, content })
    }
  }
  return ops
}

// Finds the start and end character positions of `anchor` within `code`.
// First tries exact match; if that fails, tries a line-by-line match that
// trims trailing whitespace from each line (handles trailing spaces and CRLF files).
// Returns the range in the ORIGINAL (un-normalized) code so the replacement is clean.
function findAnchorRange(code: string, anchor: string): { start: number; end: number } | null {
  // Fast path: exact match
  const exactIdx = code.indexOf(anchor)
  if (exactIdx !== -1) return { start: exactIdx, end: exactIdx + anchor.length }

  // Fallback: trim trailing whitespace (including \r) on every line and re-compare.
  // Handles trailing spaces left by editors and CRLF files (\r stripped by trimEnd).
  const anchorLines = anchor.split('\n').map(l => l.trimEnd())
  const codeLines = code.split('\n')
  const n = anchorLines.length
  if (n === 0) return null

  // Precompute byte offset of each line start — O(N) once, avoids O(N²) inner accumulation.
  const lineStart: number[] = new Array(codeLines.length + 1)
  lineStart[0] = 0
  for (let k = 0; k < codeLines.length; k++) {
    lineStart[k + 1] = lineStart[k] + codeLines[k].length + 1  // +1 for the \n separator
  }

  for (let i = 0; i <= codeLines.length - n; i++) {
    if (codeLines[i].trimEnd() !== anchorLines[0]) continue
    let match = true
    for (let j = 1; j < n; j++) {
      if (codeLines[i + j].trimEnd() !== anchorLines[j]) { match = false; break }
    }
    if (!match) continue
    const start = lineStart[i]
    // end = start of line after the match minus the \n, i.e. the span of the matched lines joined
    const end = start + codeLines.slice(i, i + n).join('\n').length
    return { start, end }
  }
  return null
}

// Finds the end of an it()/test()/describe() call starting at `startIdx` in `code`.
// `startIdx` must point to the opening `(` of the call.
// Returns the index just past the closing `)` (and optional `;`), or -1 on failure.
//
// Strategy: skip the string argument(s), find the function body `{`, track brace depth
// until it returns to 0, then consume the closing `)` and optional `;`.
// We do a simplified scan that handles string literals and template literals to avoid
// false brace counts inside quoted text.
function findCallEnd(code: string, startIdx: number): number {
  let i = startIdx  // points at the `(` of the call
  let parenDepth = 0
  let braceDepth = 0
  let foundBrace = false

  while (i < code.length) {
    const ch = code[i]

    // Skip string literals to avoid false brace/paren counts inside strings
    if (ch === '"' || ch === "'") {
      const q = ch
      i++
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === q) { i++; break }
        i++
      }
      continue
    }
    if (ch === '`') {
      i++
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === '`') { i++; break }
        // Skip ${...} expressions inside template literals (simplified: track braces)
        if (code[i] === '$' && code[i + 1] === '{') {
          i += 2
          let tDepth = 1
          while (i < code.length && tDepth > 0) {
            if (code[i] === '{') tDepth++
            else if (code[i] === '}') tDepth--
            i++
          }
          continue
        }
        i++
      }
      continue
    }

    if (ch === '{') {
      foundBrace = true
      braceDepth++
      i++
      continue
    }
    if (ch === '}') {
      if (foundBrace) {
        braceDepth--
        if (braceDepth === 0) {
          // We've closed the function body. Now consume the closing `)` and optional `;`
          i++ // move past `}`
          // skip whitespace/newlines
          while (i < code.length && (code[i] === ' ' || code[i] === '\t' || code[i] === '\n' || code[i] === '\r')) i++
          if (i < code.length && code[i] === ')') {
            i++ // consume `)`
            if (i < code.length && code[i] === ';') i++ // consume optional `;`
          }
          return i
        }
      }
      i++
      continue
    }

    if (!foundBrace) {
      // Before the opening brace we still count parens to handle nested calls in args
      if (ch === '(') parenDepth++
      else if (ch === ')') {
        parenDepth--
        // If we hit -1 depth without ever finding a brace this is a call with no body (unlikely for tests)
        if (parenDepth < 0) return -1
      }
    }

    i++
  }
  return -1
}

// Applies a list of PatchOperation objects to `existingCode` in order.
// Returns the modified string, or null if any anchor cannot be located.
export function applyPatch(existingCode: string, ops: PatchOperation[]): string | null {
  let code = existingCode

  for (const op of ops) {
    if (op.type === 'REPLACE') {
      // General text replacement — same mechanism as the Edit tool.
      // anchor = exact old text, content = replacement. First occurrence only.
      // Falls back to trailing-whitespace-normalized line matching so that minor
      // formatting differences (trailing spaces, CRLF files) don't cause failures.
      const range = findAnchorRange(code, op.anchor)
      if (!range) return null
      code = code.slice(0, range.start) + op.content + code.slice(range.end)

    } else if (op.type === 'REPLACE_TEST' || op.type === 'DELETE_TEST') {
      const anchor = op.anchor
      // Try all four quote/keyword combos
      const candidates = [
        `it("${anchor}"`,
        `it('${anchor}'`,
        `test("${anchor}"`,
        `test('${anchor}'`,
      ]
      let foundIdx = -1
      for (const c of candidates) {
        const idx = code.indexOf(c)
        if (idx !== -1) { foundIdx = idx; break }
      }
      if (foundIdx === -1) return null

      // Find the opening `(` of the call — it's right after `it` or `test`
      const parenIdx = code.indexOf('(', foundIdx)
      if (parenIdx === -1) return null

      const callEnd = findCallEnd(code, parenIdx)
      if (callEnd === -1) return null

      if (op.type === 'REPLACE_TEST') {
        code = code.slice(0, foundIdx) + op.content + code.slice(callEnd)
      } else {
        // DELETE_TEST: also remove an immediately preceding blank line
        let removeStart = foundIdx
        if (removeStart > 0 && code[removeStart - 1] === '\n') {
          // Check if the line before is blank
          const prevNewline = code.lastIndexOf('\n', removeStart - 2)
          const prevLine = code.slice(prevNewline + 1, removeStart - 1)
          if (prevLine.trim() === '') removeStart = prevNewline + 1
        }
        code = code.slice(0, removeStart) + code.slice(callEnd)
      }

    } else if (op.type === 'ADD_AFTER_DESCRIBE') {
      const anchor = op.anchor
      const candidates = [
        `describe("${anchor}"`,
        `describe('${anchor}'`,
      ]
      let foundIdx = -1
      for (const c of candidates) {
        const idx = code.indexOf(c)
        if (idx !== -1) { foundIdx = idx; break }
      }
      if (foundIdx === -1) return null

      // Find the opening `(` of the describe call
      const parenIdx = code.indexOf('(', foundIdx)
      if (parenIdx === -1) return null

      // Walk from parenIdx to find the LAST closing `})` of the describe block.
      // We track brace depth from the first `{` we encounter inside the describe args.
      let i = parenIdx
      let braceDepth = 0
      let lastClosePos = -1  // position of the `}` that closes the describe body

      // Skip string literal for the describe name argument
      // The describe call looks like: describe("name", () => { ... })
      // We need to find the function body brace
      let foundBrace = false

      while (i < code.length) {
        const ch = code[i]

        // Skip string literals
        if (ch === '"' || ch === "'") {
          const q = ch
          i++
          while (i < code.length) {
            if (code[i] === '\\') { i += 2; continue }
            if (code[i] === q) { i++; break }
            i++
          }
          continue
        }
        if (ch === '`') {
          i++
          while (i < code.length) {
            if (code[i] === '\\') { i += 2; continue }
            if (code[i] === '`') { i++; break }
            if (code[i] === '$' && code[i + 1] === '{') {
              i += 2
              let tDepth = 1
              while (i < code.length && tDepth > 0) {
                if (code[i] === '{') tDepth++
                else if (code[i] === '}') tDepth--
                i++
              }
              continue
            }
            i++
          }
          continue
        }

        if (ch === '{') {
          foundBrace = true
          braceDepth++
          i++
          continue
        }
        if (ch === '}') {
          if (foundBrace) {
            braceDepth--
            if (braceDepth === 0) {
              lastClosePos = i
              break
            }
          }
          i++
          continue
        }
        i++
      }

      if (lastClosePos === -1) return null

      // Insert content immediately before the closing `}`
      // Add a newline after content so the `}` is on its own line
      const insertion = '\n' + op.content + '\n'
      code = code.slice(0, lastClosePos) + insertion + code.slice(lastClosePos)

    } else if (op.type === 'ADD_IMPORT') {
      // Find the last `import ` line in the file
      const lines = code.split('\n')
      let lastImportLineIdx = -1
      for (let idx = 0; idx < lines.length; idx++) {
        if (/^\s*import\s/.test(lines[idx])) lastImportLineIdx = idx
      }

      const importLines = op.content.split('\n')
      if (lastImportLineIdx === -1) {
        lines.unshift(...importLines)
      } else {
        lines.splice(lastImportLineIdx + 1, 0, ...importLines)
      }
      code = lines.join('\n')
    } else if (op.type === 'ADD_AFTER_IMPORTS') {
      // Like ADD_IMPORT but inserts a blank line before the block — for vi.mock() calls
      // and other module-level statements that follow imports
      const lines = code.split('\n')
      let lastImportLineIdx = -1
      for (let idx = 0; idx < lines.length; idx++) {
        if (/^\s*import\s/.test(lines[idx])) lastImportLineIdx = idx
      }

      const contentLines = ['', ...op.content.split('\n')]
      if (lastImportLineIdx === -1) {
        lines.unshift(...contentLines)
      } else {
        lines.splice(lastImportLineIdx + 1, 0, ...contentLines)
      }
      code = lines.join('\n')
    }
  }

  // Collapse gaps left by DELETE_TEST: runs of 3+ newlines (2+ consecutive blank lines)
  // down to exactly 2 newlines (1 blank line). Safe — never affects content.
  code = code.replace(/\n{3,}/g, '\n\n')

  // Remove describe blocks that became empty shells (no it/test calls anywhere inside).
  // Repeat until stable — outer empties are caught after inner empties are removed.
  code = removeEmptyDescribeBlocks(code)

  return code
}

// Removes describe() blocks whose body contains no it() or test() calls at any depth.
// Iterates until stable to handle nested empty blocks (inner removed first, then outer).
function removeEmptyDescribeBlocks(code: string): string {
  let prev = ''
  while (code !== prev) {
    prev = code
    const lines = code.split('\n')
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (/^\s*describe\s*\(/.test(line) && line.trimEnd().endsWith('{')) {
        // Collect the full block by tracking brace depth.
        // Note: braces in string literals may cause a false depth count, but that
        // only risks keeping a block we should remove — never deleting a live one,
        // because we require it()/test() to be absent in ALL collected lines.
        let depth = 1
        let j = i + 1
        const bodyLines: string[] = []
        while (j < lines.length && depth > 0) {
          const l = lines[j]
          for (const ch of l) {
            if (ch === '{') depth++
            else if (ch === '}') depth--
          }
          if (depth > 0) bodyLines.push(l)
          j++
        }
        const hasTests = bodyLines.some(l => /\b(?:it|test)\s*\(/.test(l))
        if (!hasTests) {
          // Skip the whole block (opening line through closing line)
          i = j
          // Consume a trailing blank line so deletions don't stack up
          if (i < lines.length && !lines[i].trim()) i++
          continue
        }
      }
      out.push(line)
      i++
    }
    code = out.join('\n')
  }
  return code
}

// Convenience wrapper: parses then applies. Returns null if no ops parsed or apply fails.
export function tryApplyPatch(existingCode: string, patchOutput: string): string | null {
  const ops = parsePatch(patchOutput)
  if (ops.length === 0) return null
  return applyPatch(existingCode, ops)
}

export interface PatchApplyOk { ok: true; result: string }
export interface PatchApplyFail { ok: false; failedOp: PatchOperation | null; opsCount: number }

// Like tryApplyPatch but surfaces which operation failed, so callers can build
// a useful error message pointing the model at the exact anchor that didn't match.
export function tryApplyPatchWithDiag(existingCode: string, patchOutput: string): PatchApplyOk | PatchApplyFail {
  const ops = parsePatch(patchOutput)
  if (ops.length === 0) return { ok: false, failedOp: null, opsCount: 0 }
  let code = existingCode
  for (const op of ops) {
    const result = applyPatch(code, [op])
    if (result === null) return { ok: false, failedOp: op, opsCount: ops.length }
    code = result
  }
  return { ok: true, result: code }
}

// ---------------------------------------------------------------------------
// Mock file patch — surgical edits without rewriting the whole file.
//
// Format inside a ---MOCKS_PATCH--- block:
//
//   // @@@ REPLACE:
//   <exact existing text, copied verbatim>
//   // @@@ WITH:
//   <replacement text>
//   // @@@ END
//
//   // @@@ APPEND_EXPORT:
//   export const mockFoo = vi.fn()
//   // @@@ END
//
//   // @@@ ADD_TO_BEFOREEACH:
//   mockFoo.mockReset()
//   // @@@ END
//
// REPLACE mirrors the Edit tool exactly — old_string must match character-for-character.
// APPEND_EXPORT inserts new declarations before the existing beforeEach (or at end of file).
// ADD_TO_BEFOREEACH inserts reset calls inside the existing beforeEach body.
// ---------------------------------------------------------------------------
export type MockPatchOpType = 'REPLACE' | 'APPEND_EXPORT' | 'ADD_TO_BEFOREEACH'

export interface MockPatchOperation {
  type: MockPatchOpType
  oldText: string   // only for REPLACE — exact text to find
  newText: string   // replacement / addition content
}

export function parseMocksPatch(patchOutput: string): MockPatchOperation[] {
  const ops: MockPatchOperation[] = []
  const lines = patchOutput.split('\n')
  const headerRe = /^\/\/ @@@ (REPLACE|APPEND_EXPORT|ADD_TO_BEFOREEACH):\s*$/
  const withRe = /^\/\/ @@@ WITH:\s*$/
  const endRe = /^\/\/ @@@ END\s*$/

  let i = 0
  while (i < lines.length) {
    const m = headerRe.exec(lines[i])
    if (!m) { i++; continue }

    const type = m[1] as MockPatchOpType
    i++

    if (type === 'REPLACE') {
      const oldLines: string[] = []
      while (i < lines.length && !withRe.test(lines[i]) && !endRe.test(lines[i])) {
        oldLines.push(lines[i])
        i++
      }
      if (!withRe.test(lines[i] ?? '')) { i++; continue }
      i++ // skip // @@@ WITH:
      const newLines: string[] = []
      while (i < lines.length && !endRe.test(lines[i])) {
        newLines.push(lines[i])
        i++
      }
      i++ // skip // @@@ END
      let oldText = oldLines.join('\n')
      let newText = newLines.join('\n')
      if (oldText.startsWith('\n')) oldText = oldText.slice(1)
      if (oldText.endsWith('\n')) oldText = oldText.slice(0, -1)
      if (newText.startsWith('\n')) newText = newText.slice(1)
      if (newText.endsWith('\n')) newText = newText.slice(0, -1)
      ops.push({ type, oldText, newText })
    } else {
      // APPEND_EXPORT and ADD_TO_BEFOREEACH — just content, no WITH: block
      const contentLines: string[] = []
      while (i < lines.length && !endRe.test(lines[i])) {
        contentLines.push(lines[i])
        i++
      }
      i++ // skip // @@@ END
      let newText = contentLines.join('\n')
      if (newText.startsWith('\n')) newText = newText.slice(1)
      if (newText.endsWith('\n')) newText = newText.slice(0, -1)
      ops.push({ type, oldText: '', newText })
    }
  }
  return ops
}

export function applyMocksPatch(existing: string, ops: MockPatchOperation[]): { result: string; failedOps: MockPatchOperation[] } {
  let code = existing
  const failedOps: MockPatchOperation[] = []

  for (const op of ops) {
    if (op.type === 'REPLACE') {
      const range = findAnchorRange(code, op.oldText)
      if (!range) {
        failedOps.push(op)
        continue
      }
      code = code.slice(0, range.start) + op.newText + code.slice(range.end)

    } else if (op.type === 'APPEND_EXPORT') {
      // Insert before the last beforeEach block, or at end of file if none
      const beforeEachIdx = code.lastIndexOf('\nbeforeEach(')
      if (beforeEachIdx !== -1) {
        code = code.slice(0, beforeEachIdx) + '\n\n' + op.newText.trim() + code.slice(beforeEachIdx)
      } else {
        code = code.trimEnd() + '\n\n' + op.newText.trim()
      }

    } else if (op.type === 'ADD_TO_BEFOREEACH') {
      // Find the last beforeEach and insert before its closing brace
      const beIdx = code.lastIndexOf('\nbeforeEach(')
      if (beIdx === -1) {
        failedOps.push(op)
        continue
      }
      // Find the closing }) of that beforeEach by tracking brace depth
      let depth = 0
      let closeIdx = -1
      for (let i = beIdx + 1; i < code.length; i++) {
        if (code[i] === '{') depth++
        else if (code[i] === '}') {
          depth--
          if (depth === 0) { closeIdx = i; break }
        }
      }
      if (closeIdx === -1) { failedOps.push(op); continue }
      const indent = '  '
      const lines = op.newText.trim().split('\n').map(l => indent + l).join('\n')
      code = code.slice(0, closeIdx) + '\n' + lines + '\n' + code.slice(closeIdx)
    }
  }

  return { result: code, failedOps }
}

export function tryApplyMocksPatch(existing: string, patchOutput: string): { result: string; failedOps: MockPatchOperation[] } | null {
  const ops = parseMocksPatch(patchOutput)
  if (ops.length === 0) return null
  return applyMocksPatch(existing, ops)
}
