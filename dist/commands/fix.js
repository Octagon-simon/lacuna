import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { loadConfig, applyModelOverride } from '../lib/config.js';
import { detectEnvironment } from '../lib/detector.js';
import { runFixLoop } from '../agent/fix-loop.js';
export default class Fix extends Command {
    static description = 'Find and fix failing tests using AI — preserves existing tests, only repairs what is broken';
    static examples = [
        '$ lacuna fix',
        '$ lacuna fix --workers 4',
        '$ lacuna fix --file src/utils/math.test.ts',
        '$ lacuna fix --dry-run',
    ];
    static flags = {
        'dry-run': Flags.boolean({
            description: 'Show what would be changed without writing files',
            default: false,
        }),
        file: Flags.string({
            char: 'f',
            description: 'Target a specific test file instead of all failing tests',
        }),
        verbose: Flags.boolean({
            char: 'v',
            description: 'Show model output and full test runner logs',
            default: false,
        }),
        model: Flags.string({
            char: 'm',
            description: 'Model to use (overrides .lacuna.json)',
        }),
        workers: Flags.integer({
            char: 'w',
            description: 'Number of parallel workers (each handles one file at a time)',
            default: 1,
        }),
        fresh: Flags.boolean({
            description: 'Re-run the full test suite even if a recent failing-files cache exists',
            default: false,
        }),
    };
    async run() {
        const { flags } = await this.parse(Fix);
        const config = await loadConfig();
        if (flags.model)
            applyModelOverride(config, flags.model);
        const env = await detectEnvironment(process.cwd(), config.testRunner);
        this.log(chalk.bold('\nlacuna fix\n'));
        this.log(`${chalk.dim('Model:')}   ${chalk.cyan(config.model)}`);
        this.log(`${chalk.dim('Runner:')}  ${chalk.cyan(env.testRunner)}`);
        if (flags.workers > 1)
            this.log(`${chalk.dim('Workers:')} ${flags.workers}`);
        if (flags['dry-run'])
            this.log(chalk.yellow('  [dry-run — no files will be written]'));
        if (flags.file)
            this.log(`${chalk.dim('Target:')}  ${flags.file}`);
        if (env.testRunner === 'unknown') {
            this.warn('Could not detect test runner. Run `lacuna init` to configure.');
            this.exit(2);
        }
        let result;
        try {
            result = await runFixLoop({
                config,
                env,
                cwd: process.cwd(),
                dryRun: flags['dry-run'],
                verbose: flags.verbose,
                targetFile: flags.file,
                workers: flags.workers,
                fresh: flags.fresh,
                log: (msg) => this.log(msg),
            });
        }
        catch (err) {
            this.error(err instanceof Error ? err.message : String(err));
        }
        this.log('');
        this.log(chalk.bold('Results'));
        this.log(`  ${chalk.dim('Files processed:')} ${result.filesProcessed}`);
        this.log(`  ${chalk.dim('Files fixed:')}     ${chalk.green(String(result.filesFixed))}`);
        const stillFailing = result.filesProcessed - result.filesFixed;
        if (stillFailing > 0) {
            this.log(`  ${chalk.dim('Still failing:')}  ${chalk.red(String(stillFailing))}`);
        }
        if (result.errors.length > 0) {
            this.log(chalk.red(`\n  ${result.errors.length} error(s):`));
            for (const err of result.errors) {
                const lines = err.split('\n').slice(0, 8);
                this.log(chalk.dim('  ' + lines.join('\n  ')));
            }
        }
        if (result.filesProcessed === 0) {
            this.exit(0);
        }
        else if (result.filesFixed === result.filesProcessed) {
            this.log(chalk.green('\n  All failing tests fixed.'));
            this.exit(0);
        }
        else {
            this.log(chalk.yellow(`\n  ${stillFailing} file(s) still failing. Re-run lacuna fix or check errors above.`));
            this.exit(1);
        }
    }
}
//# sourceMappingURL=fix.js.map