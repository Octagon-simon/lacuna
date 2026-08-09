import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProcessCrash, detectUnrelatedFileCrash, buildProcessCrashMessage, buildPatchEscalationMessage, buildFailingTestChecklist, detectStrayPatchMarkers, detectOpenHandleLeak, buildOpenHandleLeakMessage, detectJestConfigConflict, detectJestValidationError, detectUnbalancedMocksSyntax } from './validate.js';
// Real text captured from a lacuna debug log on a real production project (attempt 1) — not a
// synthetic example. The retry loop classified this as "⚠ REGRESSION — 13 passing before, now
// only 0" before this fix.
const REAL_OOM_EXCERPT = `
<--- Last few GCs --->

[9011:0x7b7800000]    15901 ms: Scavenge (interleaved) 4063.5 (4085.3) -> 4058.5 (4102.8) MB, pooled: 0 MB, 6.96 / 0.00 ms  (average mu = 0.299, current mu = 0.253) allocation failure;
[9011:0x7b7800000]    16698 ms: Mark-Compact (reduce) 4060.7 (4102.8) -> 4058.0 (4073.1) MB, pooled: 0 MB, 559.00 / 0.00 ms  (+ 94.9 ms in 31 steps since start of marking, biggest step 5.0 ms, walltime since start of marking 661 ms) (average mu = 0.278, c
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
----- Native stack trace -----

 1: 0x1010f6940 node::OOMErrorHandler(char
`;
// A normal, unremarkable failing-assertion sample — must NOT trip the crash detector.
const NORMAL_ASSERTION_FAILURE = `
FAIL src/interactors/__tests__/foo.interactor.test.ts
  ● FooInteractor › does the thing

    expect(received).toBe(expected)

    Expected: true
    Received: false

      45 |     const result = await interactor.doThing();
    > 46 |     expect(result).toBe(true);
         |                    ^

Tests: 1 failed, 3 passed, 4 total
`;
// Real text captured from a lacuna debug log on a real production project (attempts 3-4) — the
// crash originates in src/utils/db.ts, neither the test file nor a configured mocks file, and
// the model got no signal pointing at the real culprit.
const REAL_UNRELATED_FILE_CRASH = `
FAIL src/interactors/__tests__/adminUsers.interactor.test.ts
  ● Test suite failed to run

    TypeError: Cannot read properties of undefined (reading 'on')

      21 | }
      22 |
    > 23 | connection.on("open", () => {
         |            ^
      24 |   isConnected = true;
      25 | });
      26 |

      at Object.<anonymous> (src/utils/db.ts:23:12)
      at Object.<anonymous> (src/utils/index.ts:5:1)
`;
const TEST_FILE = 'src/interactors/__tests__/adminUsers.interactor.test.ts';
const SOURCE_FILE = 'src/interactors/adminUsers.interactor.ts';
const MOCKS_FILES = [
    'tests/mocks.ts',
    'tests/__helpers__/mockData.ts',
    'tests/__helpers__/mockExpressMiddleware.ts',
    'tests/__helpers__/mockModels.ts',
    'tests/__helpers__/mockServices.ts',
];
test('detectProcessCrash fires on the real captured OOM excerpt', () => {
    const result = detectProcessCrash(REAL_OOM_EXCERPT);
    assert.ok(result, 'expected a crash signature to be detected');
    assert.match(result, /heap out of memory|Allocation failed/i);
});
test('detectProcessCrash does not fire on a normal failing-assertion sample', () => {
    assert.equal(detectProcessCrash(NORMAL_ASSERTION_FAILURE), null);
});
test('detectUnrelatedFileCrash fires on the real captured db.ts trace and names the culprit', () => {
    const result = detectUnrelatedFileCrash(REAL_UNRELATED_FILE_CRASH, TEST_FILE, SOURCE_FILE, MOCKS_FILES);
    assert.ok(result, 'expected an unrelated-file banner');
    assert.match(result, /src\/utils\/db\.ts/);
    assert.match(result, /UNRELATED FILE/);
});
test('detectUnrelatedFileCrash does not fire when every frame is in-scope', () => {
    const inScopeTrace = `
    TypeError: something broke

      at Object.<anonymous> (${TEST_FILE}:10:5)
      at Object.<anonymous> (${SOURCE_FILE}:20:3)
      at Object.<anonymous> (tests/mocks.ts:8:1)
  `;
    assert.equal(detectUnrelatedFileCrash(inScopeTrace, TEST_FILE, SOURCE_FILE, MOCKS_FILES), null);
});
test('detectUnrelatedFileCrash returns null when there is no stack-frame-shaped reference at all', () => {
    assert.equal(detectUnrelatedFileCrash(NORMAL_ASSERTION_FAILURE, TEST_FILE, SOURCE_FILE, MOCKS_FILES), null);
});
test('buildProcessCrashMessage frames it as a crash, not a regression', () => {
    const msg = buildProcessCrashMessage('FATAL ERROR: heap out of memory', 'original error text');
    assert.match(msg, /CRASHED/);
    assert.match(msg, /NOT A NORMAL TEST REGRESSION/);
    assert.doesNotMatch(msg, /REGRESSION —/);
});
test('buildPatchEscalationMessage names the reason, count, and forces <code_output>', () => {
    const msg = buildPatchEscalationMessage(2, 'the anchor keeps not matching the file');
    assert.match(msg, /the anchor keeps not matching the file/);
    assert.match(msg, /2 times in a row/);
    assert.match(msg, /<code_output>/);
    assert.match(msg, /Do NOT use <code_patch>/);
});
// The 3 lines below are verbatim-real, captured from
// lacuna-debug.src_interactors___tests___adminUsers.interactor.txt — the same real file whose
// baseline run reported "33 failed, 16 passed, 49 total", but extractFailureRegion's char cap
// truncated the raw output before most of the 33 individual "●" bullets survived into what got
// logged. The remaining lines below extend the same real describe blocks (AdminUsersInteractor's
// getActiveUsersCount/getAllUsers/getSingleUserDetails, visible in the file's indented ✕ tree) in
// the identical "Describe › Describe › test name" shape jest actually emits, to exercise the
// large-failure-count behavior this function exists for.
const REAL_LARGE_FAILURE_SUMMARY = `
FAIL src/interactors/__tests__/adminUsers.interactor.test.ts
  ● AdminUsersInteractor › resetSecurityQuestions › resets security questions successfully
  ● AdminUsersInteractor › resetSecurityQuestions › throws DomainError when deleteMany fails
  ● AdminUsersInteractor › updateUserInfo › aborts transaction on exception
  ● AdminUsersInteractor › getActiveUsersCount › returns total count of active users
  ● AdminUsersInteractor › getActiveUsersCount › throws DomainError when countDocuments fails
  ● AdminUsersInteractor › getActiveUsersCount › logs error and throws on failure
  ● AdminUsersInteractor › getAllUsers › returns paginated users with default query
  ● AdminUsersInteractor › getAllUsers › applies country filter when provided

Tests:       33 failed, 16 passed, 49 total
`;
test('buildFailingTestChecklist names every unique still-failing test on a large-failure file', () => {
    const result = buildFailingTestChecklist(REAL_LARGE_FAILURE_SUMMARY);
    assert.ok(result, 'expected a checklist for 8 distinct failing tests');
    assert.match(result, /8 TESTS ARE STILL FAILING/);
    assert.match(result, /resets security questions successfully/);
    assert.match(result, /applies country filter when provided/);
    assert.doesNotMatch(result, /Test suite failed to run/);
});
test('buildFailingTestChecklist dedupes repeated failure lines (retry-echoed output)', () => {
    const doubled = REAL_LARGE_FAILURE_SUMMARY + REAL_LARGE_FAILURE_SUMMARY;
    const result = buildFailingTestChecklist(doubled);
    assert.ok(result);
    assert.match(result, /8 TESTS ARE STILL FAILING/);
});
test('buildFailingTestChecklist stays out of the way for a small (≤6) failure count', () => {
    // Only the 3 verbatim-real lines — a small, easy-to-track list should not get the treatment.
    const small = `
FAIL src/interactors/__tests__/adminUsers.interactor.test.ts
  ● AdminUsersInteractor › resetSecurityQuestions › resets security questions successfully
  ● AdminUsersInteractor › resetSecurityQuestions › throws DomainError when deleteMany fails
  ● AdminUsersInteractor › updateUserInfo › aborts transaction on exception
`;
    assert.equal(buildFailingTestChecklist(small), null);
});
test('buildFailingTestChecklist returns null on a runner that does not use the ● marker', () => {
    assert.equal(buildFailingTestChecklist(NORMAL_ASSERTION_FAILURE.replace(/●/g, '×')), null);
});
// Real vitest output — captured by temporarily breaking examples/regen-demo's math.test.ts
// (2 extra failing assertions added, then reverted) and running `npx vitest run`, since the real
// production project used for the jest fixtures above only uses jest. Extended with 5 more
// synthetic-but-realistically-shaped FAIL lines in the same " FAIL  <file> > Describe > name"
// format to exercise the large-failure-count threshold, same approach as the jest fixture above.
const REAL_VITEST_FAILURE_SUMMARY = `
 ❯ src/__tests__/math.test.ts (3 tests | 2 failed) 5ms
   × Math functions > TEMP diagnostic failure one 3ms
     → expected 3 to be 999 // Object.is equality
   × Math functions > TEMP diagnostic failure two 0ms
     → expected 9 to be 999 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/__tests__/math.test.ts > Math functions > TEMP diagnostic failure one
AssertionError: expected 3 to be 999 // Object.is equality

 FAIL  src/__tests__/math.test.ts > Math functions > TEMP diagnostic failure two
AssertionError: expected 9 to be 999 // Object.is equality
 FAIL  src/__tests__/math.test.ts > Math functions > adds correctly
 FAIL  src/__tests__/math.test.ts > Math functions > subtracts correctly
 FAIL  src/__tests__/math.test.ts > Math functions > multiplies correctly
 FAIL  src/__tests__/math.test.ts > Math functions > divides correctly
 FAIL  src/__tests__/math.test.ts > Math functions > clamps correctly

 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 7 passed (9)
`;
test('buildFailingTestChecklist extracts vitest\'s "Failed Tests" recap lines', () => {
    const result = buildFailingTestChecklist(REAL_VITEST_FAILURE_SUMMARY);
    assert.ok(result, 'expected a checklist for 7 distinct vitest failures');
    assert.match(result, /7 TESTS ARE STILL FAILING/);
    assert.match(result, /Math functions > TEMP diagnostic failure one/);
    assert.match(result, /Math functions > clamps correctly/);
    // Should not accidentally include the compact "× ... 3ms" summary duplicate or the bare
    // "Tests  2 failed | 7 passed (9)" footer as a fake test name.
    assert.doesNotMatch(result, /\d+ms\s*$/m);
});
test('buildFailingTestChecklist does not fire on a small vitest failure list', () => {
    const small = `
 FAIL  src/__tests__/math.test.ts > Math functions > TEMP diagnostic failure one
 FAIL  src/__tests__/math.test.ts > Math functions > TEMP diagnostic failure two

 Test Files  1 failed | 1 passed (2)
`;
    assert.equal(buildFailingTestChecklist(small), null);
});
test('detectStrayPatchMarkers fires on real patch-format delimiter text leaking into full output', () => {
    const corrupted = `
import { describe, it, expect } from 'vitest'
// @@@ WITH:
describe('foo', () => { it('works', () => { expect(1).toBe(1) }) })
`;
    assert.equal(detectStrayPatchMarkers(corrupted), true);
});
test('detectStrayPatchMarkers does not fire on ordinary code with unrelated // comments', () => {
    const clean = `
// @@ this is just a regular comment, not a patch marker
describe('foo', () => { it('works', () => { expect(1).toBe(1) }) })
`;
    assert.equal(detectStrayPatchMarkers(clean), false);
});
// Real text captured by running a fresh `npx jest` (v29) against a throwaway fixture with a bare
// `setInterval(() => {}, 1000)` and no cleanup, under a config with `forceExit: true` (the exact
// setting kabo-cash-api's own jest.config.ts uses) — this is the line Jest prints when forceExit
// had to actually kill a lingering handle, WITHOUT --detectOpenHandles being passed at all.
const REAL_FORCE_EXIT_OUTPUT = `
Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        0.142 s
Ran all test suites matching leak.test.js.
Force exiting Jest: Have you considered using \`--detectOpenHandles\` to detect async operations that kept running after all tests finished?
`;
// Real text captured from the SAME fixture run WITHOUT forceExit at all — Jest prints this line
// within ~1s and then hangs indefinitely (verified empirically: the process was still alive and
// printed nothing further after 8+ seconds) rather than exiting on its own.
const REAL_NO_FORCE_EXIT_OUTPUT = `
Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        0.139 s
Ran all test suites matching leak.test.js.
Jest did not exit one second after the test run has completed.

'This usually means that there are asynchronous operations that weren't stopped in your tests. Consider running Jest with \`--detectOpenHandles\` to troubleshoot this issue.
`;
test('detectOpenHandleLeak fires on the real forceExit "Force exiting Jest" line', () => {
    assert.equal(detectOpenHandleLeak(REAL_FORCE_EXIT_OUTPUT), true);
});
test('detectOpenHandleLeak fires on the real no-forceExit "did not exit" line', () => {
    assert.equal(detectOpenHandleLeak(REAL_NO_FORCE_EXIT_OUTPUT), true);
});
test('detectOpenHandleLeak does not fire on a normal clean passing run', () => {
    const clean = `
Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Time:        0.1 s
`;
    assert.equal(detectOpenHandleLeak(clean), false);
});
test('buildOpenHandleLeakMessage names the concrete fix (clear the handle or call cleanup)', () => {
    const msg = buildOpenHandleLeakMessage();
    assert.match(msg, /clearInterval|clearTimeout/);
    assert.match(msg, /cleanup\/stop export/);
});
// Real text captured by running `npx jest --coverage` against a real React Native/Expo project
// that has BOTH jest.config.js (with coverageReporters/coverageDirectory correctly set) AND a
// "jest" key in package.json — jest refuses to pick one and exits in well under a second, before
// running a single test. Without this detector, "Could not read coverage report" (the generic
// fallback) is actively wrong here: the config IS correct, jest just never used it.
const REAL_JEST_MULTIPLE_CONFIGS_OUTPUT = `
● Multiple configurations found:

    * /Users/octagon/Documents/github/kabocash-mobile-RN-expo/jest.config.js
    * \`jest\` key in /Users/octagon/Documents/github/kabocash-mobile-RN-expo/package.json

  Implicit config resolution does not allow multiple configuration files.
  Either remove unused config files or select one explicitly with \`--config\`.

  Configuration Documentation:
  https://jestjs.io/docs/configuration
`;
test('detectJestConfigConflict fires on the real captured "Multiple configurations found" error and names both sources', () => {
    const result = detectJestConfigConflict(REAL_JEST_MULTIPLE_CONFIGS_OUTPUT);
    assert.ok(result, 'expected a config-conflict message');
    assert.match(result, /jest\.config\.js/);
    assert.match(result, /`jest` key in/);
    assert.match(result, /package\.json/);
});
test('detectJestConfigConflict returns null on a normal passing coverage run', () => {
    const clean = `
Tests:       12 passed, 12 total
Test Suites: 3 passed, 3 total
`;
    assert.equal(detectJestConfigConflict(clean), null);
});
// Real text captured on the SAME real React Native/Expo project, immediately after fixing the
// "Multiple configurations found" conflict above: jest-expo's preset requires the since-split-out
// @react-native/jest-preset package, and jest wraps this in its generic "Validation Error"
// envelope — the same "● <Title>:" + "Configuration Documentation:" shape as the config-conflict
// case, just a completely different underlying cause. Confirms detectJestValidationError catches
// the whole family generically rather than needing a third detector for this specific error too.
const REAL_JEST_EXPO_PRESET_VALIDATION_ERROR = `
● Validation Error:

  An unknown error occurred in jest-expo:

  The React Native Jest preset has moved to a separate package.
To migrate, please install "@react-native/jest-preset" and update your
jest.config.js to reference:
  preset: '@react-native/jest-preset'
  Error: The React Native Jest preset has moved to a separate package.
To migrate, please install "@react-native/jest-preset" and update your
jest.config.js to reference:
  preset: '@react-native/jest-preset'
    at Object.<anonymous> (/Users/octagon/Documents/github/kabocash-mobile-RN-expo/node_modules/react-native/jest-preset.js:17:11)
    at Module._compile (node:internal/modules/cjs/loader:1734:14)

  Configuration Documentation:
  https://jestjs.io/docs/configuration
`;
test('detectJestValidationError fires on a real jest-expo preset migration error and names the fix', () => {
    const result = detectJestValidationError(REAL_JEST_EXPO_PRESET_VALIDATION_ERROR);
    assert.ok(result, 'expected a validation-error message');
    assert.match(result, /@react-native\/jest-preset/);
    assert.doesNotMatch(result, /make sure your (jest|vitest) config has coverage enabled/i);
});
test('detectJestValidationError strips stack-trace lines from the body', () => {
    const result = detectJestValidationError(REAL_JEST_EXPO_PRESET_VALIDATION_ERROR);
    assert.doesNotMatch(result, /at Object\.<anonymous>/);
});
test('detectJestValidationError does not fire on an ordinary per-file "Test suite failed to run" bullet (no Configuration Documentation footer)', () => {
    const ordinaryCrash = `
FAIL src/interactors/__tests__/adminUsers.interactor.test.ts
  ● Test suite failed to run

    TypeError: Cannot read properties of undefined (reading 'on')

Tests:       0 total
`;
    assert.equal(detectJestValidationError(ordinaryCrash), null);
});
test('detectJestValidationError returns null on a normal passing coverage run', () => {
    const clean = `
Tests:       12 passed, 12 total
Test Suites: 3 passed, 3 total
`;
    assert.equal(detectJestValidationError(clean), null);
});
// Real corruption captured on kabocash-mobile-RN-expo: a truncated ---MOCKS_FILE--- response
// left this exact fragment as the shared mock file's `renderWithProviders`, which then broke
// 80+ of 87 test files that imported it in a single run.
const REAL_TRUNCATED_MOCKS_FILE = `
import React from 'react';
import { render } from '@testing-library/react-native';

export const renderWithProviders = (ui: React.ReactElement) => {
`;
test('detectUnbalancedMocksSyntax fires on the real truncated renderWithProviders fragment (unclosed brace)', () => {
    assert.equal(detectUnbalancedMocksSyntax(REAL_TRUNCATED_MOCKS_FILE), true);
});
test('detectUnbalancedMocksSyntax does not fire on the real, complete, fixed version', () => {
    const complete = `
import React from 'react';
import { render } from '@testing-library/react-native';

export const renderWithProviders = (ui: React.ReactElement) => render(ui);

export const mockAxios = {
  axiosGet: jest.fn(),
};
`;
    assert.equal(detectUnbalancedMocksSyntax(complete), false);
});
test('detectUnbalancedMocksSyntax ignores braces inside strings, template literals, and comments', () => {
    const tricky = `
// a comment with an unmatched brace {
export const label = "a string with a } in it";
export const tmpl = \`template \${1 + 1} with a brace }\`;
export const fn = () => ({ a: 1 });
`;
    assert.equal(detectUnbalancedMocksSyntax(tricky), false);
});
test('detectUnbalancedMocksSyntax fires on an extra unmatched closing brace', () => {
    const extra = `
export const fn = () => { return 1; };
}
`;
    assert.equal(detectUnbalancedMocksSyntax(extra), true);
});
//# sourceMappingURL=validate.test.js.map