import chalk from 'chalk';
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ACTIVE = new Set(['waiting', 'generating', 'writing', 'running', 'retrying', 'regenerating']);
// tip rotates every ~5 seconds at 80ms tick interval
const TIP_TICKS = 62;
export class WorkerDisplay {
    states;
    done = 0;
    passed = 0;
    failedCount = 0;
    total;
    rendered = 0;
    tick = 0;
    timer = null;
    isTTY;
    tips;
    tipIndex = 0;
    successLabel;
    winchHandler = null;
    lastRenderedText = '';
    constructor(workerCount, total, tips = [], successLabel = 'passed') {
        this.states = Array.from({ length: workerCount }, () => ({ phase: 'idle' }));
        this.total = total;
        this.isTTY = Boolean(process.stdout.isTTY);
        this.tips = tips;
        this.successLabel = successLabel;
    }
    start() {
        if (!this.isTTY)
            return;
        this.render();
        this.timer = setInterval(() => {
            this.tick++;
            if (this.tips.length > 0 && this.tick % TIP_TICKS === 0) {
                this.tipIndex = (this.tipIndex + 1) % this.tips.length;
            }
            this.render();
        }, 80);
        this.winchHandler = () => {
            if (this.lastRenderedText) {
                // Row math must use the REAL terminal width (clamping to 60 under-counts wrapped rows
                // on a narrow terminal and leaves the cursor mid-block → corrupted redraw).
                const newCols = Math.max(1, process.stdout.columns || 80);
                this.rendered = this.countVisualLines(this.lastRenderedText, newCols);
            }
            this.render();
        };
        process.on('SIGWINCH', this.winchHandler);
    }
    update(workerId, state) {
        const prev = this.states[workerId];
        this.states[workerId] = state;
        if (state.phase === 'regenerating') {
            // Fix failed — now trying regeneration. Undo the failed count so the regen's
            // final phase (passed/failed) is the single counted outcome for this file.
            if (prev.phase === 'failed') {
                this.done--;
                this.failedCount--;
            }
            // Fall through to render the state (don't return early — non-TTY needs the log line)
        }
        else if (prev.phase !== 'passed' && prev.phase !== 'failed') {
            if (state.phase === 'passed') {
                this.done++;
                this.passed++;
            }
            else if (state.phase === 'failed') {
                this.done++;
                this.failedCount++;
            }
        }
        if (!this.isTTY) {
            // fallback: plain log line for CI / piped output
            const label = this.plainLabel(state);
            process.stdout.write(`  [w${workerId + 1}] ${label}\n`);
        }
    }
    finish() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.winchHandler) {
            process.off('SIGWINCH', this.winchHandler);
            this.winchHandler = null;
        }
        if (this.isTTY && this.rendered > 0) {
            process.stdout.write(`\x1B[${this.rendered}A\x1B[0J`);
            this.rendered = 0;
        }
    }
    render() {
        if (!this.isTTY)
            return;
        if (this.rendered > 0) {
            process.stdout.write(`\x1B[${this.rendered}A\x1B[0J`);
        }
        // `cols` (min 60) governs how aggressively file paths are truncated; `realCols` is the
        // actual width and must drive the wrap/row count (see countVisualLines call below).
        const realCols = Math.max(1, process.stdout.columns || 80);
        const cols = Math.max(60, realCols);
        const lines = [''];
        for (let i = 0; i < this.states.length; i++) {
            lines.push(this.formatRow(i, this.states[i], cols));
        }
        const barWidth = Math.max(1, Math.min(28, cols - 26));
        const filled = Math.min(barWidth, this.total === 0 ? barWidth : Math.round(barWidth * this.done / this.total));
        const bar = chalk.green('█'.repeat(filled)) + chalk.dim('░'.repeat(barWidth - filled));
        const pct = this.total === 0 ? 100 : Math.round((this.done / this.total) * 100);
        const remaining = this.total - this.done;
        lines.push('');
        lines.push(`  ${chalk.dim('Progress')}  ${bar}  ${chalk.bold(String(this.done))}${chalk.dim(`/${this.total}`)}  ${chalk.dim(pct + '%')}`);
        lines.push('');
        lines.push(`  ` +
            chalk.green(`✓ ${this.passed} ${this.successLabel}`) +
            chalk.dim('  ·  ') +
            (this.failedCount > 0 ? chalk.red(`✗ ${this.failedCount} failed`) : chalk.dim(`✗ 0 failed`)) +
            chalk.dim('  ·  ') +
            chalk.dim(`${remaining} remaining`));
        if (this.tips.length > 0) {
            const tip = this.tips[this.tipIndex];
            const maxTipLen = cols - 10;
            const displayTip = tip.length > maxTipLen ? tip.slice(0, maxTipLen - 1) + '…' : tip;
            lines.push('');
            lines.push(`  ${chalk.cyan('Tip:')} ${chalk.dim(displayTip)}`);
        }
        lines.push('');
        const out = lines.join('\n');
        process.stdout.write(out);
        this.lastRenderedText = out;
        this.rendered = this.countVisualLines(out, realCols);
    }
    countVisualLines(text, cols) {
        const lines = text.split('\n');
        const countTo = text.endsWith('\n') ? lines.length - 1 : lines.length;
        let total = 0;
        for (let i = 0; i < countTo; i++) {
            const visLen = lines[i].replace(/\x1B\[[0-9;]*[\p{L}]/gu, '').length;
            total += Math.max(1, Math.ceil(visLen / cols));
        }
        return total;
    }
    formatRow(id, state, cols) {
        const wLabel = chalk.dim(`w${id + 1}`.padEnd(2));
        const frame = FRAMES[this.tick % FRAMES.length];
        const isActive = ACTIVE.has(state.phase);
        let icon;
        let label;
        let file = '';
        switch (state.phase) {
            case 'idle':
                icon = chalk.dim('○');
                label = chalk.dim('idle      ');
                break;
            case 'waiting': {
                const elapsed = Math.floor((Date.now() - state.since) / 1000);
                icon = chalk.dim('⌛');
                label = chalk.dim(('wait ' + elapsed + 's').padEnd(10));
                file = state.file;
                break;
            }
            case 'generating':
                icon = chalk.cyan(frame);
                label = chalk.cyan('generating');
                file = state.file;
                break;
            case 'writing':
                icon = chalk.blue(frame);
                label = chalk.blue('writing   ');
                file = state.file;
                break;
            case 'running':
                icon = chalk.yellow(frame);
                label = chalk.yellow('running   ');
                file = state.file;
                break;
            case 'retrying':
                icon = chalk.yellow('↺');
                label = chalk.yellow(`retry ${state.attempt}/${state.max}  `.slice(0, 10));
                file = state.file;
                break;
            case 'regenerating':
                icon = chalk.blueBright('↻');
                label = chalk.blueBright('regen     ');
                file = state.file;
                break;
            case 'passed':
                icon = chalk.green('✓');
                label = chalk.green('passed    ');
                file = state.file;
                break;
            case 'failed':
                icon = chalk.red('✗');
                label = chalk.red('failed    ');
                file = state.file;
                break;
        }
        // fixed prefix width: "  w1  ⠙  generating  " ≈ 22 chars
        const prefixWidth = 24;
        const maxFileLen = cols - prefixWidth;
        const shortFile = file.length > maxFileLen
            ? '…' + file.slice(-(maxFileLen - 1))
            : file;
        void isActive; // used implicitly via frame reference in the switch
        return `  ${wLabel}  ${icon}  ${label}  ${chalk.dim(shortFile)}`;
    }
    plainLabel(state) {
        switch (state.phase) {
            case 'idle': return 'idle';
            case 'waiting': return `waiting     ${state.file}`;
            case 'generating': return `generating  ${state.file}`;
            case 'writing': return `writing     ${state.file}`;
            case 'running': return `running     ${state.file}`;
            case 'retrying': return `retry ${state.attempt}/${state.max}  ${state.file}`;
            case 'regenerating': return `↻ regen      ${state.file}`;
            case 'passed': return `✓ passed    ${state.file}`;
            case 'failed': return `✗ failed    ${state.file}`;
        }
    }
}
//# sourceMappingURL=worker-display.js.map