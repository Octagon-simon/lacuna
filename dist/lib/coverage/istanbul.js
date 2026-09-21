import { readFile } from 'fs/promises';
import { join } from 'path';
function toFileCoverage(path, entry) {
    // Line hits: a line is covered if ANY statement starting on it executed. Multiple statements can
    // share a line, so keep the max hit count for that line (matches istanbul→lcov line semantics).
    const lineHits = new Map();
    for (const [id, stmt] of Object.entries(entry.statementMap ?? {})) {
        const line = stmt?.start?.line;
        if (typeof line !== 'number')
            continue;
        const hit = entry.s?.[id] ?? 0;
        lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hit));
    }
    const lines = [...lineHits.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([line, hit]) => ({ line, hit }));
    const functions = Object.entries(entry.fnMap ?? {}).map(([id, fn]) => ({
        name: fn.name || 'anonymous',
        line: fn.decl?.start?.line ?? fn.line ?? fn.loc?.start?.line ?? 0,
        hit: entry.f?.[id] ?? 0,
    }));
    const coveredLines = lines.filter((l) => l.hit > 0).length;
    const coveredFns = functions.filter((fn) => fn.hit > 0).length;
    return {
        path,
        lines,
        functions,
        lineRate: lines.length ? coveredLines / lines.length : 1,
        functionRate: functions.length ? coveredFns / functions.length : 1,
    };
}
export function coverageFinalPath(coverageDir, cwd) {
    return join(cwd, coverageDir, 'coverage-final.json');
}
export async function parseCoverageFinal(coverageDir, cwd = process.cwd()) {
    const raw = await readFile(coverageFinalPath(coverageDir, cwd), 'utf-8');
    const data = JSON.parse(raw);
    const entries = Object.entries(data);
    if (entries.length === 0)
        throw new Error('coverage-final.json is empty');
    const files = entries.map(([path, entry]) => toFileCoverage(entry.path || path, entry));
    const totalLines = files.reduce((sum, f) => sum + f.lines.length, 0);
    const coveredLines = files.reduce((sum, f) => sum + f.lines.filter((l) => l.hit > 0).length, 0);
    const totalFns = files.reduce((sum, f) => sum + f.functions.length, 0);
    const coveredFns = files.reduce((sum, f) => sum + f.functions.filter((fn) => fn.hit > 0).length, 0);
    return {
        files,
        totalLineRate: totalLines ? coveredLines / totalLines : 1,
        totalFunctionRate: totalFns ? coveredFns / totalFns : 1,
    };
}
//# sourceMappingURL=istanbul.js.map