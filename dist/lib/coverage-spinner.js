import chalk from 'chalk';
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ANSI_RE = /\x1B\[[0-9;]*m/g;
const MAX_VISIBLE = 7;
function stripAnsi(s) {
    return s.replace(ANSI_RE, '').trim();
}
// Visible column width of a line (ANSI codes don't occupy columns). Not trimmed — leading
// spaces count toward width and therefore toward how many terminal rows the line wraps to.
function visibleWidth(s) {
    return s.replace(ANSI_RE, '').length;
}
// How many physical terminal rows a single line (no embedded '\n') occupies at the given
// width. A line longer than the terminal wraps onto multiple rows; the cursor-up count must
// account for that or earlier wrapped rows are never cleared (the label re-prints every tick).
function physicalRows(line, cols) {
    return Math.max(1, Math.ceil(visibleWidth(line) / cols));
}
// Physical rows the cursor sits BELOW the top of a just-written block. Splits on real '\n'
// first — a label may itself contain newlines (e.g. a leading blank line for spacing), which
// a per-logical-line count would miss, leaking a stray row every tick.
function blockRows(out, cols) {
    const segments = out.split('\n');
    let rows = 0;
    // The block is written without forcing a trailing newline beyond the final empty segment,
    // so every segment except the last sits above the cursor's resting row.
    for (let i = 0; i < segments.length - 1; i++)
        rows += physicalRows(segments[i], cols);
    return rows;
}
function parseFileLine(line, runner) {
    const clean = stripAnsi(line);
    if (runner === 'vitest' || runner === 'unknown') {
        // ✓ src/foo.test.ts (3 tests) 23ms
        // × src/foo.test.ts (2 tests | 1 failed) 45ms
        const m = clean.match(/^([✓✗×↓])\s+([\w./\\-]+\.(?:test|spec)\.[a-z]+)(?:.*?(\d+ms))?/);
        if (m)
            return { file: m[2], passed: m[1] === '✓', duration: m[3] };
    }
    if (runner === 'jest') {
        const pass = clean.match(/^PASS\s+(.+?)(?:\s+\([\d.]+\s*s\))?$/);
        if (pass)
            return { file: pass[1].trim(), passed: true };
        const fail = clean.match(/^FAIL\s+(.+?)(?:\s+\([\d.]+\s*s\))?$/);
        if (fail)
            return { file: fail[1].trim(), passed: false };
    }
    if (runner === 'pytest') {
        const m = clean.match(/^(PASSED|FAILED)\s+(.+?)\s*$/);
        if (m)
            return { file: m[2], passed: m[1] === 'PASSED' };
    }
    return null;
}
export function startCoverageSpinner(label, runner = 'unknown') {
    const isTTY = Boolean(process.stdout.isTTY);
    const start = Date.now();
    let tick = 0;
    let rendered = 0;
    const files = [];
    if (!isTTY) {
        process.stdout.write(label + '\n');
        return {
            onLine: (line) => {
                const entry = parseFileLine(line, runner);
                if (entry) {
                    process.stdout.write(`  ${entry.passed ? '✓' : '✗'}  ${entry.file}\n`);
                }
            },
            stop: () => { },
        };
    }
    function render() {
        if (rendered > 0)
            process.stdout.write(`\x1B[${rendered}A\x1B[0J`);
        const secs = Math.floor((Date.now() - start) / 1000);
        const frame = chalk.cyan(FRAMES[tick % FRAMES.length]);
        // `cols` (min 60) governs how aggressively file paths are truncated; `realCols` is the
        // ACTUAL terminal width and must drive the wrap/row math — using the clamped value would
        // under-count rows on a terminal narrower than 60 and re-introduce the un-cleared lines.
        const realCols = Math.max(1, process.stdout.columns || 80);
        const cols = Math.max(60, realCols);
        const lines = [];
        lines.push(`${label}  ${frame}  ${chalk.dim(secs + 's')}`);
        if (files.length > 0) {
            lines.push('');
            const recent = files.slice(-MAX_VISIBLE);
            for (const f of recent) {
                const icon = f.passed ? chalk.green('✓') : chalk.red('✗');
                const maxLen = cols - 10;
                const short = f.file.length > maxLen ? '…' + f.file.slice(-(maxLen - 1)) : f.file;
                const dur = f.duration ? chalk.dim(`  ${f.duration}`) : '';
                lines.push(`  ${icon}  ${chalk.dim(short)}${dur}`);
            }
        }
        lines.push('');
        const out = lines.join('\n');
        process.stdout.write(out);
        // Count PHYSICAL rows of the actual written text (wrap-aware AND newline-safe), not the
        // logical line array — a label with an embedded '\n' would otherwise be under-counted.
        rendered = blockRows(out, realCols);
    }
    const timer = setInterval(() => { tick++; render(); }, 100);
    render();
    return {
        onLine: (line) => {
            const entry = parseFileLine(line, runner);
            if (entry) {
                files.push(entry);
                render();
            }
        },
        stop: () => {
            clearInterval(timer);
            if (rendered > 0) {
                process.stdout.write(`\x1B[${rendered}A\x1B[0J`);
                rendered = 0;
            }
            const secs = Math.floor((Date.now() - start) / 1000);
            const total = files.length;
            const passed = files.filter(f => f.passed).length;
            const failed = total - passed;
            const summary = total > 0
                ? `  ${chalk.dim(`${passed} passed${failed > 0 ? `, ${failed} failed` : ''}, ${total} files — ${secs}s`)}`
                : chalk.dim(`  done in ${secs}s`);
            process.stdout.write(`${label}${summary}\n`);
        },
    };
}
//# sourceMappingURL=coverage-spinner.js.map