import { Command, Flags, Args } from '@oclif/core';
import { stat } from 'fs/promises';
import { resolve, relative } from 'path';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { detectEnvironment, fileTestCommand, scopedTestCommand } from '../lib/detector.js';
import { runCommand } from '../lib/runner.js';
export default class Run extends Command {
    static description = 'Run the test suite and report coverage';
    static examples = [
        '$ lacuna run',
        '$ lacuna run src/payments',
    ];
    // Optional positional: a test file or directory to run instead of the whole suite.
    static args = {
        path: Args.string({
            description: 'Test file or directory to run instead of the whole suite',
            required: false,
        }),
    };
    static flags = {
        verbose: Flags.boolean({
            char: 'v',
            description: 'Show full test output',
            default: false,
        }),
    };
    async run() {
        const { args, flags } = await this.parse(Run);
        const config = await loadConfig();
        if (config.testEnv)
            Object.assign(process.env, config.testEnv);
        const env = await detectEnvironment(process.cwd(), config.testRunner);
        if (config.testCommand)
            env.testCommand = config.testCommand;
        this.log(chalk.bold('\nlacuna run\n'));
        if (env.testRunner === 'unknown') {
            this.warn('Could not detect test runner.');
            this.exit(1);
        }
        // Resolve the optional scope: a file runs just that file, a directory runs only the tests
        // under it (scopedTestCommand; falls back to the full command for runners we can't narrow).
        let testCommand = env.testCommand;
        let scopeLabel;
        if (args.path) {
            const abs = resolve(process.cwd(), args.path);
            let isDir = false;
            try {
                isDir = (await stat(abs)).isDirectory();
            }
            catch {
                this.error(`Path not found: ${args.path}`);
            }
            if (isDir) {
                const rel = relative(process.cwd(), abs) || '.';
                testCommand = scopedTestCommand(env, rel) ?? env.testCommand;
            }
            else {
                testCommand = fileTestCommand(env, abs);
            }
            scopeLabel = args.path;
        }
        this.log(`${chalk.dim('Runner:')} ${chalk.cyan(env.testRunner)}`);
        if (scopeLabel)
            this.log(`${chalk.dim('Scope:')}  ${chalk.cyan(scopeLabel)}`);
        this.log(chalk.dim(`\n$ ${testCommand}\n`));
        const result = await runCommand(testCommand);
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