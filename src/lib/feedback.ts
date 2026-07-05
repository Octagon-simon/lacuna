import chalk from 'chalk'

const REPO = 'https://github.com/Octagon-simon/lacuna'
const ISSUES = `${REPO}/issues/new?template=bug_report.yml`

function isSilent(): boolean {
  return !!(process.env.CI || !process.stdout.isTTY)
}

export function showStarNudge(testsWritten: number): void {
  if (isSilent() || testsWritten === 0 || Math.random() > 0.33) return
  console.log(chalk.dim('─'.repeat(60)))
  console.log(chalk.yellow('  ✦  lacuna just wrote tests for you.'))
  console.log(chalk.white('     If it saved you time, a star goes a long way — thank you!'))
  console.log(chalk.cyan(`     ${REPO}`))
  console.log(chalk.dim('─'.repeat(60)))
}

// Show AT MOST ONE nudge per run — the star ("thanks!") and the issue ("file a bug") boxes
// read as contradictory when printed together after a mixed run. A run where failures dominate
// nudges for a bug report; otherwise it nudges (occasionally) for a star. The failure COUNT is
// still printed by the command itself, so suppressing the issue box here hides nothing.
export function showOutcomeNudge(succeeded: number, failed: number, context: 'generate' | 'fix'): void {
  if (failed > succeeded) showIssueNudge(failed, context)
  else showStarNudge(succeeded)
}

export function showIssueNudge(failedCount: number, context: 'generate' | 'fix'): void {
  if (isSilent() || failedCount === 0) return
  const verb = context === 'generate' ? "generate tests for" : "fix"
  console.log(chalk.dim('─'.repeat(60)))
  console.log(chalk.red(`  ✕  lacuna couldn't ${verb} ${failedCount} file(s) after all retries.`))
  console.log(chalk.white('     If this looks like a bug, please open an issue — it helps us improve:'))
  console.log(chalk.cyan(`     ${ISSUES}`))
  console.log(chalk.dim('     Include: your test runner, model, and the error output above.'))
  console.log(chalk.dim('─'.repeat(60)))
}
