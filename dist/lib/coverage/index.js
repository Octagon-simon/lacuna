import { stat } from 'fs/promises';
import { join } from 'path';
import { parseLcov } from './lcov.js';
import { parseJsonSummary } from './json.js';
export async function loadCoverage(config, cwd = process.cwd()) {
    if (config.coverageFormat === 'json-summary') {
        return parseJsonSummary(config.coverageDir, cwd);
    }
    return parseLcov(config.coverageDir, cwd);
}
export async function coverageAgeSeconds(config, cwd = process.cwd()) {
    const file = config.coverageFormat === 'json-summary'
        ? join(cwd, config.coverageDir, 'coverage-summary.json')
        : join(cwd, config.coverageDir, 'lcov.info');
    try {
        const { mtimeMs } = await stat(file);
        return (Date.now() - mtimeMs) / 1000;
    }
    catch {
        return null;
    }
}
export { extractGaps, filterTestableGaps, findUncoveredFiles, formatCoverageSummary } from './gaps.js';
//# sourceMappingURL=index.js.map