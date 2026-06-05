import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { detectEnvironment } from '../lib/detector.js';
import { runCommand } from '../lib/runner.js';
export default class Run extends Command {
    static description = 'Run the test suite and report coverage';
    static examples = [
        '$ lacuna run',
    ];
    static flags = {
        verbose: Flags.boolean({
            char: 'v',
            description: 'Show full test output',
            default: false,
        }),
    };
    async run() {
        const { flags } = await this.parse(Run);
        const config = await loadConfig();
        const env = await detectEnvironment(process.cwd(), config.testRunner);
        this.log(chalk.bold('\nlacuna run\n'));
        if (env.testRunner === 'unknown') {
            this.warn('Could not detect test runner.');
            this.exit(1);
        }
        this.log(`${chalk.dim('Runner:')} ${chalk.cyan(env.testRunner)}\n`);
        this.log(chalk.dim(`$ ${env.testCommand}\n`));
        const result = await runCommand(env.testCommand);
        if (flags.verbose) {
            this.log(result.stdout);
        }
        if (result.success) {
            this.log(chalk.green('\nAll tests passed.'));
        }
        else {
            this.log(chalk.red('\nTests failed:'));
            this.log(result.stdout);
            this.log(result.stderr);
            this.exit(1);
        }
        void config;
    }
}
//# sourceMappingURL=run.js.map