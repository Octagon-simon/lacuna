import { access, readFile } from 'fs/promises';
import { join, dirname, basename, resolve } from 'path';
import { runCommand } from './runner.js';
// implicit-any diagnostics fire ONLY under noImplicitAny. Matched by message so the whole
// family (TS7005/7006/7019/7031/7034/7053/…) is covered without enumerating codes.
const IMPLICIT_ANY_RE = /implicitly has (?:an? |type )?'any(?:\[\])?'/i;
async function pathExists(p) {
    try {
        await access(p);
        return true;
    }
    catch {
        return false;
    }
}
// Best-effort JSONC → JSON: strip comments and trailing commas so tsconfig files parse.
function stripJsonc(raw) {
    return raw
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/(^|[^:"])\/\/.*$/gm, '$1') // line comments (skips "http://")
        .replace(/,(\s*[}\]])/g, '$1'); // trailing commas
}
// Merge compilerOptions following the tsconfig `extends` chain (child overrides parent).
async function loadCompilerOptions(tsconfigPath, cwd, seen = new Set()) {
    if (seen.has(tsconfigPath))
        return {};
    seen.add(tsconfigPath);
    let cfg;
    try {
        cfg = JSON.parse(stripJsonc(await readFile(tsconfigPath, 'utf-8')));
    }
    catch {
        return {};
    }
    let base = {};
    if (typeof cfg.extends === 'string') {
        let extPath = null;
        if (cfg.extends.startsWith('.')) {
            extPath = resolve(dirname(tsconfigPath), cfg.extends.endsWith('.json') ? cfg.extends : cfg.extends + '.json');
        }
        else {
            const rel = cfg.extends.endsWith('.json') ? cfg.extends : join(cfg.extends, 'tsconfig.json');
            const candidate = join(cwd, 'node_modules', rel);
            if (await pathExists(candidate))
                extPath = candidate;
        }
        if (extPath)
            base = await loadCompilerOptions(extPath, cwd, seen);
    }
    return { ...base, ...(cfg.compilerOptions ?? {}) };
}
// Effective noImplicitAny for the tsconfig nearest to `absFilePath` (walking up to cwd),
// following `extends`. strict:true implies it unless explicitly overridden. Defaults to true
// (i.e. "enforced", so we never hide real errors) when no governing config can be resolved.
async function noImplicitAnyEnabled(absFilePath, cwd) {
    let dir = dirname(absFilePath);
    let nearest = null;
    while (true) {
        const candidate = join(dir, 'tsconfig.json');
        if (await pathExists(candidate)) {
            nearest = candidate;
            break;
        }
        if (dir === cwd || dir === dirname(dir))
            break;
        dir = dirname(dir);
    }
    if (!nearest || !(await pathExists(nearest)))
        return true;
    const opts = await loadCompilerOptions(nearest, cwd);
    if (typeof opts.noImplicitAny === 'boolean')
        return opts.noImplicitAny;
    return opts.strict === true;
}
// Run tsc --noEmit on the project and return type errors that belong to the given
// test file. Errors in other files are intentionally ignored — we only care about
// what the AI just wrote. Returns null when there are no errors or when type-checking
// is not applicable (non-TypeScript project, no tsconfig, tsc not available).
export async function typeCheckFile(absTestPath, cwd, env) {
    if (env.language !== 'typescript')
        return null;
    try {
        await access(join(cwd, 'tsconfig.json'));
    }
    catch {
        return null;
    }
    const result = await runCommand('npx tsc --noEmit --skipLibCheck', cwd, 60_000);
    if (result.success)
        return null;
    const fileName = basename(absTestPath);
    let errors = (result.stdout + '\n' + result.stderr)
        .split('\n')
        .filter((l) => l.includes(fileName) && /error TS\d+/.test(l));
    // Respect the file's governing tsconfig: if it disables noImplicitAny (e.g. a monorepo
    // package that loosens the strict root), implicit-any is not an error for this file — drop
    // those diagnostics so lacuna never fights a rule the project deliberately turned off.
    if (errors.length > 0 && !(await noImplicitAnyEnabled(absTestPath, cwd))) {
        errors = errors.filter((l) => !IMPLICIT_ANY_RE.test(l));
    }
    return errors.join('\n').trim() || null;
}
// Runs tsc ONCE over the whole project and returns the subset of `testFiles` (absolute
// paths) that have at least one type error. Far cheaper than calling typeCheckFile per
// file, which re-runs the entire project each time. Used by `lacuna fix --types` to select
// every test file that fails type-checking regardless of whether its tests pass.
export async function findTestFilesWithTypeErrors(testFiles, cwd, env) {
    if (env.language !== 'typescript' || testFiles.length === 0)
        return [];
    try {
        await access(join(cwd, 'tsconfig.json'));
    }
    catch {
        return [];
    }
    const result = await runCommand('npx tsc --noEmit --skipLibCheck', cwd, 180_000);
    if (result.success)
        return [];
    const errorLines = (result.stdout + '\n' + result.stderr)
        .split('\n')
        .filter((l) => /error TS\d+/.test(l));
    // Match by basename — mirrors typeCheckFile's own filter so selection and per-file
    // verification agree. (Same-basename files in different dirs may both be selected; the
    // per-file fix loop simply finds nothing to change in a false match and moves on.)
    // Honor each file's governing noImplicitAny just like typeCheckFile, so a file whose only
    // diagnostics are implicit-any in a package that allows it is not selected.
    const withErrors = [];
    for (const abs of testFiles) {
        const fileName = basename(abs);
        let lines = errorLines.filter((l) => l.includes(fileName));
        if (lines.length === 0)
            continue;
        if (!(await noImplicitAnyEnabled(abs, cwd)))
            lines = lines.filter((l) => !IMPLICIT_ANY_RE.test(l));
        if (lines.length > 0)
            withErrors.push(abs);
    }
    return withErrors;
}
//# sourceMappingURL=typecheck.js.map