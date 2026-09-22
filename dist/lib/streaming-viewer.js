import chalk from 'chalk';
const PANEL_ROWS = 12; // visible code lines inside the panel
const BLINK_EVERY = 4; // ticks between cursor flips: 4 × 80ms = 320ms
// Live panel that shows a test file being written token-by-token.
// Draws a fixed-height bordered box; as lines accumulate the panel scrolls
// so the cursor is always visible at the bottom. Redraws at 80ms via setInterval.
//
// Non-TTY fallback: streams tokens directly to stdout (no panel, no cursor).
export class StreamingFileViewer {
    filename;
    content = '';
    rendered = 0;
    tick = 0;
    timer = null;
    isTTY;
    lastRenderedText = '';
    winchHandler = null;
    constructor(filename) {
        this.filename = filename;
        this.isTTY = Boolean(process.stdout.isTTY);
    }
    start() {
        if (!this.isTTY) {
            process.stdout.write(`\n  ✍  ${this.filename}\n`);
            return;
        }
        this.render();
        this.timer = setInterval(() => { this.tick++; this.render(); }, 80);
        // On resize, recompute how many visual rows the last frame occupies at the NEW width before
        // the next redraw's cursor-up — otherwise the stale `rendered` (old width) under/over-counts
        // wrapped rows and the redraw corrupts. Mirrors WorkerDisplay's SIGWINCH handling.
        this.winchHandler = () => {
            if (this.lastRenderedText) {
                const newCols = Math.max(1, process.stdout.columns || 80);
                this.rendered = this.countVisualLines(this.lastRenderedText, newCols);
            }
        };
        process.on('SIGWINCH', this.winchHandler);
    }
    append(token) {
        this.content += token;
        if (!this.isTTY)
            process.stdout.write(token);
        // In TTY mode the setInterval render loop picks up the new content
    }
    stop() {
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
        this.lastRenderedText = '';
        this.content = '';
    }
    render() {
        if (!this.isTTY)
            return;
        if (this.rendered > 0)
            process.stdout.write(`\x1B[${this.rendered}A\x1B[0J`);
        // `cols` (min 60) governs the panel width; `realCols` is the actual terminal width and MUST
        // drive the wrapped-row count below.
        const realCols = Math.max(1, process.stdout.columns || 80);
        const cols = Math.max(60, realCols);
        const panelWidth = Math.min(cols - 4, 82);
        const innerWidth = panelWidth - 4; // space between "│ " and " │"
        const cursor = Math.floor(this.tick / BLINK_EVERY) % 2 === 0 ? '▌' : ' ';
        const rawLines = (this.content + cursor).split('\n');
        const displayLines = rawLines.slice(-PANEL_ROWS);
        while (displayLines.length < PANEL_ROWS)
            displayLines.unshift('');
        const lines = [''];
        // Header
        const title = ` ✍  ${this.filename} `;
        const headerFill = Math.max(0, panelWidth - title.length - 4); // 4 = '╭──' + '╮'
        lines.push(`  ${chalk.dim('╭──')}${chalk.bold.cyan(title)}${chalk.dim('─'.repeat(headerFill) + '╮')}`);
        // Code rows
        for (const line of displayLines) {
            const text = line.length > innerWidth ? line.slice(0, innerWidth - 1) + '…' : line;
            lines.push(`  ${chalk.dim('│')} ${chalk.white(text.padEnd(innerWidth))} ${chalk.dim('│')}`);
        }
        // Footer with running line count
        const lineCount = rawLines.length - 1; // -1 for the cursor appended to last line
        const footerText = ` ${lineCount} line${lineCount !== 1 ? 's' : ''} `;
        const footerFill = Math.max(0, panelWidth - footerText.length - 2); // 2 = '╰' + '╯'
        lines.push(`  ${chalk.dim('╰' + '─'.repeat(footerFill))}${chalk.dim(footerText)}${chalk.dim('╯')}`);
        lines.push('');
        const out = lines.join('\n');
        process.stdout.write(out);
        this.lastRenderedText = out;
        // Count VISUAL rows (a panel row wider than the terminal wraps to several), not '\n' chars —
        // counting newlines under-counts wrapped rows on a terminal narrower than the panel (~84 cols),
        // so the next redraw's cursor-up moves up too few rows and leaves stale copies stacking down
        // the screen. Same accounting as WorkerDisplay.countVisualLines.
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
}
//# sourceMappingURL=streaming-viewer.js.map