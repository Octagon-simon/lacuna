// Extracts the signal from a test runner's stdout+stderr, stripping passing-test
// noise so the AI receives only what it needs to fix the failure.
//
// Raw runner output contains: passing-test lines, timing headers, summary footers,
// and the actual failure details. Only the failure details are useful on a retry.
const NOISE_PATTERNS = [
    /^✓\s+/, // vitest passing file
    /^✔\s+/, // alternate check mark
    /^PASS\s+/, // jest passing file
    /^RUN\s+v\d/, // vitest run header
    /^>\s+\S+@[\d.]+\s+test/, // npm test header
    /^Start\s+at\s+\d/, // timing footer
    /^Duration\s+[\d.]/, // timing footer
];
const SIGNAL_PATTERNS = [
    /error/i,
    /fail/i,
    /×\s+/, // vitest failing file marker
    /✗\s+/,
    /Expected/,
    /Received/,
    /AssertionError/,
    /TypeError/,
    /ReferenceError/,
    /SyntaxError/,
    /Cannot find module/,
    /error TS\d+/, // TypeScript errors
];
// Stack frames from project files — not node_modules, not runner internals
function isProjectFrame(line) {
    return (/^\s+at\s+/.test(line) &&
        !line.includes('node_modules') &&
        !line.includes('node:internal') &&
        !line.includes('@vitest/runner'));
}
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 3;
export function extractTestFailure(rawOutput) {
    if (!rawOutput.trim())
        return rawOutput;
    const stripped = rawOutput.replace(/\x1B\[[0-9;]*m/g, '');
    const lines = stripped.split('\n');
    // Pass 1 — mark signal lines
    const isSignalLine = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed)
            return false;
        if (NOISE_PATTERNS.some((p) => p.test(trimmed)))
            return false;
        return SIGNAL_PATTERNS.some((p) => p.test(trimmed)) || isProjectFrame(line);
    });
    // Pass 2 — expand each signal line into a context window
    const include = new Set();
    for (let i = 0; i < lines.length; i++) {
        if (!isSignalLine[i])
            continue;
        for (let j = Math.max(0, i - CONTEXT_BEFORE); j <= Math.min(lines.length - 1, i + CONTEXT_AFTER); j++) {
            include.add(j);
        }
    }
    // Pass 2.5 — extend any window that ends inside a diff block (+ / - lines)
    // Vitest/Jest can output 20-30 line JSON diffs that would otherwise be clipped.
    for (let i = 0; i < lines.length; i++) {
        if (!include.has(i))
            continue;
        // If the next line is a diff line not yet included, extend until the diff ends
        let j = i + 1;
        while (j < lines.length &&
            !include.has(j) &&
            j < i + 40 // safety cap — never extend more than 40 lines
        ) {
            const trimmed = lines[j].trimStart();
            // Diff content lines start with +/- (with space after) or are indented context lines
            if (/^[+-] /.test(trimmed) || /^\s{2,}/.test(lines[j])) {
                include.add(j);
                j++;
            }
            else {
                break;
            }
        }
    }
    // Pass 3 — build output, skipping pure noise outside the windows and deduping blanks
    const kept = [];
    let lastWasBlank = false;
    let lastIncluded = -1;
    for (let i = 0; i < lines.length; i++) {
        if (!include.has(i))
            continue;
        // Insert separator when there's a gap in included lines
        if (lastIncluded >= 0 && i > lastIncluded + 1) {
            if (!lastWasBlank)
                kept.push('');
        }
        lastIncluded = i;
        const trimmed = lines[i].trim();
        if (!trimmed) {
            if (lastWasBlank)
                continue;
            lastWasBlank = true;
        }
        else {
            lastWasBlank = false;
        }
        kept.push(lines[i]);
    }
    // Trim leading/trailing blank lines
    while (kept.length && !kept[0].trim())
        kept.shift();
    while (kept.length && !kept[kept.length - 1].trim())
        kept.pop();
    const result = kept.join('\n');
    // Safety: if we stripped too aggressively and lost everything, fall back
    return result.trim() || rawOutput.slice(0, 2000);
}
//# sourceMappingURL=extract-error.js.map