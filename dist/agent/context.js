import { readFile, access, mkdir, readdir } from 'fs/promises';
import { join, dirname, basename, extname, relative } from 'path';
// Compute the relative import path from one file to another, stripping the extension.
export function computeRelativeImport(fromFile, toFile) {
    const rel = relative(dirname(fromFile), toFile);
    const noExt = rel.replace(/\.(tsx?|jsx?|mts|cts)$/, '');
    return noExt.startsWith('.') ? noExt : `./${noExt}`;
}
const TEST_SUFFIXES = ['.test', '.spec'];
async function dirExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
// Candidate test-directory roots for mirrored project layouts (test/unit/…, etc.)
const MIRROR_TEST_ROOTS = ['test/unit', 'test/integration', 'test', 'tests/unit', 'tests', 'spec'];
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
// True if dir contains at least one test file (recursively, shallow). Guards against
// treating a helpers-only directory — e.g. a `test/` holding only mock.ts/setup.ts —
// as a mirror test root, which would scatter new tests far from the source.
async function dirContainsTestFile(dir, depth = 0, maxDepth = 6) {
    if (depth > maxDepth)
        return false;
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
    }
    catch {
        return false;
    }
    for (const entry of entries) {
        if (entry.isFile() && TEST_FILE_RE.test(entry.name))
            return true;
    }
    for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            if (await dirContainsTestFile(join(dir, entry.name), depth + 1, maxDepth))
                return true;
        }
    }
    return false;
}
// Recursively search dir for a file matching filename, up to maxDepth levels deep.
// Returns the first absolute path found, or null.
export async function findFileByName(dir, filename, depth = 0, maxDepth = 6) {
    if (depth > maxDepth)
        return null;
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
    }
    catch {
        return null;
    }
    for (const entry of entries) {
        if (entry.name === filename)
            return join(dir, entry.name);
    }
    for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            const found = await findFileByName(join(dir, entry.name), filename, depth + 1, maxDepth);
            if (found)
                return found;
        }
    }
    return null;
}
// Given source file path (relative to cwd) and a list of configured sourceDirs,
// returns { srcDirParent, relPath } when the source file sits inside one of the
// sourceDirs — the building blocks for mirrored test path resolution.
function mirrorParts(sourceFile, sourceDirs) {
    const norm = sourceFile.replace(/\\/g, '/');
    for (const srcDir of sourceDirs) {
        const nd = srcDir.replace(/\\/g, '/').replace(/\/$/, '');
        // Case 1: sourceDir is a prefix of the path ("packages/server/src/adapters/...")
        if (norm.startsWith(nd + '/')) {
            return { srcDirParent: '', relPath: norm.slice(nd.length + 1) };
        }
        // Case 2: sourceDir appears as a path segment ("packages/server/src/adapters/...")
        // with sourceDir = "src" → srcDirParent = "packages/server/", relPath = "adapters/..."
        const idx = norm.indexOf('/' + nd + '/');
        if (idx !== -1) {
            return { srcDirParent: norm.slice(0, idx + 1), relPath: norm.slice(idx + nd.length + 2) };
        }
    }
    return null;
}
async function inferTestFilePath(sourceFile, cwd, env, sourceDirs = ['src']) {
    const dir = dirname(sourceFile);
    const ext = extname(sourceFile);
    const base = basename(sourceFile, ext);
    if (env.language === 'python') {
        return join(dir, `test_${base}${ext}`);
    }
    if (env.language === 'go') {
        return join(dir, `${base}_test${ext}`);
    }
    const colocated = (await dirExists(join(cwd, dir, `${base}.test${ext}`))) ||
        (await dirExists(join(cwd, dir, `${base}.spec${ext}`)));
    if (colocated) {
        return join(dir, `${base}.test${ext}`);
    }
    // Sibling convention: scan other source files in the same directory.
    // If their tests are in a __tests__/ subfolder or co-located, follow that pattern
    // rather than deferring to mirror roots (which can pick up a wrong project-level test/).
    const srcAbsDir = join(cwd, dir);
    let siblingConventionDir = null;
    try {
        const sibEntries = await readdir(srcAbsDir, { withFileTypes: true });
        sibLoop: for (const entry of sibEntries) {
            if (!entry.isFile())
                continue;
            const sibExt = extname(entry.name);
            if (!['.ts', '.tsx', '.js', '.jsx'].includes(sibExt))
                continue;
            const sibBase = basename(entry.name, sibExt);
            if (sibBase === base || TEST_SUFFIXES.some(s => entry.name.endsWith(`${s}${sibExt}`)))
                continue;
            // __tests__ subdirectory (check first — preferred convention in React Native)
            for (const s of TEST_SUFFIXES) {
                try {
                    await access(join(srcAbsDir, '__tests__', `${sibBase}${s}${sibExt}`));
                    siblingConventionDir = join(dir, '__tests__');
                    break sibLoop;
                }
                catch { /* next */ }
            }
            // co-located test next to the source file
            for (const s of TEST_SUFFIXES) {
                try {
                    await access(join(srcAbsDir, `${sibBase}${s}${sibExt}`));
                    siblingConventionDir = dir;
                    break sibLoop;
                }
                catch { /* next */ }
            }
        }
    }
    catch { /* readdir failed — fall through */ }
    if (siblingConventionDir !== null) {
        await mkdir(join(cwd, siblingConventionDir), { recursive: true });
        return join(siblingConventionDir, `${base}.test${ext}`);
    }
    // Mirror test directory: if this project uses a separate test/ tree, place the
    // new test there rather than creating a co-located __tests__ folder.
    const parts = mirrorParts(sourceFile, sourceDirs);
    if (parts) {
        const { srcDirParent, relPath } = parts;
        for (const testRoot of MIRROR_TEST_ROOTS) {
            const testRootAbs = join(cwd, srcDirParent, testRoot);
            // Require the root to actually contain tests — a bare `test/` that only holds
            // mock/setup helpers must not hijack placement away from the real convention.
            if ((await dirExists(testRootAbs)) && (await dirContainsTestFile(testRootAbs))) {
                const targetDir = join(testRootAbs, dirname(relPath));
                await mkdir(targetDir, { recursive: true });
                return join(srcDirParent, testRoot, dirname(relPath), `${base}.test${ext}`);
            }
        }
    }
    const testsDir = join(cwd, dir, '__tests__');
    await mkdir(testsDir, { recursive: true });
    return join(dir, '__tests__', `${base}.test${ext}`);
}
async function findExistingTestFile(sourceFile, cwd, sourceDirs = ['src']) {
    const ext = extname(sourceFile);
    const base = basename(sourceFile, ext);
    const dir = dirname(sourceFile);
    // Attempt 1: co-located (next to source, or inside __tests__ sibling)
    const candidates = [
        ...TEST_SUFFIXES.map((s) => join(cwd, dir, '__tests__', `${base}${s}${ext}`)),
        ...TEST_SUFFIXES.map((s) => join(cwd, dir, `${base}${s}${ext}`)),
        join(cwd, dir, `test_${base}${ext}`),
        join(cwd, dir, `${base}_test${ext}`),
    ];
    for (const candidate of candidates) {
        try {
            await readFile(candidate);
            return candidate;
        }
        catch { /* not found */ }
    }
    // Attempt 2: mirrored test directory tree (exact path mirror)
    // Finds: packages/server/src/adapters/auth/Foo.ts → packages/server/test/unit/adapters/auth/Foo.test.ts
    const parts = mirrorParts(sourceFile, sourceDirs);
    if (parts) {
        const { srcDirParent, relPath } = parts;
        const relDir = dirname(relPath);
        for (const testRoot of MIRROR_TEST_ROOTS) {
            for (const s of TEST_SUFFIXES) {
                const candidate = join(cwd, srcDirParent, testRoot, relDir, `${base}${s}${ext}`);
                try {
                    await readFile(candidate);
                    return candidate;
                }
                catch { /* not found */ }
            }
        }
    }
    // Attempt 3: filename search within known test root directories
    // Handles projects where test path doesn't exactly mirror source path
    // (e.g. src/lib/interactors/Foo.ts → test/unit/interactors/Foo.test.ts — "lib" dropped)
    const srcDirParent = parts?.srcDirParent ?? '';
    for (const testRoot of MIRROR_TEST_ROOTS) {
        const searchRoot = join(cwd, srcDirParent, testRoot);
        for (const s of TEST_SUFFIXES) {
            const found = await findFileByName(searchRoot, `${base}${s}${ext}`);
            if (found)
                return found;
        }
    }
    return null;
}
function relativeMockPath(testFile, mockFile) {
    const rel = relative(dirname(testFile), mockFile);
    return rel.startsWith('.') ? rel : `./${rel}`;
}
// ─── Type definition collector ────────────────────────────────────────────────
async function readTsconfigAliases(cwd) {
    const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];
    for (const name of candidates) {
        try {
            const raw = await readFile(join(cwd, name), 'utf-8');
            const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
            const tsconfig = JSON.parse(stripped);
            if (tsconfig.compilerOptions?.paths)
                return tsconfig.compilerOptions.paths;
        }
        catch { /* try next */ }
    }
    return {};
}
// Resolve an import path to an absolute filesystem base path (no extension).
// Returns null for node_modules and unresolvable paths.
function resolveLocalImport(importPath, absoluteSourcePath, cwd, aliases) {
    // Tsconfig alias resolution (e.g. "@/*" → "src/*")
    for (const [pattern, targets] of Object.entries(aliases)) {
        const aliasPrefix = pattern.replace(/\*$/, ''); // "@/*" → "@/"
        const targetBase = (targets[0] ?? '').replace(/\*$/, ''); // "src/*" → "src/"
        if (importPath.startsWith(aliasPrefix)) {
            return join(cwd, targetBase + importPath.slice(aliasPrefix.length));
        }
        if (importPath === pattern.replace(/\/\*$/, '')) {
            return join(cwd, targets[0] ?? '');
        }
    }
    // Relative import
    if (importPath.startsWith('.'))
        return join(dirname(absoluteSourcePath), importPath);
    return null;
}
// Find the actual file by trying common extensions on a base path.
async function resolveToFile(basePath) {
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
        try {
            await access(basePath + suffix);
            return basePath + suffix;
        }
        catch { /* try next */ }
    }
    return null;
}
// Extract exported interface/type/enum declarations via brace-depth tracking.
// Only captures the declarations themselves — not function bodies, classes, or constants.
function extractTypeDeclarations(code) {
    const lines = code.split('\n');
    const result = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (/^\s*export\s+(interface|type|enum)\s+\w+/.test(line)) {
            const block = [line];
            let depth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
            if (depth <= 0) {
                // Single-line: export type Foo = string | number
                result.push(line.trimEnd());
                i++;
                continue;
            }
            // Multi-line: collect until braces balance
            i++;
            while (i < lines.length && depth > 0) {
                block.push(lines[i]);
                depth += (lines[i].match(/\{/g) ?? []).length;
                depth -= (lines[i].match(/\}/g) ?? []).length;
                i++;
            }
            result.push(block.join('\n'));
            result.push('');
            continue;
        }
        i++;
    }
    return result.join('\n').trim();
}
const MAX_TYPE_FILES = 10;
const MAX_TYPE_CHARS = 4000;
// Scans a source file's imports and follows them transitively (BFS) to collect
// interface/type/enum declarations from any locally-defined types they reference.
// Stops at MAX_TYPE_FILES files or MAX_TYPE_CHARS characters to stay prompt-safe.
export async function collectTypeDefinitions(sourceCode, absoluteSourcePath, cwd) {
    const aliases = await readTsconfigAliases(cwd);
    // BFS: each entry is a file whose imports we still need to follow.
    // Start with the source file itself so we traverse its direct imports first.
    const toFollow = [
        { code: sourceCode, absolutePath: absoluteSourcePath },
    ];
    // Mark the source file visited so we never re-process it as a type file.
    const visited = new Set([absoluteSourcePath]);
    const blocks = [];
    let totalChars = 0;
    while (toFollow.length > 0 && blocks.length < MAX_TYPE_FILES && totalChars < MAX_TYPE_CHARS) {
        const { code, absolutePath } = toFollow.shift();
        for (const m of code.matchAll(/^import(?:\s+type)?\s[^'"]*['"]([^'"]+)['"]/gm)) {
            if (blocks.length >= MAX_TYPE_FILES || totalChars >= MAX_TYPE_CHARS)
                break;
            const base = resolveLocalImport(m[1], absolutePath, cwd, aliases);
            if (!base)
                continue;
            const file = await resolveToFile(base);
            if (!file || visited.has(file))
                continue;
            visited.add(file);
            let content;
            try {
                content = await readFile(file, 'utf-8');
            }
            catch {
                continue;
            }
            // Collect type declarations from this file (if any)
            const declarations = extractTypeDeclarations(content);
            if (declarations) {
                const block = `// from ${relative(cwd, file)}\n${declarations}`;
                blocks.push(block);
                totalChars += block.length;
            }
            // Always follow this file's imports too — it might re-export types from
            // deeper files even if it has no declarations of its own.
            toFollow.push({ code: content, absolutePath: file });
        }
    }
    return blocks.length > 0 ? blocks.join('\n\n') : null;
}
// Returns the pre-computed relative import paths (from the test file) for every
// local module imported by the source file. These are the exact strings the AI
// should use in vi.mock() / jest.mock() calls — no directory counting required.
// Only direct imports are included (no BFS) since you mock direct deps, not transitive ones.
export async function collectLocalImportPaths(sourceCode, absoluteSourcePath, absoluteTestFilePath, cwd) {
    const aliases = await readTsconfigAliases(cwd);
    const results = [];
    const seen = new Set();
    for (const m of sourceCode.matchAll(/^import(?:\s+type)?\s[^'"]*['"]([^'"]+)['"]/gm)) {
        const importPath = m[1];
        const base = resolveLocalImport(importPath, absoluteSourcePath, cwd, aliases);
        if (!base)
            continue; // skip node_modules
        const file = await resolveToFile(base);
        if (!file || seen.has(file))
            continue;
        seen.add(file);
        const rel = computeRelativeImport(absoluteTestFilePath, file);
        results.push(rel);
    }
    return results.length > 0 ? results : null;
}
// ─── Used-symbols context ─────────────────────────────────────────────────────
// Builds a targeted map of exactly what the source component uses from its local
// imports: hook return shapes, service method signatures, type declarations.
// No arbitrary line cap — output is naturally bounded by what's actually referenced.
// BFS follows transitive type references (e.g. Draw type used by useDraws hook).
// Extract a brace-balanced block starting at lines[startIdx].
// Also handles brace-less type aliases by continuing while a continuation is implied.
function extractBraceBlock(lines, startIdx) {
    const block = [];
    let depth = 0;
    let opened = false;
    for (let i = startIdx; i < lines.length; i++) {
        block.push(lines[i]);
        for (const ch of lines[i]) {
            if (ch === '{') {
                depth++;
                opened = true;
            }
            else if (ch === '}')
                depth--;
        }
        if (opened && depth <= 0)
            break;
        if (!opened && i > startIdx) {
            const t = lines[i].trimEnd();
            const nextStartsCont = (i + 1 < lines.length) && /^\s*[|&]/.test(lines[i + 1]);
            const isCont = t.endsWith('|') || t.endsWith('&') || t.endsWith(',') || t.endsWith('=') || nextStartsCont;
            if (!isCont)
                break;
        }
    }
    return block.join('\n');
}
const MAX_FN_LINES = 25;
// For long functions/hooks: keep signature + "// ..." + last return statement.
function summariseFunctionBlock(code) {
    const lines = code.split('\n');
    if (lines.length <= MAX_FN_LINES)
        return code;
    let bodyOpen = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('{')) {
            bodyOpen = i;
            break;
        }
    }
    let returnStart = -1;
    for (let i = lines.length - 2; i > bodyOpen; i--) {
        if (/^\s*return\b/.test(lines[i])) {
            returnStart = i;
            break;
        }
    }
    const sig = lines.slice(0, bodyOpen + 1);
    if (returnStart === -1)
        return [...sig, '  // ...', '}'].join('\n');
    return [...sig, '  // ...', ...lines.slice(returnStart)].join('\n');
}
// For classes: keep declaration + method signatures, collapse all bodies.
function summariseClassBlock(code) {
    const lines = code.split('\n');
    const out = [lines[0]];
    let depth = 0;
    for (const ch of lines[0]) {
        if (ch === '{')
            depth++;
        else if (ch === '}')
            depth--;
    }
    let i = 1;
    while (i < lines.length) {
        const line = lines[i];
        const t = line.trim();
        if (!t || /^[/*]/.test(t) || t === '}') {
            out.push(line);
            for (const ch of line) {
                if (ch === '{')
                    depth++;
                else if (ch === '}')
                    depth--;
            }
            i++;
            continue;
        }
        // At class body depth (1): detect method-like lines by presence of '('
        if (depth === 1 && /\(/.test(t) && !/^\s*\/\//.test(line)) {
            const sigLines = [];
            let d = depth;
            let j = i;
            while (j < lines.length) {
                const l = lines[j];
                d += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
                sigLines.push(l);
                j++;
                if (d > depth)
                    break; // body opened
                if (d === depth)
                    break; // abstract / no body
            }
            // Show sig lines but strip the opening `{` from the last one
            for (let k = 0; k < sigLines.length - 1; k++)
                out.push(sigLines[k]);
            const last = sigLines[sigLines.length - 1].replace(/\s*\{[^}]*$/, '').trimEnd();
            if (last.trim())
                out.push(last);
            if (d > depth) {
                // Skip method body
                i = j;
                while (i < lines.length && d > depth) {
                    d += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
                    i++;
                }
                depth = d;
                continue;
            }
            depth = d;
            i = j;
            continue;
        }
        out.push(line);
        for (const ch of line) {
            if (ch === '{')
                depth++;
            else if (ch === '}')
                depth--;
        }
        i++;
    }
    return out.join('\n');
}
// PascalCase identifiers in code that look like local type references.
const TYPE_REF_BUILTINS = new Set([
    'React', 'Promise', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Error',
    'Date', 'Map', 'Set', 'RegExp', 'Function', 'Symbol', 'URL', 'JSON', 'Event',
    'HTMLElement', 'Element', 'Node', 'Window', 'Document', 'MouseEvent', 'KeyboardEvent',
    'FC', 'ReactNode', 'ReactElement', 'ComponentProps', 'Dispatch', 'SetStateAction',
    'MutableRefObject', 'RefObject', 'CSSProperties', 'SyntheticEvent', 'PropsWithChildren',
    'Partial', 'Required', 'Readonly', 'Record', 'Pick', 'Omit', 'Exclude', 'Extract',
    'NonNullable', 'ReturnType', 'InstanceType', 'Parameters', 'Awaited',
    'View', 'Text', 'ScrollView', 'FlatList', 'TouchableOpacity', 'Animated',
]);
function extractTypeRefs(code) {
    const found = new Set();
    for (const m of code.matchAll(/\b([A-Z][a-zA-Z0-9]+)\b/g)) {
        if (!TYPE_REF_BUILTINS.has(m[1]))
            found.add(m[1]);
    }
    return [...found];
}
function extractAllExportNames(code) {
    const names = [];
    for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/gm))
        names.push(m[1]);
    for (const m of code.matchAll(/^export\s+\{([^}]+)\}/gm)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop()?.trim();
            if (name && /^\w+$/.test(name))
                names.push(name);
        }
    }
    return [...new Set(names)];
}
function extractSymbolFromCode(code, name) {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/\bexport\b/.test(line))
            continue;
        // Re-export: export [type] { X as Y } from './path'
        const reFrom = line.match(/^export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
        if (reFrom) {
            for (const part of reFrom[1].split(',')) {
                const halves = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
                const exported = (halves[1] ?? halves[0]).trim();
                if (exported === name)
                    return { code: '', reexportPath: reFrom[2], reexportName: halves[0].trim() };
            }
            continue;
        }
        if (name === 'default' && /^\s*export\s+default\b/.test(line)) {
            const block = extractBraceBlock(lines, i);
            const isClass = /^\s*export\s+default\s+(?:abstract\s+)?class\b/.test(line);
            return { code: isClass ? summariseClassBlock(block) : summariseFunctionBlock(block) };
        }
        if (new RegExp(`^\\s*export\\s+(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*[<(]`).test(line)) {
            return { code: summariseFunctionBlock(extractBraceBlock(lines, i)) };
        }
        if (new RegExp(`^\\s*export\\s+const\\s+${name}\\s*[=:]`).test(line)) {
            return { code: summariseFunctionBlock(extractBraceBlock(lines, i)) };
        }
        if (new RegExp(`^\\s*export\\s+(?:abstract\\s+)?class\\s+${name}\\b`).test(line)) {
            return { code: summariseClassBlock(extractBraceBlock(lines, i)) };
        }
        if (new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:interface|type|enum)\\s+${name}\\b`).test(line)) {
            return { code: extractBraceBlock(lines, i) };
        }
    }
    return null;
}
// Parse which symbols a source file imports from each local dependency.
// Returns Map<absoluteFilePath, Set<symbolName>> — '*' means namespace import.
async function parseImportedSymbols(code, fromAbsPath, cwd, aliases) {
    const result = new Map();
    for (const m of code.matchAll(/^import(?:\s+type)?\s+(.+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
        const clause = m[1].trim();
        const base = resolveLocalImport(m[2], fromAbsPath, cwd, aliases);
        if (!base)
            continue;
        const file = await resolveToFile(base);
        if (!file)
            continue;
        const syms = result.get(file) ?? new Set();
        result.set(file, syms);
        if (/\*\s+as\s+/.test(clause)) {
            syms.add('*');
            continue;
        }
        const namedMatch = clause.match(/\{([^}]+)\}/);
        if (namedMatch) {
            for (const part of namedMatch[1].split(',')) {
                const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
                if (/^\w+$/.test(name))
                    syms.add(name);
            }
        }
        const stripped = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+\w+/, '').trim();
        const def = stripped.match(/^(\w+)/);
        if (def && def[1] !== 'type')
            syms.add('default');
    }
    return result;
}
const MAX_SYMBOLS_TOTAL_CHARS = 14000;
// Builds targeted context from only the symbols the source component actually uses.
// For each imported symbol: extracts its declaration, collapses function bodies to
// signature + return, collapses class bodies to method signatures.
// Transitively follows PascalCase type references through their import chains (BFS).
export async function collectUsedSymbolsContext(sourceCode, absoluteSourcePath, cwd) {
    const aliases = await readTsconfigAliases(cwd);
    const directImports = await parseImportedSymbols(sourceCode, absoluteSourcePath, cwd, aliases);
    const queue = [];
    for (const [file, syms] of directImports)
        queue.push({ file, symbols: new Set(syms) });
    const visited = new Set(); // `${file}::${symbol}`
    const fileSections = [];
    let totalChars = 0;
    while (queue.length > 0 && totalChars < MAX_SYMBOLS_TOTAL_CHARS) {
        const { file, symbols } = queue.shift();
        let fileContent;
        try {
            fileContent = await readFile(file, 'utf-8');
        }
        catch {
            continue;
        }
        const toProcess = symbols.has('*') ? new Set(extractAllExportNames(fileContent)) : symbols;
        const fileBlocks = [];
        const typeRefs = new Set();
        for (const sym of toProcess) {
            const key = `${file}::${sym}`;
            if (visited.has(key))
                continue;
            visited.add(key);
            const result = extractSymbolFromCode(fileContent, sym);
            if (!result)
                continue;
            if (result.reexportPath) {
                const base = resolveLocalImport(result.reexportPath, file, cwd, aliases);
                if (base) {
                    const reFile = await resolveToFile(base);
                    if (reFile) {
                        const reSym = result.reexportName ?? sym;
                        if (!visited.has(`${reFile}::${reSym}`))
                            queue.push({ file: reFile, symbols: new Set([reSym]) });
                    }
                }
                continue;
            }
            if (result.code) {
                fileBlocks.push(result.code);
                for (const ref of extractTypeRefs(result.code))
                    typeRefs.add(ref);
            }
        }
        // Follow type references: first check same file, then follow cross-file imports
        if (typeRefs.size > 0) {
            // Same-file types (defined in this file but not yet extracted)
            for (const ref of typeRefs) {
                const key = `${file}::${ref}`;
                if (visited.has(key))
                    continue;
                const local = extractSymbolFromCode(fileContent, ref);
                if (local?.code) {
                    visited.add(key);
                    fileBlocks.push(local.code);
                }
            }
            // Cross-file types (imported by this file from another local file)
            const typeImports = await parseImportedSymbols(fileContent, file, cwd, aliases);
            for (const [typeFile, typeSyms] of typeImports) {
                const relevant = new Set([...typeSyms].filter(s => typeRefs.has(s)));
                if (relevant.size > 0)
                    queue.push({ file: typeFile, symbols: relevant });
            }
        }
        if (fileBlocks.length > 0) {
            const section = `// from ${relative(cwd, file)}\n${fileBlocks.join('\n\n')}`;
            fileSections.push(section);
            totalChars += section.length;
        }
    }
    return fileSections.length > 0 ? fileSections.join('\n\n') : null;
}
// Reads the React major version from package.json, or null if React is not a dependency.
export async function detectReactMajorVersion(cwd) {
    try {
        const raw = await readFile(join(cwd, 'package.json'), 'utf-8');
        const pkg = JSON.parse(raw);
        const version = { ...pkg.dependencies, ...pkg.devDependencies }['react'];
        if (!version)
            return null;
        const m = version.match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }
    catch {
        return null;
    }
}
async function readPackageDeps(cwd) {
    try {
        const raw = await readFile(join(cwd, 'package.json'), 'utf-8');
        const pkg = JSON.parse(raw);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const testKeys = [
            'vitest', 'jest', '@jest/core', 'mocha', 'chai',
            '@testing-library/react', '@testing-library/user-event', '@testing-library/jest-dom',
            '@testing-library/vue', '@testing-library/svelte',
            'react', 'react-dom', 'vue', 'svelte',
            'msw', 'nock', 'supertest', 'axios-mock-adapter',
            '@types/jest', 'ts-jest', 'babel-jest',
        ];
        const relevant = Object.entries(deps)
            .filter(([k]) => testKeys.some((t) => k.includes(t)))
            .map(([k, v]) => `  "${k}": "${v}"`)
            .join('\n');
        return relevant || null;
    }
    catch {
        return null;
    }
}
async function readTsconfigPaths(cwd) {
    const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];
    for (const name of candidates) {
        try {
            const raw = await readFile(join(cwd, name), 'utf-8');
            const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
            const tsconfig = JSON.parse(stripped);
            const opts = tsconfig.compilerOptions;
            if (!opts)
                continue;
            const lines = [];
            // Strictness flags — critical for the AI to know what type safety is enforced
            const strictFlags = [
                opts.strict && 'strict',
                opts.noImplicitAny && 'noImplicitAny',
                opts.strictNullChecks && 'strictNullChecks',
                opts.noUncheckedIndexedAccess && 'noUncheckedIndexedAccess',
                opts.exactOptionalPropertyTypes && 'exactOptionalPropertyTypes',
            ].filter(Boolean);
            if (strictFlags.length)
                lines.push(`Strict flags: ${strictFlags.join(', ')}`);
            if (opts.target)
                lines.push(`target: "${opts.target}"`);
            if (opts.jsx)
                lines.push(`jsx: "${opts.jsx}"`);
            // Path aliases
            if (opts.baseUrl)
                lines.push(`baseUrl: "${opts.baseUrl}"`);
            if (opts.paths) {
                for (const [alias, targets] of Object.entries(opts.paths)) {
                    lines.push(`  "${alias}" → "${targets[0]}"`);
                }
            }
            if (lines.length === 0)
                continue;
            return lines.join('\n');
        }
        catch { /* try next */ }
    }
    return null;
}
// Lightweight context for fix-loop: reads mocks/setup/deps/tsconfig relative to
// the actual test file path. Does NOT call inferTestFilePath or findExistingTestFile
// (which would compute wrong paths and create spurious __tests__/ directories).
export async function buildFixFileContext(absTestPath, cwd, config) {
    let mocksCode = null;
    let mocksImportPath = null;
    if (config?.mocksFile) {
        const absoluteMocks = join(cwd, config.mocksFile);
        mocksImportPath = relativeMockPath(absTestPath, absoluteMocks);
        try {
            mocksCode = await readFile(absoluteMocks, 'utf-8');
        }
        catch { /* mocks file not created yet — AI will create it */ }
    }
    let setupFileCode = null;
    if (config?.setupFile) {
        try {
            setupFileCode = await readFile(join(cwd, config.setupFile), 'utf-8');
        }
        catch { /* setup file not found */ }
    }
    const [packageDeps, tsconfigPaths] = await Promise.all([
        readPackageDeps(cwd),
        readTsconfigPaths(cwd),
    ]);
    return { mocksCode, mocksImportPath, setupFileCode, packageDeps, tsconfigPaths };
}
export async function buildFileContext(sourceFilePath, cwd, env, config) {
    const absoluteSource = join(cwd, sourceFilePath);
    const sourceCode = await readFile(absoluteSource, 'utf-8');
    const srcDirs = config?.sourceDir ? (Array.isArray(config.sourceDir) ? config.sourceDir : [config.sourceDir]) : ['src'];
    const existingTestFile = await findExistingTestFile(sourceFilePath, cwd, srcDirs);
    const existingTestCode = existingTestFile ? await readFile(existingTestFile, 'utf-8') : null;
    const suggestedTestFile = existingTestFile ?? join(cwd, await inferTestFilePath(sourceFilePath, cwd, env, srcDirs));
    const sourceImportPath = computeRelativeImport(suggestedTestFile, absoluteSource);
    let mocksCode = null;
    let mocksImportPath = null;
    if (config?.mocksFile) {
        const absoluteMocks = join(cwd, config.mocksFile);
        // Always compute the import path — even if the file doesn't exist yet,
        // the AI needs to know where to create/import it from.
        mocksImportPath = relativeMockPath(suggestedTestFile, absoluteMocks);
        try {
            mocksCode = await readFile(absoluteMocks, 'utf-8');
        }
        catch { /* file not created yet — AI will create it */ }
    }
    let setupFileCode = null;
    if (config?.setupFile) {
        try {
            setupFileCode = await readFile(join(cwd, config.setupFile), 'utf-8');
        }
        catch { /* setup file not found — skip */ }
    }
    const [packageDeps, tsconfigPaths, typeDefinitions, localImportPaths, localImportContents, reactMajorVersion] = await Promise.all([
        readPackageDeps(cwd),
        readTsconfigPaths(cwd),
        collectTypeDefinitions(sourceCode, absoluteSource, cwd),
        collectLocalImportPaths(sourceCode, absoluteSource, suggestedTestFile, cwd),
        collectUsedSymbolsContext(sourceCode, absoluteSource, cwd),
        detectReactMajorVersion(cwd),
    ]);
    return {
        sourceFile: sourceFilePath,
        sourceCode,
        existingTestFile,
        existingTestCode,
        suggestedTestFile,
        sourceImportPath,
        mocksCode,
        mocksImportPath,
        setupFileCode,
        packageDeps,
        tsconfigPaths,
        typeDefinitions,
        localImportPaths,
        localImportContents,
        reactMajorVersion,
    };
}
//# sourceMappingURL=context.js.map