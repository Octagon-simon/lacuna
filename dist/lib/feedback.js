import chalk from 'chalk';
const REPO = 'https://github.com/Octagon-simon/lacuna';
const ISSUES = `${REPO}/issues/new?template=bug_report.yml`;
function isSilent() {
    return !!(process.env.CI || !process.stdout.isTTY);
}
export function showStarNudge(testsWritten) {
    if (isSilent() || testsWritten === 0 || Math.random() > 0.33)
        return;
    console.log(chalk.dim('─'.repeat(60)));
    console.log(chalk.yellow('  ✦  lacuna just wrote tests for you.'));
    console.log(chalk.white('     If it saved you time, a star goes a long way — thank you!'));
    console.log(chalk.cyan(`     ${REPO}`));
    console.log(chalk.dim('─'.repeat(60)));
}
export function showIssueNudge(failedCount, context) {
    if (isSilent() || failedCount === 0)
        return;
    const verb = context === 'generate' ? "generate tests for" : "fix";
    console.log(chalk.dim('─'.repeat(60)));
    console.log(chalk.red(`  ✕  lacuna couldn't ${verb} ${failedCount} file(s) after all retries.`));
    console.log(chalk.white('     If this looks like a bug, please open an issue — it helps us improve:'));
    console.log(chalk.cyan(`     ${ISSUES}`));
    console.log(chalk.dim('     Include: your test runner, model, and the error output above.'));
    console.log(chalk.dim('─'.repeat(60)));
}
//# sourceMappingURL=feedback.js.map