import { readFile } from 'fs/promises';
import { join } from 'path';
function parseLcovText(text) {
    const entries = [];
    let current = null;
    const fnNames = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('SF:')) {
            current = { file: line.slice(3), lines: [], functions: [] };
            Object.keys(fnNames).forEach((k) => delete fnNames[k]);
        }
        else if (line.startsWith('FN:') && current) {
            const [lineNo, name] = line.slice(3).split(',');
            fnNames[name] = parseInt(lineNo, 10);
        }
        else if (line.startsWith('FNDA:') && current) {
            const [hitStr, name] = line.slice(5).split(',');
            current.functions.push({ name, line: fnNames[name] ?? 0, hit: parseInt(hitStr, 10) });
        }
        else if (line.startsWith('DA:') && current) {
            const [lineNo, hitStr] = line.slice(3).split(',');
            current.lines.push({ line: parseInt(lineNo, 10), hit: parseInt(hitStr, 10) });
        }
        else if (line === 'end_of_record' && current) {
            entries.push(current);
            current = null;
        }
    }
    return entries;
}
function toFileCoverage(entry) {
    const coveredLines = entry.lines.filter((l) => l.hit > 0).length;
    const coveredFns = entry.functions.filter((f) => f.hit > 0).length;
    return {
        path: entry.file,
        lines: entry.lines,
        functions: entry.functions,
        lineRate: entry.lines.length ? coveredLines / entry.lines.length : 1,
        functionRate: entry.functions.length ? coveredFns / entry.functions.length : 1,
    };
}
export async function parseLcov(coverageDir, cwd = process.cwd()) {
    const lcovPath = join(cwd, coverageDir, 'lcov.info');
    const text = await readFile(lcovPath, 'utf-8');
    const entries = parseLcovText(text);
    const files = entries.map(toFileCoverage);
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
//# sourceMappingURL=lcov.js.map