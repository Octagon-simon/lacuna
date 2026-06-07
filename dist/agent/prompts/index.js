import { buildSourceSkeleton, shouldUseSkeleton, compressSource, filterMockFileForTest, filterMockFileForSource } from '../../lib/skeleton.js';
import { detectReactNative, buildReactNativeGuidance, detectRntlErrors } from './react-native.js';
import { analyzeNextJs, buildNextJsGuidance, detectNextJsImportError } from './nextjs.js';
import { buildReactCauses } from './react.js';
import { detectVue, buildVueGuidance } from './vue.js';
import { buildJsCauses } from './runners/js-common.js';
import { buildVitestCauses } from './runners/vitest.js';
import { buildTsRule } from './runners/typescript.js';
// ─── Setup file mock extractor ────────────────────────────────────────────────
function extractGlobalNextMocks(setupCode) {
    const mocked = [];
    for (const m of setupCode.matchAll(/(?:vi|jest)\.mock\(['"]([^'"]+)['"]/g)) {
        mocked.push(m[1]);
    }
    return [...new Set(mocked)];
}
const API_IMPORT_RE = /\/(?:api|services?|requests?|http|client|network)\/|\/(?:api|axios|http|request)(?:Client|Config|Instance|Service|Helper)?(?:\/|$)|[/.]api(?:[./]|$)/i;
function analyzeNetworkDeps(sourceCode) {
    const usesAxios = /\baxios\b/.test(sourceCode);
    const usesFetch = /\bfetch\s*\(/.test(sourceCode);
    const usesCustomInstance = /axios\.create\s*\(/.test(sourceCode);
    const apiModuleImports = [];
    for (const m of sourceCode.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const path = m[1];
        if (API_IMPORT_RE.test(path))
            apiModuleImports.push(path);
    }
    return { usesAxios, usesFetch, usesCustomInstance, apiModuleImports };
}
function buildNetworkMockingGuidance(analysis, sourceFile, mockApi) {
    if (!analysis.usesAxios && !analysis.usesFetch && analysis.apiModuleImports.length === 0)
        return null;
    const lines = ['NETWORK MOCKING (critical — a real HTTP request reaching the network is a test bug):'];
    if (analysis.apiModuleImports.length > 0) {
        lines.push(`The source file imports from API/service modules: ${analysis.apiModuleImports.join(', ')}`, `Mock THOSE modules, not the underlying HTTP client:`, `  ${mockApi}.mock('${analysis.apiModuleImports[0]}', () => ({ myFn: ${mockApi}.fn() }))`, `This is the most reliable approach — it intercepts at the contract boundary regardless of which HTTP client is used underneath.`);
    }
    if (analysis.usesCustomInstance) {
        lines.push(`The source creates a custom axios instance (axios.create()). ${mockApi}.mock('axios') alone WILL NOT intercept calls made through a custom instance.`, `Instead: mock the module that exports the axios instance, or mock the API service module that wraps it.`);
    }
    else if (analysis.usesAxios && analysis.apiModuleImports.length === 0) {
        lines.push(`The source imports axios directly. Mock it with: ${mockApi}.mock('axios') and set return values with axios.get.mockResolvedValue({ data: ... })`);
    }
    if (analysis.usesFetch) {
        lines.push(`The source uses fetch. Mock it with: ${mockApi}.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(data)))`);
    }
    lines.push(`If you see a real URL (e.g. https://...) or a 401/403/network error in the test output, your mock is missing or at the wrong module level. Fix it before the test can pass.`);
    return lines.join('\n');
}
function parseMockInventory(code) {
    const entries = [];
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const mockMatch = lines[i].match(/\b(?:vi|jest)\.mock\(\s*(['"])([^'"]+)\1/);
        if (!mockMatch)
            continue;
        const modulePath = mockMatch[2];
        const lineNumber = i + 1;
        const exports = [];
        let braceDepth = 0;
        let inFactory = false;
        for (let j = i; j < Math.min(i + 80, lines.length); j++) {
            const l = lines[j];
            if (!inFactory && /\(\)\s*=>\s*\(?\s*\{/.test(l))
                inFactory = true;
            if (!inFactory)
                continue;
            for (const ch of l) {
                if (ch === '{')
                    braceDepth++;
                if (ch === '}')
                    braceDepth--;
            }
            const multiLine = l.match(/^\s{2,}(\w+)\s*:\s*(\w+)/);
            if (multiLine && multiLine[1] !== 'type') {
                const key = multiLine[1], val = multiLine[2];
                exports.push(val && val !== key ? `${key}(${val})` : key);
            }
            if (j === i || l.includes('() =>') || l.includes('() => {')) {
                for (const m of l.matchAll(/\b(\w+)\s*:\s*(mock\w+)/gi)) {
                    const key = m[1], val = m[2];
                    const entry = val.toLowerCase() !== `mock${key.toLowerCase()}` ? `${key}(${val})` : key;
                    if (!exports.some(e => e === key || e.startsWith(`${key}(`)))
                        exports.push(entry);
                }
            }
            if (braceDepth <= 0 && inFactory)
                break;
        }
        entries.push({ modulePath, lineNumber, exports });
    }
    return entries;
}
function parseMockExports(code) {
    const names = [];
    for (const m of code.matchAll(/^export\s+(?:const|let|var|function|class|async\s+function)\s+(\w+)/gm)) {
        names.push(m[1]);
    }
    for (const m of code.matchAll(/^export\s*\{([^}]+)\}/gm)) {
        for (const part of m[1].split(',')) {
            const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
            if (alias && /^\w+$/.test(alias))
                names.push(alias);
        }
    }
    const defM = code.match(/^export\s+default\s+(\w+)/m);
    if (defM)
        names.push(`default (${defM[1]})`);
    return [...new Set(names)];
}
// ─── Error detectors ──────────────────────────────────────────────────────────
function detectTypeScriptErrors(errorOutput) {
    if (!/error TS\d+:/.test(errorOutput))
        return null;
    const parts = [
        'TYPESCRIPT ERRORS — treat each compiler message as an exact instruction, not a hint:',
        'The TypeScript compiler tells you precisely what is wrong and usually what the fix is.',
        'Do NOT override it with framework conventions or assumptions.',
    ];
    if (/TS1378/.test(errorOutput)) {
        parts.push('• Top-level await (TS1378): move ALL await calls inside it()/test()/beforeEach()/etc.', '  WRONG: const result = await fn();', '  RIGHT: it("desc", async () => { const result = await fn(); });');
    }
    const propErrors = [...errorOutput.matchAll(/'(\w+)' does not exist (?:on|in) type '\{([^']+)\}'/g)];
    if (propErrors.length > 0) {
        parts.push('• Wrong member name — the actual available members are:');
        const seen = new Set();
        for (const m of propErrors) {
            const wrongProp = m[1];
            const available = [...m[2].matchAll(/(\w+)\s*[?]?\s*:/g)].map(p => p[1]).filter(p => p !== 'type');
            const key = wrongProp + available.join();
            if (seen.has(key))
                continue;
            seen.add(key);
            parts.push(`  '${wrongProp}' → not valid. Use one of: ${available.slice(0, 12).join(', ')}${available.length > 12 ? ' …' : ''}`);
        }
    }
    const suggestions = [...new Set([...errorOutput.matchAll(/Did you mean(?: to write)? '(\w+)'\?/g)].map(m => m[1]))];
    if (suggestions.length > 0) {
        parts.push(`• Compiler suggestion: use ${suggestions.map(s => `'${s}'`).join(', ')}`);
    }
    const typeMismatches = [...errorOutput.matchAll(/Argument of type '([^']+)' is not assignable to parameter of type '([^']+)'/g)];
    if (typeMismatches.length > 0) {
        for (const m of typeMismatches) {
            parts.push(`• Type mismatch: passed '${m[1].slice(0, 80)}', required '${m[2].slice(0, 80)}'`);
        }
        parts.push('  (use null not undefined for nullable values; check TYPE DEFINITIONS for the required shape)');
    }
    const otherErrors = [...errorOutput.matchAll(/error (TS(?!1378|2339|2551|2561|2345)\d+): ([^\n]+)/g)];
    if (otherErrors.length > 0) {
        parts.push('• Additional compiler errors — read each one and apply the exact fix it describes:');
        const seen = new Set();
        for (const m of otherErrors) {
            const msg = `${m[1]}: ${m[2].slice(0, 120)}`;
            if (seen.has(msg))
                continue;
            seen.add(msg);
            parts.push(`  ${msg}`);
        }
    }
    return parts.join('\n');
}
function detectThinkingBleed(errorOutput) {
    const parseErr = errorOutput.match(/PARSE_ERROR|Unexpected token|SyntaxError.*\b1:\d+\b/);
    if (!parseErr)
        return null;
    const contextLine = errorOutput.match(/^\s*1\s*[│|]\s*(.+)/m);
    if (!contextLine)
        return null;
    const firstLine = contextLine[1].trim();
    if (/^(import|export|const|let|var|\/\/|\/\*|describe|it\s*\(|test\s*\(|vi\.|jest\.)/.test(firstLine))
        return null;
    return [
        `THINKING BLEED DETECTED — your previous response had reasoning text inside <code_output>.`,
        `The file started with: "${firstLine.slice(0, 80)}"`,
        `This is not valid TypeScript and caused a parse error at line 1.`,
        `RULE: finish ALL reasoning inside <thinking> first. Once <code_output> opens, the very first character must be valid code — an import, function definition, comment (//, #), or similar construct for the project's language.`,
        `Do NOT continue thinking inside <code_output> under any circumstances.`,
    ].join('\n');
}
function detectUnhandledRejection(errorOutput) {
    const hasUnhandled = /unhandled\s+(promise\s+)?rejection|vitest caught \d+ unhandled/i.test(errorOutput);
    const hasRejectedMock = /mockRejectedValue(Once)?/.test(errorOutput);
    if (!hasUnhandled && !hasRejectedMock)
        return null;
    return [
        'UNHANDLED REJECTION DETECTED — a mockRejectedValueOnce (or mockRejectedValue) promise is escaping the test scope.',
        'The component may catch the error internally, but Vitest still requires the rejection to be resolved inside the test.',
        'Required fix: after the action that triggers the rejection, await the resulting error state:',
        "  await waitFor(() => expect(screen.getByText(/error text/i)).toBeInTheDocument())",
        'This chains the rejection inside the test scope. Without it, Vitest flags it as unhandled even if the UI handles it correctly.',
    ].join('\n');
}
function detectRealRequestInError(errorOutput, mockApi = 'vi') {
    const hasRealUrl = /https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(errorOutput);
    const hasHttpStatus = /\bstatus:\s*[45]\d\d\b/.test(errorOutput);
    const hasNetworkError = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network\s+error/i.test(errorOutput);
    if (!hasRealUrl && !hasHttpStatus && !hasNetworkError)
        return null;
    const lines = [
        'REAL HTTP REQUEST DETECTED — the test is hitting the actual network. This is the root cause of the failure.',
        'A mock is either missing entirely or applied at the wrong level. Fix this before anything else.',
    ];
    const urlMatch = errorOutput.match(/https?:\/\/[^\s,'")\]}]+/);
    if (urlMatch)
        lines.push(`Intercepted URL: ${urlMatch[0]}`);
    lines.push('Required fix: find which module the source file imports for its API calls and mock THAT module.', `${mockApi}.mock('axios') does NOT intercept axios.create() instances — you must mock the module that exports the instance or the service layer above it.`);
    return lines.join('\n');
}
// ─── System prompt ────────────────────────────────────────────────────────────
export function buildSystemPrompt(env) {
    const isJS = env.language === 'typescript' || env.language === 'javascript' || env.language === 'unknown';
    const isTS = env.language === 'typescript';
    const isVitest = env.testRunner === 'vitest';
    const isJSRunner = env.testRunner === 'jest' || env.testRunner === 'vitest' || env.testRunner === 'mocha';
    const mockApi = isVitest ? 'vi' : 'jest';
    const mockAuditStep = isJS ? `
    2. MOCK AUDIT — do this before writing a single line of test code:
       a) SOURCE ANCHOR — AI models pattern-match function names to common implementations. A route named "inviteTeamMember" triggers priors about Firestore, teamId parameters, and standard error messages that may be completely wrong for this specific codebase. Override every prior by quoting verbatim from the actual source file before you write anything:
          • Backend routes/functions: (1) list every req.body/req.params/req.query field the source ACTUALLY reads — not what the function name implies; (2) quote the exact database or service call pattern used (e.g. adminDb.ref(path) vs adminDb.collection().doc()); (3) copy every error message string verbatim from each res.json({error:...}) or throw statement in the source; (4) note every HTTP status code and the exact guard condition (if block) that produces it.
          • Components/screens: (1) quote every string literal rendered in JSX/template — not what you assume is shown; (2) list the exact method name on each service/hook call as it appears in the source (e.g. UserService.inviteMember not UserService.invite); (3) note every conditional render guard (ternary, &&) and the exact state variable driving it.
          If ANYTHING you quote differs from what you expected — the source wins. Write tests for what the code ACTUALLY does, not what a similarly-named function typically does.
       b) IMPORT INVENTORY: List every import in the source file. For each client/service/hook, find every method it calls (grep for Client.method() patterns). Mock exactly those methods — nothing more, nothing less. Mocking a method the source never calls is useless; missing a method the source DOES call is a silent failure.
       c) RESPONSE ENVELOPE: At each Client.method() call site, check how the return value is consumed. If the source guards with \`if (res.success)\` or destructures \`{ success, data }\`, the mock MUST return that envelope — NOT a raw array. \`mockResolvedValue([...])\` when the hook expects \`{ success: true, data: [...] }\` produces silently empty state with no error. Pattern: \`const ok = (data: unknown) => ({ success: true, data })\`.
       d) RETURN FIELD ENUMERATION: Check the DEPENDENCY FILE CONTENTS section for each hook's implementation and read its \`return { ... }\` statement. List every key the hook actually returns — not just what the component destructures. A hook may return more keys than the component currently uses, and missing keys in mocks are silently undefined and can break conditional renders, validation, or dynamic text. If the section is absent, fall back to the component's destructure as a minimum baseline.
       e) LOADING TRIGGER MAP: Not all data loads on mount. For each piece of state, find what populates it. If a function like loadResults(classId) must be called explicitly (user selects something), the mount test will never see that data. Map: state → function that populates it → when that function is triggered.
       f) FIXTURE FIELD NAMES: Read the source's selector logic — every .find(), .filter(), and property access. Field names in fixture data must match what the source reads, not what sounds reasonable. \`is_active\` and \`is_current\` are both plausible; only one will pass the filter. Read the source.
       g) MOCK STRUCTURE — object vs factory: when the source imports a client/service as a module export and calls it as \`SomeClient.method()\`, the mock must be a plain object \`{ SomeClient: { method: ${mockApi}.fn() } }\`. If you mock it as \`${mockApi}.fn().mockReturnValue({ method: ${mockApi}.fn() })\`, SomeClient.method is undefined at runtime — the mock replaced a singleton with a callable that the source never calls. The mock structure must match how the source uses the import, not how you'd design an API.
       h) DATA TRANSFORMATIONS: Before writing any assertion about the shape of loaded data, read every .map(), .filter(), and mutation the hook applies to the raw API response. If the hook does \`.map(s => ({ ...s, selected: true, status: 'promoted' }))\`, the fixture assertion must expect the TRANSFORMED shape, not the raw API fixture. Keep two separate fixtures: the raw API response (for mockResolvedValue) and the expected hook output (for assertions).
       i) USEEFFECT COMPOUND SIDE EFFECTS: For each useEffect, read its dependency array AND every state setter it calls. Some effects reset sibling state as a side effect (e.g. fetchSourceClasses always calls setSelectedSourceClassId('')). Setting state that triggers such an effect will silently undo other state you set in the same act(). Map the full chain: which state changes trigger which effects, and what those effects do to other state — before writing any test that sets multiple state values.
       HOOK STATE SYNC: If the test mocks a hook or function that returns an object (e.g. useClasses(), useUsers()), compare its CURRENT return signature in the source against the mocked return object in the test. If any properties are missing, renamed, or stale, realign the mock FIRST — before touching any assertions.
       UNCONDITIONAL CRASH CHECK: Look at the very top of the component body — what fields are destructured and used BEFORE any conditional render (e.g. totalRevenue.toLocaleString(), sessions.length)? Every one of those fields MUST be present in the mock return value or ALL tests will crash immediately.
       MOCK PROP INTERFACE: When mocking a child component (e.g. EmptyState, Modal), check how the PARENT calls it — what prop names does the JSX pass? Use those exact names in the mock, not the names from the child's own prop type definition.
    3. COMPONENT RENDER MAP (React/Vue components only): Before writing any assertion, list what is in the DOM in each relevant state (idle / loading / error / success). Read the template/JSX — check every ternary, &&, and conditional — to determine whether a button is disabled vs unmounted, what text changes, what elements appear.
       GUARD CLAUSE AUDIT: Identify every conditional render guard in the component (e.g. payments.length > 0, isLoading, hasPermission). A test that provides data violating a guard will never find the element — the guard hides it. Match mock data to the guard condition required by each test.
       STALE TEST AUDIT: Check whether any existing test asserts UI or behavior that the current source no longer has. DELETE those tests — do not try to make the component pass a test for features it no longer has.
       BUG-ASSERTING TEST RULE: NEVER write a test that asserts the component/function throws or crashes due to a missing null check, missing guard, or undefined field — unless you have read the source and confirmed the crash path exists. A test named "throws when X is undefined due to missing null check" is testing for a bug, not behavior. If the source handles the case gracefully, test the graceful output instead. If it truly crashes, fix the source — do not write a test to document the bug.` : `
    2. DEPENDENCY AUDIT: List every external dependency the source calls. For each one, determine what needs to be mocked and what return value the code expects. Read every call site — don't infer the expected shape from the type name.
    3. DATA FIXTURE AUDIT: Read the source's selector logic — every filter, find, and field access. Fixture data field names must match what the source reads exactly.`;
    const thinkingTemplate = `
    1. WHAT IS NEEDED: What functions/behaviors are untested or broken?${mockAuditStep}
    4. WHY IT FAILED (retries only): Errors cascade — a compile error hides a resolution error which hides a wiring error which hides a logic error. Fix the first layer and expect a new error to surface. What layer are we on now?
    5. PLAN: List the exact steps you will take before writing a single line of code.`;
    const jsRules = isJS ? `
3. Use path aliases from the PROJECT TYPESCRIPT CONFIG section in IMPORT statements (e.g. "@/components/Button" not "../../components/Button").
   EXCEPTION — mock call paths: use the exact same path string that appears in the SOURCE FILE'S import statement.
   If a LOCAL IMPORT PATHS section is provided, use those pre-computed relative paths in mock calls — they are the fallback when aliases cannot be resolved by the test runner.
   Never second-guess the pre-computed paths. Never convert them back to @/ aliases in mock calls.
4. Only import from packages listed in PROJECT DEPENDENCIES. Do not invent packages that are not listed.
5. When a SHARED MOCK FILE is provided, its exported names are listed under "Available exports". Before writing the test, go through that list and identify every mock that relates to what the source file does. Import and use ALL of those mocks. Never re-create inline ${mockApi}.fn() for anything already exported from the mocks file.
   CRITICAL — never rename or change the casing of existing mock exports.
6. If you need a mock that is missing from the shared mock file, add it to that file AND import it in the test. Return BOTH files separated by exactly one line containing only: // ---MOCKS_FILE---
   CRITICAL — if you have NO new mocks to add, OMIT the // ---MOCKS_FILE--- separator entirely. Do NOT write a comment-only or placeholder mock file (e.g. "// No mocks needed"). Either add real code or omit the separator.
   CRITICAL — when writing the mocks file, you receive the FULL EXISTING content. You MUST write the complete merged result. Never add a second import statement for a module that is already imported — merge all named imports from the same module into one statement. WRONG: line 2 has \`import { View } from 'react-native'\` and you add line 28 \`import { View, Text } from 'react-native'\`. RIGHT: update line 2 to \`import { View, Text } from 'react-native'\` and omit the duplicate.
7. If a SHARED MOCK FILE (does not exist yet) section is shown — create it for any mocks you need and return it using the // ---MOCKS_FILE--- separator.
   CRITICAL — the mocks file must contain ONLY: ${mockApi}.fn() mock definitions, ${mockApi}.mock() module stubs, shared mock objects/constants, and beforeEach reset hooks. NEVER write describe(), it(), test(), or expect() calls in the mocks file.
8. If a TEST SETUP FILE is shown, assume its globals and matchers are already available. Do NOT import or re-declare them.` : `
3. Use the project's import conventions as shown in the source file and existing tests.
4. Only import from packages listed in PROJECT DEPENDENCIES. Do not invent packages that are not listed.`;
    const tsRule = isTS ? buildTsRule(mockApi) : '';
    const ruleCount = isTS ? 10 : (isJS ? 9 : 6);
    const jsOutputRules = isJS ? `
${ruleCount + 2}. Inside <code_output>: output ONLY the test file content (or test file // ---MOCKS_FILE--- mocks file).
    If you use // ---MOCKS_FILE---, everything AFTER the separator is the mocks file. The mocks file must contain ONLY:
    ${mockApi}.fn() mock definitions, ${mockApi}.mock() module stubs, shared constants, and beforeEach resets.
    NEVER put describe(), it(), test(), or expect() calls after the separator.
${ruleCount + 3}. NEVER output vitest.config.ts, jest.config.js, or any framework configuration. If an import cannot be resolved,
    fix it by mocking it with ${mockApi}.mock() — NOT by modifying the test runner configuration.` : '';
    const universalCauses = `- Wrong import paths (use the project's conventions — aliases where configured, relative paths otherwise)
- Importing from test utilities that are not in the dependency list
- Mocking modules that are already mocked in the setup file
- Forgetting to await async functions
- Real HTTP requests: NEVER let a real network call reach the internet. Every function that calls an API must be mocked before the test runs.
- Error surface mismatch: before writing any error-path test, find the catch block. Does it set state, call a notification, or just log silently? Test only what is actually observable from outside.
- Code drift — assert what the code ACTUALLY does: before writing any assertion, re-read the relevant section of the source. If it catches an error and returns null, assert null — not a rejection.`;
    const jsCauses = isJSRunner ? buildJsCauses(mockApi) : '';
    const vitestCauses = isVitest ? buildVitestCauses() : '';
    const reactCauses = buildReactCauses(isJSRunner, mockApi);
    const hookSuiteNote = isJSRunner
        ? `\n- For hooks: cover mutations (save, update, delete) and derived/computed state — not just the initial-load lifecycle. Mutations and derived state are where real bugs hide.`
        : '';
    return `You are a senior QA engineer with 10+ years of experience writing production test suites for ${env.language} projects. You use ${env.testRunner} and you take testing seriously.

Your tests catch real bugs. You think about what could go wrong — null inputs, empty arrays, async race conditions, error boundaries, permission checks, off-by-one errors — and you write assertions that would actually fail if the code broke. You never write a test just to hit a coverage number.

RULES — follow every one:
1. Write tests that verify real behavior: correctness, edge cases, boundary values, and error handling. Never write empty or trivial assertions (e.g. expect(true).toBe(true)).
2. Match the EXACT import style shown in the existing test file or PROJECT TEST EXAMPLES. If none exists, use the style from the source file.${jsRules}${tsRule}
${ruleCount}. Every test file MUST contain at least one it() or test() call with real assertions. A file with only imports, describe() blocks, types, or helper functions is invalid and will be rejected.
${ruleCount + 1}. Structure ALL output using exactly these two XML blocks — nothing before, nothing after:
    <thinking>${thinkingTemplate}
    </thinking>
    <code_output>
    // complete test file here
    </code_output>
    CRITICAL: Once you open <code_output>, ALL remaining output must be code. Finish ALL reasoning inside <thinking> first.
${ruleCount + 2 <= ruleCount + 1 ? '' : `${ruleCount + 2}. Inside <code_output>: do NOT wrap in markdown code fences.`}${jsOutputRules}

A good test suite you write will have:
- A happy-path test that confirms the main behavior works
- At least one edge-case test per function (empty input, zero, null, boundary values)
- Error-path tests for any function that throws, rejects, or returns an error state — but ONLY assert the observable effect. Read the catch block first: does it set state, call a notification, or just log? Test only what's observable.
- Async tests properly awaited — never fire-and-forget${hookSuiteNote}
- Clear, descriptive test names that read like a spec ("returns null when user is not authenticated")

Common failure causes to avoid:
${universalCauses}${jsCauses}${vitestCauses}${reactCauses}

Test file pattern for this project: ${env.testFilePattern}

You MUST wrap your reasoning inside <thinking> tags and your complete file output inside <code_output> tags. Do not output anything outside of these two tags.`;
}
// ─── Generate prompt ──────────────────────────────────────────────────────────
export function buildGeneratePrompt(args) {
    const { sourceFile, env, existingTestCode, uncoveredFunctions, uncoveredLines, sourceImportPath, mocksCode, mocksImportPath, setupFileCode, packageDeps, tsconfigPaths, typeDefinitions, localImportPaths, localImportContents, reactMajorVersion, projectMemory, } = args;
    const sourceCode = compressSource(args.sourceCode);
    const mockApi = env.testRunner === 'vitest' ? 'vi' : 'jest';
    const parts = [];
    if (projectMemory) {
        parts.push(projectMemory);
        parts.push('');
    }
    if (packageDeps) {
        parts.push('PROJECT DEPENDENCIES (only import from these):');
        parts.push('```');
        parts.push(packageDeps);
        parts.push('```');
    }
    if (reactMajorVersion !== null && reactMajorVersion !== undefined && reactMajorVersion >= 18) {
        parts.push(`\nREACT ${reactMajorVersion} DETECTED — act() async rule: every act(async () => { ... }) call MUST be awaited. Never assign an unawaited act() to a variable. Unawaited act() leaks state updates into subsequent tests, causing cascading failures and null-read errors in unrelated tests.`);
    }
    if (tsconfigPaths) {
        parts.push('\nPROJECT TYPESCRIPT CONFIG (strict flags, target, and path aliases — follow these exactly):');
        parts.push(tsconfigPaths);
    }
    if (localImportPaths && localImportPaths.length > 0) {
        parts.push(`\nLOCAL IMPORT PATHS (pre-computed relative to the test file — use EXACTLY these strings in ${mockApi}.mock() calls, even if the source file uses @/ aliases. The test runner resolves ${mockApi}.mock() paths relative to the test file, not via tsconfig aliases. Do NOT convert these back to @/ paths in ${mockApi}.mock(). Do NOT recount directory levels yourself.):`);
        for (const p of localImportPaths)
            parts.push(`  ${p}`);
    }
    if (typeDefinitions) {
        parts.push('\nTYPE DEFINITIONS (exported from files the source imports — use these exact shapes, do NOT invent properties or guess types):');
        parts.push('```typescript');
        parts.push(typeDefinitions);
        parts.push('```');
    }
    if (localImportContents) {
        parts.push('\nUSED SYMBOL DEFINITIONS (extracted from files the component imports — only the specific symbols used, with function bodies collapsed to signature + return and class bodies collapsed to method signatures. Use this to find exact hook return shapes, service method names, and type definitions. Cross-check every hook mock against the hook\'s actual return statement here):');
        parts.push('```typescript');
        parts.push(localImportContents);
        parts.push('```');
    }
    if (setupFileCode) {
        const nextMocked = extractGlobalNextMocks(setupFileCode);
        const setupNote = nextMocked.length > 0
            ? `\nTEST SETUP FILE (already loaded before every test — do NOT import it again):\nThe following modules are ALREADY mocked globally in this setup file — do NOT add ${mockApi}.mock() for them in the test: ${nextMocked.join(', ')}`
            : `\nTEST SETUP FILE (already loaded before every test — do NOT import it again):`;
        parts.push(setupNote);
        parts.push('```');
        parts.push(setupFileCode);
        parts.push('```');
    }
    if (mocksImportPath) {
        if (mocksCode) {
            const exports = parseMockExports(mocksCode);
            parts.push(`\nSHARED MOCK FILE (import from: '${mocksImportPath}')`);
            if (exports.length > 0) {
                parts.push(`Available exports: ${exports.join(', ')}`);
                parts.push(`↑ Every name above ALREADY EXISTS in the mock file — do NOT re-declare any of them in a ---MOCKS_FILE--- block. Only declare names that do NOT appear in this list.\n↑ Before writing the test, identify which of these match the source file's domain and import every relevant one. Do NOT create inline mocks for anything already in this list.\n↑ NAMES ARE FROZEN — use each export exactly as spelled above. Never rename, recase, or restructure an existing mock (e.g. do not change mockFoo → MockFoo or const → class). Renaming breaks every other test that imports the original name.`);
            }
            const inventory = parseMockInventory(mocksCode);
            if (inventory.length > 0) {
                const maxLen = Math.max(...inventory.map(e => e.modulePath.length));
                parts.push(`\nMOCK MODULE INVENTORY — modules already ${mockApi}.mocked:`);
                for (const entry of inventory) {
                    const path = `'${entry.modulePath}'`.padEnd(maxLen + 2);
                    const exp = entry.exports.length > 0 ? entry.exports.join(', ') : '(no simple key exports)';
                    parts.push(`  ${path} → ${exp}`);
                }
                parts.push('MOCK EDITING RULES — follow exactly when returning a ---MOCKS_FILE--- block:');
                parts.push(`• A module in the inventory is ALREADY mocked. To add a new export: write ONE updated ${mockApi}.mock() block with ALL existing exports PLUS the new one. NEVER write a second ${mockApi}.mock() for the same path — the second block silently wipes every export from the first.`);
                parts.push(`• New export const mockFoo = ${mockApi}.fn(): declare it near other exports of the same domain. Add its .mockReset() or .mockClear() to the EXISTING beforeEach — do NOT create an extra beforeEach for one variable.`);
                parts.push(`• New module (not in inventory): append a new ${mockApi}.mock() at the END of the file, before the final beforeEach.`);
            }
            const relevantMocks = filterMockFileForSource(mocksCode, sourceCode);
            if (relevantMocks !== mocksCode || relevantMocks.split('\n').length < 80) {
                parts.push('```');
                parts.push(relevantMocks);
                parts.push('```');
            }
        }
        else {
            parts.push(`\nSHARED MOCK FILE (does not exist yet) — create it if you need mocks, return it via the // ---MOCKS_FILE--- separator. Path: '${mocksImportPath}'\n⚠ Mocks file must contain ONLY ${mockApi}.fn()/${mockApi}.mock() definitions and beforeEach resets — NEVER describe/it/test/expect blocks.`);
        }
    }
    const networkGuidance = buildNetworkMockingGuidance(analyzeNetworkDeps(sourceCode), sourceFile, mockApi);
    if (networkGuidance)
        parts.push(`\n${networkGuidance}`);
    const nextGuidance = buildNextJsGuidance(analyzeNextJs(sourceCode), mockApi);
    if (nextGuidance)
        parts.push(`\n${nextGuidance}`);
    if (detectReactNative(packageDeps ?? null))
        parts.push(`\n${buildReactNativeGuidance()}`);
    else if (detectVue(packageDeps ?? null))
        parts.push(`\n${buildVueGuidance()}`);
    const displaySource = buildSourceSkeleton(sourceCode, uncoveredFunctions);
    const skeletonized = shouldUseSkeleton(sourceCode);
    parts.push(`\nSOURCE FILE: ${sourceFile}${skeletonized ? ' (large file — bodies of already-covered functions collapsed; uncovered functions shown in full)' : ''}`);
    if (sourceImportPath) {
        parts.push(`SOURCE FILE IMPORT PATH: when importing the source in your test file, use exactly: '${sourceImportPath}'`);
    }
    parts.push('```');
    parts.push(displaySource);
    parts.push('```');
    if (existingTestCode) {
        parts.push('\nEXISTING TEST FILE (preserve all existing tests, only add new ones):');
        parts.push('```');
        parts.push(existingTestCode);
        parts.push('```');
    }
    else {
        parts.push('\nNo existing test file — create one from scratch.');
    }
    if (uncoveredFunctions.length > 0) {
        parts.push(`\nUNCOVERED FUNCTIONS (must write tests for these): ${uncoveredFunctions.join(', ')}`);
    }
    if (uncoveredLines.length > 0) {
        parts.push(`\nUNCOVERED LINES: ${uncoveredLines.slice(0, 30).join(', ')}${uncoveredLines.length > 30 ? '…' : ''}`);
    }
    parts.push('\nWrite the complete test file now.');
    return parts.join('\n');
}
// ─── Fix prompt ───────────────────────────────────────────────────────────────
export function buildFixPrompt(args) {
    const { testFile, testCode, sourceFile, sourceImportPath, errorOutput, env, mocksCode, mocksImportPath, setupFileCode, packageDeps, tsconfigPaths, typeDefinitions, localImportPaths, reactMajorVersion, projectMemory } = args;
    const sourceCode = args.sourceCode ? compressSource(args.sourceCode) : null;
    const mockApi = env.testRunner === 'vitest' ? 'vi' : 'jest';
    const parts = [];
    parts.push('Your job is to fix a failing test file. Do NOT rewrite it from scratch — preserve every existing test and only change what is necessary to make them pass.');
    parts.push('');
    if (projectMemory) {
        parts.push(projectMemory);
        parts.push('');
    }
    if (packageDeps) {
        parts.push('PROJECT DEPENDENCIES (only import from these):');
        parts.push('```');
        parts.push(packageDeps);
        parts.push('```');
    }
    if (reactMajorVersion !== null && reactMajorVersion !== undefined && reactMajorVersion >= 18) {
        parts.push(`\nREACT ${reactMajorVersion} DETECTED — act() async rule: every act(async () => { ... }) call MUST be awaited. Never assign an unawaited act() to a variable. Unawaited act() leaks state updates into subsequent tests, causing cascading failures and null-read errors in unrelated tests.`);
    }
    if (tsconfigPaths) {
        parts.push('\nPROJECT TYPESCRIPT CONFIG:');
        parts.push(tsconfigPaths);
    }
    if (localImportPaths && localImportPaths.length > 0) {
        parts.push(`\nLOCAL IMPORT PATHS (pre-computed relative to the test file — use EXACTLY these strings in ${mockApi}.mock() calls, even if the source file uses @/ aliases. The test runner resolves ${mockApi}.mock() paths relative to the test file, not via tsconfig aliases. Do NOT convert these back to @/ paths in ${mockApi}.mock(). Do NOT recount directory levels yourself.):`);
        for (const p of localImportPaths)
            parts.push(`  ${p}`);
    }
    if (typeDefinitions) {
        parts.push('\nTYPE DEFINITIONS (exported from files the source imports — use these exact shapes, do NOT invent properties or guess types):');
        parts.push('```typescript');
        parts.push(typeDefinitions);
        parts.push('```');
    }
    if (setupFileCode) {
        parts.push('\nTEST SETUP FILE (already loaded — do NOT import it again):');
        parts.push('```');
        parts.push(setupFileCode);
        parts.push('```');
    }
    if (mocksImportPath) {
        if (mocksCode) {
            const exports = parseMockExports(mocksCode);
            const compressed = filterMockFileForTest(mocksCode, args.testCode);
            parts.push(`\nSHARED MOCK FILE (import from: '${mocksImportPath}')`);
            if (exports.length > 0) {
                parts.push(`Available exports: ${exports.join(', ')}`);
                parts.push(`↑ Every name above ALREADY EXISTS in the mock file — do NOT re-declare any of them in a ---MOCKS_FILE--- block. Only declare names that do NOT appear in this list.\n↑ Import every mock that matches the source file's domain. Do NOT create inline mocks for anything already in this list.`);
            }
            const inventory = parseMockInventory(compressed);
            if (inventory.length > 0) {
                const maxLen = Math.max(...inventory.map(e => e.modulePath.length));
                parts.push(`\nMOCK MODULE INVENTORY — modules already ${mockApi}.mocked (line numbers refer to the file below):`);
                for (const entry of inventory) {
                    const path = `'${entry.modulePath}'`.padEnd(maxLen + 2);
                    const exp = entry.exports.length > 0 ? entry.exports.join(', ') : '(no simple key exports)';
                    parts.push(`  Line ${String(entry.lineNumber).padStart(4)}: ${path} → ${exp}`);
                }
                parts.push('MOCK EDITING RULES — follow exactly when returning a ---MOCKS_FILE--- block:');
                parts.push(`• A module in the inventory is ALREADY mocked. To add a new export: write ONE updated ${mockApi}.mock() block with ALL existing exports PLUS the new one. NEVER write a second ${mockApi}.mock() for the same path — the second block silently wipes every export from the first.`);
                parts.push(`• New export const mockFoo = ${mockApi}.fn(): declare it near other exports of the same domain. Add its .mockReset() or .mockClear() to the EXISTING beforeEach — do NOT create an extra beforeEach for one variable.`);
                parts.push(`• New module (not in inventory): append a new ${mockApi}.mock() at the END of the file, before the final beforeEach.`);
            }
            parts.push('```');
            parts.push(compressed);
            parts.push('```');
        }
        else {
            parts.push(`\nSHARED MOCK FILE (does not exist yet) — create it if you need mocks, return it via the // ---MOCKS_FILE--- separator. Path: '${mocksImportPath}'\n⚠ Mocks file must contain ONLY ${mockApi}.fn()/${mockApi}.mock() definitions and beforeEach resets — NEVER describe/it/test/expect blocks.`);
        }
    }
    if (detectReactNative(packageDeps ?? null))
        parts.push(`\n${buildReactNativeGuidance()}`);
    else if (detectVue(packageDeps ?? null))
        parts.push(`\n${buildVueGuidance()}`);
    if (sourceFile && sourceCode) {
        const networkGuidance = buildNetworkMockingGuidance(analyzeNetworkDeps(sourceCode), sourceFile, mockApi);
        if (networkGuidance)
            parts.push(`\n${networkGuidance}`);
        const nextGuidance = buildNextJsGuidance(analyzeNextJs(sourceCode), mockApi);
        if (nextGuidance)
            parts.push(`\n${nextGuidance}`);
        const FIX_SKELETON_THRESHOLD = 600;
        const displaySource = sourceCode.split('\n').length > FIX_SKELETON_THRESHOLD
            ? buildSourceSkeleton(sourceCode, [])
            : sourceCode;
        const fixSkeletonized = displaySource !== sourceCode;
        parts.push(`\nSOURCE FILE (what is being tested): ${sourceFile}${fixSkeletonized ? ' (large file — function bodies collapsed to signatures)' : ''}`);
        if (sourceImportPath) {
            parts.push(`SOURCE FILE IMPORT PATH: when importing the source in the test file, use exactly: '${sourceImportPath}'`);
        }
        parts.push('```');
        parts.push(displaySource);
        parts.push('```');
    }
    parts.push(`\nFAILING TEST FILE: ${testFile}`);
    parts.push('```');
    parts.push(testCode);
    parts.push('```');
    parts.push('\nFAILURE OUTPUT:');
    parts.push('```');
    parts.push(errorOutput.slice(0, 3000));
    parts.push('```');
    const realRequestWarning = detectRealRequestInError(errorOutput, mockApi);
    if (realRequestWarning)
        parts.push(`\n⚠️  ${realRequestWarning}`);
    const rejectionWarning = detectUnhandledRejection(errorOutput);
    if (rejectionWarning)
        parts.push(`\n⚠️  ${rejectionWarning}`);
    const rntlWarning = detectRntlErrors(errorOutput);
    if (rntlWarning)
        parts.push(`\n⚠️  ${rntlWarning}`);
    const nextImportWarning = detectNextJsImportError(errorOutput, mockApi);
    if (nextImportWarning)
        parts.push(`\n⚠️  ${nextImportWarning}`);
    const bleedWarning = detectThinkingBleed(errorOutput);
    if (bleedWarning)
        parts.push(`\n⚠️  ${bleedWarning}`);
    const tsErrorWarning = detectTypeScriptErrors(errorOutput);
    if (tsErrorWarning)
        parts.push(`\n⚠️  ${tsErrorWarning}`);
    const testHasAxiosMock = /vi\.mock\(['"]axios['"]\)/.test(testCode);
    const sourceHasCustomInstance = sourceCode != null && /axios\.create\s*\(/.test(sourceCode);
    if (testHasAxiosMock && sourceHasCustomInstance) {
        parts.push("\n⚠️  WRONG MOCK PATTERN: The test mocks 'axios' directly but the source file uses axios.create().", `${mockApi}.mock('axios') cannot intercept a custom axios instance.`, 'You must mock the module that exports the axios instance, or mock the service/API module the source imports.');
    }
    parts.push('\nCommon causes to check:');
    parts.push('- Wrong import path (use path aliases, not deep relative paths)');
    parts.push('- Mock not set up correctly (check the shared mock file)');
    parts.push('- Asserting on the wrong value or using the wrong matcher');
    parts.push('- Async code not awaited');
    parts.push('- Component/function API changed — check the source file');
    parts.push('- Unhandled rejection: if the error output says "Unhandled Rejection" or "Vitest caught 1 unhandled error", a mockRejectedValueOnce promise is escaping the test scope. Fix by adding await waitFor(() => expect(errorElement).toBeInTheDocument()) after the triggering action, so the rejection is fully resolved inside the test.');
    parts.push('\nReturn your response in the required <thinking> + <code_output> format.');
    return parts.join('\n');
}
// ─── Pollution fix prompt ─────────────────────────────────────────────────────
export function buildPollutionFixPrompt(args) {
    const { pollutorFile, pollutorCode, victimFile, victimCode, victimError } = args;
    const parts = [];
    parts.push('This test file corrupts shared state and causes another test file to fail when run afterwards.');
    parts.push('Your job: add afterEach() or afterAll() cleanup to reset whatever global state this file mutates.');
    parts.push('');
    parts.push('Rules:');
    parts.push('- DO NOT remove, rewrite, or alter any existing test logic or assertions');
    parts.push('- ONLY add cleanup hooks — nothing else');
    parts.push('- The fix must be minimal: add the smallest afterEach/afterAll that resets the leaked state');
    parts.push('');
    parts.push(`POLLUTING FILE (add cleanup here): ${pollutorFile}`);
    parts.push('```');
    parts.push(pollutorCode);
    parts.push('```');
    parts.push('');
    parts.push(`VICTIM FILE (fails when run after the polluting file): ${victimFile}`);
    parts.push('```');
    parts.push(victimCode);
    parts.push('```');
    parts.push('');
    parts.push('ERROR the victim gets when run after this file:');
    parts.push('```');
    parts.push(victimError.slice(0, 2000));
    parts.push('```');
    parts.push('');
    parts.push('HOW TO DIAGNOSE:');
    parts.push("1. Read the victim's error — what value is null/undefined/wrong, or what element is missing?");
    parts.push('2. Search the polluting file for where that thing is set or modified (localStorage, window properties, module singletons, mock state, React context, timers, environment variables)');
    parts.push('3. Add afterEach (or afterAll) in the polluting file to reset exactly that thing');
    parts.push('');
    parts.push('Common cleanup patterns:');
    parts.push('  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })');
    parts.push('  afterEach(() => { localStorage.clear(); sessionStorage.clear() })');
    parts.push('  afterEach(() => { delete (window as any).myProperty })');
    parts.push('  afterEach(() => { myModuleSingleton.reset() })');
    parts.push('  afterEach(() => { vi.useRealTimers() })');
    parts.push('');
    parts.push('Return the complete modified polluting file in the required <thinking> + <code_output> format.');
    return parts.join('\n');
}
export function buildRetryPrompt(failureOutput, failedAttempts = []) {
    const parts = [];
    if (failedAttempts.length > 0) {
        parts.push(`You have already attempted to fix this ${failedAttempts.length} time(s). Do NOT repeat these failed approaches:`);
        for (const a of failedAttempts) {
            let hypContext = a.hypothesis;
            if (hypContext) {
                const planMatch = hypContext.match(/(?:4\.\s*WHY IT FAILED|5\.\s*PLAN)[\s\S]*/i);
                if (planMatch) {
                    hypContext = planMatch[0];
                }
                else if (hypContext.length > 800) {
                    hypContext = '...' + hypContext.slice(-800);
                }
            }
            const hyp = hypContext ? `[${hypContext.slice(0, 1000)}]` : '(no plan recorded)';
            parts.push(`- Attempt ${a.attemptNumber} Reasoning: ${hyp}\n  Failed with: ${a.failureReason.slice(0, 800)}`);
        }
        parts.push('');
    }
    parts.push(`The tests failed. Error output:`);
    parts.push('```');
    parts.push(failureOutput.slice(0, 3000));
    parts.push('```');
    const realRequestWarning = detectRealRequestInError(failureOutput);
    if (realRequestWarning)
        parts.push(`\n⚠️  ${realRequestWarning}`);
    const rejectionWarning = detectUnhandledRejection(failureOutput);
    if (rejectionWarning)
        parts.push(`\n⚠️  ${rejectionWarning}`);
    const rntlRetryWarning = detectRntlErrors(failureOutput);
    if (rntlRetryWarning)
        parts.push(`\n⚠️  ${rntlRetryWarning}`);
    const nextImportWarning = detectNextJsImportError(failureOutput);
    if (nextImportWarning)
        parts.push(`\n⚠️  ${nextImportWarning}`);
    const bleedWarning = detectThinkingBleed(failureOutput);
    if (bleedWarning)
        parts.push(`\n⚠️  ${bleedWarning}`);
    const tsErrorWarning = detectTypeScriptErrors(failureOutput);
    if (tsErrorWarning)
        parts.push(`\n⚠️  ${tsErrorWarning}`);
    parts.push('');
    parts.push('Common causes:');
    parts.push('- Wrong import path — check the path aliases and dependency list from the original prompt');
    parts.push('- Missing mock — if a module needs mocking, add it to the shared mock file');
    parts.push('- Wrong mock path: mock paths are relative to the TEST FILE, not the source file. Count up from the test file\'s directory to reach the mocked module — if the test is in src/features/x/__tests__/ and mocks src/components/, that is ../../../components/, not ../components/.');
    parts.push('- Barrel file mock miss: if a module is re-exported from a barrel/index file, mocking the barrel will NOT intercept imports of the direct file. Mock the specific file the source actually imports. If unsure, mock both.');
    parts.push('- Wrong API — use only methods that exist in the installed version of the library');
    parts.push('- Type error — make sure the types match what the source file exports');
    parts.push('- React 18 act() async: every act(async () => ...) MUST be awaited. Unawaited act() calls cause state to leak across tests, producing "Cannot read properties of null" or timeout failures in unrelated tests. Fix: add await before every act() call that wraps async code.');
    parts.push('- Loading state — if the error is "Unable to find element" on a Submit/Save button, the component likely unmounts the button during loading rather than disabling it. Assert on the spinner or loading indicator instead.');
    parts.push('- Unhandled rejection ("Vitest caught 1 unhandled error" / "Unhandled Rejection"): a mockRejectedValueOnce promise is escaping the test scope. After the action that triggers the rejection, add: await waitFor(() => expect(screen.getByText(/error/i)).toBeInTheDocument()) — this keeps the rejection chained inside the test so Vitest doesn\'t treat it as unhandled. The component may already catch the error internally, but the test still needs to await the resulting state change.');
    parts.push('');
    parts.push('Fix the issue and return your response in the required <thinking> + <code_output> format.');
    return parts.join('\n');
}
//# sourceMappingURL=index.js.map