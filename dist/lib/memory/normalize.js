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
const MAX_NORMALIZE_INPUT = 4000;
export function normalizeErrorSignature(rawErrorOutput) {
    const capped = rawErrorOutput.slice(0, MAX_NORMALIZE_INPUT);
    return capped
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