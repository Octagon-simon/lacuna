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

const RULE_DIVIDER = '─'.repeat(60)

// Retry message when a fix attempt caused Vitest to collect 0 tests —
// the model likely broke an import. Anchors the model to the original error.
export function buildStructureBrokenMessage(initialError: string, currentError: string): string {
  return (
    `⚠ CRITICAL — Your fix broke the file structure: Vitest found 0 tests.\n\n` +
    `This means an import is now failing during module collection, or you accidentally removed all test functions.\n` +
    `Look for: Cannot find module, TypeError, SyntaxError in the error output below.\n\n` +
    `RULES:\n` +
    `- Do NOT change any imports unless the import itself caused the original failure\n` +
    `- Do NOT restructure the describe block or rename other tests\n` +
    `- ONLY fix the specific assertion that was originally failing\n\n` +
    `Original failing test error (what you were supposed to fix):\n` +
    `${RULE_DIVIDER}\n` +
    `${initialError}\n` +
    `${RULE_DIVIDER}\n\n` +
    `Error from your attempted fix:\n` +
    `${currentError}`
  )
}

// Retry message when a fix attempt reduced the number of passing tests —
// the model broke previously-passing tests while trying to fix one.
export function buildRegressionMessage(
  initialError: string,
  currentError: string,
  baselinePass: number,
  currentPass: number,
): string {
  return (
    `⚠ REGRESSION — Your fix made things worse: ${baselinePass} test(s) were passing before, now only ${currentPass} are.\n\n` +
    `Do NOT modify tests that were already passing.\n` +
    `ONLY fix the test that was originally failing.\n\n` +
    `Original failing test error:\n` +
    `${RULE_DIVIDER}\n` +
    `${initialError}\n` +
    `${RULE_DIVIDER}\n\n` +
    `Current errors:\n` +
    `${currentError}`
  )
}
