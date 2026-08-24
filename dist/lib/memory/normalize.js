import { createHash } from 'crypto';
// Collapses near-identical errors (same underlying problem, different file paths / line
// numbers / literal values) down to one signature so they retrieve/write-back to the SAME
// `fixes/` entry instead of spawning a new one per occurrence.
//
// Deliberately operates on extractTestFailure's OUTPUT (src/lib/extract-error.ts) — that
// function already strips ANSI codes and keeps only signal lines (errors, assertions, project
// stack frames). Re-deriving that classification here, or re-stripping ANSI (validate.ts has
// its own separate stripAnsi already), would be a second/third implementation of the same
// thing — this only does the ADDITIONAL normalization neither of those already does.
const FILE_PATH_RE = /(?:\.\.?\/|~\/|[A-Za-z]:\\|\/)[\w./\\-]*\.\w+/g;
const LINE_COL_RE = /:\d+:\d+/g;
const BARE_NUMBER_RE = /\b\d+\b/g;
const QUOTED_RE = /(["'`])(?:(?!\1).)*\1/g;
// Runner DECORATION that isn't the error itself — separator rules, the command echo the runner
// prints, console.* spew, and PASS/FAIL/✕ result markers. extractTestFailure keeps some of this
// as "signal" (it's useful in the prompt), but for a signature/summary it's noise: it made learned
// `fixes` summaries read as "======= FAIL hooks<file> useThing ✕ …" instead of the actual
// error, and it dilutes signature matching (two runs of the SAME error that differ only in console
// output would hash differently). Stripped per-line BEFORE the path/number normalization below.
// Separator rules can be inline (jest/vitest print "===== FAIL path =====" on ONE line), so strip
// the rule run FIRST — that exposes the "FAIL <path>" header for the line matcher below.
const SEPARATOR_RUN_RE = /[=~⎯–—-]{6,}/g;
const DECORATION_LINE_RE = /^\s*(?:>\s+(?:jest|vitest|mocha|npm|yarn|pnpm)\b.*|(?:PASS|FAIL)\s+\S.*|console\.(?:error|warn|log)\b.*)\s*$/gm;
const RESULT_MARKER_RE = /[✕✓×✔❯●]/g;
const MAX_NORMALIZE_INPUT = 4000;
export function normalizeErrorSignature(rawErrorOutput) {
    const capped = rawErrorOutput.slice(0, MAX_NORMALIZE_INPUT);
    return capped
        .replace(SEPARATOR_RUN_RE, '')
        .replace(DECORATION_LINE_RE, '')
        .replace(RESULT_MARKER_RE, '')
        .replace(FILE_PATH_RE, '<file>')
        .replace(LINE_COL_RE, ':<line>:<col>')
        .replace(QUOTED_RE, '<value>')
        .replace(BARE_NUMBER_RE, '<n>')
        .replace(/\s+/g, ' ')
        .trim();
}
export function errorSignatureHash(normalized) {
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
//# sourceMappingURL=normalize.js.map