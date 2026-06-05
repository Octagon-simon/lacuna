import { readFile } from 'fs/promises';
import { join } from 'path';
function entryToFileCoverage(path, entry) {
    return {
        path,
        lines: [],
        functions: [],
        lineRate: entry.lines.total ? entry.lines.covered / entry.lines.total : 1,
        functionRate: entry.functions.total ? entry.functions.covered / entry.functions.total : 1,
    };
}
export async function parseJsonSummary(coverageDir, cwd = process.cwd()) {
    const summaryPath = join(cwd, coverageDir, 'coverage-summary.json');
    const raw = await readFile(summaryPath, 'utf-8');
    const summary = JSON.parse(raw);
    const files = Object.entries(summary)
        .filter(([path]) => path !== 'total')
        .map(([path, entry]) => entryToFileCoverage(path, entry));
    const total = summary['total'];
    const totalLineRate = total ? total.lines.pct / 100 : files.reduce((s, f) => s + f.lineRate, 0) / (files.length || 1);
    const totalFunctionRate = total ? total.functions.pct / 100 : files.reduce((s, f) => s + f.functionRate, 0) / (files.length || 1);
    return { files, totalLineRate, totalFunctionRate };
}
//# sourceMappingURL=json.js.map