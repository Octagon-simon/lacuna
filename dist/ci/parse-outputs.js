import { readFile, appendFile } from 'fs/promises';
async function main() {
    const reportPath = process.env.LACUNA_REPORT_FILE ?? 'lacuna-report.json';
    const outputFile = process.env.GITHUB_OUTPUT;
    let report;
    try {
        const raw = await readFile(reportPath, 'utf-8');
        report = JSON.parse(raw);
    }
    catch {
        console.error(`Could not read ${reportPath}`);
        process.exit(1);
    }
    const coverage = report.coverage;
    const before = coverage?.before ?? coverage?.lines ?? 0;
    const after = coverage?.after ?? coverage?.lines ?? 0;
    const passed = report.passed ? 'true' : 'false';
    if (outputFile) {
        await appendFile(outputFile, `coverage-before=${before.toFixed(1)}\n`);
        await appendFile(outputFile, `coverage-after=${after.toFixed(1)}\n`);
        await appendFile(outputFile, `passed=${passed}\n`);
    }
    else {
        console.log(`coverage-before=${before.toFixed(1)}`);
        console.log(`coverage-after=${after.toFixed(1)}`);
        console.log(`passed=${passed}`);
    }
}
main();
//# sourceMappingURL=parse-outputs.js.map