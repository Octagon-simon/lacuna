// The identifier a test file is named for — `useForcedUpdate.test.ts` → `useForcedUpdate`. Used to
// guard against a fix/regen QUIETLY changing WHAT the test tests: a model that can't get a hard
// hook/component mock right will sometimes rewrite the file to test an easy imported utility
// instead (observed: `useForcedUpdate.test.ts` rewritten to test `compareVersions`), and because
// keep-best ranks by PASS COUNT, those trivial-but-passing tests beat the real ones and get kept —
// silently destroying coverage of the actual subject. Returns null for generic/aggregate names
// where the guard would false-positive.
export function subjectFromTestPath(testPath) {
    const base = (testPath.replace(/\\/g, '/').split('/').pop() ?? '')
        .replace(/\.(test|spec)\.[jt]sx?$/, '')
        .replace(/^test_/, '')
        .replace(/_test$/, '')
        .replace(/\.[jt]sx?$/, '');
    if (base.length < 3)
        return null;
    if (/^(index|main|app|setup|utils?|helpers?|constants?|types?)$/i.test(base))
        return null;
    return base;
}
// True when `code` references `subject` as a whole-word identifier (import or usage). Word-bounded so
// `useForcedUpdate` doesn't match inside `useForcedUpdateThing`.
export function referencesSubject(code, subject) {
    return new RegExp(`\\b${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code);
}
// Whether a leaked-handle warning is plausibly fixable by editing THIS test — i.e. the test or its
// source actually creates a timer/interval/subscription/connection the test could clear. When it
// does NOT (the leak comes from the RN/jest/firebase/expo environment or a dependency the test only
// mocks), no test edit can clear it, so the fix loop must NOT chase it: doing so treats a passing
// file as failing and burns iterations on an unfixable warning. In that case, accept the green tests
// with a note instead. Keyed on real handle-creating APIs in the test/source, not in mocks.
const LEAK_FIXABLE_RE = /\b(setInterval|setTimeout|setImmediate|requestAnimationFrame|addEventListener|addListener|new WebSocket|createConnection)\b|\.(subscribe|listen|connect|watch|poll)\s*\(/;
export function leakLooksTestFixable(testCode, sourceCode) {
    return LEAK_FIXABLE_RE.test(testCode) || (!!sourceCode && LEAK_FIXABLE_RE.test(sourceCode));
}
// Detects when a compile/runtime error actually originates in the SHARED mocks file(s) rather
// than the test file the fix loop is currently editing (e.g. a bare `jest.fn()` inside
// tests/mocks.ts itself losing its type, breaking `.mockResolvedValue()` for every test file that
// imports it). Without this, the model is only ever shown the raw diagnostic — which names the
// mocks file's path, not the test file's — and has no explicit signal that rewriting the TEST
// file can never fix it. Observed repeatedly: the model retries the test file up to
// maxIterations with no progress because the actual broken line lives in a file it was never
// told to touch. Returns a prompt-injectable banner naming the exact offending file(s), or null
// when the error doesn't reference any configured mocks file.
export function detectMocksFileError(errorOutput, mocksFiles) {
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hits = mocksFiles.filter(mf => new RegExp(`${escapeRe(mf)}[:(]\\d`).test(errorOutput));
    if (hits.length === 0)
        return null;
    return (`\n\n⚠ THIS ERROR IS IN THE SHARED MOCKS FILE, NOT YOUR TEST FILE: the diagnostic above references ${hits.map(h => `"${h}"`).join(', ')} — a file shared across every test that imports it, not the file you are editing.\n` +
        `Editing your test file CANNOT fix this. You must emit a // ---MOCKS_PATCH--- (or // ---MOCKS_FILE--- for a full rewrite) section that fixes the EXACT reported line inside the mocks file itself, in addition to (or instead of, if your test file needs no changes) editing the test file. See the MOCK PATCH instructions for the exact syntax.`);
}
// A hard process crash (V8 out-of-memory abort, segfault) looks superficially like a normal test
// regression to the pass/fail-count classification in loop.ts/fix-loop.ts — the runner never
// prints a summary line, so parsePassCount reads 0, which satisfies "fewer passing than before"
// and gets reported as ⚠ REGRESSION. That's actively wrong guidance: a crash means something is
// consuming unbounded memory/resources, not that an assertion is wrong — "fix your assertions"
// sends the model nowhere useful. These signatures are V8-runtime-internal phrasing, distinctive
// enough that no real application test fixture would ever legitimately contain them.
const CRASH_SIGNATURES = [
    /FATAL ERROR:[\s\S]{0,200}?(?:heap out of memory|Allocation failed)/i,
    /JavaScript heap out of memory/i,
    /Segmentation fault/i,
];
// Jest refuses to run at all when it finds BOTH a jest.config.js/ts AND a `"jest"` key in
// package.json (no --config flag disambiguating) — a real, live-reproduced case: a project with
// coverageReporters/coverageDirectory correctly set in jest.config.js still got "Could not read
// coverage report" because jest exited in under a second with THIS error before running a single
// test, so no report was ever written — completely unrelated to whether coverage is configured.
// The generic "make sure your config has coverage enabled" message is actively wrong here since
// the config IS correct; this fires first and names the real, fixable cause instead.
const JEST_MULTIPLE_CONFIGS_RE = /Multiple configurations found:\s*\n\s*\n?((?:\s*\*\s*.+\n?)+)/;
export function detectJestConfigConflict(rawOutput) {
    const m = JEST_MULTIPLE_CONFIGS_RE.exec(rawOutput);
    if (!m)
        return null;
    const sources = m[1].trim().split('\n').map(l => l.replace(/^\s*\*\s*/, '').trim()).filter(Boolean);
    return (`Jest found more than one config source and refuses to guess which one to use, so it exited before running any tests (no coverage report was ever written):\n` +
        sources.map(s => `  • ${s}`).join('\n') + '\n' +
        `Delete or merge one of them — most commonly, remove the "jest" key from package.json if jest.config.js/ts is the one you actually maintain (or vice versa).`);
}
// Jest wraps EVERY fatal pre-test config/validation failure (missing preset, malformed config,
// "Multiple configurations found", etc.) in the SAME generic envelope: a `● <Title>:` header,
// the actual error body, and — uniquely to this class of error, never printed for an ordinary
// per-file "Test suite failed to run" — a "Configuration Documentation:" footer. Live-reproduced
// TWICE on the same real project: first "Multiple configurations found" (handled precisely above
// by detectJestConfigConflict), then — after fixing that — jest-expo's preset requiring the
// since-split-out `@react-native/jest-preset` package threw a DIFFERENT "Validation Error" that
// fell through to the same misleading "make sure coverage is enabled" message, because only the
// narrow "Multiple configurations" pattern was being checked. Rather than adding one detector per
// crash shape (whack-a-mole), this catches the WHOLE family generically and surfaces jest's own
// error verbatim instead of guessing "check your coverage config." Checked AFTER
// detectJestConfigConflict, which gives a more specific, actionable message for its one case.
const JEST_VALIDATION_ERROR_RE = /●\s*([^\n:]+):\s*\n+([\s\S]*?)\n\s*Configuration Documentation:\s*\n\s*https:\/\/jestjs\.io\/docs\/configuration/;
export function detectJestValidationError(rawOutput) {
    const m = JEST_VALIDATION_ERROR_RE.exec(rawOutput);
    if (!m)
        return null;
    const title = m[1].trim();
    const body = m[2].trim().split('\n').filter(l => !/^\s*at\s/.test(l)).join('\n').trim();
    return (`Jest crashed with a fatal "${title}" before running any tests (no coverage report was ever written):\n\n${body}\n\n` +
        `This is a Jest/dependency configuration problem, not a lacuna coverage setting — resolve it directly (the message above names the exact fix), then re-run.`);
}
export function detectProcessCrash(rawOutput) {
    for (const re of CRASH_SIGNATURES) {
        const m = re.exec(rawOutput);
        if (m)
            return m[0];
    }
    return null;
}
// Scans for stack-frame-shaped "at ... (file:line:col)" references and flags the first one that
// points OUTSIDE the set of files the model actually knows it's allowed to touch (the test file,
// the source file under test, and the configured mocks files) — i.e. a fix broke a SHARED,
// unrelated module's init/mock chain, collateral damage the model has no visibility into and no
// way to connect back to its own edit. Deliberately narrow: only meaningful against a genuine
// crash trace (call from the isZeroTestsOutput/structure-broken branch only) — a normal in-test
// assertion failure's stack legitimately references many application files, which would make this
// noisy/false-positive-prone if applied broadly.
export function detectUnrelatedFileCrash(errorOutput, testFilePath, sourceFilePath, mocksFiles) {
    const frames = [...errorOutput.matchAll(/\bat\s+(?:[\w.$<>]+\s+)?\(?([\w./-]+\.tsx?):(\d+):(\d+)\)?/g)];
    if (frames.length === 0)
        return null;
    const known = [testFilePath, sourceFilePath, ...mocksFiles].filter((p) => Boolean(p));
    const isKnown = (file) => known.some(k => file.endsWith(k) || k.endsWith(file));
    const culprit = frames.find(f => !isKnown(f[1]));
    if (!culprit)
        return null;
    const [, file, line] = culprit;
    return (`\n\n⚠ THIS CRASH ORIGINATES IN AN UNRELATED FILE (${file}:${line}) — not your test file, not a configured mock, not the source file under test.\n` +
        `Your change likely altered something ${file}'s module-load or dependency chain relies on (e.g. removed/broke a mock or import elsewhere). Do NOT edit assertions in your test file to work around this — find and undo whatever change caused '${file}' to receive an unexpected value, or add/fix a mock for whatever it depends on that isn't mocked yet.`);
}
// Serializes the read-merge-write critical section around the shared mocks file(s). Under
// parallel workers (`generate -w N` / `fix -w N`) each worker processes a DIFFERENT test file but
// they can all touch the SAME shared mocksFile — without a lock, two workers can both read the
// current content, independently compute their own merge, and write back; the second writer wins
// and silently discards whatever the first worker just added (or reintroduces the very
// duplicate-export corruption dedupeMockExports exists to prevent, if both reads land before
// either write). Mirrors typecheck.ts's withTscLock — same one-at-a-time promise-chain pattern,
// applied here instead to the mocks file's read+merge+write instead of a tsc invocation. Exported
// so loop.ts (generate) and fix-loop.ts (fix) share ONE lock instance rather than each queuing
// only against their own in-process calls.
let mocksLock = Promise.resolve();
export function withMocksLock(fn) {
    const run = mocksLock.then(fn, fn);
    mocksLock = run.then(() => { }, () => { });
    return run;
}
// Strip comments and string literals to avoid false positives inside quoted text.
function stripNonCode(code) {
    return code
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, '""')
        .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
        .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, '""');
}
// Returns true if the code contains at least one executable test function.
// A file that only has describe() with no it()/test() inside is considered empty.
export function hasTestFunctions(code) {
    const stripped = stripNonCode(code);
    return /\b(?:it|test)\s*(?:\.(?:each|concurrent|skip|only))?\s*\(/.test(stripped);
}
// Counts top-level it()/test() cases (including .each/.concurrent/.skip/.only variants),
// ignoring string/comment content. Used to detect a patch that net-deletes tests: DELETE_TEST is
// a legitimate op for genuinely obsolete tests, but a model that can't get a REPLACE anchor to
// match sometimes reaches for DELETE_TEST on perfectly valid tests just to get SOME op in its
// patch to succeed. A raw count comparison against the pre-patch file is a cheap, model-agnostic
// tripwire for that failure mode.
export function countTestCases(code) {
    const stripped = stripNonCode(code);
    const matches = stripped.match(/\b(?:it|test)\s*(?:\.(?:each|concurrent|skip|only))?\s*\(/g);
    return matches ? matches.length : 0;
}
// Scores how "blocked" a STRUCTURE-BROKEN run's output is (a compile error or a require-time
// crash where 0 tests could even be collected). Pass count can't distinguish two such runs from
// each other — both report 0 passing — so the fix loop's keep-best tracking (fix-loop.ts)
// historically gave ZERO credit for fixing one blocking error only to reveal a different one
// underneath it: observed live, a model correctly fixed an invalid `import { default }`
// reserved-word error (TS1003 — the file doesn't even PARSE), which then surfaced a separate
// module-hoisting TDZ ReferenceError (the file parses fine, crashes during evaluation instead) —
// genuine forward progress, but a raw error COUNT can't see it: both states have exactly one
// error. The two failure classes aren't equally severe though — a file that doesn't parse is
// strictly further from working than one that parses and crashes at require-time, regardless of
// how many errors of each kind there are — so this scores by TIER first (parse errors are always
// worse than any number of runtime crashes) and error count only as the tiebreaker within a tier.
// Lower score = closer to compiling.
export function countDistinctErrors(output) {
    const TIER_PARSE_ERROR = 1000; // TS compile/syntax errors — the file doesn't even parse
    const TIER_RUNTIME_CRASH = 100; // require-time exception — parses fine, throws during eval
    const tsErrors = (output.match(/error TS\d+/g) ?? []).length;
    if (tsErrors > 0)
        return TIER_PARSE_ERROR + tsErrors;
    // No TS compile errors — most likely a single require-time exception (SyntaxError,
    // ReferenceError, TypeError thrown while evaluating the module, or Jest's own generic "Error:").
    // Count distinct "<ErrorType>:" headers rather than every stack-trace line under it.
    const exceptionHeaders = (output.match(/\b(?:SyntaxError|ReferenceError|TypeError|Error):/g) ?? []).length;
    // Always at least 1 — the caller only calls this when the run is already known to be
    // structure-broken, so an unrecognized error format still counts as "something is wrong".
    return TIER_RUNTIME_CRASH + Math.max(exceptionHeaders, 1);
}
// Returns true when the code contains placeholder test bodies — e.g. `{ // body }`.
// A placeholder passes vitest (no assertions = no failures) but produces zero value.
export function hasPlaceholderBodies(code) {
    // Match an opening brace, optional whitespace/newline, a // comment that looks like
    // a placeholder, then closing brace. Catches: { // body }, { // TODO }, { // implement }.
    return /\{\s*\/\/\s*(body|todo|implement(?:ation)?|placeholder|stub|fill\s*in|your\s*code)\s*\}/i.test(code);
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
export function isZeroTestsOutput(raw) {
    if (parsePassCount(raw) > 0 || parseFailCount(raw) > 0)
        return false;
    return /Tests:?\s+(?:0\s+total|no tests)\b|no tests? found|found 0 tests/i.test(stripAnsi(raw));
}
// Human-facing display name for a runner id (from env.testRunner). Falls back to a neutral
// phrase for unknown/omitted runners so the message never lies about which runner ran.
function runnerDisplayName(runner) {
    const names = {
        jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', pytest: 'pytest',
        'go-test': 'go test', phpunit: 'PHPUnit', pest: 'Pest', rspec: 'RSpec',
    };
    return (runner && names[runner]) || 'The test runner';
}
// If the runner output indicates "no tests found", replace it with a clear instruction
// so the AI knows exactly what went wrong. The zero-tests decision is made on `rawOutput`
// (the full runner output, which still carries the authoritative Tests summary line);
// `extracted` is the already-trimmed failure text that gets returned/appended. Callers that
// only have one string can omit `rawOutput` — it defaults to `extracted`. Pass `runner`
// (env.testRunner) so the message names the ACTUAL runner instead of hardcoding "Vitest" —
// naming the wrong runner sends the model chasing vitest-specific fixes in a jest project.
export function enrichNoTestsError(extracted, rawOutput = extracted, runner) {
    if (!isZeroTestsOutput(rawOutput))
        return extracted;
    return (`ERROR: ${runnerDisplayName(runner)} found 0 tests in this file. The file ran but had nothing to execute.\n\n` +
        'This means one of:\n' +
        '  1. You wrote only imports, types, or describe() blocks with no it()/test() inside\n' +
        '  2. A module import failed during collection — check the output below for an error\n' +
        '  3. Tests are inside a plain function that is never called\n' +
        '  4. The runner matched 0 files for this path (look for a "0 matches" / "No tests found" line\n' +
        '     below — this is a runner invocation issue, NOT something to fix by rewriting the tests)\n\n' +
        'REQUIRED: Every test file must have at least one test like this:\n' +
        '  it(\'description\', () => {\n' +
        '    expect(result).toBe(expected)\n' +
        '  })\n\n' +
        'DO NOT wrap tests inside a function. Put them directly inside describe() or at the top level.\n\n' +
        'Original runner output:\n' +
        extracted);
}
// Strips ANSI SGR (color/style) escape codes. The runner colorizes its output when a TTY is
// present OR when FORCE_COLOR is set in the environment lacuna spawns it from — and a colored
// summary line looks like "\x1B[2m      Tests \x1B[22m \x1B[1m\x1B[32m15 passed\x1B[39m (15)".
// The leading escape defeats a `^\s*Tests` anchor, so the count parsers below MUST strip first
// (extractTestFailure already does this for display, which is why the shown summary looked clean
// while the parsed count silently fell back to the "Test Files  1 passed" line).
const ANSI_SGR_RE = /\x1B\[[0-9;]*m/g;
function stripAnsi(s) {
    return s.replace(ANSI_SGR_RE, '');
}
// Extracts the number of passing tests from the runner summary footer.
// Targets the "Tests  N failed | M passed (total)" line specifically to avoid
// false matches from file-level headers like "(1 passed)" or test descriptions.
export function parsePassCount(output) {
    const clean = stripAnsi(output);
    // Prefer the Tests summary line: "Tests  1 failed | 15 passed (16)" or "Tests  15 passed (15)"
    const summaryLine = clean.match(/^\s*Tests\b[^\n]*?(\d+)\s+passed/m);
    if (summaryLine)
        return parseInt(summaryLine[1], 10);
    // Fallback: first "N passed" — but NEVER the file-count line ("Test Files  1 passed"), which
    // would misreport a 15-passing run as 1 and trigger a phantom regression.
    for (const line of clean.split('\n')) {
        if (/Test\s+Files/i.test(line))
            continue;
        const m = line.match(/(\d+)\s+passed/);
        if (m)
            return parseInt(m[1], 10);
    }
    return 0;
}
// Extracts the number of failing tests from the runner summary footer.
// Anchored to the "Tests  N failed | M passed" line specifically — the word "failed"
// appears in too many noise lines (per-test FAIL markers, stack frames) to match loosely.
// Used alongside parsePassCount to prove tests were actually collected.
export function parseFailCount(output) {
    const summaryLine = stripAnsi(output).match(/^\s*Tests\b[^\n]*?(\d+)\s+failed/m);
    return summaryLine ? parseInt(summaryLine[1], 10) : 0;
}
// Once a file has enough failing tests, asking the model to "fix the file" means regenerating a
// large amount of mocking code in one shot — observed on a real 1,073-line file (33/49 failing):
// three DIFFERENT mistakes surfaced across three DIFFERENT full-rewrite attempts, the signature
// of getting a different fraction wrong each time rather than a stuck loop repeating one error.
// Narrowing the ask to a named, shrinking checklist of specific still-failing tests — explicitly
// stating everything else already passes and must not be touched — is a task size a model
// handles far more reliably. Both supported runners print exactly this, just in different shapes:
// jest's failure-summary lists each failing test's full `Describe › Describe › test name` path on
// a `●`-prefixed line (the same marker FAILURE_MARKERS above already anchors on); vitest's
// "Failed Tests" recap lists ` FAIL  <file> > Describe > test name` per failing test. Both are
// framing changes on data already captured, not new instrumentation — confirmed against a real
// vitest failure captured from examples/regen-demo (temporarily broken, then reverted) alongside
// a real jest capture from a production project's debug logs.
const LARGE_FAILURE_THRESHOLD = 6;
export function buildFailingTestChecklist(rawRunOutput) {
    const clean = stripAnsi(rawRunOutput);
    let names = [...new Set([...clean.matchAll(/^\s*●\s+(.+)$/gm)]
            .map(m => m[1].trim())
            .filter(name => name && name !== 'Test suite failed to run'))];
    if (names.length === 0) {
        // vitest's "Failed Tests" recap section — " FAIL  <file path> > Describe > test name".
        // Requires the " > " continuation after the file path, so a bare file-level "FAIL <file>"
        // line (no test path — the whole suite failed to run) is correctly NOT matched here.
        names = [...new Set([...clean.matchAll(/^\s*FAIL\s+\S+\s*>\s*(.+)$/gm)]
                .map(m => m[1].trim())
                .filter(Boolean))];
    }
    // Self-gating and purely current-attempt-driven: a handful of failures is already easy to
    // track from the raw error text, so this stays out of the way for ordinary files, and
    // naturally stops firing once a later attempt shrinks the failing count back down — a good
    // sign, not a gap to patch around.
    if (names.length <= LARGE_FAILURE_THRESHOLD)
        return null;
    return (`\n\n⚠ ${names.length} TESTS ARE STILL FAILING IN THIS FILE — fix ONLY these, one at a time if needed. Every other test in the file is passing; do NOT modify, rename, or restructure any test not listed here:\n` +
        names.map(n => `  - ${n}`).join('\n'));
}
// Test runners print PASSING tests first and the actual failures + summary LAST. Naively
// slicing the HEAD of a long, mostly-passing run (slice(0, N)) therefore shows the model only
// ✓ passes and hides every failure — so it concludes "the tests pass, the output is just
// truncated" and stops fixing (or starts DELETING tests to force green). Keep the region that
// actually carries the failure: from the earliest failure/summary marker to the end, and if
// that still overflows the budget keep its TAIL (the summary and last-printed failures live
// there). Falls back to the tail of the whole output when no marker is found.
const FAILURE_MARKERS = [
    /^[ \t]*(?:FAIL|×|✗|❯|❌)[ \t]/m, // per-file / per-test failure lines (vitest/jest)
    /⎯{3,}/, // vitest "Failed Tests" separator banner
    /^\s*●/m, // jest failure bullet
    /^\s*(?:Failed Tests|Test Files)\b/m, // vitest end-of-run summary block
    /\b\d+\s+failed\b/, // "N failed" (summary or inline)
];
export function extractFailureRegion(output, maxChars = 4500) {
    const clean = stripAnsi(output);
    if (clean.length <= maxChars)
        return clean;
    let start = -1;
    for (const re of FAILURE_MARKERS) {
        const m = re.exec(clean);
        if (m && (start === -1 || m.index < start))
            start = m.index;
    }
    const region = start >= 0 ? clean.slice(start) : clean;
    return region.length > maxChars
        ? '…(earlier passing output trimmed)…\n' + region.slice(region.length - maxChars)
        : region;
}
// Strips leading prose/thinking lines from generated code output.
// When a model bleeds reasoning into <code_output>, the file starts with fragments
// like ", nothing else." or "I'll write the test now." before the real code begins.
// Scans forward to the first valid TypeScript/code line and strips everything before it.
// Returns the cleaned code and whether anything was stripped.
export function stripLeadingProse(code) {
    // Valid first lines for TypeScript/JS, Python, and Go — all languages lacuna supports.
    const VALID_START = /^\s*(import\b|export\b|const\b|let\b|var\b|function\b|class\b|describe\s*\(|it\s*\(|test\s*[(\s]|vi\.|jest\.|before(?:Each|All)\b|after(?:Each|All)\b|\/\/|\/\*|\*\s|type\s+\w|interface\s+\w|enum\s+\w|def\s+\w|async\s+def\s+\w|@\w|pytest\b|package\s+\w|func\s+\w|#)/;
    const lines = code.split('\n');
    const firstCode = lines.findIndex(l => VALID_START.test(l));
    if (firstCode <= 0)
        return { code, stripped: null }; // starts correctly or no code found
    const leakedText = lines.slice(0, firstCode).join('\n').trim().slice(0, 120);
    return { code: lines.slice(firstCode).join('\n'), stripped: leakedText };
}
// Merges new mocks content with an existing mocks file without duplicating.
// Three cases:
//   1. Existing is empty → use incoming as-is
//   2. Incoming contains all existing exports (complete replacement) → use incoming
//   3. Incoming is partial → extract ONLY the new exports and append them
export function mergeMocksContent(existing, incoming) {
    const existingNames = new Set(extractExportNames(existing));
    if (existingNames.size === 0)
        return incoming;
    const incomingNames = extractExportNames(incoming);
    // Case 2: incoming is a superset — safe to replace entirely
    if (incomingNames.length > 0 && [...existingNames].every(n => incomingNames.includes(n))) {
        return incoming;
    }
    // Case 3: incoming is partial — extract only truly new export declarations
    const newNames = new Set(incomingNames.filter(n => !existingNames.has(n)));
    if (newNames.size === 0)
        return existing; // nothing new, keep existing unchanged
    // Walk lines and capture blocks that belong to new exports.
    // Capturing starts on `export const/function/class X` where X is new,
    // and continues until the next export declaration (handles multi-line exports).
    const lines = incoming.split('\n');
    const toAppend = [];
    let capturing = false;
    for (const line of lines) {
        const exportMatch = line.match(/^\s*export\s+(?:const|let|var|function|async\s+function|class)\s+(\w+)/);
        if (exportMatch) {
            capturing = newNames.has(exportMatch[1]);
        }
        else if (/^\s*import\b/.test(line)) {
            // Include import statements that are not already in the existing file
            if (!existing.includes(line.trim()))
                toAppend.push(line);
            capturing = false;
            continue;
        }
        if (capturing)
            toAppend.push(line);
    }
    const appended = toAppend.join('\n').trim();
    return appended ? existing.trimEnd() + '\n\n' + appended : existing;
}
// Collapses duplicate top-level `export const/function/class NAME` declarations in a mocks file
// down to a single (the LAST) occurrence. mergeMocksContent is called on every retry that touches
// the shared mocks file, and a model response that re-emits an export the file already has —
// rather than a true partial diff — can slip through the superset-replace branch (case 2), or
// accumulate across retries via the append branch (case 3), leaving the same name declared 2-3
// times in one file: a hard "Cannot redeclare block-scoped variable" compile error that cascades
// into every test file importing the mock (observed across multiple fix-cache debug logs:
// mockCreateProcessorsRepo, mockCreateWalletsRepo, mockFlutterwaveClient each declared 2-3x).
// Runs as part of the same write-time cleanup pipeline as dedupeImports/dedupeTestBlocks, just
// for the mocks file instead of the test file.
export function dedupeMockExports(code) {
    const lines = code.split('\n');
    const exportRe = /^export\s+(?:const|let|var|function|async\s+function|class)\s+(\w+)/;
    const starts = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(exportRe);
        if (m)
            starts.push({ name: m[1], start: i });
    }
    if (starts.length <= 1)
        return code;
    // Each block runs from its own `export` line to the line before the NEXT export declaration
    // (or EOF) — the same "capture until next export" boundary mergeMocksContent already uses.
    const blocks = starts.map((s, idx) => ({
        name: s.name,
        start: s.start,
        end: idx + 1 < starts.length ? starts[idx + 1].start : lines.length,
    }));
    const lastIndexByName = new Map();
    blocks.forEach((b, idx) => lastIndexByName.set(b.name, idx));
    if (lastIndexByName.size === blocks.length)
        return code; // no duplicate names — nothing to do
    const keptLines = [];
    let cursor = 0;
    blocks.forEach((b, idx) => {
        // Non-export lines between the previous block and this one (blank lines, comments, plain
        // imports) are always preserved regardless of which duplicate wins.
        if (b.start > cursor)
            keptLines.push(...lines.slice(cursor, b.start));
        if (lastIndexByName.get(b.name) === idx)
            keptLines.push(...lines.slice(b.start, b.end));
        cursor = b.end;
    });
    if (cursor < lines.length)
        keptLines.push(...lines.slice(cursor));
    return keptLines.join('\n');
}
export function extractExportNames(code) {
    const names = [];
    for (const m of code.matchAll(/^export\s+(?:const|let|var|function|class|async\s+function)\s+(\w+)/gm))
        names.push(m[1]);
    for (const m of code.matchAll(/^export\s*\{([^}]+)\}/gm)) {
        for (const part of m[1].split(',')) {
            const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
            if (alias && /^\w+$/.test(alias))
                names.push(alias);
        }
    }
    return [...new Set(names)];
}
// Returns true when content is clearly prose/thinking rather than TypeScript.
// Conservative by design: any real code line (export, const, vi., import) means
// it's not prose, even if comments look sentence-like.
function isProseContent(content) {
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0)
        return false;
    // If ANY line looks like real TypeScript/JS code, it's not prose.
    // This prevents false positives on mock files with sentence-like comments.
    const hasCode = lines.some(l => /^\s*(import\s|export\s+(const|let|function|class|default|type|interface)\s)/.test(l) ||
        /^\s*(const|let|var)\s+\w/.test(l) ||
        /^\s*vi\.|^\s*jest\./.test(l) ||
        /^\s*(beforeEach|afterEach|beforeAll|afterAll)\s*\(/.test(l));
    if (hasCode)
        return false;
    // No code found — check for thinking/reasoning patterns that confirm it's prose
    const thinkingPatterns = /\bI think\b|\bLet me\b|\bActually,?\s|\bBut wait\b|\bHmm,?\b/m.test(content);
    const bulletLines = lines.filter(l => /^[-*]\s/.test(l)).length;
    return thinkingPatterns || bulletLines > 5;
}
// A malformed or truncated model response (hit a token limit mid-function, or emitted a stray
// fragment) can otherwise be merged straight into the SHARED mocks file with no check at all —
// unlike test-file content (see hasTestFunctions below), nothing validated the mocks file was
// even syntactically complete before this existed. Live-observed on kabocash-mobile-RN-expo: a
// truncated `---MOCKS_FILE---` response left `renderWithProviders` as `(ui) => {` with no closing
// brace, silently corrupting the ONE file every test in the project imports — cascading to 80+ of
// 87 files in a single run, each independently (and wastefully) re-attempting to fix the same
// shared file from its own per-file retry loop instead of the actual corruption ever being caught
// at the source. String/comment-aware brace/paren/bracket balance scan, same walk as findCallEnd.
export function detectUnbalancedMocksSyntax(code) {
    let paren = 0, brace = 0, bracket = 0;
    let i = 0;
    while (i < code.length) {
        const ch = code[i];
        if (ch === '/' && code[i + 1] === '/') {
            i += 2;
            while (i < code.length && code[i] !== '\n')
                i++;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            i += 2;
            while (i < code.length && !(code[i] === '*' && code[i + 1] === '/'))
                i++;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const q = ch;
            i++;
            while (i < code.length) {
                if (code[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (code[i] === q) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (ch === '`') {
            i++;
            while (i < code.length) {
                if (code[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (code[i] === '`') {
                    i++;
                    break;
                }
                if (code[i] === '$' && code[i + 1] === '{') {
                    i += 2;
                    let tDepth = 1;
                    while (i < code.length && tDepth > 0) {
                        if (code[i] === '{')
                            tDepth++;
                        else if (code[i] === '}')
                            tDepth--;
                        i++;
                    }
                    continue;
                }
                i++;
            }
            continue;
        }
        if (ch === '{')
            brace++;
        else if (ch === '}') {
            brace--;
            if (brace < 0)
                return true;
        }
        else if (ch === '(')
            paren++;
        else if (ch === ')') {
            paren--;
            if (paren < 0)
                return true;
        }
        else if (ch === '[')
            bracket++;
        else if (ch === ']') {
            bracket--;
            if (bracket < 0)
                return true;
        }
        i++;
    }
    return paren !== 0 || brace !== 0 || bracket !== 0;
}
// Removes content that does not belong in a shared mock file.
// Strips: test blocks (describe/it/test/expect), framework config
// (defineConfig exports, vitest/jest config objects), whole-file prose,
// and trailing prose that appears after valid mock definitions.
export function sanitizeMocksContent(raw) {
    // Prose/thinking detection — reject wholesale if content is not code
    if (isProseContent(raw))
        return { code: '', stripped: true };
    // Reject if content looks like a framework config file
    const CONFIG_FILE_RE = /defineConfig\s*\(|module\.exports\s*=\s*\{[^}]*(?:test|resolve|plugins)\s*:/s;
    if (CONFIG_FILE_RE.test(raw))
        return { code: '', stripped: true };
    const TEST_START = /^\s*(describe|it|test)\s*[.(]|^\s*expect\s*\(/;
    const CONFIG_START = /^\s*export\s+default\s+(defineConfig\s*\(|\{)|^\s*module\.exports\s*=/;
    const lines = raw.split('\n');
    const kept = [];
    let depth = 0;
    let inBlock = false;
    let stripped = false;
    for (const line of lines) {
        if (!inBlock && (TEST_START.test(line) || CONFIG_START.test(line))) {
            inBlock = true;
            stripped = true;
        }
        if (inBlock) {
            for (const ch of line) {
                if (ch === '{' || ch === '(')
                    depth++;
                else if (ch === '}' || ch === ')') {
                    depth--;
                    if (depth < 0)
                        depth = 0;
                }
            }
            if (depth === 0)
                inBlock = false;
            continue;
        }
        kept.push(line);
    }
    // Truncate trailing prose that appears after valid mock definitions.
    // Pattern: valid exports → orphaned quote/bracket → bullet-point thinking.
    const CODE_LINE = /^\s*(export\b|import\b|const\b|let\b|var\b|vi\.|jest\.|before(?:Each|All)|after(?:Each|All)|\/\/|\/\*)/;
    const PROSE_LINE = /^\s*["'`]\s*$|^\s*[-*]\s+[A-Za-z]|^\s{1,8}-\s+[A-Z]/;
    let foundCode = false;
    let truncateAt = -1;
    for (let i = 0; i < kept.length; i++) {
        if (CODE_LINE.test(kept[i])) {
            foundCode = true;
            truncateAt = -1;
        }
        else if (foundCode && PROSE_LINE.test(kept[i]) && truncateAt === -1) {
            truncateAt = i;
        }
    }
    if (truncateAt !== -1) {
        kept.splice(truncateAt);
        stripped = true;
    }
    const result = kept.join('\n').trim();
    // Reject content that is only comments/whitespace — no real code to add to the mock file.
    const hasRealCode = result.split('\n').some(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('/*') && !l.trim().startsWith('*'));
    if (!hasRealCode)
        return { code: '', stripped: true };
    return { code: result, stripped };
}
// Vitest/Jest partial mocks call `importOriginal()` to pull the real module, then spread it:
// `const actual = await importOriginal(); return { ...actual, ... }`. Untyped, importOriginal
// returns `unknown`, so `{ ...actual }` fails type-checking with TS2698 "Spread types may only
// be created from object types". The fix is mechanical: give the call the module's type via a
// generic — `importOriginal<typeof import('<the vi.mock path>')>()`. We infer the module path
// from the enclosing `vi.mock('PATH', ...)` (the nearest preceding mock call). Adding the
// generic is always safe (it only supplies a type), so we apply it to every untyped call.
export function typeImportOriginalCalls(code) {
    if (!code.includes('importOriginal'))
        return code;
    // Match a call site `importOriginal(` — capturing an optional `<` that means it's already
    // typed (skip those). The bare param declaration `(importOriginal) =>` has no following `(`,
    // so it never matches.
    const callRe = /\bimportOriginal\s*(<)?\s*\(/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = callRe.exec(code)) !== null) {
        if (m[1])
            continue; // already has a type argument
        const before = code.slice(0, m.index);
        const mockMatch = [...before.matchAll(/\b(?:vi|jest)\.mock\(\s*['"`]([^'"`]+)['"`]/g)].pop();
        if (!mockMatch)
            continue; // can't resolve the module path — leave it for the model
        const insertAt = m.index + 'importOriginal'.length;
        out += code.slice(last, insertAt) + `<typeof import('${mockMatch[1]}')>`;
        last = insertAt;
    }
    return out + code.slice(last);
}
// The bare `Function` type trips @typescript-eslint/no-unsafe-function-type. That rule is NOT
// auto-fixable (eslint can't infer the intended signature) and it's an ESLint error, not a tsc
// error — so it survives BOTH the type-check retry loop and formatFile's `eslint --fix`, and ends
// up in the accepted file. This replaces `Function`, in TYPE positions only, with the parenthesized
// general callable `((...args: unknown[]) => unknown)` — the parens keep the arrow-type valid in
// EVERY type position (annotation, union, array, cast, generic arg). Value uses of the global
// (`instanceof Function`, `toBeInstanceOf(Function)`, `new Function`, `Function.prototype`,
// `typeof Function`) are left untouched. Deterministic and behavior-preserving (types erase at
// runtime). CONSERVATIVE: on any ambiguity it SKIPS — a leftover lint warning is better than a
// broken file. Scans string/comment-masked code so a `Function` inside text can't match.
export function replaceUnsafeFunctionType(code) {
    if (!/\bFunction\b/.test(code))
        return code;
    const masked = blankStringsAndComments(code);
    const CALLABLE = '((...args: unknown[]) => unknown)';
    const re = /\bFunction\b/g;
    let out = '';
    let last = 0;
    for (let m = re.exec(masked); m; m = re.exec(masked)) {
        const start = m.index;
        const end = start + 'Function'.length;
        const before = masked.slice(Math.max(0, start - 32), start);
        const after = masked.slice(end);
        const prevCh = (before.match(/(\S)\s*$/) || ['', ''])[1];
        const nextCh = (after.match(/^\s*(\S)/) || ['', ''])[1];
        const prevWord = (before.match(/([A-Za-z0-9_$]+)\s*$/) || ['', ''])[1];
        // Value positions — never a type, always skip.
        if (prevCh === '.' || nextCh === '.' || nextCh === '(')
            continue;
        if (prevWord === 'new' || prevWord === 'instanceof' || prevWord === 'typeof')
            continue;
        // Strong type-position signals (default is skip on anything else).
        const isCast = /\bas\s*$/.test(before);
        // Param/property/return annotation: `name: Function`, `name?: Function`, `): Function`.
        const isAnnotation = /[({;,]\s*[A-Za-z0-9_$]+\??\s*:\s*$/.test(before) ||
            /\b(?:let|const|var|readonly|public|private|protected)\s+[A-Za-z0-9_$]+\??\s*:\s*$/.test(before) ||
            /^\s*(?:readonly\s+)?[A-Za-z0-9_$]+\??\s*:\s*$/.test(before) ||
            /\)\s*:\s*$/.test(before);
        const isUnion = prevCh === '|' || prevCh === '&' || nextCh === '|' || nextCh === '&';
        const isArray = /^\s*\[\]/.test(after);
        // Generic argument: `Record<string, Function>`, `Map<Function, X>`.
        const isGeneric = (prevCh === '<' || prevCh === ',') && (nextCh === '>' || nextCh === ',');
        if (isCast || isAnnotation || isUnion || isArray || isGeneric) {
            out += code.slice(last, start) + CALLABLE;
            last = end;
        }
    }
    return out + code.slice(last);
}
// Collapses duplicate named imports from the SAME module into one statement, and de-dupes
// repeated specifiers within a single import. The model sometimes emits two
// `import { A } from '../index'` + `import { A, b } from '../index'` lines — not a TS error
// (no duplicate identifier), so the type-check loop never catches it, but ESLint's
// no-duplicate-imports flags it and it just reads badly. Deliberately CONSERVATIVE: only
// single-line, purely-named imports (`import { … } from 'x'`) are touched. Default, namespace
// (`* as`), side-effect, `import type`, and multi-line imports are left exactly as-is so we
// never corrupt a valid file. Specifier tokens (incl. `a as b`, inline `type X`) are preserved
// verbatim and de-duped by exact text.
export function dedupeImports(code) {
    const lines = code.split('\n');
    const NAMED_RE = /^(\s*)import\s+\{([^{}]*)\}\s+from\s+(['"])([^'"]+)\3(\s*;?\s*)$/;
    const firstLineFor = new Map(); // module → line index of the kept import
    const namesFor = new Map(); // module → ordered, de-duped specifiers
    const drop = new Set();
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(NAMED_RE);
        if (!m)
            continue;
        const mod = m[4];
        const names = m[2].split(',').map((s) => s.trim()).filter(Boolean);
        if (!firstLineFor.has(mod)) {
            firstLineFor.set(mod, i);
            namesFor.set(mod, []);
        }
        else {
            drop.add(i); // fold this duplicate into the first import for the module
            changed = true;
        }
        const acc = namesFor.get(mod);
        for (const n of names) {
            if (!acc.includes(n))
                acc.push(n);
            else
                changed = true; // repeated specifier (within-line or across lines)
        }
    }
    if (!changed)
        return code;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (drop.has(i))
            continue;
        const m = lines[i].match(NAMED_RE);
        if (m && firstLineFor.get(m[4]) === i) {
            const [, indent, , quote, mod, tail] = m;
            out.push(`${indent}import { ${namesFor.get(mod).join(', ')} } from ${quote}${mod}${quote}${tail.includes(';') ? ';' : ''}`);
        }
        else {
            out.push(lines[i]);
        }
    }
    return out.join('\n');
}
// Top-level keys of the object literal whose opening `{` is at `objOpen`. String/comment/template
// aware; returns identifiers used as keys at depth 1 (`useApp:`, `'useApp':`), skipping nested
// object keys (`WalletService: { getBanks: … }` yields `WalletService`, not `getBanks`).
function objectLiteralTopKeys(code, objOpen) {
    const end = scanToMatchingBrace(code, objOpen);
    if (end < 0)
        return [];
    const keys = [];
    let depth = 0;
    let atPropStart = false;
    for (let i = objOpen; i <= end; i++) {
        const ch = code[i];
        if (ch === '/' && code[i + 1] === '/') {
            i += 2;
            while (i <= end && code[i] !== '\n')
                i++;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            i += 2;
            while (i <= end && !(code[i] === '*' && code[i + 1] === '/'))
                i++;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            const q = ch;
            i++;
            while (i <= end) {
                if (code[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (code[i] === q)
                    break;
                i++;
            }
            continue;
        }
        if (ch === '{') {
            depth++;
            if (depth === 1)
                atPropStart = true;
            continue;
        }
        if (ch === '}') {
            depth--;
            continue;
        }
        if (ch === '(' || ch === '[') {
            depth++;
            continue;
        }
        if (ch === ')' || ch === ']') {
            depth--;
            continue;
        }
        if (depth === 1 && ch === ',') {
            atPropStart = true;
            continue;
        }
        if (depth === 1 && atPropStart) {
            const m = code.slice(i, end + 1).match(/^\s*(?:([A-Za-z_$][\w$]*)|['"]([A-Za-z_$][\w$]*)['"])\s*:/);
            if (m) {
                keys.push(m[1] ?? m[2]);
                atPropStart = false;
            }
            else if (!/\s/.test(ch))
                atPropStart = false; // spread / shorthand / method — not a plain key
        }
    }
    return [...new Set(keys)];
}
// Blank out string/template/comment CONTENT (preserving length & newlines) so a name appearing
// only inside a literal — `getByText('Wallet')` — isn't counted as an identifier use.
function blankStringsAndComments(code) {
    let out = '';
    let i = 0;
    while (i < code.length) {
        const ch = code[i];
        if (ch === '/' && code[i + 1] === '/') {
            while (i < code.length && code[i] !== '\n') {
                out += ' ';
                i++;
            }
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            out += '  ';
            i += 2;
            while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
                out += code[i] === '\n' ? '\n' : ' ';
                i++;
            }
            out += '  ';
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            const q = ch;
            out += ' ';
            i++;
            while (i < code.length) {
                if (code[i] === '\\') {
                    out += '  ';
                    i += 2;
                    continue;
                }
                if (code[i] === q) {
                    out += ' ';
                    i++;
                    break;
                }
                out += code[i] === '\n' ? '\n' : ' ';
                i++;
            }
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}
// When a test mocks a module with a factory — `jest.mock('@/context/AppContext', () => ({ useApp:
// jest.fn() }))` — and then references an export by BARE name to configure it — `(useApp as
// jest.Mock).mockReturnValue(...)` — that name MUST be imported from the module. jest/vitest hoist
// the mock, so `import { useApp } from '@/context/AppContext'` binds to the mock fn. Models
// sometimes emit the mock but forget the import, so `useApp` is undefined and EVERY test throws
// `ReferenceError: useApp is not defined`. This scans factory mocks and injects the missing import
// for any exported name that's used outside the factory and isn't already imported or locally
// declared. Deterministic and safe — it only ever ADDS a binding the mock already guarantees.
export function ensureMockedImports(code) {
    const mockCallRe = /\b(?:jest|vi)\.mock\s*\(\s*(['"])([^'"]+)\1\s*,\s*(?:async\s*)?\([^)]*\)\s*=>/g;
    const mocks = [];
    for (let m = mockCallRe.exec(code); m; m = mockCallRe.exec(code)) {
        // Locate the factory's returned object `{`: either `=> ({ … })` or `=> { return { … } }`.
        let k = mockCallRe.lastIndex;
        while (k < code.length && /\s/.test(code[k]))
            k++;
        let objOpen = -1;
        if (code[k] === '(') {
            k++;
            while (k < code.length && /\s/.test(code[k]))
                k++;
            if (code[k] === '{')
                objOpen = k;
        }
        else if (code[k] === '{') {
            const r = code.indexOf('return', k);
            if (r >= 0) {
                let j = r + 6;
                while (j < code.length && /\s/.test(code[j]))
                    j++;
                if (code[j] === '{')
                    objOpen = j;
            }
        }
        if (objOpen < 0)
            continue;
        const objEnd = scanToMatchingBrace(code, objOpen);
        if (objEnd < 0)
            continue;
        mocks.push({ path: m[2], names: objectLiteralTopKeys(code, objOpen), objOpen, objEnd });
    }
    if (mocks.length === 0)
        return code;
    // Mask factory object bodies so their keys aren't mistaken for "uses", and blank string/comment
    // content so a name that only appears as asserted TEXT (`getByText('Wallet')`) isn't either.
    let masked = code;
    for (const mk of mocks)
        masked = masked.slice(0, mk.objOpen) + ' '.repeat(mk.objEnd - mk.objOpen + 1) + masked.slice(mk.objEnd + 1);
    masked = blankStringsAndComments(masked);
    const lines = code.split('\n');
    const bound = new Set(); // names already imported (so a duplicate import isn't added)
    for (const stmt of iterImportStatements(lines)) {
        const p = parseImportStatement(stmt.text);
        if (p) {
            for (const n of p.names)
                bound.add(n);
            if (p.def)
                bound.add(p.def);
        }
    }
    const need = new Map();
    for (const mk of mocks) {
        for (const name of mk.names) {
            // `default` and `__esModule` are factory-interop keys (`{ __esModule: true, default: fn }`
            // marks a mocked module's default export), never real named exports a consumer imports
            // directly. `default` in particular is a reserved word — `import { default } from '...'`
            // is invalid syntax under ANY circumstances (only `import { default as X }` or a plain
            // `import X from '...'` are valid), so this function must never propose it as a bare named
            // import regardless of how the "used outside factory" heuristic below reads the code.
            // Confirmed live: this was the actual root cause of a bug that looked like a MODEL mistake
            // across every provider tried (local and cloud) — the model's own responses were correct
            // (either omitting the import or writing `import PhoneAdapter from '...'`), but this
            // function then injected `import { default }` / appended `, { default }` afterward because
            // it saw `default` as a "name used outside the factory" (see the next skip's comment).
            if (name === 'default' || name === '__esModule')
                continue;
            if (bound.has(name))
                continue;
            if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(masked))
                continue; // locally declared
            // "Used outside the factory" must mean used as a FREE IDENTIFIER, not as `.name` property
            // access (e.g. `jest.requireMock(...).default`) — a bare \b${name}\b match doesn't
            // distinguish the two, since a word boundary exists on both sides of "default" whether or
            // not it's preceded by a dot. A negative lookbehind excludes the property-access form.
            if (!new RegExp(`(?<!\\.)\\b${name}\\b`).test(masked))
                continue; // never used outside factory
            const s = need.get(mk.path) ?? new Set();
            s.add(name);
            need.set(mk.path, s);
        }
    }
    if (need.size === 0)
        return code;
    let outLines = code.split('\n');
    for (const [path, namesSet] of need) {
        const stmt = `import { ${[...namesSet].join(', ')} } from '${path}';`;
        if (!mergeNamedImportIntoExisting(outLines, stmt)) {
            const at = lastImportStatementEndIdx(outLines);
            outLines.splice(at + 1, 0, stmt);
        }
    }
    return outLines.join('\n');
}
// A bare `jest.fn()`/`vi.fn()` (no generic) types as Mock<UnknownFunction>, whose return type is
// `unknown` — NOT `Promise<unknown>`. jest-mock's `.mockResolvedValue()`/`.mockRejectedValue()`
// overloads are conditional on the mock's return type extending Promise, so against a bare
// UnknownFunction mock they collapse their parameter to `never` and reject every value, no matter
// what's passed. The fix is mechanical (give the mock an explicit Promise-returning type) and
// models reliably fail to apply it even when told the exact pattern to use, re-emitting the same
// broken `jest.fn().mockResolvedValue(x)` verbatim across retries — so do it deterministically
// instead of relying on the model. Two shapes seen in practice:
//   jest.fn().mockResolvedValue(x)              -> (jest.fn() as unknown as jest.Mock<() => Promise<any>>).mockResolvedValue(x)
//   (thing as jest.Mock).mockResolvedValue(x)    -> (thing as unknown as jest.Mock<() => Promise<any>>).mockResolvedValue(x)
// A single-generic, full-function-type `jest.Mock<() => Promise<any>>` ONLY resolves this way
// under `@jest/globals`'s modern type (`Mock<T extends FunctionLike = UnknownFunction>`). Without
// `import { jest } from '@jest/globals'` in scope, the ambient (ships-with-@types/jest) `Mock` is
// the legacy 3-generic form (`Mock<T = any, Y extends any[] = any, C = any>`) where the first slot
// means RETURN TYPE, not a full function signature — so `Mock<() => Promise<any>>` silently binds
// `T` to a function type instead, and `.mockResolvedValue()`'s conditional overload (needs T to
// extend Promise) collapses to `never` again, the exact failure this function exists to fix.
// Confirmed by direct testing: this happens identically whether the annotation is written as a
// cast (`as unknown as jest.Mock<T>`), a call generic (`jest.fn<T>()`, which additionally hits a
// TS2743 arity error under the legacy ambient overloads), or a variable annotation — there is no
// generic-position trick that avoids it. So whenever this function performs a jest rewrite, it
// also ensures the file imports `{ jest }` from '@jest/globals' (merging into an existing import
// from that module if present) — vitest is left alone since `vi.fn<T>()`'s arity hasn't been
// observed to have the same fragility and vitest's `Mock<T>` is a different (args, return) shape
// that isn't safe to guess a fix for here. Already-generic forms (`jest.fn<...>()`,
// `as jest.Mock<...>`) don't match and are left alone.
export function fixNeverTypedAsyncMocks(code) {
    if (!/\.mock(?:Resolved|Rejected)Value\(/.test(code))
        return code;
    const masked = blankStringsAndComments(code);
    const chainRe = /\b(?:jest|vi)\.fn\(\)(?=\s*\.mock(?:Resolved|Rejected)Value\()/g;
    const castRe = /\([^()]+?\s+as\s+jest\.Mock\)(?=\s*\.mock(?:Resolved|Rejected)Value\()/g;
    const matches = [];
    let touchedJest = false;
    for (let m = chainRe.exec(masked); m; m = chainRe.exec(masked)) {
        const ns = masked.slice(m.index, m.index + m[0].indexOf('.'));
        if (ns === 'jest')
            touchedJest = true;
        matches.push({
            start: m.index,
            end: m.index + m[0].length,
            replacement: ns === 'jest'
                ? `(jest.fn() as unknown as jest.Mock<() => Promise<any>>)`
                : `vi.fn<() => Promise<any>>()`,
        });
    }
    for (let m = castRe.exec(masked); m; m = castRe.exec(masked)) {
        touchedJest = true;
        const inner = code.slice(m.index + 1, m.index + m[0].length - 1).replace(/\s+as\s+jest\.Mock\s*$/, '');
        matches.push({ start: m.index, end: m.index + m[0].length, replacement: `(${inner} as unknown as jest.Mock<() => Promise<any>>)` });
    }
    if (matches.length === 0)
        return code;
    matches.sort((a, b) => a.start - b.start);
    let out = '';
    let last = 0;
    for (const m of matches) {
        if (m.start < last)
            continue; // overlapping match, skip
        out += code.slice(last, m.start) + m.replacement;
        last = m.end;
    }
    out += code.slice(last);
    if (touchedJest) {
        const outLines = out.split('\n');
        const alreadyImported = [...iterImportStatements(outLines)].some(stmt => {
            const p = parseImportStatement(stmt.text);
            return p && moduleKey(p.module) === moduleKey('@jest/globals') && p.names.includes('jest');
        });
        if (!alreadyImported) {
            const stmt = `import { jest } from '@jest/globals';`;
            if (!mergeNamedImportIntoExisting(outLines, stmt)) {
                const at = lastImportStatementEndIdx(outLines);
                outLines.splice(at + 1, 0, stmt);
            }
            out = outLines.join('\n');
        }
    }
    return out;
}
// Merges duplicate vi.mock() calls for the same module path into one.
// The model sometimes emits two vi.mock('lucide-react', ...) blocks when a component
// imports many icons — the second overrides the first, silently dropping exports.
// Only merges simple `() => ({...})` factories; complex factories (async imports,
// function-body returns) are left untouched.
export function deduplicateViMocks(code) {
    const blocks = [];
    let pos = 0;
    while (pos < code.length) {
        // Match either vi.mock( or jest.mock(
        const viIdx = code.indexOf('vi.mock(', pos);
        const jestIdx = code.indexOf('jest.mock(', pos);
        let idx;
        let prefixLen;
        if (viIdx === -1 && jestIdx === -1)
            break;
        if (viIdx === -1) {
            idx = jestIdx;
            prefixLen = 10;
        }
        else if (jestIdx === -1) {
            idx = viIdx;
            prefixLen = 8;
        }
        else if (viIdx < jestIdx) {
            idx = viIdx;
            prefixLen = 8;
        }
        else {
            idx = jestIdx;
            prefixLen = 10;
        }
        const afterOpen = idx + prefixLen;
        const q = code[afterOpen];
        if (q !== "'" && q !== '"' && q !== '`') {
            pos = idx + 1;
            continue;
        }
        const nameEnd = code.indexOf(q, afterOpen + 1);
        if (nameEnd === -1) {
            pos = idx + 1;
            continue;
        }
        const moduleName = code.slice(afterOpen + 1, nameEnd);
        // Find the full call extent via paren depth
        let depth = 0;
        let callEnd = -1;
        for (let i = idx + prefixLen - 1; i < code.length; i++) {
            if (code[i] === '(')
                depth++;
            else if (code[i] === ')') {
                depth--;
                if (depth === 0) {
                    callEnd = i + 1;
                    break;
                }
            }
        }
        if (callEnd === -1) {
            pos = idx + 1;
            continue;
        }
        // Only merge factories that use the () => ({...}) form — the paren-wrapped object
        // literal pattern. Function-body factories (` () => { return {...} }`) are skipped.
        const factoryRe = /,\s*\(\s*\)\s*=>\s*\(\s*\{/;
        if (!factoryRe.test(code.slice(nameEnd + 1, callEnd))) {
            blocks.push({ start: idx, end: callEnd, module: moduleName, objectBody: null });
            pos = callEnd;
            continue;
        }
        // First { after the module name is the object literal opening brace
        let braceStart = -1;
        for (let i = nameEnd + 1; i < callEnd; i++) {
            if (code[i] === '{') {
                braceStart = i;
                break;
            }
        }
        if (braceStart === -1) {
            pos = callEnd;
            continue;
        }
        // Track brace depth to find matching }
        let braceDepth = 0;
        let braceEnd = -1;
        for (let i = braceStart; i < callEnd; i++) {
            if (code[i] === '{')
                braceDepth++;
            else if (code[i] === '}') {
                braceDepth--;
                if (braceDepth === 0) {
                    braceEnd = i;
                    break;
                }
            }
        }
        if (braceEnd === -1) {
            pos = callEnd;
            continue;
        }
        blocks.push({ start: idx, end: callEnd, module: moduleName, objectBody: code.slice(braceStart + 1, braceEnd) });
        pos = callEnd;
    }
    // Group by module — only process groups where every occurrence has a simple factory
    const byModule = new Map();
    for (const b of blocks) {
        const arr = byModule.get(b.module) ?? [];
        arr.push(b);
        byModule.set(b.module, arr);
    }
    const toProcess = [...byModule.entries()].filter(([, list]) => list.length > 1 && list.every(b => b.objectBody !== null));
    if (toProcess.length === 0)
        return code;
    const edits = [];
    for (const [module, list] of toProcess) {
        // Normalize each body: split into lines, trim, re-indent uniformly at 2 spaces.
        const allLines = [];
        for (const b of list) {
            const lines = b.objectBody.split('\n').map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                allLines.push('  ' + (line.endsWith(',') ? line : line + ','));
            }
        }
        // Deduplicate keys across all merged bodies: when the same property appears in
        // multiple vi.mock() calls, keep only the last occurrence. This matches Vitest's
        // own override semantics (last vi.mock wins) and avoids duplicate-key objects.
        const keyLastIdx = new Map();
        for (let i = 0; i < allLines.length; i++) {
            const m = allLines[i].match(/^\s*(\w+)\s*:/);
            if (m)
                keyLastIdx.set(m[1], i);
        }
        const deduped = allLines.filter((line, i) => {
            const m = line.match(/^\s*(\w+)\s*:/);
            return m ? keyLastIdx.get(m[1]) === i : true;
        });
        const mockPrefix = code.slice(list[0].start, list[0].start + 4) === 'jest' ? 'jest' : 'vi';
        const merged = `${mockPrefix}.mock('${module}', () => ({\n${deduped.join('\n')}\n}))`;
        edits.push({ start: list[0].start, end: list[0].end, text: merged });
        for (let i = 1; i < list.length; i++) {
            let removeStart = list[i].start;
            if (removeStart > 0 && code[removeStart - 1] === '\n')
                removeStart--;
            edits.push({ start: removeStart, end: list[i].end, text: '' });
        }
    }
    edits.sort((a, b) => b.start - a.start);
    let result = code;
    for (const edit of edits) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }
    return result;
}
const RULE_DIVIDER = '─'.repeat(60);
// Retry message when a fix attempt caused Vitest to collect 0 tests —
// the model likely broke an import. Anchors the model to the original error.
// Error from the broken fix is placed FIRST so it appears in the terminal display
// (which caps at ~15 lines) before the rules boilerplate.
export function buildStructureBrokenMessage(initialError, currentError) {
    return (`⚠ CRITICAL — Your fix broke the file structure: 0 tests collected.\n` +
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
        `- ONLY fix the specific assertion that was originally failing`);
}
// Retry message when a fix attempt reduced the number of passing tests —
// the model broke previously-passing tests while trying to fix one.
// Current errors placed FIRST for the same display reason.
export function buildRegressionMessage(initialError, currentError, baselinePass, currentPass) {
    return (`⚠ REGRESSION — Your fix broke passing tests: ${baselinePass} passing before, now only ${currentPass}.\n\n` +
        `Current errors:\n` +
        `${RULE_DIVIDER}\n` +
        `${currentError}\n` +
        `${RULE_DIVIDER}\n\n` +
        `Original failing test error:\n` +
        `${RULE_DIVIDER}\n` +
        `${initialError}\n` +
        `${RULE_DIVIDER}\n\n` +
        `Do NOT modify tests that were already passing.\n` +
        `ONLY fix the test that was originally failing.`);
}
// Message for the case where every collected test PASSES but the run still exits non-zero because
// the runner caught an UNHANDLED error (an unhandled promise rejection, or a suite-level error
// thrown outside any test/assertion). The model otherwise sees "still failing" with no failing
// assertion to anchor on and oscillates. This names the real problem and the standard fix.
export function buildUnhandledErrorMessage(currentError, passCount) {
    return (`All ${passCount} tests PASS, but the run still FAILED — the runner caught an unhandled error ` +
        `(an unhandled promise rejection, or an error thrown outside any test). These fail the run and ` +
        `cause false-positive/flaky results in CI, so they must be eliminated — not ignored.\n\n` +
        `Most common cause: an async action or a mount effect fires a promise that REJECTS and nothing ` +
        `awaits or catches it within the test's scope (e.g. a fetch mocked with mockRejectedValue whose ` +
        `rejection escapes after the test body returns). Fix by handling the rejection INSIDE the test: ` +
        `await the settling of the error path (e.g. \`await waitFor(() => expect(<error state>)...)\` or ` +
        `\`await expect(promise).rejects.toThrow(...)\`) so no rejection outlives the test. If a specific ` +
        `test is meant to exercise the rejection, assert it explicitly. Do NOT silence it with an empty ` +
        `try/catch or by deleting the test.\n\n` +
        `Runner output:\n` +
        `${RULE_DIVIDER}\n` +
        `${currentError}\n` +
        `${RULE_DIVIDER}`);
}
// The test process CRASHED (see detectProcessCrash) rather than failing a normal assertion —
// framed completely differently from buildRegressionMessage/buildStructureBrokenMessage on
// purpose, since "fix your assertions" is actively wrong advice for a heap-exhaustion/segfault.
export function buildProcessCrashMessage(crashSignature, originalError) {
    return (`⚠ CRITICAL — THE TEST PROCESS CRASHED (${crashSignature.slice(0, 150)}). THIS IS NOT A NORMAL TEST REGRESSION.\n\n` +
        `Do NOT edit assertions or try to "make tests pass again" — a crash means something is consuming unbounded memory or resources. Most likely causes:\n` +
        `- An unmocked timer/interval, or a real network/DB call, left running across tests instead of being mocked or cleared\n` +
        `- A mock that calls itself recursively, or returns something that drives an infinite loop\n` +
        `- A genuinely huge fixture/mock data structure your change introduced\n\n` +
        `Find and undo whatever your last change introduced that could run unbounded — do not just resubmit a similar patch.\n\n` +
        `Original failing test error (what you were originally fixing):\n` +
        `${RULE_DIVIDER}\n` +
        `${originalError.slice(0, 800)}\n` +
        `${RULE_DIVIDER}`);
}
// Shared by every consecutivePatchFailures escalation trigger (anchor-not-found, test-count-
// mismatch, and a patch/rewrite that keeps producing a 0-tests-collected file) in both
// loop.ts and fix-loop.ts — one message instead of three near-duplicate strings per file.
export function buildPatchEscalationMessage(count, reason) {
    return (`PATCH MODE KEEPS FAILING (${reason}, ${count} times in a row) — SWITCH TO FULL REWRITE MODE.\n` +
        `You MUST use <code_output> (NOT <code_patch>) on this attempt and output the COMPLETE test file, including every existing test verbatim plus your fix.\n` +
        `Do NOT use <code_patch> this time.`);
}
// A very specific, high-signal failure: the stack bottoms out in `process.exit`
// inside PRODUCTION code (a fail-loud health check in an async factory/singleton
// — getInstance/connect/init), invoked from the test, NOT on an `expect` line.
// This is almost always an unawaited async factory whose rejection leaked, and/or
// a dependency mocked as a plain object when the source CALLS it (so the call
// throws and drives the catch → process.exit path). The generic "unhandled
// rejection" advice (await the error state) misdiagnoses it, so name it precisely.
// Returns a guidance block to append, or '' when the signature is absent.
export function processExitLeakGuidance(output) {
    // `process.exit unexpectedly called with "1"` is vitest's banner for this exact
    // case. Match it (and the bare `process.exit(` in a stack) as the trigger.
    if (!/process\.exit unexpectedly called/i.test(output) && !/\bprocess\.exit\(/.test(output))
        return '';
    return (`PROCESS.EXIT LEAK — the stack bottoms out in \`process.exit\` inside PRODUCTION code (a fail-loud ` +
        `health check in an async factory/singleton such as getInstance/connect/init), reached from the ` +
        `test and NOT from an \`expect(...)\` line. Do NOT touch the production code — that exit is ` +
        `intentional. The test is at fault, in one or both of these ways:\n` +
        `  1) UNAWAITED ASYNC FACTORY — the method is \`async\` (returns a Promise), but the test calls it ` +
        `without \`await\`, so its rejection escapes the test body as an unhandled rejection. Fix: \`await\` ` +
        `every call site (e.g. \`const client = await Factory.getInstance(cfg)\`), or for the failure case ` +
        `\`await expect(Factory.getInstance(cfg)).rejects.toThrow(...)\`. A returned Promise is never an ` +
        `instance of the class — assert against the awaited value.\n` +
        `  2) NON-CALLABLE / NON-RESOLVING MOCK — the source CALLS the mocked dependency (e.g. a health ` +
        `check runs \`sql\\\`SELECT 1\\\`\`), but the mock is a plain object, so calling it throws and trips ` +
        `the catch → process.exit path. Mock the dependency's REAL shape: many library values are "a ` +
        `function that ALSO has methods" (postgres.js \`sql\`, axios instances, express apps). Make it ` +
        `callable AND resolve the happy path:\n` +
        `       const sql = Object.assign(vi.fn().mockResolvedValue([{ '?column?': 1 }]), { end: vi.fn().mockResolvedValue(undefined) })\n` +
        `     A plain \`{ end }\` object is NOT callable and drives the failure branch. When code has a ` +
        `\`catch { process.exit/throw }\` health check, the happy-path mock MUST resolve.`);
}
// ---------------------------------------------------------------------------
// Patch-mode support
// ---------------------------------------------------------------------------
// Index of the line that ENDS the last import statement (or -1 if there are none).
// Unlike a naive "last line starting with `import`", this spans multi-line imports so
// callers insert AFTER the whole statement, never inside an `import { ... } from '...'` block.
function lastImportStatementEndIdx(lines) {
    let end = -1;
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*import\b/.test(lines[i]))
            continue;
        // Walk to the line that completes this statement: one ending in `from '...'`/`from "..."`,
        // a bare side-effect import (`import '...'`), or any line ending with a semicolon.
        let j = i;
        while (j < lines.length &&
            !/from\s+['"][^'"]+['"]\s*;?\s*$/.test(lines[j]) &&
            !/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/.test(lines[j]) &&
            !/;\s*$/.test(lines[j])) {
            j++;
        }
        end = Math.min(j, lines.length - 1);
        i = end; // resume scanning after this statement
    }
    return end;
}
// Walk the file's import statements, yielding each one's line range + joined text
// (spans multi-line imports).
function* iterImportStatements(lines) {
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*import\b/.test(lines[i]))
            continue;
        let j = i;
        while (j < lines.length &&
            !/from\s+['"][^'"]+['"]\s*;?\s*$/.test(lines[j]) &&
            !/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/.test(lines[j]) &&
            !/;\s*$/.test(lines[j])) {
            j++;
        }
        const end = Math.min(j, lines.length - 1);
        yield { start: i, end, text: lines.slice(i, end + 1).join('\n') };
        i = end;
    }
}
const moduleKey = (m) => m.replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, '');
// Parse a single import statement into its parts. Returns null if it has no module specifier.
function parseImportStatement(text) {
    const modM = text.match(/from\s+(['"])([^'"]+)\1/);
    if (!modM)
        return null;
    const typeOnly = /^\s*import\s+type\b/.test(text);
    const braceM = text.match(/\{([\s\S]*?)\}/);
    const names = braceM ? braceM[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const defM = text.match(/import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/);
    return { module: modM[2], quote: modM[1], typeOnly, def: defM ? defM[1] : null, names, semicolon: /;\s*$/.test(text.trim()) };
}
// ADD_IMPORT helper: if the new import names come from a module already imported in the file,
// merge them into that existing statement (deduped) instead of appending a duplicate import —
// a second `import … from 'X'` triggers bundler "imported multiple times" errors. Mutates
// `lines` and returns true when a merge happened; false means "no existing import to merge into".
function mergeNamedImportIntoExisting(lines, content) {
    // Only handle a single named-import statement; anything more exotic falls back to append.
    if ((content.match(/\bimport\b/g) ?? []).length !== 1)
        return false;
    const incoming = parseImportStatement(content);
    if (!incoming || incoming.names.length === 0)
        return false;
    for (const stmt of iterImportStatements(lines)) {
        const existing = parseImportStatement(stmt.text);
        if (!existing)
            continue;
        if (moduleKey(existing.module) !== moduleKey(incoming.module))
            continue;
        if (existing.typeOnly !== incoming.typeOnly)
            continue; // don't mix `import type` with value imports
        const mergedNames = [...existing.names];
        for (const n of incoming.names)
            if (!mergedNames.includes(n))
                mergedNames.push(n);
        const def = existing.def ?? incoming.def;
        const q = existing.quote;
        const rebuilt = `import ${existing.typeOnly ? 'type ' : ''}` +
            `${def ? def + (mergedNames.length ? ', ' : ' ') : ''}` +
            `${mergedNames.length ? `{ ${mergedNames.join(', ')} }` : ''}` +
            ` from ${q}${existing.module}${q}${existing.semicolon ? ';' : ''}`;
        lines.splice(stmt.start, stmt.end - stmt.start + 1, rebuilt);
        return true;
    }
    return false;
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
// Strips a single matching pair of outer quotes (either "..." or '...') from an
// anchor and unescapes the wrapping quote char inside it. Models emit anchors for
// test names that contain quotes in two ways, and both must resolve to the literal
// name as it appears in the file:
//   raw nested:  "shows "x" msg"   → shows "x" msg
//   escaped:     "shows \"x\" msg" → shows "x" msg   (proper JS string literal)
// Only the outermost pair is removed, and only the wrapping quote's escape (\" for
// a "..." anchor, \' for a '...' anchor) plus \\ are unescaped — so inner quotes
// of the OTHER style are left untouched. A string whose ends don't both match
// (unquoted anchors, or one stray quote) is returned unchanged.
function stripOuterQuotes(s) {
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            const inner = s.slice(1, -1);
            // Unescape string-literal escapes in one left-to-right pass: \" -> ", \' -> ',
            // \\ -> \ . Non-overlapping matching means \\" stays \" (escaped backslash
            // followed by a literal quote), which is the correct interpretation.
            return inner.replace(/\\(["'\\])/g, '$1');
        }
    }
    return s;
}
// Models occasionally wrap a `@@@` marker line in a comment style other than the required `//`
// line-comment — most often HTML-comment syntax (`<!-- @@@ REPLACE: ... -->`) or a block comment
// (`/* @@@ REPLACE: ... */`), and typically wrap the WHOLE multi-line op in one comment (opener
// on the REPLACE line, closer on the END line) rather than per-line, so the opener and closer
// tokens can land on different lines entirely. headerRe/withRe/endRe require an exact `// @@@ ...`
// prefix with no fallback, so a marker in the wrong comment style doesn't error, it just fails to
// match — the line is silently skipped and the whole operation vanishes with no signal to the
// model or the user, even when the underlying fix was otherwise correct. Confirmed in practice: a
// model correctly diagnosed a missing `session.withTransaction` mock and emitted two REPLACE ops,
// but wrote the first as `<!-- @@@ REPLACE:` ... `// @@@ END -->` — it silently no-opped while the
// second, plain `// @@@`-prefixed op for the same fix elsewhere applied fine. Strip a leading
// comment-opener immediately before `@@@` and a trailing comment-closer at end of line
// independently (not requiring both on the same line) before running the marker regexes; only
// ever used for MARKER detection on a parallel array, never for the captured old/new content
// itself, so a correctly-formatted patch behaves identically to before.
function normalizePatchMarkerLine(line) {
    return line
        .replace(/^(\s*)(?:<!--|\/\*)\s*(?=@@@)/, '$1// ')
        .replace(/\s*(?:-->|\*\/)\s*$/, '');
}
export function parsePatch(patchOutput) {
    const ops = [];
    const lines = patchOutput.split('\n');
    const markerLines = lines.map(normalizePatchMarkerLine);
    // Capture everything after the colon as the raw anchor; a single pair of
    // outer quotes is stripped below. Capturing the whole remainder (rather than
    // a `"([^"]*)"` group) is required because a test name can itself contain
    // double quotes — e.g. it('shows "No accounts match" message') — and a
    // greedy-stop-at-first-quote group would truncate the anchor to "shows ",
    // which never matches the file. Models also routinely drop the outer quotes,
    // so unquoted anchors must work too.
    const headerRe = /^\/\/ @@@ (REPLACE_TEST|DELETE_TEST|ADD_AFTER_DESCRIBE|ADD_IMPORT|ADD_AFTER_IMPORTS|REPLACE):\s*(.*)$/;
    const withRe = /^\/\/ @@@ WITH:\s*$/;
    const endRe = /^\/\/ @@@ END\s*$/;
    let i = 0;
    while (i < lines.length) {
        const m = headerRe.exec(markerLines[i]);
        if (!m) {
            i++;
            continue;
        }
        const type = m[1];
        i++;
        if (type === 'REPLACE') {
            // Read old text until // @@@ WITH:
            const oldLines = [];
            while (i < lines.length && !withRe.test(markerLines[i]) && !endRe.test(markerLines[i])) {
                oldLines.push(lines[i]);
                i++;
            }
            if (!withRe.test(markerLines[i] ?? '')) {
                i++;
                continue;
            } // malformed — skip
            i++; // skip // @@@ WITH:
            const newLines = [];
            while (i < lines.length && !endRe.test(markerLines[i])) {
                newLines.push(lines[i]);
                i++;
            }
            i++; // skip // @@@ END
            let anchor = oldLines.join('\n');
            let content = newLines.join('\n');
            if (anchor.startsWith('\n'))
                anchor = anchor.slice(1);
            if (anchor.endsWith('\n'))
                anchor = anchor.slice(0, -1);
            if (content.startsWith('\n'))
                content = content.slice(1);
            if (content.endsWith('\n'))
                content = content.slice(0, -1);
            ops.push({ type, anchor, content });
        }
        else {
            const anchor = stripOuterQuotes((m[2] ?? '').trim()); // ADD_IMPORT/ADD_AFTER_IMPORTS have no anchor
            const contentLines = [];
            while (i < lines.length && !endRe.test(markerLines[i])) {
                contentLines.push(lines[i]);
                i++;
            }
            i++; // skip // @@@ END
            let content = contentLines.join('\n');
            if (content.startsWith('\n'))
                content = content.slice(1);
            if (content.endsWith('\n'))
                content = content.slice(0, -1);
            ops.push({ type, anchor, content });
        }
    }
    return ops;
}
// Finds the start and end character positions of `anchor` within `code`.
// First tries exact match; if that fails, tries a line-by-line match that
// trims trailing whitespace from each line (handles trailing spaces and CRLF files).
// Returns the range in the ORIGINAL (un-normalized) code so the replacement is clean.
function findAnchorRange(code, anchor) {
    // Fast path: exact match
    const exactIdx = code.indexOf(anchor);
    if (exactIdx !== -1)
        return { start: exactIdx, end: exactIdx + anchor.length };
    // Fallback: trim trailing whitespace (including \r) on every line and re-compare.
    // Handles trailing spaces left by editors and CRLF files (\r stripped by trimEnd).
    const anchorLines = anchor.split('\n').map(l => l.trimEnd());
    const codeLines = code.split('\n');
    const n = anchorLines.length;
    if (n === 0)
        return null;
    // Precompute byte offset of each line start — O(N) once, avoids O(N²) inner accumulation.
    const lineStart = new Array(codeLines.length + 1);
    lineStart[0] = 0;
    for (let k = 0; k < codeLines.length; k++) {
        lineStart[k + 1] = lineStart[k] + codeLines[k].length + 1; // +1 for the \n separator
    }
    for (let i = 0; i <= codeLines.length - n; i++) {
        if (codeLines[i].trimEnd() !== anchorLines[0])
            continue;
        let match = true;
        for (let j = 1; j < n; j++) {
            if (codeLines[i + j].trimEnd() !== anchorLines[j]) {
                match = false;
                break;
            }
        }
        if (!match)
            continue;
        const start = lineStart[i];
        // end = start of line after the match minus the \n, i.e. the span of the matched lines joined
        const end = start + codeLines.slice(i, i + n).join('\n').length;
        return { start, end };
    }
    return null;
}
// Finds the end of an it()/test()/describe() call starting at `startIdx` in `code`.
// `startIdx` must point to the opening `(` of the call.
// Returns the index just past the closing `)` (and optional `;`), or -1 on failure.
//
// Strategy: skip the string argument(s), find the function body `{`, track brace depth
// until it returns to 0, then consume the closing `)` and optional `;`.
// We do a simplified scan that handles string literals and template literals to avoid
// false brace counts inside quoted text.
export function findCallEnd(code, startIdx) {
    let i = startIdx; // points at the `(` of the call
    let parenDepth = 0;
    let braceDepth = 0;
    let foundBrace = false;
    while (i < code.length) {
        const ch = code[i];
        // Skip line/block comments BEFORE the string check. An apostrophe inside a
        // comment (e.g. `// channel that doesn't exist`) would otherwise be read as a
        // string-literal opener and swallow the rest of the test body — including its
        // closing braces — so findCallEnd never balances and returns -1.
        if (ch === '/' && code[i + 1] === '/') {
            i += 2;
            while (i < code.length && code[i] !== '\n')
                i++;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            i += 2;
            while (i < code.length && !(code[i] === '*' && code[i + 1] === '/'))
                i++;
            i += 2;
            continue;
        }
        // Skip string literals to avoid false brace/paren counts inside strings
        if (ch === '"' || ch === "'") {
            const q = ch;
            i++;
            while (i < code.length) {
                if (code[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (code[i] === q) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (ch === '`') {
            i++;
            while (i < code.length) {
                if (code[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (code[i] === '`') {
                    i++;
                    break;
                }
                // Skip ${...} expressions inside template literals (simplified: track braces)
                if (code[i] === '$' && code[i + 1] === '{') {
                    i += 2;
                    let tDepth = 1;
                    while (i < code.length && tDepth > 0) {
                        if (code[i] === '{')
                            tDepth++;
                        else if (code[i] === '}')
                            tDepth--;
                        i++;
                    }
                    continue;
                }
                i++;
            }
            continue;
        }
        if (ch === '{') {
            foundBrace = true;
            braceDepth++;
            i++;
            continue;
        }
        if (ch === '}') {
            if (foundBrace) {
                braceDepth--;
                if (braceDepth === 0) {
                    // We've closed the function body. Now consume the closing `)` and optional `;`
                    i++; // move past `}`
                    // skip whitespace/newlines
                    while (i < code.length && (code[i] === ' ' || code[i] === '\t' || code[i] === '\n' || code[i] === '\r'))
                        i++;
                    if (i < code.length && code[i] === ')') {
                        i++; // consume `)`
                        if (i < code.length && code[i] === ';')
                            i++; // consume optional `;`
                    }
                    return i;
                }
            }
            i++;
            continue;
        }
        if (!foundBrace) {
            // Before the opening brace we still count parens to handle nested calls in args
            if (ch === '(')
                parenDepth++;
            else if (ch === ')') {
                parenDepth--;
                // If we hit -1 depth without ever finding a brace this is a call with no body (unlikely for tests)
                if (parenDepth < 0)
                    return -1;
            }
        }
        i++;
    }
    return -1;
}
// Applies a list of PatchOperation objects to `existingCode` in order.
// Returns the modified string, or null if any anchor cannot be located.
export function applyPatch(existingCode, ops) {
    let code = existingCode;
    for (const op of ops) {
        if (op.type === 'REPLACE') {
            // General text replacement — same mechanism as the Edit tool.
            // anchor = exact old text, content = replacement. First occurrence only.
            // Falls back to trailing-whitespace-normalized line matching so that minor
            // formatting differences (trailing spaces, CRLF files) don't cause failures.
            const range = findAnchorRange(code, op.anchor);
            if (!range)
                return null;
            code = code.slice(0, range.start) + op.content + code.slice(range.end);
        }
        else if (op.type === 'REPLACE_TEST' || op.type === 'DELETE_TEST') {
            const anchor = op.anchor;
            // Try all four quote/keyword combos
            const candidates = [
                `it("${anchor}"`,
                `it('${anchor}'`,
                `test("${anchor}"`,
                `test('${anchor}'`,
            ];
            let foundIdx = -1;
            for (const c of candidates) {
                const idx = code.indexOf(c);
                if (idx !== -1) {
                    foundIdx = idx;
                    break;
                }
            }
            if (foundIdx === -1)
                return null;
            // Find the opening `(` of the call — it's right after `it` or `test`
            const parenIdx = code.indexOf('(', foundIdx);
            if (parenIdx === -1)
                return null;
            const callEnd = findCallEnd(code, parenIdx);
            if (callEnd === -1)
                return null;
            if (op.type === 'REPLACE_TEST') {
                code = code.slice(0, foundIdx) + op.content + code.slice(callEnd);
            }
            else {
                // DELETE_TEST: also remove an immediately preceding blank line
                let removeStart = foundIdx;
                if (removeStart > 0 && code[removeStart - 1] === '\n') {
                    // Check if the line before is blank
                    const prevNewline = code.lastIndexOf('\n', removeStart - 2);
                    const prevLine = code.slice(prevNewline + 1, removeStart - 1);
                    if (prevLine.trim() === '')
                        removeStart = prevNewline + 1;
                }
                code = code.slice(0, removeStart) + code.slice(callEnd);
            }
        }
        else if (op.type === 'ADD_AFTER_DESCRIBE') {
            const anchor = op.anchor;
            const candidates = [
                `describe("${anchor}"`,
                `describe('${anchor}'`,
            ];
            let foundIdx = -1;
            for (const c of candidates) {
                const idx = code.indexOf(c);
                if (idx !== -1) {
                    foundIdx = idx;
                    break;
                }
            }
            if (foundIdx === -1)
                return null;
            // Find the opening `(` of the describe call
            const parenIdx = code.indexOf('(', foundIdx);
            if (parenIdx === -1)
                return null;
            // Walk from parenIdx to find the LAST closing `})` of the describe block.
            // We track brace depth from the first `{` we encounter inside the describe args.
            let i = parenIdx;
            let braceDepth = 0;
            let lastClosePos = -1; // position of the `}` that closes the describe body
            // Skip string literal for the describe name argument
            // The describe call looks like: describe("name", () => { ... })
            // We need to find the function body brace
            let foundBrace = false;
            while (i < code.length) {
                const ch = code[i];
                // Skip line/block comments before the string check — an apostrophe in a
                // comment must not be read as a string opener (see findCallEnd).
                if (ch === '/' && code[i + 1] === '/') {
                    i += 2;
                    while (i < code.length && code[i] !== '\n')
                        i++;
                    continue;
                }
                if (ch === '/' && code[i + 1] === '*') {
                    i += 2;
                    while (i < code.length && !(code[i] === '*' && code[i + 1] === '/'))
                        i++;
                    i += 2;
                    continue;
                }
                // Skip string literals
                if (ch === '"' || ch === "'") {
                    const q = ch;
                    i++;
                    while (i < code.length) {
                        if (code[i] === '\\') {
                            i += 2;
                            continue;
                        }
                        if (code[i] === q) {
                            i++;
                            break;
                        }
                        i++;
                    }
                    continue;
                }
                if (ch === '`') {
                    i++;
                    while (i < code.length) {
                        if (code[i] === '\\') {
                            i += 2;
                            continue;
                        }
                        if (code[i] === '`') {
                            i++;
                            break;
                        }
                        if (code[i] === '$' && code[i + 1] === '{') {
                            i += 2;
                            let tDepth = 1;
                            while (i < code.length && tDepth > 0) {
                                if (code[i] === '{')
                                    tDepth++;
                                else if (code[i] === '}')
                                    tDepth--;
                                i++;
                            }
                            continue;
                        }
                        i++;
                    }
                    continue;
                }
                if (ch === '{') {
                    foundBrace = true;
                    braceDepth++;
                    i++;
                    continue;
                }
                if (ch === '}') {
                    if (foundBrace) {
                        braceDepth--;
                        if (braceDepth === 0) {
                            lastClosePos = i;
                            break;
                        }
                    }
                    i++;
                    continue;
                }
                i++;
            }
            if (lastClosePos === -1)
                return null;
            // Insert content immediately before the closing `}`
            // Add a newline after content so the `}` is on its own line
            const insertion = '\n' + op.content + '\n';
            code = code.slice(0, lastClosePos) + insertion + code.slice(lastClosePos);
        }
        else if (op.type === 'ADD_IMPORT') {
            const lines = code.split('\n');
            // Prefer merging into an existing import from the same module (avoids a duplicate
            // `import … from 'X'` that bundlers reject). Otherwise insert after the END of the last
            // import statement (handles multi-line imports — inserting after the opening `import {`
            // line would split the block).
            if (!mergeNamedImportIntoExisting(lines, op.content)) {
                const lastImportLineIdx = lastImportStatementEndIdx(lines);
                const importLines = op.content.split('\n');
                if (lastImportLineIdx === -1) {
                    lines.unshift(...importLines);
                }
                else {
                    lines.splice(lastImportLineIdx + 1, 0, ...importLines);
                }
            }
            code = lines.join('\n');
        }
        else if (op.type === 'ADD_AFTER_IMPORTS') {
            // Like ADD_IMPORT but inserts a blank line before the block — for vi.mock() calls
            // and other module-level statements that follow imports
            const lines = code.split('\n');
            const lastImportLineIdx = lastImportStatementEndIdx(lines);
            const contentLines = ['', ...op.content.split('\n')];
            if (lastImportLineIdx === -1) {
                lines.unshift(...contentLines);
            }
            else {
                lines.splice(lastImportLineIdx + 1, 0, ...contentLines);
            }
            code = lines.join('\n');
        }
    }
    // Collapse gaps left by DELETE_TEST: runs of 3+ newlines (2+ consecutive blank lines)
    // down to exactly 2 newlines (1 blank line). Safe — never affects content.
    code = code.replace(/\n{3,}/g, '\n\n');
    // Remove describe blocks that became empty shells (no it/test calls anywhere inside).
    // Repeat until stable — outer empties are caught after inner empties are removed.
    code = removeEmptyDescribeBlocks(code);
    return code;
}
// Removes describe() blocks whose body contains no it() or test() calls at any depth.
// Iterates until stable to handle nested empty blocks (inner removed first, then outer).
function removeEmptyDescribeBlocks(code) {
    let prev = '';
    while (code !== prev) {
        prev = code;
        const lines = code.split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (/^\s*describe\s*\(/.test(line) && line.trimEnd().endsWith('{')) {
                // Collect the full block by tracking brace depth.
                // Note: braces in string literals may cause a false depth count, but that
                // only risks keeping a block we should remove — never deleting a live one,
                // because we require it()/test() to be absent in ALL collected lines.
                let depth = 1;
                let j = i + 1;
                const bodyLines = [];
                while (j < lines.length && depth > 0) {
                    const l = lines[j];
                    for (const ch of l) {
                        if (ch === '{')
                            depth++;
                        else if (ch === '}')
                            depth--;
                    }
                    if (depth > 0)
                        bodyLines.push(l);
                    j++;
                }
                const hasTests = bodyLines.some(l => /\b(?:it|test)\s*\(/.test(l));
                if (!hasTests) {
                    // Skip the whole block (opening line through closing line)
                    i = j;
                    // Consume a trailing blank line so deletions don't stack up
                    if (i < lines.length && !lines[i].trim())
                        i++;
                    continue;
                }
            }
            out.push(line);
            i++;
        }
        code = out.join('\n');
    }
    return code;
}
// Scans from the `{` at `openIdx` to its matching `}`, skipping strings/comments/template
// expressions so braces inside quoted text don't miscount. Returns the index of the matching
// `}`, or -1 if unbalanced.
function scanToMatchingBrace(code, openIdx) {
    let i = openIdx;
    let depth = 0;
    while (i < code.length) {
        const ch = code[i];
        if (ch === '/' && code[i + 1] === '/') {
            i += 2;
            while (i < code.length && code[i] !== '\n')
                i++;
            continue;
        }
        if (ch === '/' && code[i + 1] === '*') {
            i += 2;
            while (i < code.length && !(code[i] === '*' && code[i + 1] === '/'))
                i++;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const q = ch;
            i++;
            while (i < code.length) {
                if (code[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (code[i] === q) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (ch === '`') {
            i++;
            while (i < code.length) {
                if (code[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (code[i] === '`') {
                    i++;
                    break;
                }
                if (code[i] === '$' && code[i + 1] === '{') {
                    i += 2;
                    let t = 1;
                    while (i < code.length && t > 0) {
                        if (code[i] === '{')
                            t++;
                        else if (code[i] === '}')
                            t--;
                        i++;
                    }
                    continue;
                }
                i++;
            }
            continue;
        }
        if (ch === '{') {
            depth++;
            i++;
            continue;
        }
        if (ch === '}') {
            depth--;
            if (depth === 0)
                return i;
            i++;
            continue;
        }
        i++;
    }
    return -1;
}
// Index of the FIRST `{` in `block` (the callback-body opener), skipping strings/comments.
function firstBodyBrace(block) {
    let i = 0;
    while (i < block.length) {
        const ch = block[i];
        if (ch === '/' && block[i + 1] === '/') {
            i += 2;
            while (i < block.length && block[i] !== '\n')
                i++;
            continue;
        }
        if (ch === '/' && block[i + 1] === '*') {
            i += 2;
            while (i < block.length && !(block[i] === '*' && block[i + 1] === '/'))
                i++;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const q = ch;
            i++;
            while (i < block.length) {
                if (block[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (block[i] === q) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (ch === '`') {
            i++;
            while (i < block.length && block[i] !== '`') {
                if (block[i] === '\\')
                    i++;
                i++;
            }
            i++;
            continue;
        }
        if (ch === '{')
            return i;
        i++;
    }
    return -1;
}
// A block's identity for duplicate detection: every line trimmed, blanks dropped, rejoined.
// So two blocks that differ only in indentation/blank lines still compare equal (a re-emitted
// copy), while any real difference in test names or assertions keeps them distinct.
function normalizeBlockSig(block) {
    return block.split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n');
}
// Removes a describe()/it()/test() block that is an EXACT duplicate (identical normalized text)
// of an earlier SIBLING block in the same scope. Models in extend/improve mode ("preserve existing
// tests, only add new ones") sometimes re-emit an existing describe verbatim instead of adding
// genuinely new cases — producing two identical `describe('X', …)` blocks. Removing a byte-identical
// copy is semantically a no-op (the tests were redundant). By design this ONLY drops exact-duplicate
// SIBLINGS: it never merges different-content blocks (that needs judgment — left to the prompt), and
// never removes an identical it() that lives under a DIFFERENT describe (a different parent's
// beforeEach can make it a distinct test). String/comment-aware via findCallEnd, so it can't
// mis-slice on braces inside quoted text; on any parse failure it leaves the remainder untouched.
export function dedupeTestBlocks(code) {
    return dedupeScope(code);
}
// A full <code_output> rewrite should NEVER legitimately contain this literal text — `// @@@
// REPLACE:`/`// @@@ WITH:`/`// @@@ END` is lacuna's OWN internal <code_patch> delimiter syntax
// (see parsePatch above), not real TypeScript. Found leaking into a full-file response in real
// production dogfooding — the model's own prior patch-mode attempt was still sitting in
// conversation history, and a later full-rewrite response copied fragments of it verbatim,
// including the raw markers, rather than treating it as reference-only. The EXISTING check at
// loop.ts's `generator.isPatch && !patchBase` branch is a different, already-fixed scenario (patch
// syntax used for a brand-new file); this checks the OPPOSITE direction — patch syntax bleeding
// into what's supposed to be full, patch-free file content.
const STRAY_PATCH_MARKER_RE = /\/\/ @@@ (?:REPLACE|WITH|END)\b/;
export function detectStrayPatchMarkers(code) {
    return STRAY_PATCH_MARKER_RE.test(code);
}
// A test file can pass every assertion while still leaking a real async handle (an interval a
// module starts on import, an open socket/connection) that's never cleared — invisible to
// pass/fail-count classification since the run is green. Confirmed via a real production dogfooding
// bug: db.ts's setInterval-based connection-progress logger stayed alive past 2 tests that never
// called the module's own exported stopProgress(). Jest itself already tells us this happened —
// `forceExit` prints "Force exiting Jest: Have you considered using `--detectOpenHandles`" whenever
// it had to kill a lingering handle, and WITHOUT forceExit at all, Jest instead first prints "Jest
// did not exit one second after the test run has completed" and then hangs indefinitely (verified
// empirically: a bare `setInterval` in a test left the process alive with no further output).
// Both phrasings are Jest-internal and distinctive enough that no real test fixture would produce
// them coincidentally.
const OPEN_HANDLE_LEAK_RE = /Force exiting Jest|Jest did not exit one second after the test run/;
export function detectOpenHandleLeak(rawRunOutput) {
    return OPEN_HANDLE_LEAK_RE.test(rawRunOutput);
}
export function buildOpenHandleLeakMessage() {
    return ('Tests passed, but Jest had to force-exit because of a leaked async handle (a setInterval/setTimeout/open ' +
        'connection that was never cleared) — left running, this can hang CI or bleed into later test suites.\n' +
        'Find the timer/interval/connection this test (or a module it imports) creates and clear it before the test ' +
        'ends: capture the handle and call clearInterval(...)/clearTimeout(...)/close(...), or call the module\'s own ' +
        'cleanup/stop export if it has one — a module that starts a background interval on import often also exports ' +
        'a stop/cleanup function for exactly this reason.\n' +
        'Only switch to jest.useFakeTimers() if doing so does not change what the test is actually verifying — ' +
        'otherwise clear the real handle directly.');
}
function dedupeScope(code) {
    const seen = new Set();
    let out = '';
    let cursor = 0; // next unprocessed char in `code`
    let i = 0;
    while (i < code.length) {
        const m = code.slice(i).match(/\b(?:describe|it|test)\s*\(/);
        if (!m || m.index === undefined)
            break;
        const callStart = i + m.index;
        const parenIdx = callStart + m[0].length - 1; // the `(`
        const end = findCallEnd(code, parenIdx);
        if (end === -1)
            break; // unparseable — leave the rest as-is (safe)
        const block = code.slice(callStart, end);
        const sig = normalizeBlockSig(block);
        const gap = code.slice(cursor, callStart);
        const isDescribe = /^describe\b/.test(block);
        if (seen.has(sig)) {
            // Exact-duplicate sibling — drop it, and collapse the blank line that preceded it plus a
            // single blank line that follows, so removal doesn't leave a widening gap.
            out += gap.replace(/[ \t]*\n[ \t]*\n[ \t]*$/, '\n');
            cursor = end;
            let k = end;
            while (k < code.length && (code[k] === ' ' || code[k] === '\t'))
                k++;
            if (code[k] === '\n')
                cursor = k + 1;
        }
        else {
            seen.add(sig);
            out += gap + (isDescribe ? dedupeDescribeBody(block) : block);
            cursor = end;
        }
        i = end;
    }
    out += code.slice(cursor);
    return out;
}
// Recurse into a describe block's callback body so nested sibling duplicates are also collapsed.
function dedupeDescribeBody(block) {
    const open = firstBodyBrace(block);
    if (open === -1)
        return block;
    const close = scanToMatchingBrace(block, open);
    if (close === -1)
        return block;
    return block.slice(0, open + 1) + dedupeScope(block.slice(open + 1, close)) + block.slice(close);
}
// Convenience wrapper: parses then applies. Returns null if no ops parsed or apply fails.
export function tryApplyPatch(existingCode, patchOutput) {
    const ops = parsePatch(patchOutput);
    if (ops.length === 0)
        return null;
    return applyPatch(existingCode, ops);
}
// Like tryApplyPatch but surfaces which operation failed, so callers can build
// a useful error message pointing the model at the exact anchor that didn't match.
export function tryApplyPatchWithDiag(existingCode, patchOutput) {
    const ops = parsePatch(patchOutput);
    if (ops.length === 0)
        return { ok: false, failedOp: null, opsCount: 0 };
    let code = existingCode;
    for (const op of ops) {
        const result = applyPatch(code, [op]);
        if (result === null)
            return { ok: false, failedOp: op, opsCount: ops.length };
        code = result;
    }
    return { ok: true, result: code };
}
export function parseMocksPatch(patchOutput) {
    const ops = [];
    const lines = patchOutput.split('\n');
    const markerLines = lines.map(normalizePatchMarkerLine);
    const headerRe = /^\/\/ @@@ (REPLACE|APPEND_EXPORT|ADD_TO_BEFOREEACH):\s*$/;
    const withRe = /^\/\/ @@@ WITH:\s*$/;
    const endRe = /^\/\/ @@@ END\s*$/;
    let i = 0;
    while (i < lines.length) {
        const m = headerRe.exec(markerLines[i]);
        if (!m) {
            i++;
            continue;
        }
        const type = m[1];
        i++;
        if (type === 'REPLACE') {
            const oldLines = [];
            while (i < lines.length && !withRe.test(markerLines[i]) && !endRe.test(markerLines[i])) {
                oldLines.push(lines[i]);
                i++;
            }
            if (!withRe.test(markerLines[i] ?? '')) {
                i++;
                continue;
            }
            i++; // skip // @@@ WITH:
            const newLines = [];
            while (i < lines.length && !endRe.test(markerLines[i])) {
                newLines.push(lines[i]);
                i++;
            }
            i++; // skip // @@@ END
            let oldText = oldLines.join('\n');
            let newText = newLines.join('\n');
            if (oldText.startsWith('\n'))
                oldText = oldText.slice(1);
            if (oldText.endsWith('\n'))
                oldText = oldText.slice(0, -1);
            if (newText.startsWith('\n'))
                newText = newText.slice(1);
            if (newText.endsWith('\n'))
                newText = newText.slice(0, -1);
            ops.push({ type, oldText, newText });
        }
        else {
            // APPEND_EXPORT and ADD_TO_BEFOREEACH — just content, no WITH: block
            const contentLines = [];
            while (i < lines.length && !endRe.test(markerLines[i])) {
                contentLines.push(lines[i]);
                i++;
            }
            i++; // skip // @@@ END
            let newText = contentLines.join('\n');
            if (newText.startsWith('\n'))
                newText = newText.slice(1);
            if (newText.endsWith('\n'))
                newText = newText.slice(0, -1);
            ops.push({ type, oldText: '', newText });
        }
    }
    return ops;
}
export function applyMocksPatch(existing, ops) {
    let code = existing;
    const failedOps = [];
    for (const op of ops) {
        if (op.type === 'REPLACE') {
            const range = findAnchorRange(code, op.oldText);
            if (!range) {
                failedOps.push(op);
                continue;
            }
            code = code.slice(0, range.start) + op.newText + code.slice(range.end);
        }
        else if (op.type === 'APPEND_EXPORT') {
            // Insert before the last beforeEach block, or at end of file if none
            const beforeEachIdx = code.lastIndexOf('\nbeforeEach(');
            if (beforeEachIdx !== -1) {
                code = code.slice(0, beforeEachIdx) + '\n\n' + op.newText.trim() + code.slice(beforeEachIdx);
            }
            else {
                code = code.trimEnd() + '\n\n' + op.newText.trim();
            }
        }
        else if (op.type === 'ADD_TO_BEFOREEACH') {
            // Find the last beforeEach and insert before its closing brace
            const beIdx = code.lastIndexOf('\nbeforeEach(');
            if (beIdx === -1) {
                failedOps.push(op);
                continue;
            }
            // Find the closing }) of that beforeEach by tracking brace depth
            let depth = 0;
            let closeIdx = -1;
            for (let i = beIdx + 1; i < code.length; i++) {
                if (code[i] === '{')
                    depth++;
                else if (code[i] === '}') {
                    depth--;
                    if (depth === 0) {
                        closeIdx = i;
                        break;
                    }
                }
            }
            if (closeIdx === -1) {
                failedOps.push(op);
                continue;
            }
            const indent = '  ';
            const lines = op.newText.trim().split('\n').map(l => indent + l).join('\n');
            code = code.slice(0, closeIdx) + '\n' + lines + '\n' + code.slice(closeIdx);
        }
    }
    return { result: code, failedOps };
}
export function tryApplyMocksPatch(existing, patchOutput) {
    const ops = parseMocksPatch(patchOutput);
    if (ops.length === 0)
        return null;
    return applyMocksPatch(existing, ops);
}
//# sourceMappingURL=validate.js.map