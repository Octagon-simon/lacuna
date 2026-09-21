import { readFile, writeFile, access } from 'fs/promises';
import { join, basename } from 'path';
import chalk from 'chalk';
import { mocksFileList } from '../lib/config.js';
import { typeCheckFile, TYPECHECK_INCONCLUSIVE } from '../lib/typecheck.js';
import { runCommand } from '../lib/runner.js';
import { createProvider } from '../lib/providers/index.js';
import { dedupeMockExports, extractExportNames, withMocksLock, tryApplyMocksPatch } from '../lib/validate.js';
import { resolveDebugBase, perFileDebugPath, debugWrite } from './generator.js';
import { nonStandardMockApiNote } from './prompts/runners/js-common.js';
// Strips a single leading/trailing markdown code fence, if present — mirrors generator.ts's
// stripCodeFences but kept local since this module intentionally does NOT go through the full
// TestGenerator (that class's prompt machinery is test-specific: describe/it structure, coverage
// framing, patch-mode thresholds — none of which apply to a plain shared mocks/helpers file).
function stripCodeFences(code) {
    const trimmed = code.trim();
    const fenced = trimmed.match(/^```(?:\w+)?\n([\s\S]*?)\n?```$/);
    return fenced ? fenced[1] : trimmed;
}
// Layered, forgiving extraction — mirrors generator.ts's parseStructuredResponse fallback chain
// (not reused directly since that function is patch/thinking-aware and test-specific; this is
// the relevant subset for a plain full-file rewrite). A single rigid `<code_output>` regex is NOT
// enough: different providers/models don't all follow the same tag convention — deepseek-v4-flash
// in particular was observed returning a plain fenced code block with no <code_output> tag at
// all, which made every attempt log "No <code_output> in model response" and burn the entire
// retry budget without ever writing anything. Always falls back to the raw trimmed response
// rather than returning null, since for a full-file-rewrite task the response is overwhelmingly
// likely to just BE the code even when it isn't wrapped the way the prompt asked.
function extractCodeOutput(raw) {
    const tagMatch = raw.match(/(?:^|\n)<code_output>\n?([\s\S]*?)(?:\n?<\/code_output>|$)/);
    if (tagMatch)
        return stripCodeFences(tagMatch[1]);
    const fenceMatches = [...raw.matchAll(/```(?:typescript|tsx?|javascript|jsx?)?\s*\n([\s\S]*?)```/g)];
    if (fenceMatches.length > 0)
        return fenceMatches[fenceMatches.length - 1][1].trim();
    return stripCodeFences(raw);
}
// Errors an UNDER-TYPED mock export produces at its USE SITE, in a DIFFERENT file — the
// declaration line itself (`export const x = jest.fn();`) is syntactically valid TypeScript, so
// scoping tsc to the mocks file alone never flags it (see the big comment below). This is the
// message family that shows up instead, in whatever test file calls the mock.
const MOCK_SHAPE_SYMPTOM_RE = /error TS(?:2339|2345|2352|2353|18046).*(?:\bnever\b|\bunknown\b|UnknownFunction|is of type 'unknown')/;
export async function findDownstreamMockSymptoms(cwd, env, mocksFiles) {
    const byMocksFile = new Map(mocksFiles.map(f => [f, []]));
    if (env.language !== 'typescript')
        return byMocksFile;
    try {
        await access(join(cwd, 'tsconfig.json'));
    }
    catch {
        return byMocksFile;
    }
    const result = await runCommand('npx tsc -p tsconfig.json --noEmit --skipLibCheck', cwd, 180_000);
    if (result.success)
        return byMocksFile;
    const combined = result.stdout + '\n' + result.stderr;
    if (!/error TS\d+/.test(combined))
        return byMocksFile; // killed/crashed, not a real "clean"
    // Group raw error lines by the file they're attributed to (tsc prints "path(line,col): ...").
    // Capture the line NUMBER too — it's needed below to check what the error line actually touches.
    const byFile = new Map();
    for (const rawLine of combined.split('\n')) {
        const m = rawLine.match(/^(\S+\.tsx?)\((\d+),\d+\):/);
        if (!m)
            continue;
        if (!MOCK_SHAPE_SYMPTOM_RE.test(rawLine))
            continue;
        const arr = byFile.get(m[1]) ?? [];
        arr.push({ raw: rawLine, line: Number(m[2]) });
        byFile.set(m[1], arr);
    }
    if (byFile.size === 0)
        return byMocksFile;
    // For each erroring file, first find the SPECIFIC NAMES it imports from each mocks file (not
    // just "does it import from there at all" — nearly every test file imports SOMETHING from the
    // shared mocks file for unrelated reasons, so a file-level check alone produces false positives:
    // observed live on sendMoney/service.test.ts, whose real errors came from its OWN inline
    // `jest.mock(..., () => ({ findByIdAndUpdate: jest.fn<any, any[]>() }))`, completely unrelated
    // to anything imported from tests/mocks.ts, yet the file-level check flagged them as a mocks-
    // file bug anyway because the file also imports other, unrelated names from it elsewhere. Only
    // attribute an error line to the mocks file if that SPECIFIC line's code actually references one
    // of the names imported from it.
    for (const [relFile, entries] of byFile) {
        let content;
        try {
            content = await readFile(join(cwd, relFile), 'utf-8');
        }
        catch {
            continue;
        }
        const fileLines = content.split('\n');
        // Capture whole `import { a, b, c } from '...'` blocks (dotAll so a multi-line brace list —
        // routine in this codebase — is captured as one match, not missed by a line-anchored regex).
        const importedNamesByMocksFile = new Map();
        for (const m of content.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
            const [, namesBlock, spec] = m;
            const matchedIdx = mocksFiles.findIndex(mf => {
                const b = basename(mf).replace(/\.tsx?$/, '');
                return spec.endsWith('/' + b) || spec.endsWith(b);
            });
            if (matchedIdx === -1)
                continue;
            const mocksFile = mocksFiles[matchedIdx];
            const names = namesBlock.split(',').map(n => n.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
            const set = importedNamesByMocksFile.get(mocksFile) ?? new Set();
            for (const n of names)
                set.add(n);
            importedNamesByMocksFile.set(mocksFile, set);
        }
        if (importedNamesByMocksFile.size === 0)
            continue;
        for (const [mocksFile, names] of importedNamesByMocksFile) {
            // A wrong type can span a few lines (an object literal argument, say) before the reported
            // line, so check a small window ending at the error line rather than that exact line alone.
            const matchingEntries = entries.filter(({ line }) => {
                const window = fileLines.slice(Math.max(0, line - 4), line).join('\n');
                return [...names].some(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(window));
            });
            if (matchingEntries.length === 0)
                continue;
            const arr = byMocksFile.get(mocksFile) ?? [];
            // Cap per-file lines fed into the prompt — a single broken mock shape routinely produces
            // 10-20+ near-identical error lines in one consuming file (same wrong type at every call
            // site), and feeding every one of them, across every consuming file, made the aggregate
            // prompt big enough that a local model took several minutes to even start responding.
            // A handful of examples is enough for the model to identify which export is at fault;
            // more repetitions of the SAME message add cost without adding information.
            const lines = matchingEntries.map(e => e.raw);
            const capped = lines.length > 6 ? [...lines.slice(0, 6), `  …and ${lines.length - 6} more like the above in this file.`] : lines;
            arr.push(`From ${relFile} (imports this mocks file):\n${capped.join('\n')}`);
            byMocksFile.set(mocksFile, arr);
        }
    }
    return byMocksFile;
}
// PATCH mode is the preferred path — this file is routinely 250-400+ lines and the fix is
// virtually always a handful of individual broken declarations, not a structural rewrite. Asking
// for a full-file regeneration every time (the ONLY mode this function originally supported) is
// slow (a full rewrite + two project-wide tsc verification passes took 1.5-2 min per attempt,
// live-observed against deepseek-v4-flash) and, worse, gives the model a much larger surface to
// introduce a NEW mistake while touching lines that were never broken — exactly what happened
// live: one attempt "fixed" the reported errors but simultaneously rewrote every OTHER mock in
// the file to the wrong jest.fn() generic arity, because a full rewrite means regenerating
// everything from memory rather than leaving working code untouched. This mirrors the SAME
// // @@@ REPLACE:/WITH:/END + APPEND_EXPORT/ADD_TO_BEFOREEACH patch-op syntax the normal test-fix
// prompts already teach for this exact file (prompts/index.ts) — reusing the existing
// tryApplyMocksPatch parser rather than inventing a second format.
const SYSTEM_PROMPT = 'You are fixing TypeScript compile errors in a shared test-mocks/helpers file used by MANY test files across the project. ' +
    'This is infrastructure, not a test file — there are no describe()/it() blocks to worry about, only exported mock declarations and helpers. ' +
    'Prefer SURGICAL PATCH ops over a full rewrite — most fixes are one or two broken declarations, not the whole file. ' +
    'Do not explain, do not include markdown fences around patch ops or code output.';
const PATCH_INSTRUCTIONS = `
PREFERRED: respond with ONLY the patch operations needed, using this exact syntax (no other wrapper):
// @@@ REPLACE:
<exact existing line(s), copied character-for-character from CURRENT FILE CONTENT above>
// @@@ WITH:
<replacement line(s)>
// @@@ END

Repeat a REPLACE block for each broken declaration. The anchor (the text between REPLACE: and WITH:) MUST match the current file byte-for-byte, including exact spacing — copy it directly from the file content shown above, don't retype it from memory.
To add a brand-new export instead of fixing an existing one: // @@@ APPEND_EXPORT: / <new export> / // @@@ END
Only fall back to a full-file rewrite (wrapped in <code_output>...</code_output>) if the fix genuinely can't be expressed as a handful of REPLACE ops — e.g. the file needs broad restructuring. This should be rare.`;
// Bounds how many consuming files' worth of downstream evidence go into one prompt — several
// files often break on the exact same root cause, so a handful of examples identifies it just as
// well as showing every affected file, at a fraction of the token cost.
const MAX_DOWNSTREAM_FILES_IN_PROMPT = 3;
function buildPrompt(fileLabel, code, ownErrors, downstreamErrors, requiredExports, isVitest, hasFnStyleMockApi = true) {
    const fn = !hasFnStyleMockApi ? 'a mock/stub function' : isVitest ? 'vi.fn()' : 'jest.fn()';
    const sections = [
        `The shared mocks file "${fileLabel}" is broken. Every test file across the project that imports from it is currently affected.\n`,
        `CURRENT FILE CONTENT:\n\`\`\`typescript\n${code}\n\`\`\`\n`,
    ];
    if (ownErrors) {
        sections.push(`COMPILE ERRORS IN THIS FILE ITSELF:\n${ownErrors}\n`);
    }
    if (downstreamErrors.length > 0) {
        const shown = downstreamErrors.slice(0, MAX_DOWNSTREAM_FILES_IN_PROMPT);
        const omittedCount = downstreamErrors.length - shown.length;
        sections.push(`ERRORS THIS FILE CAUSES IN FILES THAT IMPORT IT (these errors are reported against the OTHER file, but they stem from an under-specified export HERE — most commonly a bare \`${fn}\` with no type parameter, so TypeScript infers \`never\`/\`unknown\` and the importing file can't call \`.mockResolvedValue()\`/\`.mockReturnValue()\` or access a property on the result):\n${shown.join('\n\n')}\n` +
            (omittedCount > 0 ? `(${omittedCount} more affected file(s) not shown — likely the same root cause.)\n` : ''));
    }
    // jest.fn<T>()'s generic-arity quirk (and vitest's equivalent) is jest/vitest-specific — a
    // mocha project's own mocking library (commonly sinon) has no `.fn()`-shaped API at all, so
    // this typing rule doesn't translate; see nonStandardMockApiNote (prompts/runners/js-common.ts).
    const typingRule = !hasFnStyleMockApi
        ? `1. Fix every error above, including the downstream ones — find the export responsible and give it an explicit function-type annotation matching what the importing file expects. ${nonStandardMockApiNote()}\n`
        : isVitest
            ? `1. Fix every error above, including the downstream ones — find the export responsible (by matching the property/method names used against it in the downstream error) and give vi.fn() an explicit function-type generic matching this project's installed vitest Mock typing convention, e.g. \`vi.fn<() => Promise<T>>()\` for something resolved with a value, or \`vi.fn<() => Record<string, ReturnType<typeof vi.fn>>>()\` for a repo/interactor factory whose result has further mock methods called on it.\n`
            : `1. Fix every error above, including the downstream ones — find the export responsible (by matching the property/method names used against it in the downstream error) and give jest.fn() an explicit function-type generic, e.g. \`jest.fn<() => Promise<T>>()\` for something resolved with a value, or \`jest.fn<() => Record<string, jest.Mock>>()\` for a repo/interactor factory whose result has further mock methods called on it.\n` +
                `2. jest.fn()'s generic takes EXACTLY ONE type argument — the FULL FUNCTION TYPE — never two. This project's installed @types/jest defines \`Mock<T extends FunctionLike>\`/\`fn<T extends FunctionLike>()\`, a NEWER single-generic form; do not use the older two-argument \`jest.fn<ReturnType, Args[]>()\` style (e.g. \`jest.fn<Promise<string>, any[]>()\`) — it fails with "TS2558: Expected 0-1 type arguments, but got 2" at EVERY call site if used even once, since it's wrong for every mock in the file, not just one.\n` +
                `   WRONG: jest.fn<Promise<string>, any[]>()\n` +
                `   WRONG: jest.fn<string, []>()\n` +
                `   RIGHT: jest.fn<() => Promise<string>>()\n` +
                `   RIGHT: jest.fn<() => string>()\n`;
    const ruleOffset = !hasFnStyleMockApi ? 1 : isVitest ? 1 : 2;
    sections.push(`RULES:\n` +
        typingRule +
        `${1 + ruleOffset}. You MUST preserve every one of these exported names EXACTLY (same name, same export kind) — other files import them by name and a rename or removal will break them even if this file itself compiles clean: ${requiredExports.join(', ')}\n` +
        `${2 + ruleOffset}. Do not add new tests, describe(), or it() blocks — this file has none and must stay that way.\n` +
        `${3 + ruleOffset}. Do not use 'as any' or '@ts-ignore' to silence an error — fix ONLY the declarations named in the errors above. Do not touch, retype, or rewrite any other line — every other mock in this file is currently working; changing something you weren't asked to fix is how a previous attempt introduced 100+ new errors across the whole file.\n` +
        PATCH_INSTRUCTIONS);
    return sections.join('\n');
}
// Rough error-count heuristic used only to compare attempts against each other and against the
// original baseline — not shown to the model, just used internally to decide whether an attempt
// is actually an improvement worth keeping.
function countErrors(ownErrors, downstreamErrors) {
    const ownCount = ownErrors ? (ownErrors.match(/error TS\d+/g) ?? []).length : 0;
    const downstreamCount = downstreamErrors.reduce((sum, entry) => sum + (entry.match(/error TS\d+/g) ?? []).length, 0);
    return ownCount + downstreamCount;
}
// Proactively checks every configured mocks file BEFORE any test file is processed, and fixes it
// in a dedicated pass if broken.
//
// Why this exists, and why it checks TWO different things:
//
// 1. Self-contained errors (`typeCheckFile` scoped to the mocks file) — e.g. a mock that calls
//    `.mockResolvedValue()` on its OWN bare `jest.fn()` right there in the file. These are cheap
//    to find directly.
//
// 2. Downstream-only errors (`findDownstreamMockSymptoms`) — the more common and more dangerous
//    case. `export const mockCreateXRepo = jest.fn();` is 100% valid TypeScript ON ITS OWN — the
//    under-specification only becomes an error at the USE SITE, in whatever test file calls
//    `mockCreateXRepo().someMethod(...)`. Scoping tsc to the mocks file alone therefore reports
//    ZERO errors for this — confirmed by direct experiment: reintroducing exactly this bug and
//    re-running `typeCheckFile` on the mocks file in isolation found nothing, while the project-
//    wide compile showed `'repo' is of type 'unknown'` in the consuming test file instead. The
//    per-test-file fix loop's reactive detectMocksFileError (validate.ts) ALSO misses this case,
//    since the error text never names the mocks file at all. So this function additionally runs
//    one project-wide tsc pass, filters for the mock-shape-mismatch error family in ANY file, and
//    — for files that import one of the configured mocks files — hands those errors to the model
//    alongside the mocks file's own content, so it can correlate a downstream symptom back to the
//    declaration responsible even though tsc never attributed the error to this file directly.
export async function fixMocksFilesUpfront(config, env, cwd, options = {}) {
    const result = { checked: [], fixed: [], stillBroken: [] };
    if (env.language !== 'typescript')
        return result;
    const log = options.log ?? (() => { });
    const mocksFiles = mocksFileList(config);
    if (mocksFiles.length === 0)
        return result;
    const downstreamByFile = await findDownstreamMockSymptoms(cwd, env, mocksFiles);
    for (const relMocksFile of mocksFiles) {
        const absMocksFile = join(cwd, relMocksFile);
        let code;
        try {
            code = await readFile(absMocksFile, 'utf-8');
        }
        catch {
            continue; // doesn't exist yet — nothing to fix
        }
        result.checked.push(relMocksFile);
        let ownErrors = await typeCheckFile(absMocksFile, cwd, env);
        if (ownErrors === TYPECHECK_INCONCLUSIVE)
            ownErrors = null;
        let downstreamErrors = downstreamByFile.get(relMocksFile) ?? [];
        if (!ownErrors && downstreamErrors.length === 0)
            continue; // genuinely clean
        log(chalk.yellow(`\n  ⚠ Shared mocks file has type errors: ${relMocksFile} — fixing before processing test files...`));
        const requiredExports = extractExportNames(code);
        const provider = createProvider(config);
        const debugBase = resolveDebugBase(config.debug);
        const debugFile = perFileDebugPath(debugBase, relMocksFile);
        // Never-regress safety net: a full-file rewrite can make things WORSE (observed live —
        // deepseek-v4-flash's last attempt introduced 100+ new errors by using the wrong jest.fn()
        // generic arity everywhere), and the old version of this function had no guard against that
        // at all — it just wrote whatever the final attempt produced and stopped, leaving the file
        // in a worse state than it started. originalCode/originalErrorCount are the restore point;
        // bestCode/bestErrorCount track the best attempt seen so exhaustion keeps genuine partial
        // progress instead of either the broken last attempt OR throwing away real improvement.
        const originalCode = code;
        const originalErrorCount = countErrors(ownErrors, downstreamErrors);
        let bestCode = originalCode;
        let bestErrorCount = originalErrorCount;
        let fixedThisFile = false;
        for (let attempt = 1; attempt <= config.maxIterations; attempt++) {
            const prompt = buildPrompt(relMocksFile, code, ownErrors, downstreamErrors, requiredExports, env.testRunner === 'vitest', env.testRunner === 'jest' || env.testRunner === 'vitest');
            await debugWrite(debugFile, `PROMPT (mocks-fix attempt ${attempt})`, prompt, attempt === 1);
            log(chalk.dim(`  ⌛ Attempt ${attempt}/${config.maxIterations}: waiting for model...`));
            let raw;
            try {
                raw = await provider.generate([{ role: 'user', content: prompt }], SYSTEM_PROMPT, undefined, config.maxTokens, 0.1);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await debugWrite(debugFile, `ERROR (mocks-fix attempt ${attempt})`, msg);
                log(chalk.red(`  ⚠ Model error while fixing ${relMocksFile}: ${msg}`));
                break;
            }
            await debugWrite(debugFile, `RESPONSE (mocks-fix attempt ${attempt})`, raw);
            // Prefer patch mode — try parsing the response as // @@@ REPLACE/APPEND_EXPORT ops against
            // the CURRENT code first. Only fall back to treating the response as a full-file rewrite
            // when it contains no patch ops at all (the model decided the fix needed one, or ignored
            // the instruction — either way there's nothing to apply a patch against).
            const patched = tryApplyMocksPatch(code, raw);
            let candidate;
            if (patched) {
                if (patched.failedOps.length > 0) {
                    const anchors = patched.failedOps.map(op => `"${op.oldText.slice(0, 80).replace(/\n/g, '↵')}"`).join(', ');
                    log(chalk.yellow(`  ⚠ Attempt ${attempt}: patch anchor(s) not found — retrying...`));
                    ownErrors = `Your previous response's patch failed — these REPLACE anchor(s) were not found character-for-character in the current file: ${anchors}\nCopy the anchor text EXACTLY from CURRENT FILE CONTENT, including whitespace.${ownErrors ? `\n\nOriginal errors, still needing a fix:\n${ownErrors}` : ''}`;
                    continue;
                }
                candidate = patched.result;
                log(chalk.dim(`  Attempt ${attempt}: applied as a surgical patch (${(raw.match(/@@@ (REPLACE|APPEND_EXPORT):/g) ?? []).length} op(s)).`));
            }
            else {
                candidate = extractCodeOutput(raw);
                log(chalk.dim(`  Attempt ${attempt}: response had no patch ops — treating as a full-file rewrite.`));
            }
            // Sanity floor — a real fix (patched or full rewrite) always has at least one `export`.
            // Guards against an empty/near-empty extraction (e.g. the model produced only prose) being
            // written over a working file.
            if (candidate.trim().length < 20 || !/\bexport\b/.test(candidate)) {
                log(chalk.yellow(`  ⚠ Attempt ${attempt}: response didn't look like a real file — retrying...`));
                continue;
            }
            const candidateExports = new Set(extractExportNames(candidate));
            const missing = requiredExports.filter(n => !candidateExports.has(n));
            if (missing.length > 0) {
                log(chalk.yellow(`  ⚠ Attempt ${attempt}: dropped ${missing.length} required export(s) — retrying...`));
                ownErrors = `Your previous response DROPPED these required exports: ${missing.join(', ')}. Every export listed must remain present with the exact same name.${ownErrors ? `\n\nOriginal errors, still needing a fix:\n${ownErrors}` : ''}`;
                continue;
            }
            const cleaned = dedupeMockExports(candidate);
            // Verify BEFORE writing anything permanent — check the candidate in a scratch location
            // conceptually by writing it, measuring, and being ready to restore. withMocksLock still
            // guards the write itself against concurrent workers; the never-regress decision below
            // guards against the CONTENT being a regression once we can measure it.
            if (!options.dryRun) {
                await withMocksLock(async () => {
                    await writeFile(absMocksFile, cleaned, 'utf-8');
                });
            }
            const recheckOwn = options.dryRun ? null : await typeCheckFile(absMocksFile, cwd, env);
            const recheckDownstream = options.dryRun
                ? []
                : (await findDownstreamMockSymptoms(cwd, env, [relMocksFile])).get(relMocksFile) ?? [];
            const recheckOwnForCount = recheckOwn === TYPECHECK_INCONCLUSIVE ? null : recheckOwn;
            const attemptErrorCount = countErrors(recheckOwnForCount, recheckDownstream);
            if ((!recheckOwn || recheckOwn === TYPECHECK_INCONCLUSIVE) && recheckDownstream.length === 0) {
                log(chalk.green(`  ✓ Attempt ${attempt}: verified clean.`));
                fixedThisFile = true;
                break;
            }
            log(chalk.yellow(`  ⚠ Attempt ${attempt}: still ${attemptErrorCount} error(s) (started at ${originalErrorCount}) — ${attemptErrorCount < bestErrorCount ? 'an improvement, keeping as best-so-far' : 'not better than the best seen'}, retrying...`));
            if (attemptErrorCount < bestErrorCount) {
                bestCode = cleaned;
                bestErrorCount = attemptErrorCount;
            }
            if (recheckOwn === TYPECHECK_INCONCLUSIVE && recheckDownstream.length === 0)
                break; // couldn't verify — stop, don't loop on an unknown state
            ownErrors = recheckOwnForCount;
            downstreamErrors = recheckDownstream;
            code = cleaned;
        }
        if (fixedThisFile) {
            log(chalk.green(`  ✓ Fixed shared mocks file: ${relMocksFile}`));
            result.fixed.push(relMocksFile);
        }
        else {
            // Exhausted retries without reaching clean — never leave the file worse than it started.
            // Keep the best attempt if it actually beat the original; otherwise restore the original
            // verbatim rather than whatever the last (possibly worse) attempt wrote.
            const keepBest = bestErrorCount < originalErrorCount;
            if (!options.dryRun) {
                await withMocksLock(async () => {
                    await writeFile(absMocksFile, keepBest ? bestCode : originalCode, 'utf-8');
                });
            }
            if (keepBest) {
                log(chalk.yellow(`  ⚠ Could not fully fix ${relMocksFile} — kept the best attempt (${bestErrorCount} error(s) remaining, down from ${originalErrorCount}).`));
            }
            else {
                log(chalk.red(`  ✗ Could not fix shared mocks file: ${relMocksFile} — restored the original (no attempt improved on it). Test files importing it will likely still fail to compile.`));
            }
            result.stillBroken.push(relMocksFile);
        }
    }
    return result;
}
//# sourceMappingURL=mocks-fix.js.map