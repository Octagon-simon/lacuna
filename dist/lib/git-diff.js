import { join } from 'path';
import { runCommand } from './runner.js';
import { isWithinDir } from './coverage/gaps.js';
// Only source files can carry patch coverage — everything else (docs, configs, lockfiles)
// is skipped at parse time. Testability (types-only files etc.) is filtered downstream by
// the same gap pipeline the rest of lacuna uses.
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
// Refs are interpolated into a shell command — allow only ref-shaped strings.
const SAFE_REF_RE = /^[\w\-./@~^{}]+$/;
const GIT_TIMEOUT_MS = 30_000;
export class GitDiffError extends Error {
}
async function git(cwd, args) {
    const res = await runCommand(`git ${args}`, cwd, GIT_TIMEOUT_MS);
    return { ok: res.success, out: res.stdout.trim() };
}
async function refExists(cwd, ref) {
    return (await git(cwd, `rev-parse --verify --quiet ${ref}`)).ok;
}
// Base-ref precedence: explicit `@diff:<ref>` → the remote's default branch (origin/HEAD) →
// local main/master → HEAD~1 as a last resort.
async function resolveBaseRef(cwd, explicitRef) {
    if (explicitRef) {
        if (!SAFE_REF_RE.test(explicitRef)) {
            throw new GitDiffError(`"${explicitRef}" is not a valid git ref.`);
        }
        if (!(await refExists(cwd, explicitRef))) {
            throw new GitDiffError(`Base ref "${explicitRef}" could not be resolved.\n` +
                `Fetch it first: git fetch origin ${explicitRef.replace(/^origin\//, '')}\n` +
                `In a shallow CI clone you may also need: git fetch --unshallow`);
        }
        return explicitRef;
    }
    const originHead = await git(cwd, 'rev-parse --abbrev-ref origin/HEAD');
    if (originHead.ok && originHead.out && originHead.out !== 'origin/HEAD')
        return originHead.out;
    for (const candidate of ['main', 'master']) {
        if (await refExists(cwd, `refs/heads/${candidate}`))
            return candidate;
    }
    if (await refExists(cwd, 'HEAD~1'))
        return 'HEAD~1';
    throw new GitDiffError('Could not resolve a base ref for @diff — no origin/HEAD, no local main/master, and no parent commit.\n' +
        'Pass one explicitly: lacuna generate @diff:<base-ref>');
}
// Resolves the base ref + merge-base and returns the changed-line map. Throws GitDiffError
// with an actionable message when the repo/base can't be resolved (the caller exits non-zero
// rather than silently diffing against nothing).
export async function resolveDiffScope(cwd, explicitRef) {
    const inRepo = await git(cwd, 'rev-parse --is-inside-work-tree');
    if (!inRepo.ok) {
        throw new GitDiffError('@diff needs a git repository — this directory is not one (or git is not installed).');
    }
    const baseRef = await resolveBaseRef(cwd, explicitRef);
    const mb = await git(cwd, `merge-base ${baseRef} HEAD`);
    if (!mb.ok || !mb.out) {
        throw new GitDiffError(`Could not compute a merge-base between ${baseRef} and HEAD.\n` +
            `In a shallow CI clone, fetch history first: git fetch --unshallow\n` +
            `(or fetch the base branch: git fetch origin ${baseRef.replace(/^origin\//, '')})`);
    }
    const mergeBase = mb.out;
    // Diff the merge-base against the WORKING TREE (not HEAD): in CI they're identical, and
    // locally the coverage report was produced from the files on disk — so working-tree line
    // numbers are the ones that line up with lcov. --unified=0 makes hunk headers exactly the
    // changed ranges; --diff-filter=d drops pure deletions (nothing to cover).
    const diff = await runCommand(`git diff --unified=0 --no-color --diff-filter=d ${mergeBase}`, cwd, GIT_TIMEOUT_MS);
    // A failed/empty diff run means "no changed files" — never throw the run for this.
    const changed = diff.stdout ? parseUnifiedDiff(diff.stdout, cwd) : new Map();
    return { baseRef, mergeBase, changed };
}
// Parses `git diff --unified=0` output into changed new-side lines per absolute path.
// With zero context lines the `@@ -a,b +c,d @@` headers ARE the changed ranges (c..c+d-1,
// d omitted = 1, d=0 = deletion-only hunk → nothing on the new side). Exported for tests.
export function parseUnifiedDiff(diffOutput, cwd) {
    const changed = new Map();
    let current = null;
    for (const line of diffOutput.split('\n')) {
        if (line.startsWith('+++ ')) {
            let p = line.slice(4).trim();
            if (p === '/dev/null') {
                current = null;
                continue;
            } // pure deletion
            if (p.startsWith('"') && p.endsWith('"'))
                p = p.slice(1, -1); // quoted (special chars)
            if (p.startsWith('b/'))
                p = p.slice(2);
            if (!SOURCE_EXT_RE.test(p)) {
                current = null;
                continue;
            }
            const abs = p.startsWith('/') ? p : join(cwd, p);
            current = changed.get(abs) ?? new Set();
            changed.set(abs, current);
            continue;
        }
        if (current !== null && line.startsWith('@@')) {
            const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (!m)
                continue;
            const start = parseInt(m[1], 10);
            const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
            for (let i = 0; i < count; i++)
                current.add(start + i);
        }
    }
    for (const [path, lines] of changed) {
        if (lines.size === 0)
            changed.delete(path); // file had only deletion hunks
    }
    return changed;
}
// Narrows a diff scope to only the changed files that live under `absDir` — the
// `@diff <dir>` case (patch coverage of just the changed lines inside a folder). The
// base ref / merge-base are untouched; only the changed-line map is filtered.
export function scopeDiffToDir(scope, absDir) {
    const changed = new Map();
    for (const [path, lines] of scope.changed) {
        if (isWithinDir(path, absDir))
            changed.set(path, lines);
    }
    return { ...scope, changed };
}
// Total changed-line count across all files — used for the CLI header.
export function countChangedLines(changed) {
    let n = 0;
    for (const lines of changed.values())
        n += lines.size;
    return n;
}
//# sourceMappingURL=git-diff.js.map