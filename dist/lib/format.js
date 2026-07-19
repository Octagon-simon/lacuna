import { access, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { runCommand } from './runner.js';
import { fileTestCommand } from './detector.js';
// Run the project's OWN formatter(s) on a freshly written test file so generated/fixed output
// matches repo style (indentation, semicolons, quotes) and clears the repo's lint gate — the
// model frequently emits 2-space/no-semicolon blocks inconsistent with the surrounding file.
//
// Design rules:
//   • Project-local only. We resolve `node_modules/.bin/<tool>` directly and never shell out to
//     `npx`, so an absent tool can't trigger a surprise network install. If the project has
//     NEITHER eslint nor prettier, formatting is a silent no-op — there is no canonical style to
//     match, and bundling/forcing a formatter would fight the repo's conventions. (The model's
//     output already passed our internal transforms: dedupeImports, typeImportOriginalCalls, etc.)
//   • Best-effort. Every step is timed out; failures (config errors, rule crashes) are swallowed —
//     a formatter that can't run must never fail test generation.
//   • Behavior-preserving. prettier only touches whitespace, but `eslint --fix` can change code.
//     So after eslint we RE-RUN the file; if its fix broke the (already-passing) tests, we restore
//     the pre-eslint content. This guarantees formatting never regresses a green file.
const eslintBinCache = new Map();
const prettierBinCache = new Map();
async function exists(p) {
    try {
        await access(p);
        return true;
    }
    catch {
        return false;
    }
}
// Resolve a project-local tool binary, or null if the project doesn't have it installed.
async function localBin(cwd, name, cache) {
    const hit = cache.get(cwd);
    if (hit !== undefined)
        return hit;
    const bin = join(cwd, 'node_modules', '.bin', name);
    const resolved = (await exists(bin)) ? bin : null;
    cache.set(cwd, resolved);
    return resolved;
}
export async function formatFile(absPath, cwd, opts = {}) {
    if (opts.enabled === false)
        return;
    const eslint = await localBin(cwd, 'eslint', eslintBinCache);
    const prettier = await localBin(cwd, 'prettier', prettierBinCache);
    if (!eslint && !prettier)
        return; // project has no formatter → safe no-op
    const quoted = JSON.stringify(absPath);
    // eslint --fix first (can reorder/rewrite), guarded by a re-verify; prettier last (whitespace).
    if (eslint) {
        const before = await readFile(absPath, 'utf-8').catch(() => null);
        await runCommand(`${JSON.stringify(eslint)} --fix ${quoted}`, cwd, 60_000);
        if (before !== null && opts.env) {
            const after = await readFile(absPath, 'utf-8').catch(() => null);
            if (after !== null && after !== before) {
                // eslint changed the file — make sure it didn't break the (already-green) tests.
                const res = await runCommand(fileTestCommand(opts.env, absPath), cwd, 60_000);
                if (!res.success) {
                    await writeFile(absPath, before, 'utf-8').catch(() => { });
                }
            }
        }
    }
    if (prettier) {
        await runCommand(`${JSON.stringify(prettier)} --write ${quoted}`, cwd, 30_000);
    }
}
//# sourceMappingURL=format.js.map