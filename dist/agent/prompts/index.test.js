import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFixPrompt, buildRetryPrompt } from './index.js';
import { buildVueGuidance } from './vue.js';
import { TAG_NEVER_TYPE_MOCK, TAG_UNSAFE_CAST, TAG_ENUM_COLLISION, TAG_TOP_LEVEL_AWAIT, } from '../../lib/memory/pattern-tags.js';
const JEST_ENV = {
    testRunner: 'jest',
    language: 'typescript',
    testFilePattern: '**/*.test.ts',
    coverageCommand: 'npx jest --coverage',
    testCommand: 'npx jest',
    jestTestPathFlag: '--testPathPatterns',
};
// Mocha has no built-in mocking API at all (no global `.fn()`/`.mock()`) — projects bring their
// own (commonly sinon). Real bug found this session: mockApi's ternary (`testRunner === 'vitest'
// ? 'vi' : 'jest'`) defaulted mocha to 'jest', so generated mocha tests were told to write
// jest.fn()/jest.mock() calls that don't exist at runtime under mocha.
const MOCHA_ENV = {
    testRunner: 'mocha',
    language: 'typescript',
    testFilePattern: '**/*.test.ts',
    coverageCommand: 'npx nyc mocha',
    testCommand: 'npx mocha',
    jestTestPathFlag: '',
};
function promptFor(errorOutput, coveredPatterns) {
    return buildFixPrompt({
        testFile: 'src/foo.test.ts',
        testCode: 'it("works", () => { expect(1).toBe(1) })',
        sourceFile: null,
        sourceCode: null,
        errorOutput,
        env: JEST_ENV,
        coveredPatterns,
    });
}
// Real (representative) tsc output shapes, matching the regexes in detectTypeScriptErrors and
// pattern-tags.ts's PATTERN_TAGS exactly — these are what a genuine `tsc`/jest run would surface.
const NEVER_TYPE_MOCK_ERROR = [
    'src/foo.test.ts:42:10 - error TS2345: Argument of type \'string\' is not assignable to parameter of type \'never\'.',
    'src/foo.test.ts:97:10 - error TS2345: Argument of type \'string\' is not assignable to parameter of type \'never\'.',
].join('\n');
const UNSAFE_CAST_ERROR = 'src/foo.test.ts:10:5 - error TS2352: Conversion of type \'Redis\' to type \'{ add: jest.Mock; }\' may be a mistake because neither type sufficiently overlaps with the other.';
const ENUM_COLLISION_ERROR = 'src/foo.test.ts:5:3 - error TS2322: Type \'Status.Active\' is not assignable to type \'Status\'.';
const TOP_LEVEL_AWAIT_ERROR = 'src/foo.test.ts:1:1 - error TS1378: Top-level \'await\' expressions are only allowed when the \'module\' option is set to \'esnext\', \'system\', \'node16\', \'nodenext\', or \'preserve\', and the \'target\' option is set to \'es2017\' or higher.';
test('never-type-mock: static WRONG/RIGHT example present when NOT covered', () => {
    const prompt = promptFor(NEVER_TYPE_MOCK_ERROR, []);
    assert.match(prompt, /at line\(s\) 42, 97/, 'dynamic line-number reference should be present');
    assert.match(prompt, /jest\.Mock<\(\) => Promise<string>>/, 'static WRONG/RIGHT example should be present when not covered');
    assert.match(prompt, /SAME fix needed at ALL 2 locations/, 'multi-location instruction should be present');
});
test('never-type-mock: static example dropped, dynamic content survives when covered', () => {
    const prompt = promptFor(NEVER_TYPE_MOCK_ERROR, [TAG_NEVER_TYPE_MOCK]);
    assert.match(prompt, /at line\(s\) 42, 97/, 'dynamic line-number reference should survive suppression');
    assert.doesNotMatch(prompt, /jest\.Mock<\(\) => Promise<string>>/, 'static WRONG/RIGHT example should be dropped when covered');
    assert.match(prompt, /SAME fix needed at ALL 2 locations/, 'multi-location instruction should survive suppression (dynamic, not duplicated in memory)');
});
test('unsafe-cast: static Better/Quick fix present when NOT covered', () => {
    const prompt = promptFor(UNSAFE_CAST_ERROR, []);
    assert.match(prompt, /Unsafe cast \(TS2352\) to '\{ add: jest\.Mock; \}'/, 'dynamic targets line should be present');
    assert.match(prompt, /Better fix: jest\.mock\(\)/, 'static explanation should be present when not covered');
});
test('unsafe-cast: static Better/Quick fix dropped, dynamic targets line survives when covered', () => {
    const prompt = promptFor(UNSAFE_CAST_ERROR, [TAG_UNSAFE_CAST]);
    assert.match(prompt, /Unsafe cast \(TS2352\) to '\{ add: jest\.Mock; \}'/, 'dynamic targets line should survive suppression');
    assert.doesNotMatch(prompt, /Better fix: jest\.mock\(\)/, 'static explanation should be dropped when covered');
});
test('enum-collision: full explanation present when NOT covered', () => {
    const prompt = promptFor(ENUM_COLLISION_ERROR, []);
    assert.match(prompt, /Type collision \('Status' not assignable to itself\)/, 'dynamic type name should be present');
    assert.match(prompt, /DELETE any local 'Status' declaration/, 'static explanation should be present when not covered');
});
test('enum-collision: full explanation dropped, short dynamic reference survives when covered', () => {
    const prompt = promptFor(ENUM_COLLISION_ERROR, [TAG_ENUM_COLLISION]);
    assert.match(prompt, /Type collision \('Status' not assignable to itself\)/, 'dynamic type name should survive suppression');
    assert.doesNotMatch(prompt, /DELETE any local 'Status' declaration/, 'static explanation should be dropped when covered');
});
test('top-level-await: full suppression removes the entire static block when covered', () => {
    const uncovered = promptFor(TOP_LEVEL_AWAIT_ERROR, []);
    assert.match(uncovered, /Top-level await \(TS1378\)/, 'block should be present when not covered');
    const covered = promptFor(TOP_LEVEL_AWAIT_ERROR, [TAG_TOP_LEVEL_AWAIT]);
    assert.doesNotMatch(covered, /Top-level await \(TS1378\)/, 'block should be fully suppressed when covered');
});
test('unrelated pattern tags in coveredPatterns do not suppress an unrelated error', () => {
    // A never-type-mock coverage confirmation must not accidentally suppress an unsafe-cast error
    // present in the SAME output — suppression is gated per-pattern, not "any coverage at all".
    const combined = [NEVER_TYPE_MOCK_ERROR, UNSAFE_CAST_ERROR].join('\n');
    const prompt = promptFor(combined, [TAG_NEVER_TYPE_MOCK]);
    assert.doesNotMatch(prompt, /jest\.Mock<\(\) => Promise<string>>/, 'never-type-mock example should still be suppressed');
    assert.match(prompt, /Better fix: jest\.mock\(\)/, 'unsafe-cast explanation should remain since it was not covered');
});
// Real text captured from a lacuna debug log on a real production project — a mock object
// missing a method (findOneAndDelete) that the source actually calls. Recurred 4 times before
// the model traced it back to the mock's shape; no existing detector recognized it (it's a
// runtime TypeError, not a compile-time `error TS\d+:` diagnostic detectTypeScriptErrors gates on).
const REAL_MOCK_SHAPE_MISMATCH_ERROR = `
FAIL src/interactors/__tests__/adminUsers.interactor.test.ts
  ● AdminUsersInteractor › resetSecurityQuestions › resets security questions successfully

    TypeError: (0 , securityQuestions_repo_1.createSecurityQuestionsRepo)(...).findOneAndDelete is not a function

      493 |     const [updateRecord, deleteRecord] = await Promise.all([
          |                                                             ^
`;
test('detectMockShapeMismatch names the missing method on a real captured runtime TypeError', () => {
    const prompt = promptFor(REAL_MOCK_SHAPE_MISMATCH_ERROR, []);
    assert.match(prompt, /MOCK SHAPE MISMATCH/);
    assert.match(prompt, /findOneAndDelete/);
    assert.match(prompt, /NOT a TypeScript error/);
});
test('detectMockShapeMismatch does not fire on a normal assertion failure', () => {
    const prompt = promptFor(NEVER_TYPE_MOCK_ERROR, []);
    assert.doesNotMatch(prompt, /MOCK SHAPE MISMATCH/);
});
// Real symptom: a jest project's retry prompt used to hardcode 'vi.mock(...)' (buildRetryPrompt
// had no runner parameter at all) — telling a jest project to use vitest syntax. Fixed by
// threading mockApi through from the generator's own env.testRunner.
const REAL_REQUEST_ERROR = `
TypeError: Network Error
    at XMLHttpRequestImpl._onError
Intercepted a real request to https://api.example.com/users, status: 500
`;
test('buildRetryPrompt names jest.mock() when the project is jest, not vi.mock()', () => {
    const prompt = buildRetryPrompt(REAL_REQUEST_ERROR, [], false, true, [], 'jest');
    assert.match(prompt, /jest\.mock\('axios'\)/);
    assert.doesNotMatch(prompt, /vi\.mock\('axios'\)/);
});
test('buildRetryPrompt defaults to vi.mock() for backward compatibility when mockApi is omitted', () => {
    const prompt = buildRetryPrompt(REAL_REQUEST_ERROR, [], false, true, []);
    assert.match(prompt, /vi\.mock\('axios'\)/);
});
test('buildVueGuidance names jest.advanceTimersByTime() for a jest project, not vi.advanceTimersByTime()', () => {
    const guidance = buildVueGuidance('jest');
    assert.match(guidance, /jest\.advanceTimersByTime\(\)/);
    assert.doesNotMatch(guidance, /vi\.advanceTimersByTime\(\)/);
});
test('buildVueGuidance omits the timer-API line entirely for mocha (sinon has no advanceTimersByTime)', () => {
    const guidance = buildVueGuidance('jest', false);
    assert.doesNotMatch(guidance, /advanceTimersByTime/);
    assert.doesNotMatch(guidance, /jest\./);
});
// Full-prompt regression coverage: a mocha project's fix prompt must never assert jest.fn()/
// jest.mock()/vi.fn()/vi.mock() exist, since neither API is real under mocha's runtime. A jest
// project's prompt must still contain the real jest.fn()/jest.mock() guidance (no regression).
test('buildFixPrompt for a mocha project contains no jest.fn()/jest.mock()/vi.fn()/vi.mock() assertions', () => {
    const prompt = buildFixPrompt({
        testFile: 'src/foo.test.ts',
        testCode: 'it("works", () => { expect(1).toBe(1) })',
        sourceFile: 'src/foo.ts',
        sourceCode: 'export function foo() { return 1 }',
        errorOutput: 'AssertionError: expected 2 to equal 1',
        env: MOCHA_ENV,
        mocksCode: "export const mockThing = sinon.stub()",
        mocksImportPath: './mocks',
    });
    // The mocks file's own real content (sinon-based, since this is mocha) is expected to appear —
    // only lacuna's OWN generated instructional text must never assert a jest/vi API exists.
    const withoutFileContent = prompt.replace(/```[\s\S]*?```/g, '');
    assert.doesNotMatch(withoutFileContent, /jest\.fn\(\)/);
    assert.doesNotMatch(withoutFileContent, /jest\.mock\(/);
    assert.doesNotMatch(withoutFileContent, /vi\.fn\(\)/);
    assert.doesNotMatch(withoutFileContent, /vi\.mock\(/);
});
test('buildFixPrompt for a jest project still contains real jest.fn()/jest.mock() guidance (no regression)', () => {
    const prompt = buildFixPrompt({
        testFile: 'src/foo.test.ts',
        testCode: 'it("works", () => { expect(1).toBe(1) })',
        sourceFile: 'src/foo.ts',
        sourceCode: 'export function foo() { return 1 }',
        errorOutput: 'AssertionError: expected 2 to equal 1',
        env: JEST_ENV,
        mocksCode: "export const mockThing = jest.fn()",
        mocksImportPath: './mocks',
    });
    assert.match(prompt, /jest\.fn\(\)/);
    assert.match(prompt, /jest\.mock\(/);
});
//# sourceMappingURL=index.test.js.map