// Filters a shared mock file to only the sections the failing test actually uses.
// Scans the test file's imports from the mock file, then returns:
//   - export declarations for those specific names
//   - vi.mock() blocks that reference any of those names
// Falls back to the full file if no imports can be detected.
// This prevents burning tokens on 40 unrelated service mocks when fixing a billing test.
export function filterMockFileForTest(mocksCode, testCode) {
    // Extract mock variable names the test imports from the mock file
    const importedNames = new Set();
    for (const m of testCode.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*mock[s]?[^'"]*['"]/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim();
            if (name && /^\w+$/.test(name))
                importedNames.add(name);
        }
    }
    if (importedNames.size === 0)
        return mocksCode;
    const lines = mocksCode.split('\n');
    const include = new Set();
    // Include export declaration lines for imported names
    for (let i = 0; i < lines.length; i++) {
        for (const name of importedNames) {
            if (new RegExp(`\\bexport\\b[^{\\n]*\\b${name}\\b`).test(lines[i])) {
                include.add(i);
            }
        }
    }
    // Include vi.mock() blocks that reference any imported name
    let i = 0;
    while (i < lines.length) {
        if (/\bvi\.mock\(/.test(lines[i])) {
            const blockStart = i;
            let depth = 0;
            let j = i;
            // Scan to the end of this mock call (balanced parens)
            while (j < lines.length) {
                for (const ch of lines[j]) {
                    if (ch === '(')
                        depth++;
                    if (ch === ')')
                        depth--;
                }
                j++;
                if (depth === 0)
                    break;
            }
            const blockText = lines.slice(blockStart, j).join('\n');
            for (const name of importedNames) {
                if (new RegExp(`\\b${name}\\b`).test(blockText)) {
                    for (let k = blockStart; k < j; k++)
                        include.add(k);
                    break;
                }
            }
            i = j;
            continue;
        }
        i++;
    }
    // Reconstruct, collapsing gaps to a single blank line
    const result = [];
    let gapped = false;
    for (let i = 0; i < lines.length; i++) {
        if (include.has(i)) {
            result.push(lines[i]);
            gapped = false;
        }
        else if (!gapped) {
            result.push('');
            gapped = true;
        }
    }
    const filtered = result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // Safety: if filter stripped too aggressively, fall back to full file
    return filtered.length < 50 ? mocksCode : filtered;
}
// Filters a shared mock file to sections relevant to the source file being tested.
// Used in generate prompts (no test file exists yet) — scans the source file's imports
// and returns vi.mock() blocks for those same module paths, plus any mock variables
// whose name matches the pattern mock<ImportedName> (e.g. WorkspacesClient → mockWorkspacesClient).
// This gives the AI the shapes of mocks it will need without sending the whole file.
export function filterMockFileForSource(mocksCode, sourceCode) {
    // Extract module paths the source imports from
    const importedPaths = new Set();
    for (const m of sourceCode.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
        importedPaths.add(m[1]);
    }
    if (importedPaths.size === 0)
        return mocksCode;
    const lines = mocksCode.split('\n');
    const include = new Set();
    // Include vi.mock() blocks whose module path matches a source import
    let i = 0;
    while (i < lines.length) {
        const mockMatch = lines[i].match(/\bvi\.mock\(\s*(['"])([^'"]+)\1/);
        if (mockMatch) {
            const mockedPath = mockMatch[2];
            const blockStart = i;
            let depth = 0;
            let j = i;
            while (j < lines.length) {
                for (const ch of lines[j]) {
                    if (ch === '(')
                        depth++;
                    if (ch === ')')
                        depth--;
                }
                j++;
                if (depth === 0)
                    break;
            }
            // Include if the mocked path is directly imported by the source, or the source
            // imports something from the same package (e.g. source imports WorkspacesClient
            // from '@/lib/client/services/index.client' → include index.client mock block)
            const relevant = [...importedPaths].some(p => p === mockedPath || p.includes(mockedPath) || mockedPath.includes(p.split('/').pop() ?? ''));
            if (relevant) {
                for (let k = blockStart; k < j; k++)
                    include.add(k);
            }
            i = j;
            continue;
        }
        i++;
    }
    // Include export declarations for mock variables inferred from source imports.
    // e.g. source imports `getSession` → look for `mockGetSession` (capitalise the first letter
    // after the `mock` prefix to match the camelCase convention used in mock files).
    // Also try lowercase fallback (`mockgetSession`) in case the file uses it.
    const inferredNames = new Set();
    for (const m of sourceCode.matchAll(/\bimport\s*\{([^}]+)\}/gm)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim();
            if (!name)
                continue;
            // Capitalised prefix: mock + GetSession
            inferredNames.add(`mock${name[0].toUpperCase()}${name.slice(1)}`);
            // Lowercase prefix fallback: mock + getSession
            inferredNames.add(`mock${name}`);
        }
    }
    for (let i = 0; i < lines.length; i++) {
        for (const name of inferredNames) {
            if (new RegExp(`\\bexport\\b[^{\\n]*\\b${name}\\b`).test(lines[i])) {
                include.add(i);
            }
        }
    }
    if (include.size === 0)
        return mocksCode;
    const result = [];
    let gapped = false;
    for (let i = 0; i < lines.length; i++) {
        if (include.has(i)) {
            result.push(lines[i]);
            gapped = false;
        }
        else if (!gapped) {
            result.push('');
            gapped = true;
        }
    }
    const filtered = result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return filtered.length < 50 ? mocksCode : filtered;
}
// Compresses a shared mock file before sending in a fix prompt.
// The generate prompt skips the raw file entirely (inventory + exports list suffices).
// Here we keep the file readable but strip multi-line vi.fn() implementations —
// the AI only needs to know the mock EXISTS and its name, not its JSX body.
export function compressMockFile(code) {
    const lines = code.split('\n');
    const result = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        // Detect a multi-line vi.fn() body: `export const mockFoo = vi.fn(` that doesn't close on the same line.
        // These are icon/component mocks returning React.createElement — the AI only needs the name.
        const multiLineFn = line.match(/^(export const \w+) = vi\.fn\(/);
        if (multiLineFn) {
            const openParens = (line.match(/\(/g) ?? []).length;
            const closeParens = (line.match(/\)/g) ?? []).length;
            if (openParens > closeParens) {
                // Multi-line — scan forward to find the closing paren, then emit a collapsed form
                let depth = openParens - closeParens;
                i++;
                while (i < lines.length && depth > 0) {
                    for (const ch of lines[i]) {
                        if (ch === '(')
                            depth++;
                        if (ch === ')')
                            depth--;
                    }
                    i++;
                }
                result.push(`${multiLineFn[1]} = vi.fn()`);
                continue;
            }
        }
        result.push(line);
        i++;
    }
    // Collapse 3+ blank lines to 1
    return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// Removes documentation dead-weight from source code before sending to the AI.
// Targets content that costs tokens but adds no signal for test generation:
// license headers, long JSDoc blocks, and excessive blank lines.
// Intentionally conservative: short JSDoc (≤6 lines) and all inline // comments are kept.
export function compressSource(source) {
    let out = source;
    // Strip license / copyright block comments at the very top of the file.
    // These are always before the first import and never describe testable behaviour.
    out = out.replace(/^(?:\/\*[\s\S]*?(?:license|copyright|\bMIT\b|\bApache\b|\bGPL\b|@license)[\s\S]*?\*\/\s*)+/i, '');
    // Strip block comments longer than 6 lines. Short ones (≤6 lines) describe
    // edge cases and error conditions worth keeping; long ones are @param/@example boilerplate.
    out = out.replace(/\/\*[\s\S]*?\*\//g, (match) => match.split('\n').length > 6 ? '' : match);
    // Collapse 3+ consecutive blank lines to 1.
    out = out.replace(/\n{3,}/g, '\n\n');
    return out.trim();
}
// Generates a compact structural summary of a TypeScript/JavaScript source file.
// Large files are skeletonized: only the functions that need to be tested are expanded
// to their full implementation; everything else is collapsed to its signature.
// This cuts prompt size by 60–80% on large files without losing signal for the AI.
const SKELETON_THRESHOLD = 80; // lines; files at or below this are returned as-is
// ─── Block-end finder ────────────────────────────────────────────────────────
// Finds the line index of the closing } for a block that opens at startLine.
// Uses a simple state machine to skip braces inside string literals.
function findBlockEnd(lines, startLine) {
    let depth = 0;
    let inString = null;
    let escaped = false;
    let opened = false;
    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        for (let j = 0; j < line.length; j++) {
            const ch = line[j];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\' && inString) {
                escaped = true;
                continue;
            }
            if (inString) {
                if (ch === inString)
                    inString = null;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') {
                inString = ch;
                continue;
            }
            if (ch === '{') {
                depth++;
                opened = true;
            }
            if (ch === '}') {
                depth--;
                if (opened && depth === 0)
                    return i;
            }
        }
    }
    return lines.length - 1;
}
// ─── Declaration name extractor ──────────────────────────────────────────────
// Returns the identifier name from a top-level declaration line, or null if
// the line isn't a recognisable declaration.
function extractDeclaredName(line) {
    const s = line.trim().replace(/^export\s+(default\s+)?/, '');
    // function name / async function name
    const fn = s.match(/^(?:async\s+)?function\s+(\w+)/);
    if (fn)
        return fn[1];
    // class Name
    const cl = s.match(/^class\s+(\w+)/);
    if (cl)
        return cl[1];
    // const/let/var name = (...) => or = function or = async (
    const cv = s.match(/^(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\(|function\b|\w+\s*=>)/);
    if (cv)
        return cv[1];
    return null;
}
// Keywords that open a `name(...) {` shaped block but are control flow, NOT a method.
const CONTROL_KEYWORDS = /^(?:if|for|while|switch|catch|else|do|with|return|function|class|await|yield|new)\b/;
// Extracts a class/object METHOD name from a declaration line (`async foo(...) {`,
// `private bar<T>(): X {`, `get baz() {`, `constructor(...) {`), guarding against control-flow
// (`if (...) {`, `for (...) {`) that shares the `name(...) {` shape. Methods aren't top-level
// declarations, so `extractDeclaredName` misses them — this lets a class body collapse its
// non-target methods to signatures instead of dumping every method verbatim.
function extractMethodName(line) {
    const s = line.trim();
    if (CONTROL_KEYWORDS.test(s))
        return null;
    const m = s.match(/^(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/);
    return m ? m[1] : null;
}
// ─── Skeleton builder ─────────────────────────────────────────────────────────
export function shouldUseSkeleton(code) {
    return code.split('\n').length > SKELETON_THRESHOLD;
}
/**
 * Returns a skeletonized version of sourceCode.
 * expandFunctions: names of functions whose full body must be included (the uncovered ones).
 * expandLines: 1-based line numbers that MUST stay visible — the enclosing block of any such
 *   line is kept expanded (recursing into classes so only the target method survives, its
 *   siblings collapse). This is the reliable path when the coverage report names functions
 *   anonymously (`(anonymous_23)`) or when the target lives inside a class method — name
 *   matching alone then expands nothing and the whole class collapses to an empty shell.
 * If the file is short enough, returns the original code unchanged.
 */
export function buildSourceSkeleton(sourceCode, expandFunctions = [], expandLines = []) {
    if (!shouldUseSkeleton(sourceCode))
        return sourceCode;
    const lines = sourceCode.split('\n');
    const expandSet = new Set(expandFunctions);
    const lineSet = new Set(expandLines); // 1-based
    const out = [];
    skeletonizeRange(lines, 0, lines.length - 1, expandSet, lineSet, out);
    return out.join('\n');
}
// True if any target (1-based) line falls within the block spanning [start, end] (0-based).
function blockHasTargetLine(lineSet, start, end) {
    if (lineSet.size === 0)
        return false;
    for (let n = start + 1; n <= end + 1; n++)
        if (lineSet.has(n))
            return true;
    return false;
}
// Given a declaration starting at `start` (a function/method/const-arrow line), returns the line
// index where its body `{` opens — handling MULTI-LINE signatures (params spread over many lines,
// so the `{` isn't on the `name(` line). Returns -1 when this is NOT a block declaration: a call
// like `foo(a, {b});`, or a field like `const x = (expr) as T;`. The braces inside the param
// list (default args, object-type params) are at paren-depth > 0 and correctly ignored — only a
// `{` AFTER the params close (optionally past a `: ReturnType` annotation or an `=>`) counts.
function findSignatureBlockOpen(lines, start) {
    let parenDepth = 0;
    let seenParen = false;
    const end = Math.min(start + 30, lines.length - 1);
    for (let i = start; i <= end; i++) {
        const line = lines[i];
        for (let j = 0; j < line.length; j++) {
            const ch = line[j];
            if (ch === '(') {
                parenDepth++;
                seenParen = true;
            }
            else if (ch === ')') {
                parenDepth--;
            }
            else if (parenDepth === 0 && seenParen) {
                if (ch === '{')
                    return i; // body opens
                if (ch === ';')
                    return -1; // statement/call — not a body
                if (ch === '=' && line[j + 1] !== '>')
                    return -1; // assignment (not `=>`) — a field
            }
        }
    }
    return -1;
}
// A class/namespace/module block whose direct children are methods/fields — the only context
// where method-name collapsing is safe. (Function BODIES contain calls and object literals that
// share the `name(...) {` / `= {` shape, so we never descend into them to collapse.)
const CONTAINER_DECL = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|namespace|module)\b/;
// First line in body [from, to] that begins a JSX return — either `return <Foo…` (inline/early
// return) or `return (` immediately followed by a `<…` line. Returns -1 for non-JSX functions.
// Used to preserve a component's render output (the test contract) instead of collapsing it.
function findJsxReturnLine(lines, from, to) {
    for (let i = from; i <= to; i++) {
        const t = lines[i].trim();
        if (/\breturn\s*</.test(t))
            return i; // return <Foo …  (early or inline)
        if (/\breturn\s*\(\s*$/.test(t)) {
            for (let k = i + 1; k <= to; k++) { // `return (` — confirm JSX follows
                const nt = lines[k].trim();
                if (!nt)
                    continue;
                return nt.startsWith('<') ? i : -1;
            }
            return -1;
        }
    }
    return -1;
}
// Line index of the first `{` at/after `start` — used for container headers (`class X {`,
// `class X extends Y {` possibly spanning lines), which open a block directly with no param list.
function findBraceOpenLine(lines, start) {
    const end = Math.min(start + 10, lines.length - 1);
    for (let i = start; i <= end; i++)
        if (lines[i].includes('{'))
            return i;
    return -1;
}
// Processes lines [from, to] (inclusive, 0-based), appending the skeletonized output.
//   inContainer=true  → we're directly inside a class/namespace body: collapse non-target
//                       methods to signatures, recurse into nested classes.
//   inContainer=false → module scope: only top-level function/class/const decls are considered.
// A class is always recursed (so its non-target methods collapse); a function/method that holds
// a target line is emitted WHOLE (never descended into — that avoids misreading its call sites
// as declarations); everything else with a name collapses to a signature stub.
function skeletonizeRange(lines, from, to, expandSet, lineSet, result, inContainer = false) {
    let i = from;
    while (i <= to) {
        const line = lines[i];
        const trimmed = line.trim();
        // ── Always keep verbatim ──────────────────────────────────────────────────
        if (!trimmed ||
            trimmed.startsWith('//') ||
            /^\/?\*/.test(trimmed) || // block comments
            trimmed.startsWith('import ') ||
            trimmed.startsWith('@') || // decorators
            /^export\s+(type|interface|enum)\b/.test(trimmed) ||
            /^(?:type|interface|enum)\s+\w/.test(trimmed)) {
            result.push(line);
            i++;
            continue;
        }
        // ── Detect a collapsible declaration ──────────────────────────────────────
        // Module scope: top-level function/class/const. Inside a class: also methods.
        const name = extractDeclaredName(trimmed) ?? (inContainer ? extractMethodName(trimmed) : null);
        const isContainer = name != null && CONTAINER_DECL.test(trimmed);
        // Container headers open a block directly (`class X {`, no params); everything else must be
        // validated as a real signature — never trust a bare `{` on the line, which could be an
        // object arg in a call (`foo({a});`) or an object field initializer.
        const blockOpen = !name ? -1
            : isContainer ? findBraceOpenLine(lines, i)
                : findSignatureBlockOpen(lines, i);
        if (name && blockOpen >= 0) {
            const blockEnd = findBlockEnd(lines, blockOpen);
            const bodyLines = blockEnd - i;
            if (isContainer) {
                // Segment the class body by BRACE DEPTH (not regex per line): each member is a run
                // between depth-0 boundaries, so calls/object-literals nested inside a method body
                // (`this.logger.error('x', { … })`) can never be misread as a member declaration.
                result.push(...lines.slice(i, blockOpen + 1));
                skeletonizeContainerBody(lines, blockOpen + 1, blockEnd - 1, expandSet, lineSet, result);
                if (blockEnd > blockOpen)
                    result.push(lines[blockEnd]);
            }
            else if (expandSet.has(name) || blockHasTargetLine(lineSet, i, blockEnd)) {
                // Named uncovered function OR a function/method containing a target line: emit whole.
                result.push(...lines.slice(i, blockEnd + 1));
            }
            else {
                // Collapse to a signature stub — keep the full (possibly multi-line) signature, replace
                // the body with a stub comment. EXCEPTION: a component/render function whose body returns
                // JSX — that JSX (labels, testIDs, conditional branches) is exactly what a testing-library
                // test asserts against, so collapsing it blinds the model to the render contract. Preserve
                // the JSX return; collapse only the setup (hooks/handlers) above the first JSX return.
                const jsxStart = findJsxReturnLine(lines, blockOpen + 1, blockEnd - 1);
                if (jsxStart >= 0) {
                    result.push(...lines.slice(i, blockOpen + 1)); // signature line(s) incl. `{`
                    const collapsed = jsxStart - (blockOpen + 1);
                    if (collapsed > 0)
                        result.push(`  /* ... ${collapsed} setup line${collapsed === 1 ? '' : 's'} collapsed */`);
                    result.push(...lines.slice(jsxStart, blockEnd + 1)); // JSX return … through closing `}`
                }
                else {
                    const sigText = lines.slice(i, blockOpen + 1).join('\n').replace(/\{[^{}]*$/, '').trimEnd();
                    result.push(`${sigText} { /* ... (${bodyLines} line${bodyLines === 1 ? '' : 's'}) */ }`);
                }
            }
            i = blockEnd + 1;
            continue;
        }
        result.push(line);
        i++;
    }
}
// Skeletonizes the INSIDE of a class/namespace body [from, to] by segmenting members on brace
// depth. A member is either a block (method/getter/nested class — opens `{`, closes at the
// matching `}`) or a field/statement (ends in `;` at depth 0). Depth tracking is string-aware,
// so braces in strings/params/nested calls don't split members. Non-target methods collapse to
// a signature stub; a member holding a target line (or a name in expandSet) is emitted whole.
function skeletonizeContainerBody(lines, from, to, expandSet, lineSet, result) {
    let depth = 0;
    let parenDepth = 0; // braces inside a param list (`= {}` defaults, object-type params) don't count
    let inString = null;
    let escaped = false;
    let memberStart = from;
    let braceOpenLine = -1;
    const emitMember = (start, end, sigOpen) => {
        if (sigOpen < 0) {
            result.push(...lines.slice(start, end + 1));
            return;
        } // field/statement
        // A nested class inside the body → recurse so ITS methods collapse too.
        const firstCode = lines.slice(start, sigOpen + 1).find((l) => CONTAINER_DECL.test(l.trim()));
        if (firstCode) {
            skeletonizeRange(lines, start, end, expandSet, lineSet, result);
            return;
        }
        let name = null;
        for (let k = start; k <= sigOpen; k++) {
            name = extractDeclaredName(lines[k].trim()) ?? extractMethodName(lines[k].trim());
            if (name)
                break;
        }
        const bodyLines = end - sigOpen; // size of the BODY (from its `{` line), not the signature
        const keepWhole = (name != null && expandSet.has(name))
            || blockHasTargetLine(lineSet, start, end)
            || bodyLines <= 1; // empty/one-line body (`{}`) — nothing worth collapsing
        if (keepWhole) {
            result.push(...lines.slice(start, end + 1));
            return;
        }
        // Keep the full (possibly multi-line) signature; replace only the body with a stub. The body
        // opens on sigOpen, so strip from the LAST `{` on that line onward.
        const sigHead = lines.slice(start, sigOpen).join('\n');
        const sigTail = lines[sigOpen].replace(/\{(?![^]*\{).*$/, '').trimEnd();
        const sigText = (sigHead ? sigHead + '\n' : '') + sigTail;
        result.push(`${sigText} { /* ... (${bodyLines} line${bodyLines === 1 ? '' : 's'}) */ }`);
    };
    for (let i = from; i <= to; i++) {
        const line = lines[i];
        for (let j = 0; j < line.length; j++) {
            const ch = line[j];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\' && inString) {
                escaped = true;
                continue;
            }
            if (inString) {
                if (ch === inString)
                    inString = null;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') {
                inString = ch;
                continue;
            }
            // Track parens so braces inside a (possibly multi-line) param list are ignored — a member
            // body brace is only one seen while NOT inside parentheses.
            if (ch === '(') {
                parenDepth++;
                continue;
            }
            if (ch === ')') {
                if (parenDepth > 0)
                    parenDepth--;
                continue;
            }
            if (parenDepth > 0)
                continue;
            if (ch === '{') {
                if (depth === 0)
                    braceOpenLine = i;
                depth++;
            }
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    emitMember(memberStart, i, braceOpenLine);
                    memberStart = i + 1;
                    braceOpenLine = -1;
                }
            }
            else if (ch === ';' && depth === 0) {
                // Field / statement member (no block). Emit its lines verbatim (fields are short).
                result.push(...lines.slice(memberStart, i + 1));
                memberStart = i + 1;
            }
        }
    }
    // Trailing lines with no terminator (blank lines / comments before the class close) — verbatim.
    if (memberStart <= to)
        result.push(...lines.slice(memberStart, to + 1));
}
//# sourceMappingURL=skeleton.js.map