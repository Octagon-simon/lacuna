import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeErrorSignature } from './normalize.js';
import { renderMemorySection } from './retrieve.js';
// Real-SHAPED (anonymized) runner output: the kind of DECORATION (a `====` rule, the `> jest`
// command echo, `console.error`, a `FAIL` header, a `✕` marker) that used to survive normalization
// and become a learned `fixes` summary. Before the fix, `summary = normalized.slice(0,120)`
// surfaced this decoration as prompt noise instead of the actual error.
const BANNER_NOISE = `
================================================================================ FAIL hooks/useThing.test.ts
> jest --coverage hooks/useThing.test.ts --no-cache --forceExit
console.error An update to a component inside a test was not wrapped in act(...)
✕ useThing returns a stable callback
TypeError: Cannot read properties of undefined (reading 'current')
`;
test('normalizeErrorSignature strips runner banner/console/result decoration, keeping the real error', () => {
    const sig = normalizeErrorSignature(BANNER_NOISE);
    assert.doesNotMatch(sig, /={6,}/, 'separator rule should be gone');
    assert.doesNotMatch(sig, />\s+jest/, 'command echo should be gone');
    assert.doesNotMatch(sig, /console\.error/, 'console spew should be gone');
    assert.doesNotMatch(sig, /[✕✓]/, 'result marker should be gone');
    assert.doesNotMatch(sig, /\bFAIL\b/, 'FAIL header should be gone');
    // The actual error survives (paths/values normalized as before). `undefined` is unquoted so it
    // stays verbatim; only the quoted 'current' collapses to <value>.
    assert.match(sig, /Cannot read properties of undefined \(reading <value>\)/);
});
test('normalizeErrorSignature still collapses paths, line/col, quotes, and numbers', () => {
    const sig = normalizeErrorSignature('at foo (/a/b/c.ts:12:5) expected "x" but got 42');
    assert.match(sig, /<file>/);
    assert.match(sig, /:<line>:<col>/);
    assert.match(sig, /<value>/);
    assert.match(sig, /<n>/);
});
function entry(summary, rule = 'a generic mocking rule') {
    return {
        id: 'x', category: 'fixes', error_signature: 'x', tags: [], summary, rule,
        source: 'learned', confidence: 0.9, hit_count: 1, last_used: null, created_at: '2026-01-01T00:00:00Z',
    };
}
test('renderMemorySection drops entries whose summary is banner junk (already-stored corrupt entries)', () => {
    const junk = entry('================================================================================ FAIL hooks<file> useThing ✕ fail');
    assert.equal(renderMemorySection([junk]), null, 'a lone junk entry renders nothing');
});
test('renderMemorySection keeps a clean entry and skips only the junk one', () => {
    const clean = entry('Cannot read properties of undefined (reading <value>)', 'ensure the mock returns the function itself');
    const junk = entry('> jest --coverage hooks<file> console.error overlapping act()');
    const out = renderMemorySection([clean, junk]);
    assert.ok(out);
    assert.match(out, /ensure the mock returns the function itself/);
    assert.doesNotMatch(out, /console\.error/);
});
//# sourceMappingURL=normalize.test.js.map