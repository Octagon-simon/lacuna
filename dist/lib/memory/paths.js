import { homedir } from 'os';
import { join } from 'path';
// The single memory root — first homedir() use in this codebase (no existing global/user-level
// config precedent; config.ts loads entirely from cwd via cosmiconfig). Deliberately NOT
// project-scoped: a per-project store's only real justification was CI/parallel-process
// isolation (many jobs writing the same shared store concurrently can lose a confidence delta —
// see store.ts's withMemoryLock comment), which only matters at a scale this tool isn't run at
// yet, and the entries this system actually produces (the seed catalog, and
// writeback.ts's deriveMechanicalRule output) are already written generically enough that
// cross-project sharing doesn't leak wrong, repo-specific advice. One store, no scope dimension
// to reason about, test, or document.
export function globalMemoryRoot() {
    return join(homedir(), '.lacuna', 'memory');
}
export function entryPath(root, category, id) {
    return join(root, category, `${id}.json`);
}
export function indexPath(root) {
    return join(root, 'index.json');
}
//# sourceMappingURL=paths.js.map