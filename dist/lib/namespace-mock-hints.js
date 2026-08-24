// Namespace-import mock SHAPE.
//
// When the source does `import * as NS from 'mod'` and reads `NS.foo`, that reads the module's
// TOP-LEVEL `foo` export. A `jest.mock('mod', () => ({ … }))` / `vi.mock` factory must therefore
// expose `foo` at the TOP LEVEL:  `jest.mock('mod', () => ({ foo: … }))`.
//
// The trap this catches: mocking it NESTED — e.g. `() => ({ NS: { foo: … } })` (often paired with a
// wrong `import { NS } from 'mod'` in the test). Then the SOURCE's `NS.foo` (a top-level namespace
// member) is `undefined`, so a value silently defaults (`?? fallback`) and the code takes the wrong
// branch. There is NO "x is not a function" crash — just a WRONG assertion — so it's nearly
// impossible to fix by editing anything other than the mock shape, and a fix loop burns every
// retry on the wrong lever (observed live: an expo-application mock nested `nativeApplicationVersion`
// under an `Application` key, so `currentVersion` was stuck at the `?? '0.0.0'` fallback and a
// version-gate test could never pass).
const NS_IMPORT = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
// Namespace-imported but essentially never mocked wholesale — listing them (esp. in generate mode,
// which has no test to cross-reference) would be noise. A test that genuinely DOES mock one still
// gets flagged in fix mode via the `test mocks the module` gate below.
const NEVER_MOCKED_WHOLESALE = new Set(['react', 'react-dom', 'react-native']);
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Members are reads like `NS.foo` / `NS.foo.bar` / `NS.foo(`; capture the FIRST segment after NS.
export function extractNamespaceImports(sourceCode) {
    const out = new Map();
    for (const m of sourceCode.matchAll(NS_IMPORT)) {
        const ns = m[1];
        const module = m[2];
        const memberRe = new RegExp(`\\b${escapeRe(ns)}\\.([A-Za-z_$][\\w$]*)`, 'g');
        const members = new Set();
        for (const mm of sourceCode.matchAll(memberRe))
            members.add(mm[1]);
        if (members.size > 0)
            out.set(ns, { module, members });
    }
    return out;
}
/**
 * Guidance on the required top-level mock shape for every module the source namespace-imports.
 * In fix mode (testCode given) it only flags modules the test actually mocks — the high-signal case.
 * In generate mode it lists them proactively so the first attempt gets the shape right. Not gated on
 * the error kind: the failure this prevents is a WRONG-VALUE assertion, not a missing-field crash.
 */
export function buildNamespaceMockHint(sourceCode, testCode, _errorOutput) {
    if (!sourceCode)
        return null;
    const imports = extractNamespaceImports(sourceCode);
    if (imports.size === 0)
        return null;
    const rows = [];
    for (const [ns, { module, members }] of imports) {
        // Fix mode: only flag modules the test mocks (that's where a shape mismatch bites). Generate
        // mode: skip framework modules nobody mocks wholesale (react/react-native) to avoid noise.
        if (testCode) {
            if (!new RegExp(`(?:jest|vi)\\.mock\\(\\s*['"]${escapeRe(module)}['"]`).test(testCode))
                continue;
        }
        else if (NEVER_MOCKED_WHOLESALE.has(module)) {
            continue;
        }
        const memberList = [...members];
        const reads = memberList.map((m) => `${ns}.${m}`).join(', ');
        const shape = memberList.map((m) => `${m}: …`).join(', ');
        rows.push(`  • '${module}' is imported as \`import * as ${ns}\`; the source reads ${reads}. Mock it with those names at the TOP LEVEL: (jest|vi).mock('${module}', () => ({ __esModule: true, ${shape} })).`);
    }
    if (rows.length === 0)
        return null;
    return buildNamespaceShapeText(imports, rows);
}
function buildNamespaceShapeText(imports, rows) {
    return ('NAMESPACE-IMPORT MOCK SHAPE: `import * as NS from \'mod\'` then `NS.foo` reads the module\'s ' +
        'TOP-LEVEL `foo` export — so the mock factory must expose those names at the top level, NOT nested ' +
        'under another key (e.g. NOT `() => ({ ' + [...imports.keys()][0] + ': { … } })`):\n' +
        rows.join('\n') + '\n' +
        'If you nest them, the source\'s `NS.foo` is `undefined`, a value silently defaults, and the code takes ' +
        'the WRONG branch — a wrong assertion with no crash to point at.\n' +
        'VARYING A VALUE PER TEST (esp. a plain `const` export like a version string, NOT a jest.fn()): include ' +
        '`__esModule: true` in the factory so `import * as NS` returns the mock object DIRECTLY (without it, the ' +
        'interop copies the namespace and your per-test change is lost). Then set the value by MUTATING the same ' +
        'object the source reads: `import * as NS from \'mod\'; (NS as { foo: T }).foo = value` in beforeEach and in ' +
        'each test that needs a different value. Do NOT try to change it with a new jest.fn() or a nested object — ' +
        'the source reads `NS.foo`, so `NS.foo` is exactly what must be set. Full working shape:\n' +
        '  jest.mock(\'mod\', () => ({ __esModule: true, foo: \'default\' }));\n' +
        '  import * as NS from \'mod\';\n' +
        '  beforeEach(() => { (NS as { foo: string }).foo = \'default\'; });\n' +
        '  it(\'case\', () => { (NS as { foo: string }).foo = \'other\'; /* … */ });');
}
// jest.mock()/vi.mock() calls are HOISTED above the file's imports. A factory that references a mock
// VALUE imported from a shared mocks file — `jest.mock('@/x', () => ({ useX: mockUseX }))` — needs
// that shared module already loaded when the factory RUNS. If the test imports the module-under-test
// BEFORE the shared mocks file, loading the source triggers the factory (via the source's transitive
// import of the mocked module) while `mockUseX` is still undefined → "Cannot read properties of
// undefined (reading 'mockUseX')" AT the jest.mock line, and the WHOLE suite fails to load (0 tests).
const HOIST_UNDEF_RE = /Cannot read propert(?:y|ies) of undefined \(reading '(mock[\w$]*)'\)/i;
export function buildHoistedMockOrderHint(errorOutput, testCode) {
    if (!errorOutput)
        return null;
    const m = HOIST_UNDEF_RE.exec(errorOutput);
    if (!m)
        return null;
    const varName = m[1];
    // Only fire when that name is actually a mock var the test uses (in a jest.mock factory or anywhere).
    if (testCode && !new RegExp(`\\b${escapeRe(varName)}\\b`).test(testCode))
        return null;
    return (`HOISTED MOCK ORDER: the suite failed to LOAD — "Cannot read properties of undefined (reading '${varName}')" ` +
        `at a jest.mock()/vi.mock() line. Those calls are HOISTED above the imports, and this factory references ` +
        `\`${varName}\` (imported from a shared mocks/helpers file). Because the module-under-test is imported BEFORE ` +
        `that shared file, loading the source runs the factory while \`${varName}\` is still undefined. FIX: move the ` +
        `import of the shared mocks file (the one exporting \`${varName}\`) ABOVE the import of the module under test — ` +
        `mock-value imports must come first. If the ordering is awkward, reference it lazily inside the factory instead: ` +
        `\`() => ({ useX: (...a) => require('<shared-mocks>').${varName}(...a) })\`. This is a load-order bug, not an ` +
        `assertion or mock-shape problem — do NOT change the assertions or the mocked return value.`);
}
//# sourceMappingURL=namespace-mock-hints.js.map