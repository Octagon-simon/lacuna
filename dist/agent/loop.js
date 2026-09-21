import { writeFile, mkdir, readFile, unlink, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, isAbsolute, relative } from 'path';
import chalk from 'chalk';
import { mocksFileList, iterationCeiling } from '../lib/config.js';
import { scopedCoverageCommand, relatedCoverageCommand } from '../lib/detector.js';
import { resolveFileTestRun, resolveIncrementalCoverageRun, resolveEnvForFile, resolveEnvForDir } from '../lib/test-run.js';
import { runCommand } from '../lib/runner.js';
import { loadCoverage, parseLcov, coverageAgeSeconds, extractGaps, filterTestableGaps, findUncoveredFiles, findTestFiles, isWithinDir, narrowGapsToDiff, computePatchCoverage, missingChangedFileGaps, alignReportToChanged } from '../lib/coverage/index.js';
import { resolveDiffScope, scopeDiffToDir } from '../lib/git-diff.js';
import { WorkerDisplay } from '../lib/worker-display.js';
import { startCoverageSpinner } from '../lib/coverage-spinner.js';
import { buildFileContext, findExistingTestFile } from './context.js';
import { TestGenerator, TruncatedOutputError, OscillationError, ModelStallError, ModelRateLimitError, ModelCancelledError, TRUNCATION_RETRY_MESSAGE, OSCILLATION_ESCAPE_MESSAGE } from './generator.js';
import { ProjectMemory } from './project-memory.js';
import { buildFixMemoryHint, recordFixOutcome, recordTagMatchOutcome, normalizeErrorSignature, errorSignatureHash } from '../lib/memory/index.js';
import { fixMocksFilesUpfront } from './mocks-fix.js';
import { getActiveTips, createTipRotator, formatTip } from '../lib/tips.js';
import { typeCheckFile, TYPECHECK_INCONCLUSIVE } from '../lib/typecheck.js';
import { formatFile } from '../lib/format.js';
import { routeTestToNodeEnv } from '../lib/env-route.js';
import { detectWeakAsyncWait } from './prompts/index.js';
import { hasTestFunctions, hasPlaceholderBodies, enrichNoTestsError, isZeroTestsOutput, parsePassCount, buildStructureBrokenMessage, buildRegressionMessage, processExitLeakGuidance, sanitizeMocksContent, detectUnbalancedMocksSyntax, stripLeadingProse, mergeMocksContent, dedupeMockExports, countTestCases, withMocksLock, detectMocksFileError, deduplicateViMocks, typeImportOriginalCalls, ensureMockedImports, fixNeverTypedAsyncMocks, dedupeImports, dedupeTestBlocks, replaceUnsafeFunctionType, tryApplyPatchWithDiag, tryApplyMocksPatch, detectProcessCrash, buildProcessCrashMessage, detectUnrelatedFileCrash, buildPatchEscalationMessage, buildFailingTestChecklist, detectStrayPatchMarkers, detectOpenHandleLeak, buildOpenHandleLeakMessage, detectJestConfigConflict, detectJestValidationError, subjectFromTestPath, referencesSubject } from '../lib/validate.js';
import { extractTestFailure } from '../lib/extract-error.js';
import { StreamingFileViewer } from '../lib/streaming-viewer.js';
import { fixFile } from './fix-loop.js';
async function getCoverageRate(config, cwd) {
    try {
        const report = await loadCoverage(config, cwd);
        return report.totalLineRate * 100;
    }
    catch {
        return 0;
    }
}
export async function processGap(gap, options, generator, parallel, onStatus, projectMemory, overrideTestFile) {
    const { config, env, cwd, dryRun, verbose, log, fixOnFailure = true } = options;
    const shortPath = gap.filePath.replace(cwd + '/', '');
    if (!onStatus) {
        log(chalk.bold(`\n  Processing: ${chalk.cyan(shortPath)}`));
        if (gap.uncoveredFunctions.length > 0) {
            log(chalk.dim(`  Uncovered functions: ${gap.uncoveredFunctions.join(', ')}`));
        }
    }
    let context;
    try {
        context = await buildFileContext(gap.filePath.replace(cwd + '/', ''), cwd, env, config);
    }
    catch {
        const msg = `Could not read source file: ${gap.filePath}`;
        if (!onStatus)
            log(chalk.red(`  ${msg}`));
        onStatus?.({ phase: 'failed', file: shortPath });
        return { success: false, error: msg };
    }
    // When called from regenerateFile the original test was deleted so inferTestFilePath
    // mirrors the source path (including any extra segments like lib/) instead of using
    // the real test location. The caller passes the original path to pin the write target.
    if (overrideTestFile) {
        context.suggestedTestFile = overrideTestFile;
        context.existingTestCode = null;
        context.existingTestFile = null;
    }
    // Surface the learned rules this file's prompt was enriched with (proactive tag-matched
    // memory) as a structured event — otherwise which rules were in play is invisible outside
    // the raw debug log. Inert for the CLI (options.onEvent unset); no-op when memory retrieved
    // nothing.
    if (context.memoryEntries.length > 0) {
        options.onEvent?.({ type: 'memory-used', file: shortPath, entries: context.memoryEntries.map((e) => e.id) });
    }
    if (!onStatus) {
        log(chalk.dim(`  ${context.existingTestFile ? 'Updating' : 'Creating'}: ${context.suggestedTestFile.replace(cwd + '/', '')}`));
    }
    // parallel: run only this test file so workers don't race on the full suite. Resolve it under
    // the file's OWN package config (monorepo setupFiles/cleanup/env), not bare from the repo root.
    const testRun = parallel
        ? await resolveFileTestRun(env, context.suggestedTestFile, cwd)
        : { command: env.testCommand, cwd };
    // A monorepo can mix runners per package — make prompt-building (mock API choice, etc.) match
    // whatever runner actually executes this file, not the repo-wide default the generator/worker
    // was constructed with.
    generator.setEnv(await resolveEnvForFile(env, context.suggestedTestFile, cwd));
    // Forward the embedder "Stop" signal so an in-flight generation is aborted, not just halted
    // between attempts.
    generator.setAbortSignal(options.abortSignal);
    // Capture pre-existing test file so we can restore on failure
    let originalTestContent = null;
    if (!dryRun) {
        try {
            originalTestContent = await readFile(context.suggestedTestFile, 'utf-8');
        }
        catch { /* new file */ }
    }
    // Two separate write-backs, both no-op (never throw) when memory is disabled:
    // 1. The "fixes" category only makes sense once there was a REAL failure to key it against
    //    (firstError, set on attempt 1) — a file whose first attempt just passed outright has no
    //    error signature to record a fix for.
    // 2. The tag-matched (mocks/frameworks) entries shown proactively via context.memoryEntries —
    //    these get their confidence bumped/decayed on the file's overall outcome regardless of
    //    whether a "fixes" entry also applies, since they were shown on attempt 1 either way.
    const recordFixMemory = async (outcome, finalCode) => {
        if (!config.memory.enabled)
            return;
        await Promise.all([
            firstError !== null
                ? recordFixOutcome(config, {
                    errorSignature: firstError,
                    tags: [env.testRunner, ...(context.reactMajorVersion !== null ? ['react'] : [])],
                    outcome,
                    diffBefore: originalTestContent,
                    diffAfter: finalCode,
                }).catch(() => { })
                : Promise.resolve(),
            context.memoryEntries.length > 0
                ? recordTagMatchOutcome(config, context.memoryEntries, firstError, outcome === 'success' ? null : lastError).catch(() => { })
                : Promise.resolve(),
        ]);
    };
    let generatedCode = null;
    let lastError = null;
    // One-shot: a green-but-racy "weak wait" test is invisible to the run-loop, so we nudge the
    // model to strengthen it once. If it still trips after the nudge we accept the file rather than
    // burn every iteration on a heuristic that might be a false positive.
    let weakWaitNudged = false;
    // One-shot: a leaked timer/handle still lets tests pass (invisible to pass/fail classification)
    // but makes Jest force-exit — nudge the model to add cleanup once, then accept-with-warning.
    let openHandleNudged = false;
    let firstError = null; // error from attempt 1, kept as anchor for regressions
    let firstPassCount = 0; // passing tests on attempt 1
    // Retrieved memory for the attempt-1 failure, computed ONCE (not per retry — see fix-loop.ts's
    // identical fixMemoryHint for why) and reused verbatim on every subsequent retry.
    let fixMemoryHint = null;
    let stallRetries = 0;
    const MAX_STALL_RETRIES = 2;
    let rateLimitRetries = 0;
    const MAX_RATE_LIMIT_RETRIES = 4;
    let consecutivePatchFailures = 0;
    // Live-observed on an RN-Expo project: an infrastructure-level crash (Expo's
    // ExpoFetchModule polyfill, no native runtime under Jest) hit 53/66 files identically, and
    // this loop burned its FULL config.maxIterations on every single one — no test-file edit could
    // ever fix a crash that happens before any test runs. Mirrors the identical guard added to
    // fix-loop.ts's retry loop; needed HERE too since this loop is shared by both `generate` and
    // regenerateFile()'s fallback (fix.ts's second-opinion rewrite also runs through here).
    let consecutiveUnrelatedFileCrashes = 0;
    // Best collecting attempt seen so far — used on failure to keep a net-improving partial
    // result (which `lacuna fix` can finish) instead of discarding work. Only attempts that
    // actually collected tests qualify, so a fence-broken / 0-test file is never kept.
    let bestCode = null;
    let bestPassCount = -1;
    // Mirror bestCode/lastCode's own run results, so a fixOnFailure handoff can hand fixFile the
    // EXACT result for whatever content is actually on disk right now, instead of fixFile blindly
    // re-running a test we just ran ourselves seconds ago (a real, avoidable duplicate execution
    // on every handoff — see fixFile's precomputedFirstRun doc comment).
    let bestRunResult = null;
    let lastRunResult = null;
    // The most recent attempt whose TESTS PASSED but left TypeScript type errors (which is why the
    // loop kept going). generate's contract is green tests, so this file is a keeper — if the loop
    // then oscillates or exhausts retries on the type-only repair, we keep THIS instead of deleting
    // a passing test the user could finish with `lacuna fix --file`.
    let acceptedPassingCode = null;
    // Running base for patch-mode application. Starts as the original test file and is updated
    // to the written content after each attempt, so a retry that patches a test ADDED by an
    // earlier attempt anchors against the current file — not the frozen original (which would
    // fail with "anchor not found").
    let patchBase = context.existingTestCode;
    // Convergence-based iteration budget — see fixFile's identical block for the full rationale. As
    // long as each attempt resolves its problem and surfaces a genuinely NEW one (a new normalized
    // error signature, not a repeat/oscillation), extend the budget one attempt at a time up to
    // ITERATION_CEILING; the moment an error repeats, growth stops and the flat cap resumes.
    let effectiveMax = config.maxIterations;
    const ITERATION_CEILING = iterationCeiling(config.maxIterations);
    const seenErrorSigs = new Set();
    for (let attempt = 1; attempt <= effectiveMax; attempt++) {
        // Cancellation (embedder "Stop"): checked before every attempt so a stop lands within the
        // current attempt rather than only between files — a single-file run has no between-files
        // boundary, which is why Stop appeared to do nothing. Breaks out with the best kept so far.
        if (options.shouldContinue && !options.shouldContinue()) {
            onStatus?.({ phase: 'failed', file: shortPath });
            return { success: false, error: 'Stopped by user.' };
        }
        // Progress check: `lastError` is the problem THIS attempt will fix (the previous attempt's
        // result). A new signature means the last attempt made forward progress — keep the budget one
        // ahead of the current attempt (never below the base cap, never above the ceiling).
        if (attempt > 1 && lastError) {
            const sig = errorSignatureHash(normalizeErrorSignature(lastError));
            if (!seenErrorSigs.has(sig)) {
                seenErrorSigs.add(sig);
                if (effectiveMax < ITERATION_CEILING) {
                    const extended = Math.min(ITERATION_CEILING, Math.max(effectiveMax, attempt + 1));
                    if (extended > effectiveMax && !onStatus) {
                        log(chalk.dim(`  Still making progress (new issue each pass) — extending to attempt ${extended}/${ITERATION_CEILING}.`));
                    }
                    effectiveMax = extended;
                }
            }
        }
        if (!onStatus) {
            if (attempt > 1) {
                // Word the header by the actual reason for this retry. After a type-check
                // failure the tests already PASS — calling it "fixing failures" is misleading.
                const fixingTypes = lastError?.startsWith('Tests passed but TypeScript type errors');
                const what = fixingTypes ? 'fixing type errors (tests pass)' : 'fixing failures';
                log(chalk.yellow(`\n  Retry ${attempt}/${effectiveMax} — ${what}...`));
            }
        }
        // Show waiting phase before the model call; transition to generating/retrying on first token
        onStatus?.({ phase: 'waiting', file: shortPath, since: Date.now() });
        const currentAttempt = attempt;
        generator.setFirstTokenCallback(() => {
            onStatus?.({
                phase: currentAttempt === 1 ? 'generating' : 'retrying',
                file: shortPath,
                ...(currentAttempt > 1 ? { attempt: currentAttempt, max: effectiveMax } : {}),
            });
        });
        if (!onStatus)
            log(chalk.dim(`\n  ⌛ Waiting for model response...`));
        let viewer;
        if (verbose && !onStatus) {
            viewer = new StreamingFileViewer(shortPath);
            generator.setTokenCallback(t => viewer.append(t));
            viewer.start();
        }
        // If the diagnostic actually points at the shared mocks file rather than this test file,
        // rewriting the test file can never fix it — say so explicitly rather than let the model
        // burn every retry re-editing a file that was never broken. See fix-loop.ts's identical
        // guard for the fuller rationale.
        const mocksFileBanner = lastError ? detectMocksFileError(lastError, mocksFileList(config)) : null;
        const promptLastError = lastError == null
            ? null
            : [lastError, mocksFileBanner, fixMemoryHint ? `\n\n${fixMemoryHint}` : null].filter(Boolean).join('');
        try {
            generatedCode = attempt === 1
                ? await generator.generate(context, gap, projectMemory)
                : await generator.retry(promptLastError ?? '', lastError ?? '');
        }
        catch (err) {
            viewer?.stop();
            generator.setTokenCallback(undefined);
            generator.setFirstTokenCallback(undefined);
            // User pressed Stop mid-generation — abort immediately, no retry.
            if (err instanceof ModelCancelledError) {
                onStatus?.({ phase: 'failed', file: shortPath });
                return { success: false, error: 'Stopped by user.' };
            }
            if (err instanceof ModelStallError) {
                if (stallRetries < MAX_STALL_RETRIES) {
                    stallRetries++;
                    if (!onStatus)
                        log(chalk.yellow(`\n  ⌛ Model stalled — reconnecting (${stallRetries}/${MAX_STALL_RETRIES})...`));
                    onStatus?.({ phase: 'waiting', file: shortPath, since: Date.now() });
                    await new Promise(r => setTimeout(r, 3000));
                    attempt--; // don't consume an AI iteration for a connection stall
                    continue;
                }
            }
            // See fix-loop.ts's identical branch: a capacity rejection (429/5xx/"overloaded") isn't
            // this file's fault, so back off with jitter and retry instead of failing it outright.
            if (err instanceof ModelRateLimitError) {
                if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                    rateLimitRetries++;
                    const delayMs = 2000 * 2 ** (rateLimitRetries - 1) + Math.floor(Math.random() * 1000);
                    if (!onStatus)
                        log(chalk.yellow(`\n  ⌛ Provider is rate-limited/overloaded — backing off ${Math.round(delayMs / 1000)}s (${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})...`));
                    onStatus?.({ phase: 'waiting', file: shortPath, since: Date.now() });
                    await new Promise(r => setTimeout(r, delayMs));
                    attempt--; // don't consume an AI iteration for a capacity rejection
                    continue;
                }
            }
            if (err instanceof TruncatedOutputError) {
                lastError = TRUNCATION_RETRY_MESSAGE;
                if (!onStatus)
                    log(chalk.yellow(`\n  Output truncated — retrying with shorter output request...`));
                onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
                continue;
            }
            if (err instanceof OscillationError) {
                if (attempt < effectiveMax) {
                    if (!onStatus)
                        log(chalk.yellow(`\n  ⚠ Agent loop detected — retrying with different strategy...`));
                    onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
                    generator.resetOscillationState();
                    lastError = OSCILLATION_ESCAPE_MESSAGE;
                    continue;
                }
                if (!onStatus)
                    log(chalk.red(`\n  ⚠ Agent loop detected — output identical to a previous attempt. Stopping early.`));
                // If a prior attempt already reached GREEN tests (only type errors kept it looping), keep
                // that passing file — deleting a test the user can `lacuna fix --file` to clean up is
                // strictly worse. Mirrors the natural last-attempt "type errors remain" acceptance.
                if (acceptedPassingCode !== null) {
                    await writeFile(context.suggestedTestFile, acceptedPassingCode, 'utf-8');
                    if (!dryRun)
                        await formatFile(context.suggestedTestFile, cwd, { enabled: config.format, env });
                    const relTest = context.suggestedTestFile.replace(cwd + '/', '');
                    if (!onStatus)
                        log(chalk.yellow(`  ⚠ Type errors remain — tests pass. Kept the file; run ${chalk.cyan(`lacuna fix --file ${relTest}`)} to clean up types.`));
                    onStatus?.({ phase: 'passed', file: shortPath });
                    await recordFixMemory('success', acceptedPassingCode);
                    return { success: true, testCode: acceptedPassingCode };
                }
                // No green attempt — fall through to the keep-best finalization, which preserves a new
                // file's best partial for `lacuna fix` instead of deleting it.
                lastError = err.message;
                break;
            }
            const msg = err instanceof Error ? err.message : String(err);
            if (!onStatus)
                log(chalk.red(`\n  API error: ${msg}`));
            // Fall through to the keep-best finalization (and fix-specialist handoff) instead of an
            // immediate return — a prior iteration may have already collected passing tests (bestCode)
            // before THIS iteration's raw API error, and that's still worth keeping/handing off rather
            // than discarding outright. Mirrors the identical OscillationError fall-through above.
            lastError = msg;
            break;
        }
        viewer?.stop();
        generator.setTokenCallback(undefined);
        generator.setFirstTokenCallback(undefined);
        if (dryRun) {
            if (!onStatus) {
                log(chalk.yellow('\n  [dry-run] Would write:'));
                log(chalk.dim(generatedCode.split('\n').slice(0, 10).map((l) => `    ${l}`).join('\n')));
                if (generatedCode.split('\n').length > 10)
                    log(chalk.dim('    …'));
            }
            onStatus?.({ phase: 'passed', file: shortPath });
            return { success: true, testCode: generatedCode };
        }
        // Patch mode: model returned surgical edits — apply them to get the complete file.
        // patchBase is null on the very first attempt at a BRAND-NEW test file (nothing exists yet
        // to patch against) — if the model still emits patch-op syntax there, that's always a model
        // error, never a legitimate patch. Route it into the same failure path as an unresolved
        // anchor (bump consecutivePatchFailures, retry with guidance) instead of silently falling
        // through: skipping validation here let raw, un-applied patch text — including a garbled
        // patch missing its // @@@ REPLACE: header, just a stray // @@@ WITH: marker sandwiched
        // between the old and new blocks — get written to disk verbatim as the "generated" file.
        if (generator.isPatch && !patchBase) {
            consecutivePatchFailures++;
            lastError =
                `PATCH APPLICATION FAILED: you used a // @@@ patch (REPLACE_TEST/DELETE_TEST/ADD_AFTER_DESCRIBE/REPLACE) but this test file does not exist yet — there is nothing to patch.\n` +
                    `Use <code_output> (NOT <code_patch>) and write the COMPLETE new test file from scratch.`;
            if (!onStatus)
                log(chalk.yellow(`  Patch mode used for a new file — retrying with full-file output...`));
            onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
            continue;
        }
        else if (generator.isPatch && patchBase) {
            const patchResult = tryApplyPatchWithDiag(patchBase, generatedCode);
            if (patchResult.ok) {
                const baseTestCount = countTestCases(patchBase);
                const resultTestCount = countTestCases(patchResult.result);
                if (resultTestCount < baseTestCount) {
                    // The patch applied cleanly but net-deletes tests — DELETE_TEST is for genuinely
                    // obsolete tests, not an anchor-mismatch escape hatch (observed: a model stuck on
                    // repeated "anchor not found" reaching for DELETE_TEST on ~18 valid tests just to get
                    // SOME op in its patch to succeed). Reject and retry rather than silently shipping a
                    // file with fewer tests than it started with.
                    consecutivePatchFailures++;
                    if (consecutivePatchFailures >= 2) {
                        lastError = buildPatchEscalationMessage(consecutivePatchFailures, 'repeatedly deleting tests instead of fixing the anchor');
                        generator.setPatchMode(false);
                    }
                    else {
                        lastError =
                            `PATCH REJECTED: this patch removes ${baseTestCount - resultTestCount} test case(s) (${baseTestCount} → ${resultTestCount}) without adding replacements.\n` +
                                `DELETE_TEST is only for tests that are genuinely obsolete (e.g. testing removed behavior) — never use it to work around a REPLACE/anchor mismatch.\n` +
                                `Re-read the test file and fix the actual anchor problem, or add new tests covering what you removed.`;
                    }
                    if (!onStatus)
                        log(chalk.yellow(`  ⚠ Patch deletes ${baseTestCount - resultTestCount} test(s) — rejecting and retrying...`));
                    onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
                    continue;
                }
                // NOTE: consecutivePatchFailures is NOT reset here — a clean anchor application only
                // means the patch STRUCTURALLY applied, not that the resulting code actually compiles or
                // collects tests. It's reset below, in the post-run classification, only once the test
                // run itself confirms the file is structurally intact (not 0-tests-collected) — see the
                // identical reasoning where that reset now lives.
                generatedCode = patchResult.result;
            }
            else {
                consecutivePatchFailures++;
                if (consecutivePatchFailures >= 2) {
                    // Escape hatch: after 2 failed patches the model can't anchor correctly.
                    // Force a full-file rewrite on the next attempt so it bypasses patch matching entirely.
                    lastError =
                        `PATCH ANCHORS FAILED ${consecutivePatchFailures} TIMES — SWITCH TO FULL REWRITE MODE.\n` +
                            `Your patch is not matching the file. On this attempt you MUST use <code_output> (NOT <code_patch>) and output the COMPLETE test file.\n` +
                            `Include every existing test verbatim and add the new ones you need.\n` +
                            `Do NOT use <code_patch> this time.`;
                }
                else {
                    // Give the model the exact anchor text that failed so it can correct it
                    const failedOp = patchResult.failedOp;
                    const anchorBlock = failedOp
                        ? `\nFailed operation: ${failedOp.type}\nAnchor that was NOT found in the file:\n"""\n${failedOp.anchor.slice(0, 600)}\n"""`
                        : '';
                    lastError =
                        `PATCH APPLICATION FAILED: an anchor string in your patch was not found in the test file.${anchorBlock}\n\n` +
                            `The anchor must be character-for-character identical to the text in the EXISTING TEST FILE shown in the original prompt.\n` +
                            `Checklist:\n` +
                            `  • REPLACE_TEST / DELETE_TEST anchor = exact it/test name string (without quotes)\n` +
                            `  • ADD_AFTER_DESCRIBE anchor = exact describe() name string\n` +
                            `  • REPLACE anchor = entire text block copied verbatim from the test file\n` +
                            `Re-read the test file in the original prompt, locate the exact text, and rewrite your patch.`;
                }
                if (!onStatus)
                    log(chalk.yellow(`  Patch anchors not found — retrying...`));
                onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
                continue;
            }
        }
        else if (!generator.isPatch) {
            // A full <code_output> rewrite should never contain lacuna's OWN internal <code_patch>
            // delimiter syntax — found leaking into a real full-file response (the model's own prior
            // patch attempt, still sitting in conversation history, got copied verbatim into a later
            // full rewrite). Reject and retry rather than silently write corrupted content to disk.
            if (detectStrayPatchMarkers(generatedCode)) {
                consecutivePatchFailures++;
                lastError =
                    'STRAY PATCH-FORMAT MARKERS DETECTED in your full-file output — this response contains literal "// @@@ REPLACE:"/"// @@@ WITH:"/"// @@@ END" text, which is lacuna\'s internal <code_patch> syntax, not valid code.\n' +
                        'Do NOT copy patch-format text from an earlier attempt into a full <code_output> rewrite — write ONLY real, complete TypeScript, with no "// @@@" markers anywhere.';
                if (!onStatus)
                    log(chalk.yellow(`  ⚠ Stray patch-format markers found in full-file output — rejecting and retrying...`));
                onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
                continue;
            }
            // Model switched to (or stayed in) full-file mode — reset patch failure counter
            consecutivePatchFailures = 0;
        }
        // Strip thinking/prose that leaked before the first real code line.
        // Happens under retry pressure when the model bleeds reasoning into <code_output>.
        const { code: cleanCode, stripped: bleedText } = stripLeadingProse(generatedCode);
        if (bleedText !== null) {
            if (!onStatus)
                log(chalk.yellow(`  ⚠ Thinking bleed detected — stripped: "${bleedText.slice(0, 80)}…"`));
            generatedCode = cleanCode;
        }
        const MOCKS_SEPARATOR = '// ---MOCKS_FILE---';
        const MOCKS_PATCH_SEPARATOR = '// ---MOCKS_PATCH---';
        let testCode = generatedCode;
        // Set when a mocks patch fails to apply — appended to whatever lastError the test-file run
        // itself produces below, rather than discarding the whole attempt via `continue`. See the
        // identical note in fix-loop.ts for the full rationale: the test-file fix and the mocks-file
        // patch are independent changes bundled into one response, and a stale anchor (common under
        // `-w N` parallel workers, whose prompt was built from an earlier read of the shared file)
        // shouldn't throw away a genuinely correct test-file fix sitting right next to it.
        let mocksPatchFailureNote = null;
        const primaryMocksFile = mocksFileList(config)[0];
        if (generatedCode.includes(MOCKS_PATCH_SEPARATOR) && primaryMocksFile) {
            // Surgical patch mode: model only emits the changed sections
            const [newTestCode, patchContent] = generatedCode.split(MOCKS_PATCH_SEPARATOR);
            testCode = newTestCode.trim();
            if (patchContent?.trim()) {
                const absoluteMocksFile = join(cwd, primaryMocksFile);
                // Read + apply + write must be one atomic section under parallel workers — see
                // withMocksLock.
                const applied = await withMocksLock(async () => {
                    let existing = '';
                    try {
                        existing = await readFile(absoluteMocksFile, 'utf-8');
                    }
                    catch { /* new file — patch can't apply */ }
                    if (!existing)
                        return null;
                    const result = tryApplyMocksPatch(existing, patchContent.trim());
                    if (result && result.failedOps.length === 0) {
                        if (detectUnbalancedMocksSyntax(result.result))
                            return { ...result, unbalanced: true };
                        await writeFile(absoluteMocksFile, result.result, 'utf-8');
                    }
                    return result;
                });
                if (applied) {
                    if ('unbalanced' in applied && applied.unbalanced) {
                        mocksPatchFailureNote = `MOCKS PATCH REJECTED: applying it left the shared mock file with unbalanced braces/parens/brackets — it was NOT written to disk (this would have broken every test that imports it). Your patch content is likely truncated or incomplete. Re-emit the full, complete ---MOCKS_PATCH--- (or ---MOCKS_FILE--- for a full rewrite) with matching braces.`;
                        if (!onStatus)
                            log(chalk.red(`  ⚠ Mock patch would leave the shared file unbalanced — rejected, not written.`));
                    }
                    else if (applied.failedOps.length > 0) {
                        const anchors = applied.failedOps.map(op => `"${op.oldText.slice(0, 60).replace(/\n/g, '↵')}"`).join(', ');
                        mocksPatchFailureNote = `MOCKS PATCH FAILED: the following REPLACE anchor(s) were not found in the mock file:\n${anchors}\nAnchors must be copied character-for-character from the SHARED MOCK FILE shown above (re-read it — under parallel workers it may have changed since you last saw it). Re-read it and rewrite your ---MOCKS_PATCH--- block.`;
                        if (!onStatus)
                            log(chalk.yellow(`  ⚠ Mock patch anchors not found — proceeding with the test-file fix alone, will retry the mocks patch...`));
                    }
                    else {
                        if (!onStatus)
                            log(chalk.dim(`  Patched mocks file: ${primaryMocksFile}`));
                    }
                }
            }
        }
        else if (generatedCode.includes(MOCKS_SEPARATOR) && primaryMocksFile) {
            // Full-rewrite mode (new mock file or explicit full replacement)
            const [newTestCode, newMocksCode] = generatedCode.split(MOCKS_SEPARATOR);
            testCode = newTestCode.trim();
            if (newMocksCode?.trim()) {
                const { code: safeMocks, stripped } = sanitizeMocksContent(newMocksCode.trim());
                if (stripped && !onStatus)
                    log(chalk.yellow(`  ⚠ Mocks file contained test blocks — stripped before writing`));
                if (safeMocks) {
                    const absoluteMocksFile = join(cwd, primaryMocksFile);
                    await mkdir(dirname(absoluteMocksFile), { recursive: true });
                    // Read + merge + dedupe + write as one atomic section — under parallel workers, two
                    // workers reading the same pre-write content would otherwise each compute their own
                    // merge and the second writer would silently discard the first worker's addition.
                    const wasUnbalanced = await withMocksLock(async () => {
                        let existing = '';
                        try {
                            existing = await readFile(absoluteMocksFile, 'utf-8');
                        }
                        catch { /* new file */ }
                        const merged = dedupeMockExports(existing ? mergeMocksContent(existing, safeMocks) : safeMocks);
                        if (detectUnbalancedMocksSyntax(merged))
                            return true;
                        await writeFile(absoluteMocksFile, merged, 'utf-8');
                        return false;
                    });
                    if (wasUnbalanced) {
                        mocksPatchFailureNote = `MOCKS FILE REJECTED: the rewritten mock file has unbalanced braces/parens/brackets — it was NOT written to disk (this would have broken every test that imports it). Your response is likely truncated (hit a length limit mid-function) or incomplete. Re-emit the complete mock file with every function body closed, or use ---MOCKS_PATCH--- for a smaller, surgical change instead of a full rewrite.`;
                        if (!onStatus)
                            log(chalk.red(`  ⚠ Mocks file rewrite would leave it unbalanced — rejected, not written.`));
                    }
                    else {
                        if (!onStatus)
                            log(chalk.dim(`  Updated mocks file: ${primaryMocksFile}`));
                    }
                }
            }
        }
        testCode = deduplicateViMocks(testCode);
        testCode = typeImportOriginalCalls(testCode);
        testCode = ensureMockedImports(testCode);
        testCode = fixNeverTypedAsyncMocks(testCode);
        testCode = dedupeImports(testCode);
        testCode = dedupeTestBlocks(testCode);
        testCode = replaceUnsafeFunctionType(testCode);
        // Catch empty test files before writing — no point running a file with no tests
        if (!hasTestFunctions(testCode)) {
            lastError =
                'ERROR: The code you wrote contains NO test functions (no it() or test() calls).\n' +
                    'Do not write a file with only imports, types, describe() blocks, or helper functions.\n' +
                    'Every test file must contain at least one: it(\'description\', () => { expect(...).toBe(...) })\n' +
                    'Rewrite the file and include real test cases.';
            if (!onStatus)
                log(chalk.yellow(`  Generated file has no tests — retrying...`));
            onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
            continue;
        }
        // Subject-integrity: the generated test must actually test THIS source file (import + exercise
        // it), not an easy imported utility. Without this a hard-to-mock hook/component gets "tested" by
        // trivially testing a dependency (e.g. a hook whose test drifts to an imported util), which passes and gets
        // kept. Gated on a specific (non-generic) subject name; the test's own import path from the
        // source satisfies the reference, so ordinary multi-export util files are unaffected.
        const genSubject = subjectFromTestPath(context.suggestedTestFile);
        if (genSubject && !referencesSubject(testCode, genSubject)) {
            lastError =
                `ERROR: This test must test \`${genSubject}\` (the source file it is for), but your test never ` +
                    `imports or references \`${genSubject}\` — you tested a DIFFERENT module (likely an imported ` +
                    `dependency). Import \`${genSubject}\` from its source file and write tests that exercise IT. Do ` +
                    `not test an imported helper as a substitute for the file under test.`;
            if (!onStatus)
                log(chalk.red(`  ⚠ Test doesn't test its subject (${genSubject}) — rejected, retrying...`));
            onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
            continue;
        }
        onStatus?.({ phase: 'writing', file: shortPath });
        await mkdir(dirname(context.suggestedTestFile), { recursive: true });
        await writeFile(context.suggestedTestFile, testCode, 'utf-8');
        // Next patch-mode retry anchors against what's actually on disk now (including tests this
        // attempt added/changed), not the frozen original.
        patchBase = testCode;
        if (!onStatus)
            log(chalk.dim(`  Written. Running tests...`));
        onStatus?.({ phase: 'running', file: shortPath });
        const runResult = await runCommand(testRun.command, testRun.cwd, 300_000, undefined, options.abortSignal);
        if (runResult.aborted || options.abortSignal?.aborted) {
            onStatus?.({ phase: 'failed', file: shortPath });
            return { success: false, error: 'Cancelled.' };
        }
        lastRunResult = runResult;
        const rawRunOutput = runResult.stdout + '\n' + runResult.stderr;
        if (runResult.success) {
            // Reject placeholder test bodies — `{ // body }` passes vitest (no assertions)
            // but produces zero coverage value. Force a retry with an explicit error.
            if (hasPlaceholderBodies(testCode)) {
                lastError =
                    'ERROR: One or more test bodies contain placeholder comments (e.g. `// body`, `// TODO`) with no real assertions.\n' +
                        'Every test must have complete, working expectations:\n' +
                        '  it(\'description\', async () => {\n' +
                        '    const result = await subject.doThing(...);\n' +
                        '    expect(result).toEqual(expectedValue);\n' +
                        '  })\n' +
                        'Replace every `// body` placeholder with real arrange-act-assert code.';
                if (!onStatus)
                    log(chalk.yellow(`  Placeholder test bodies detected — retrying...`));
                onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
                continue;
            }
            // Tests pass — but a "weak wait" (assert state right after a call-only waitFor) passes
            // locally and fails in slow CI. The run-loop can't see it (it's green), so scan statically
            // and nudge once. One-shot to bound the cost of a false positive.
            if (!weakWaitNudged && attempt < effectiveMax) {
                const weakWait = detectWeakAsyncWait(testCode);
                if (weakWait) {
                    weakWaitNudged = true;
                    lastError = weakWait;
                    if (!onStatus)
                        log(chalk.yellow(`  Tests pass but an async wait looks racy — strengthening it (retrying)...`));
                    onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
                    continue;
                }
            }
            // Tests pass — but Jest had to force-exit on a leaked handle (interval/connection never
            // cleared). Invisible to pass/fail classification (still green), so nudge once like the
            // weak-wait check above, then accept-with-warning rather than loop on a possible false positive.
            const openHandleLeak = detectOpenHandleLeak(rawRunOutput);
            if (openHandleLeak && !openHandleNudged && attempt < effectiveMax) {
                openHandleNudged = true;
                acceptedPassingCode = testCode;
                lastError = buildOpenHandleLeakMessage();
                if (!onStatus)
                    log(chalk.yellow(`  Tests pass but Jest force-exited on a leaked handle — fixing (retrying)...`));
                onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
                continue;
            }
            const typeErrors = await typeCheckFile(context.suggestedTestFile, cwd, env);
            // Inconclusive (tsc timed out/crashed) is not an actionable type error — the tests pass,
            // which is generate's contract, so don't burn a retry feeding the model a non-error.
            if (typeErrors && typeErrors !== TYPECHECK_INCONCLUSIVE) {
                if (attempt < effectiveMax) {
                    // Green tests, only type errors remain — remember this file so an oscillation/exhaustion
                    // on the type repair keeps it rather than discarding a passing test.
                    acceptedPassingCode = testCode;
                    lastError = `Tests passed but TypeScript type errors were found in the generated file:\n${typeErrors}\n\nFix ALL type errors. Do not use 'as any' or '@ts-ignore'.`;
                    if (!onStatus)
                        log(chalk.yellow(`  Tests pass — fixing type errors (retrying)...`));
                    onStatus?.({ phase: 'retrying', file: shortPath, attempt, max: effectiveMax });
                    continue;
                }
                // Last attempt — tests pass even though type errors remain.
                // Report as passed rather than discarding a working test file.
                const relTest = context.suggestedTestFile.replace(cwd + '/', '');
                if (!onStatus)
                    log(chalk.yellow(`  ⚠ Type errors remain — tests pass. Run \`lacuna fix --file ${relTest}\` to clean up types.`));
            }
            else {
                if (!onStatus)
                    log(chalk.green(`  Tests passed.`));
            }
            if (openHandleLeak && !onStatus) {
                log(chalk.yellow(`  ⚠ Jest had to force-exit due to a leaked timer/handle in this test file — tests pass but consider adding cleanup.`));
            }
            if (mocksPatchFailureNote && !onStatus) {
                log(chalk.yellow(`  ⚠ Note: this file's tests pass without it, but the accompanying mocks-file patch in this response did NOT apply (anchor not found) — ${primaryMocksFile} was left unchanged.`));
            }
            // Format the accepted file with the repo's own eslint/prettier so it matches local style and
            // clears the lint gate. eslint --fix is NOT guaranteed behavior-preserving (it can drop an
            // import it thinks is unused, apply an autofix that changes a matcher, etc.), so re-verify and
            // restore the EXACT green version if it broke the test — we must never report `passed` with a
            // failing file on disk (the file the user reviews/keeps must match what we verified).
            if (!dryRun) {
                await formatFile(context.suggestedTestFile, cwd, { enabled: config.format, env });
                if (config.format) {
                    const afterFormat = await runCommand(testRun.command, testRun.cwd);
                    if (!afterFormat.success) {
                        await writeFile(context.suggestedTestFile, testCode, 'utf-8');
                        if (!onStatus)
                            log(chalk.yellow('  ⚠ Formatting changed the test\'s behavior — restored the verified passing version.'));
                    }
                }
                // A DOM-free test pays the jsdom startup tax for nothing — route it to the node
                // environment via a docblock (verified per-file, reverted if it breaks the test).
                const routed = await routeTestToNodeEnv(context.suggestedTestFile, cwd, { enabled: config.nodeEnvRouting, env });
                if (routed && !onStatus)
                    log(chalk.dim(`  ↳ DOM-free — routed to the node environment (skips jsdom startup).`));
            }
            onStatus?.({ phase: 'passed', file: shortPath });
            await recordFixMemory('success', testCode);
            return { success: true, testCode };
        }
        const rawExtracted = extractTestFailure(rawRunOutput);
        const leakGuidance = processExitLeakGuidance(rawRunOutput);
        const extracted = leakGuidance
            ? `${leakGuidance}\n\n${enrichNoTestsError(rawExtracted, rawRunOutput, env.testRunner)}`
            : enrichNoTestsError(rawExtracted, rawRunOutput, env.testRunner);
        const passCount = parsePassCount(rawRunOutput);
        // A hard process crash (OOM/segfault) can otherwise get sorted into either "0 tests
        // collected" (crash before any test starts) or "regression" (crash partway through, killing
        // the process before a summary line prints — passCount reads 0, satisfying "fewer than
        // before") — checked first so it always gets its own, correct guidance instead.
        const crashSignature = detectProcessCrash(rawRunOutput);
        let unrelatedFileNote = null;
        if (!isZeroTestsOutput(rawRunOutput) && passCount > bestPassCount) {
            bestPassCount = passCount;
            bestCode = testCode;
            bestRunResult = runResult;
        }
        if (attempt === 1) {
            firstError = extracted;
            firstPassCount = passCount;
            lastError = crashSignature ? buildProcessCrashMessage(crashSignature, extracted) : extracted;
            if (config.memory.enabled) {
                const hint = await buildFixMemoryHint(config, extracted, {
                    testRunner: env.testRunner,
                    dependencies: context.reactMajorVersion !== null ? ['react'] : [],
                }).catch(() => ({ text: null, coveredPatterns: [] }));
                fixMemoryHint = hint.text;
                generator.setCoveredPatterns(hint.coveredPatterns);
            }
            // Match attempt 2+'s more specific classification below — a generic "Tests failed" on
            // attempt 1 read as "assertions failed, tests were at least collected" even when the
            // model's first attempt was ALSO structurally broken (0 tests collected / a hard crash),
            // which silently meant bestCode never qualified and fixOnFailure correctly never had
            // anything to hand off — but nothing in the log said so, reading as a mysterious no-op.
            if (!onStatus) {
                const what = crashSignature ? 'Test process CRASHED' : isZeroTestsOutput(rawRunOutput) ? '0 tests collected — file structure broken' : 'Tests failed';
                log(chalk.red(`  ${what} (attempt ${attempt}/${effectiveMax})`));
            }
        }
        else if (crashSignature) {
            lastError = buildProcessCrashMessage(crashSignature, extracted);
            if (!onStatus)
                log(chalk.red(`  Test process CRASHED (attempt ${attempt}/${effectiveMax})`));
        }
        else if (isZeroTestsOutput(rawRunOutput)) {
            unrelatedFileNote = detectUnrelatedFileCrash(rawExtracted, shortPath, context.sourceFile, mocksFileList(config));
            if (generator.isPatch) {
                consecutivePatchFailures++;
                if (consecutivePatchFailures >= 2) {
                    lastError = buildPatchEscalationMessage(consecutivePatchFailures, 'the patch keeps breaking the file structure — 0 tests collected');
                    generator.setPatchMode(false);
                }
                else {
                    lastError = buildStructureBrokenMessage(firstError, rawExtracted) + (unrelatedFileNote ?? '');
                }
            }
            else {
                lastError = buildStructureBrokenMessage(firstError, rawExtracted) + (unrelatedFileNote ?? '');
            }
            if (!onStatus)
                log(chalk.red(`  Fix broke file structure — 0 tests collected (attempt ${attempt}/${effectiveMax})`));
        }
        else if (passCount < firstPassCount) {
            // Reached here means the file collected tests fine this attempt — patch mode is
            // structurally working again, regardless of the assertion-level regression itself.
            consecutivePatchFailures = 0;
            lastError = buildRegressionMessage(firstError, extracted, firstPassCount, passCount) + (buildFailingTestChecklist(rawRunOutput) ?? '');
            if (!onStatus)
                log(chalk.red(`  Fix caused regression: ${firstPassCount} → ${passCount} passing (attempt ${attempt}/${effectiveMax})`));
        }
        else {
            consecutivePatchFailures = 0;
            lastError = extracted + (buildFailingTestChecklist(rawRunOutput) ?? '');
            if (!onStatus)
                log(chalk.red(`  Tests failed (attempt ${attempt}/${effectiveMax})`));
        }
        // Surface the mocks-patch failure alongside whatever the test run itself reported — see the
        // identical note in fix-loop.ts.
        if (mocksPatchFailureNote)
            lastError = `${lastError}\n\n${mocksPatchFailureNote}`;
        if (!onStatus && verbose)
            log(chalk.dim(lastError.split('\n').slice(0, 20).join('\n')));
        // Same reasoning as fix-loop.ts's identical guard: an unrelated-file crash is, by
        // definition, not something any test-file edit can fix — if it's identical two attempts in a
        // row, further attempts are pure wasted budget (confirmed live: 53/66 files on one project
        // burned their full maxIterations here on the exact same node_modules crash before this
        // guard existed).
        consecutiveUnrelatedFileCrashes = unrelatedFileNote ? consecutiveUnrelatedFileCrashes + 1 : 0;
        if (consecutiveUnrelatedFileCrashes >= 2 && attempt < effectiveMax) {
            if (!onStatus) {
                log(chalk.red(`  ⚠ Same unrelated-file crash on ${consecutiveUnrelatedFileCrashes} attempts in a row — no test-file edit can fix this. Stopping early instead of burning the remaining budget.`));
            }
            break;
        }
    }
    onStatus?.({ phase: 'failed', file: shortPath });
    await recordFixMemory('failure', bestCode ?? originalTestContent ?? '');
    const rel = context.suggestedTestFile.replace(cwd + '/', '');
    const keepHint = () => {
        if (!onStatus)
            log(chalk.yellow(`\n  Kept ${bestPassCount} passing test(s) at ${rel} — run ${chalk.cyan(`lacuna fix --file ${rel}`)} to repair the remaining failures`));
    };
    // Tracks whether the file on disk right now is a genuinely collecting (bestCode) attempt —
    // vs. the restored original or a non-collecting last attempt — since only a collecting
    // attempt is worth handing to the fix specialist below.
    let keptBestOnDisk = false;
    // Separate, narrower flag: a NEW file where EVERY attempt was structurally broken (0 tests
    // collected every time — e.g. a jest.mock() scope violation) still has the last attempt's
    // (non-collecting) code sitting on disk. That's exactly the failure class the fix specialist's
    // hook/service/mock-call hints are built to diagnose, so it's still worth ONE handoff attempt
    // even though there's no bestCode to fall back to if the specialist also can't fix it — unlike
    // an EXISTING file, which always has a known-good original to restore to instead.
    let hasBrokenNewFileOnDisk = false;
    if (originalTestContent === null) {
        // New file — keep the best collecting attempt so `lacuna fix` can repair it.
        if (bestCode !== null) {
            await writeFile(context.suggestedTestFile, bestCode, 'utf-8');
            keepHint();
            keptBestOnDisk = true;
        }
        else {
            hasBrokenNewFileOnDisk = true;
            if (!onStatus)
                log(chalk.yellow(`\n  Last attempt kept at ${rel} — run ${chalk.cyan(`lacuna fix --file ${rel}`)} to repair it`));
        }
    }
    else if (parallel && bestCode !== null) {
        // Existing file with a clean, collecting attempt. Keep it ONLY if it adds net-new passing
        // tests vs the original — otherwise the generated tests broke the suite or added no value,
        // so restore the original. parallel ⇒ testCmd is file-scoped, so parsePassCount reflects
        // this file and the comparison is sound. Measure the baseline lazily (only here on failure).
        await writeFile(context.suggestedTestFile, originalTestContent, 'utf-8');
        const baseRun = await runCommand(testRun.command, testRun.cwd);
        const baselinePassCount = parsePassCount(baseRun.stdout + '\n' + baseRun.stderr);
        if (bestPassCount > baselinePassCount) {
            await writeFile(context.suggestedTestFile, bestCode, 'utf-8');
            keepHint();
            keptBestOnDisk = true;
        }
        else if (!onStatus) {
            log(chalk.dim(`\n  Generated tests didn't improve on the existing file (${baselinePassCount} passing) — restored the original.`));
        }
    }
    else {
        // Existing file under a full-suite run (per-file pass count not measurable) or no clean
        // attempt — restore the original so the workspace stays coherent.
        await restoreTestFile(context.suggestedTestFile, originalTestContent);
    }
    // Explain the skip explicitly when fix-on-failure is enabled but has nothing to work with at
    // all — an EXISTING file that got restored to its (already-passing) original, since there's no
    // new broken content worth handing off. Without this line, an absent handoff for that case
    // silently reads as "fix-on-failure didn't work" rather than "correctly declined — nothing new
    // to fix; the original was already fine."
    if (fixOnFailure && !dryRun && !keptBestOnDisk && !hasBrokenNewFileOnDisk && !onStatus) {
        log(chalk.dim(`  (fix-on-failure skipped: the existing file was restored to its already-passing original — nothing new to fix)`));
    }
    // Hand off to the fix specialist: buildFixPrompt gets the exact runtime error, the real mocks
    // file, and the full hook/service/mock-call hint suite that generate's own buildRetryPrompt
    // does not carry to the same degree — a second, differently-equipped attempt at the SAME file
    // before giving up, using the same worker slot (so under --workers N it interleaves with other
    // files' generation rather than requiring a separate later `lacuna fix` pass). Also covers a
    // NEW file where every attempt was structurally broken (hasBrokenNewFileOnDisk) — the fix
    // specialist's mock-shape hints are often exactly what a 0-tests-collected scope/import error
    // needs, and there's no downside if it also fails (fixFile has its own never-regress guarantee).
    if (fixOnFailure && !dryRun && (keptBestOnDisk || hasBrokenNewFileOnDisk)) {
        onStatus?.({ phase: 'fixing', file: shortPath });
        if (!onStatus)
            log(chalk.magenta(`\n  Handing off to the fix specialist (${rel})...`));
        // Bounded budget: this is a second opinion on a file generate already spent its FULL budget
        // on, not an independent fresh attempt — giving it another complete maxIterations would
        // silently double the worst-case cost of every exhausted file now that this handoff is
        // default-on. If the specialist's better-equipped prompt hasn't turned it around in half the
        // budget, a full second budget rarely does either.
        const fixOptions = { config: { ...config, maxIterations: Math.max(1, Math.ceil(config.maxIterations / 2)) }, env, cwd, dryRun, verbose, log };
        // Skip fixFile's own from-scratch re-run: we just ran this EXACT content (bestCode or the
        // last attempt, matching whichever branch above actually wrote it to disk) seconds ago and
        // already have the result — see fixFile's precomputedFirstRun doc comment. ONLY valid when
        // `parallel` was true for this gap: that's what made `testRun` file-scoped (via
        // resolveFileTestRun), matching fixFile's OWN file-scoped `fileRun` resolution. When
        // `parallel` is false, `testRun` ran the FULL SUITE command instead (see its definition
        // above) — a full-suite result handed to fixFile as if it were file-scoped would carry the
        // wrong error text and pass-count semantics, so the optimization simply doesn't apply there
        // and fixFile falls back to its own (correct, file-scoped) from-scratch run.
        const precomputedFirstRun = parallel ? ((keptBestOnDisk ? bestRunResult : lastRunResult) ?? undefined) : undefined;
        // Keep the display pinned on 'fixing' for every intermediate phase (waiting/running/writing/
        // retrying) instead of letting fixFile's own onStatus stream through raw — otherwise the
        // worker row flips to showing the TEST file path under a generic-looking label (fixFile
        // computes ITS OWN shortPath from the test file, since that's what it operates on), which
        // reads as "a completely different, unrelated file is now being processed" rather than "the
        // fix specialist is working on the same file." Mirrors regenerateFile's identical
        // regenOnStatus wrapper (fix-loop.ts) for the exact same brief-flash/wrong-file-shown problem.
        const fixOnStatus = onStatus
            ? (state) => {
                if (state.phase === 'passed' || state.phase === 'failed') {
                    onStatus('file' in state ? { ...state, file: shortPath } : state);
                }
                else {
                    onStatus({ phase: 'fixing', file: shortPath });
                }
            }
            : undefined;
        const fixResult = await fixFile(context.suggestedTestFile, fixOptions, generator, fixOnStatus, projectMemory, precomputedFirstRun);
        if (fixResult.success) {
            const finalCode = await readFile(context.suggestedTestFile, 'utf-8');
            await recordFixMemory('success', finalCode);
            if (!onStatus)
                log(chalk.green(`  ✓ Fix specialist recovered ${rel}.`));
            return { success: true, testCode: finalCode, fixHandoffAttempted: true };
        }
        // fixFile already wrote back its own best-effort attempt (never worse than what we handed
        // it — see fixFile's own keep-best logic) and emitted its own 'failed' onStatus; fall
        // through to the standard failure return below.
        if (!onStatus)
            log(chalk.yellow(`  Fix specialist could not recover ${rel} either.`));
        return {
            success: false,
            error: `Tests still failing after generate's ${config.maxIterations} attempts AND a fix-specialist handoff. Last error:\n${lastError?.slice(0, 1500)}`,
            fixHandoffAttempted: true,
        };
    }
    return {
        success: false,
        error: `Tests still failing after ${config.maxIterations} attempts. Last error:\n${lastError?.slice(0, 1500)}`,
    };
}
async function restoreTestFile(testPath, original) {
    try {
        if (original !== null) {
            await writeFile(testPath, original, 'utf-8');
        }
        else {
            await unlink(testPath);
        }
    }
    catch { /* best-effort */ }
}
// Prefix a per-file error with the source file it belongs to, so the summary
// names which target failed instead of leaving a bare stack/patch error.
function tagFileError(filePath, cwd, error) {
    const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
    return `${rel}\n${error}`;
}
async function runWorkerPool(gaps, options, workerCount, projectMemory) {
    const tips = getActiveTips({
        workers: workerCount,
        targetFile: options.targetFile,
        verbose: options.verbose,
        dryRun: options.dryRun,
        fresh: options.fresh,
        model: options.config.model,
        threshold: options.config.threshold,
        mocksFile: options.config.mocksFile,
        ignore: options.config.ignore,
        command: 'generate',
    });
    const display = new WorkerDisplay(workerCount, gaps.length, tips);
    const queue = [...gaps];
    let filesProcessed = 0;
    let testsWritten = 0;
    let fixHandoffs = 0;
    let fixHandoffRecovered = 0;
    const errors = [];
    display.start();
    const workers = Array.from({ length: workerCount }, async (_, wi) => {
        const generator = new TestGenerator({
            config: options.config,
            env: options.env,
            cwd: options.cwd,
            // suppress token streaming in parallel mode — display is the UI
        });
        while (true) {
            if (options.shouldContinue && !options.shouldContinue())
                break;
            const gap = queue.shift();
            if (!gap)
                break;
            const onStatus = (state) => { display.update(wi, state); options.onStatus?.(state); };
            const result = await processGap(gap, { ...options, log: () => { }, verbose: false }, generator, true, onStatus, projectMemory);
            filesProcessed++;
            if (result.fixHandoffAttempted) {
                fixHandoffs++;
                if (result.success)
                    fixHandoffRecovered++;
            }
            if (result.success)
                testsWritten++;
            else if (result.error)
                errors.push(tagFileError(gap.filePath, options.cwd, result.error));
        }
    });
    await Promise.all(workers);
    display.finish();
    return { filesProcessed, testsWritten, errors, fixHandoffs, fixHandoffRecovered };
}
// Coverage report is considered fresh for 10 minutes — lets `analyze` then `generate` share one run.
const COVERAGE_CACHE_TTL_S = 600;
export async function runAgentLoop(options) {
    const { config, env, cwd, log } = options;
    // Apply configured test-env vars (e.g. MONGO_URL) into process.env before any test run — the
    // spawned runner inherits it. Here in the shared loop (not only the CLI commands) so the embedded
    // extension path, which calls runAgentLoop directly and skips the command layer, honors "testEnv"
    // too. Idempotent with the CLI's own assignment.
    if (config.testEnv)
        Object.assign(process.env, config.testEnv);
    const workerCount = Math.max(1, Math.min(options.workers ?? 1, 10));
    const parallel = workerCount > 1;
    // Proactively check + fix the shared mocks file(s) before generating/verifying any test file —
    // see mocks-fix.ts for the rationale (same reasoning as fix-loop.ts's identical call).
    await fixMocksFilesUpfront(config, env, cwd, { dryRun: options.dryRun, log });
    // ─── Single-file fast path ────────────────────────────────────────────────────
    // Skip the coverage suite entirely. Build a synthetic gap that treats the whole
    // file as uncovered — the AI reads the source and writes comprehensive tests.
    // Uses fileTestCommand (not the full suite) to verify the generated tests pass.
    // With @diff, --file instead NARROWS the diff scope to that file (handled below) —
    // the fast path is skipped because diff mode needs the coverage report.
    if (options.targetFile) {
        const abs = options.targetFile.startsWith('/')
            ? options.targetFile
            : join(cwd, options.targetFile);
        // Fail fast if the user passed a test file instead of a source file (both modes).
        const isTestPath = /\.(test|spec)\.[jt]sx?$/.test(abs)
            || abs.includes('__tests__/')
            || /\/test_[^/]+\.[jt]sx?$/.test(abs)
            || abs.endsWith('_test.go');
        if (isTestPath) {
            throw new Error(`"${options.targetFile}" looks like a test file, not a source file.\n` +
                `Pass the source file you want tests generated for.\n` +
                `Example: lacuna generate --file ${options.targetFile.replace(/__tests__\//, '').replace(/\.(test|spec)(\.[jt]sx?)$/, '$2')}`);
        }
        if (options.diffRef === undefined) {
            const gap = {
                filePath: abs,
                uncoveredLines: [],
                uncoveredFunctions: [],
            };
            const memory = new ProjectMemory();
            await memory.initialize(cwd, env, config);
            const generator = new TestGenerator({ config, env, cwd });
            const result = await processGap(gap, options, generator, true, options.onStatus, memory.toPromptSection());
            return {
                filesProcessed: 1,
                testsWritten: result.success ? 1 : 0,
                coverageBefore: 0,
                coverageAfter: 0,
                hasCoverage: false,
                errors: result.error ? [result.error] : [],
                ...(result.fixHandoffAttempted ? { fixHandoffs: 1, fixHandoffRecovered: result.success ? 1 : 0 } : {}),
            };
        }
    }
    // ─── Full suite path ──────────────────────────────────────────────────────────
    // Scope/improve setup. `scopeDir` (absolute) restricts discovery + the coverage run to a
    // subtree; it also implies improve-existing (raise every file under the dir to threshold,
    // creating OR extending tests). `--improve` enables the same create+improve repo-wide.
    const scopeDir = options.scopeDir;
    const scopeRel = scopeDir ? scopeDir.replace(cwd + '/', '').replace(/\/+$/, '') : undefined;
    // Diff (patch-coverage) scope: resolve base + changed lines up front so an unresolvable
    // base fails fast (before a long coverage run) and a docs-only diff exits cleanly without
    // running the suite at all.
    const diffMode = options.diffRef !== undefined;
    let diffScope = null;
    if (diffMode) {
        diffScope = await resolveDiffScope(cwd, options.diffRef || undefined);
        // `--file` + @diff = the intersection: only that file's changed lines are targets
        // (and patch coverage is measured over just those lines).
        if (options.targetFile) {
            const absTarget = options.targetFile.startsWith('/') ? options.targetFile : join(cwd, options.targetFile);
            const kept = diffScope.changed.get(absTarget);
            diffScope = { ...diffScope, changed: kept ? new Map([[absTarget, kept]]) : new Map() };
        }
        // `<dir>` + @diff = the intersection: only the changed lines inside the directory are
        // targets (and patch coverage is measured over just those lines).
        if (scopeDir)
            diffScope = scopeDiffToDir(diffScope, scopeDir);
        if (diffScope.changed.size === 0) {
            const where = options.targetFile ? `in ${options.targetFile}` : scopeRel ? `under ${scopeRel}` : 'in the diff';
            log(chalk.green(`\nNo changed source lines ${where} vs ${diffScope.baseRef} — nothing to cover.`));
            return {
                filesProcessed: 0, testsWritten: 0, coverageBefore: 0, coverageAfter: 0,
                hasCoverage: false, patchCoverageBefore: 100, patchCoverageAfter: 100,
                diffBase: diffScope.baseRef, errors: [],
            };
        }
    }
    const improveExisting = options.improve === true || !!scopeDir || diffMode;
    // Verify each file with its own file-scoped command (like single-file mode) whenever we're
    // improving — so we never run the whole suite per file and the keep-best-vs-baseline branch
    // applies to existing tests. Parallel mode already verifies per-file.
    const perFileVerify = improveExisting || parallel;
    // Pick the coverage command. Scoped (vitest/jest) keeps a dir-scoped run cheap; null → full
    // command + report post-filter. **Patch mode uses the FULL command, never a narrowed one**:
    // patch coverage must match what Codecov measured, and Codecov's number comes from the whole
    // CI suite. A narrowed run (`vitest related` / one dir) executes only a SUBSET of the tests
    // that cover the changed file — any line covered solely by a test outside that subset (an
    // integration/DI test that reaches the method indirectly) looks uncovered, so lacuna would
    // over-target lines Codecov shows green. The cheap path in patch mode is REUSING an existing
    // full report (below), not running a smaller one.
    // A monorepo scope directory can run a different runner than the repo-wide default (e.g. one
    // package still on Jest, another on Vitest) — resolve the scope's OWN runner from its package.json
    // / config file rather than trusting the global default for this scoped coverage command.
    const scopeEnv = (scopeDir && !diffMode) ? await resolveEnvForDir(env, scopeDir, cwd) : env;
    const scopedCmd = (scopeRel && !diffMode) ? scopedCoverageCommand(scopeEnv, scopeRel) : null;
    const coverageCommand = scopedCmd ?? env.coverageCommand;
    // The changed target file (relative), for the cheap diff-mode AFTER measurement only.
    const relTargetFile = diffMode && options.targetFile
        ? (options.targetFile.startsWith('/') ? options.targetFile.replace(cwd + '/', '') : options.targetFile)
        : undefined;
    const existingTests = await findTestFiles(cwd, {}, config, scopeDir);
    let hasTests = existingTests.length > 0;
    let report = { files: [], totalLineRate: 0, totalFunctionRate: 0 };
    if (!hasTests) {
        const where = scopeRel ? ` under ${scopeRel}` : '';
        log(chalk.dim(`  No test files yet${where} — scanning source files for coverage gaps.`));
    }
    else {
        // Scoped runs always run fresh: the time-cache holds a whole-repo report whose freshness
        // says nothing about this scope, and a scoped run rewrites lcov with scope-only data. Diff
        // mode is the exception even when scoped to a dir — it reuses the FULL report (below), so a
        // `@diff <dir>` run still reads the CI/test:cov report instantly instead of re-running.
        const ageSeconds = (scopeDir && !diffMode) ? null : await coverageAgeSeconds(config, cwd);
        // Patch mode INTERPRETS an existing coverage measurement (ideally the one CI uploaded to
        // Codecov), so any on-disk full report is reused regardless of age — only `--fresh` forces
        // a re-run. This is the fast path: point lacuna at the report your `test:cov`/CI produced
        // and it reads it instantly instead of re-running the suite. Non-diff runs keep the 10-min TTL.
        const useCached = !options.fresh && ageSeconds !== null && (diffMode || ageSeconds < COVERAGE_CACHE_TTL_S);
        if (useCached) {
            const freshness = ageSeconds < 90 ? `${Math.round(ageSeconds)}s old`
                : ageSeconds < 5400 ? `${Math.round(ageSeconds / 60)}m old`
                    : `${Math.round(ageSeconds / 3600)}h old`;
            const hint = diffMode
                ? `  Reusing existing coverage report (${freshness}). This must be a FULL-suite report (your test:cov / CI) to match Codecov. Pass --fresh to re-run.`
                : `  Using cached coverage report (${freshness}). Pass --fresh to re-run the suite.`;
            log(chalk.dim(hint));
        }
        else {
            if (diffMode) {
                log(chalk.yellow(`  No coverage report on disk — running the FULL suite to match Codecov's measurement (this can be slow).`));
                log(chalk.dim(`  Tip: run your coverage script once (e.g. npm run test:cov) or reuse the CI lcov, then re-run — lacuna will read it instantly.`));
            }
            // Diff mode runs the FULL suite even when scoped to a dir (coverageCommand is unscoped),
            // so don't imply a narrowed run in the label.
            const label = (scopeRel && !diffMode)
                ? `  Running tests under ${scopeRel} to collect coverage...`
                : '  Running test suite to collect coverage...';
            const spinner = startCoverageSpinner(chalk.dim(label), scopeEnv.testRunner);
            const coverageResult = await runCommand(coverageCommand, cwd, config.coverageTimeout * 1000, spinner.onLine, options.abortSignal);
            spinner.stop(coverageResult.stdout + coverageResult.stderr);
            if (coverageResult.timedOut) {
                throw new Error(`Test suite timed out after ${config.coverageTimeout}s.\n\n` +
                    `This usually means a test has an open handle (unclosed server, timer, or connection).\n` +
                    `Try running: ${env.testCommand} --reporter=verbose\n` +
                    `Or increase the timeout in .lacuna.json: { "coverageTimeout": ${config.coverageTimeout * 2} }`);
            }
            const coverageOutput = coverageResult.stdout + coverageResult.stderr;
            const configConflict = detectJestConfigConflict(coverageOutput);
            if (configConflict) {
                throw new Error(`Jest never ran any tests — no coverage report exists to read.\n\n${configConflict}`);
            }
            const validationError = detectJestValidationError(coverageOutput);
            if (validationError) {
                throw new Error(validationError);
            }
            if (/Tests:\s+0 total/i.test(coverageOutput)) {
                throw new Error(`Your test suites are failing before any tests run.\n\n` +
                    `This usually means a missing environment variable, broken import, or setup file error.\n` +
                    `Run: ${env.testCommand} 2>&1 | head -80\nto see the actual error.`);
            }
            // A fresh full-suite run that executed ZERO passing tests measured nothing. In @diff mode
            // that yields a PHANTOM "patch coverage before: 0%" — the changed lines look uncovered only
            // because the suite never ran them. Classic monorepo trap: `npx vitest run --coverage` from
            // the repo ROOT skips a package's prerequisites (a build step, or the config/env its
            // globalSetup needs), so it finishes in seconds with an empty report (v8: 0/0) or
            // "No test files found" — and still exits 0. Don't silently generate against a bogus
            // baseline; stop and point the user at reusing their real (CI/test:cov) coverage.
            if (diffMode && hasTests && parsePassCount(coverageOutput) === 0) {
                const setupErr = /Unhandled Error|Configuration property .*? is not defined|globalSetup\b|No test files found|Cannot find (?:module|package)/i.exec(coverageOutput);
                throw new Error(`The full-suite coverage run executed 0 tests — there is no coverage to measure the diff against.\n` +
                    (setupErr ? `The suite aborted before running: "${setupErr[0]}".\n` : '') +
                    `\nIn a monorepo, \`${coverageCommand}\` from the repo root often skips a package's\n` +
                    `prerequisites (a build step, or the config/env its globalSetup needs) and finishes fast\n` +
                    `with an empty report — so every changed line looks uncovered (a phantom 0%).\n\n` +
                    `Fix: reuse the coverage your CI or coverage script already produces — lacuna reads an\n` +
                    `existing full lcov instantly:\n` +
                    `  1. run your real coverage command once (it sets each package up correctly), then\n` +
                    `  2. re-run this WITHOUT --fresh so lacuna reuses that report.`);
            }
            // When ALL tests are failing (0 passed), the lcov data is unreliable —
            // failing tests still execute source lines, inflating coverage to 50–100%.
            // Fall back to source-file scanning so gaps are found correctly.
            // The user should run `lacuna fix` to repair failing tests afterward.
            if (parsePassCount(coverageOutput) === 0) {
                hasTests = false;
            }
        }
        if (hasTests) {
            try {
                report = await loadCoverage(config, cwd);
            }
            catch {
                throw new Error(`Could not read coverage report from ./${config.coverageDir}/`);
            }
        }
    }
    const coverageBefore = report.totalLineRate * 100;
    // includeExisting keeps below-threshold files that ALREADY have a test, so the loop extends
    // them instead of skipping — the create+improve behavior of a scoped/`--improve` run.
    // Diff mode ignores the per-file threshold entirely (101 keeps every file with any uncovered
    // line): a file at 94% overall can still have uncovered CHANGED lines — that's the exact
    // patch-coverage case this mode exists for.
    const gaps = await filterTestableGaps(extractGaps(report, diffMode ? 101 : config.threshold), config.ignore, { includeExisting: improveExisting, cwd });
    const untouchedFiles = await findUncoveredFiles(report, config.sourceDir, cwd, config.ignore, scopeDir);
    const existingPaths = new Set(gaps.map((g) => g.filePath));
    for (const g of untouchedFiles) {
        if (!existingPaths.has(g.filePath))
            gaps.push(g);
    }
    // Diff mode: keep only gaps in changed files, each narrowed to its changed-and-uncovered
    // lines. Patch coverage is measured over the same changed-line set; changed testable files
    // with no coverage entry count as fully uncovered (the untested-new-file case). A changed
    // file with an existing-but-unexecuted test file is in neither the report nor the gap set —
    // pull it in explicitly so its changed lines aren't silently counted as covered.
    let diffGaps = gaps;
    let patchCoverageBefore;
    if (diffScope) {
        gaps.push(...await missingChangedFileGaps(diffScope.changed, report, gaps, cwd, config.ignore));
        diffGaps = narrowGapsToDiff(gaps, diffScope.changed, report, cwd);
        patchCoverageBefore = computePatchCoverage(report, diffScope.changed, cwd, filesOutsideReport(diffGaps, report, cwd)).pct;
    }
    // Restrict to the scope subtree. extractGaps paths come from lcov (absolute OR relative), so
    // normalize before the prefix test; untouched files are already absolute and scope-walked.
    // Diff mode wins when both are set: diffScope.changed was already filtered to scopeDir, so
    // diffGaps is the directory-scoped, diff-narrowed set.
    const scopedGaps = diffScope
        ? diffGaps
        : scopeDir
            ? gaps.filter((g) => isWithinDir(g.filePath.startsWith('/') ? g.filePath : join(cwd, g.filePath), scopeDir))
            : gaps;
    if (scopedGaps.length === 0) {
        if (diffScope) {
            const pct = patchCoverageBefore ?? 100;
            log(chalk.green(`\nAll testable changed lines vs ${diffScope.baseRef} are already covered — nothing to generate.`));
            log(chalk.dim(`  Patch coverage: ${pct.toFixed(1)}%`));
            return {
                filesProcessed: 0, testsWritten: 0, coverageBefore, coverageAfter: coverageBefore,
                hasCoverage: true, patchCoverageBefore: pct, patchCoverageAfter: pct,
                diffBase: diffScope.baseRef, errors: [],
            };
        }
        const where = scopeRel ? ` under ${scopeRel}` : '';
        if (coverageBefore < config.threshold && !improveExisting) {
            log(chalk.yellow(`\n⚠ Coverage is ${coverageBefore.toFixed(1)}% — below the ${config.threshold}% threshold.`));
            log(chalk.dim('  Every source file already has a test file, so there is nothing new to generate.'));
            log(chalk.dim('  Run `lacuna fix` to repair the failing tests and raise coverage.'));
        }
        else if (scopeRel) {
            // Scoped run: coverageBefore is the WHOLE-project total, not this folder — so never claim
            // the folder "meets the threshold" off it (that reads as false when the global number is
            // low, exactly the confusing case). Per the coverage report, every file here is either
            // already at/above threshold or already has a test. If gaps were expected, the report's
            // file paths may not line up with this folder (monorepo/base-path mismatch) — `--verbose`
            // or the raw log shows which coverage command ran and what it reported.
            log(chalk.green(`\nNo files under ${scopeRel} need tests generated.`));
            log(chalk.dim(`  Per the coverage report, they already meet ${config.threshold}% or already have tests.`));
            log(chalk.dim(`  (Project-wide coverage is ${coverageBefore.toFixed(1)}% — that total spans the whole repo, not just ${scopeRel}.)`));
        }
        else {
            log(chalk.green(`\nAll files already meet the ${config.threshold}% threshold.`));
        }
        return { filesProcessed: 0, testsWritten: 0, coverageBefore, coverageAfter: coverageBefore, hasCoverage: true, errors: [] };
    }
    if (diffScope) {
        const targetLines = scopedGaps.reduce((n, g) => n + g.uncoveredLines.length, 0);
        log(chalk.bold(`\nFound ${scopedGaps.length} changed file(s) vs ${diffScope.baseRef} with uncovered changed lines (${targetLines} target line(s)).`));
        log(chalk.dim(`Patch coverage before: ${(patchCoverageBefore ?? 0).toFixed(1)}%`));
    }
    else {
        const scopeNote = scopeRel ? ` under ${scopeRel}` : '';
        log(chalk.bold(`\nFound ${scopedGaps.length} file(s)${scopeNote} below ${config.threshold}% threshold.`));
        log(chalk.dim(`Coverage before: ${coverageBefore.toFixed(1)}%`));
    }
    if (parallel) {
        if (options.verbose)
            log(chalk.dim(`  (--verbose is not shown in parallel mode — use --workers 1 to see the live code panel)`));
        log(chalk.dim(`\nWorkers: ${workerCount}\n`));
    }
    // Build project memory once — shared snapshot for all files in this run
    const memory = new ProjectMemory();
    await memory.initialize(cwd, env, config);
    const memorySnapshot = memory.toPromptSection();
    let filesProcessed;
    let testsWritten;
    let errors;
    let fixHandoffs = 0;
    let fixHandoffRecovered = 0;
    if (parallel) {
        ;
        ({ filesProcessed, testsWritten, errors, fixHandoffs, fixHandoffRecovered } = await runWorkerPool(scopedGaps, options, workerCount, memorySnapshot));
    }
    else {
        filesProcessed = 0;
        testsWritten = 0;
        errors = [];
        const generator = new TestGenerator({ config, env, cwd });
        const tips = getActiveTips({
            workers: 1,
            targetFile: options.targetFile,
            verbose: options.verbose,
            dryRun: options.dryRun,
            fresh: options.fresh,
            model: config.model,
            threshold: config.threshold,
            mocksFile: config.mocksFile,
            ignore: config.ignore,
            command: 'generate',
        });
        const nextTip = createTipRotator(tips);
        for (const gap of scopedGaps) {
            if (options.shouldContinue && !options.shouldContinue())
                break;
            const tip = nextTip();
            if (tip)
                log(formatTip(tip));
            const result = await processGap(gap, options, generator, perFileVerify, options.onStatus, memory.toPromptSection());
            filesProcessed++;
            if (result.fixHandoffAttempted) {
                fixHandoffs++;
                if (result.success)
                    fixHandoffRecovered++;
            }
            if (result.success) {
                testsWritten++;
                // Update memory so subsequent files learn from patterns in this one
                if (result.testCode) {
                    memory.recordSuccess(gap.filePath.replace(cwd + '/', ''), result.testCode);
                }
            }
            else if (result.error)
                errors.push(tagFileError(gap.filePath, cwd, result.error));
        }
    }
    // Final coverage measurement. The per-file runs that verified each generated test executed
    // WITHOUT coverage instrumentation — true for every parallel-worker run AND for scoped/improve
    // sequential runs (both use the file-scoped command). So coverage on disk is stale; re-run once
    // (scoped command when scoped) to get a real after-%. Classic unscoped sequential generate
    // already verified via the full suite and is left untouched (no extra pass for everyone).
    // DIFF MODE skips this: we do NOT re-run the whole suite for the after-number — see below.
    if (!options.dryRun && testsWritten > 0 && (parallel || perFileVerify) && !diffMode) {
        const measureLabel = scopeRel
            ? `\n  Measuring coverage under ${scopeRel}...`
            : '\n  Running full suite for final coverage measurement...';
        const finalSpinner = startCoverageSpinner(chalk.dim(measureLabel), env.testRunner);
        const finalCoverageResult = await runCommand(coverageCommand, cwd, config.coverageTimeout * 1000, finalSpinner.onLine, options.abortSignal);
        finalSpinner.stop(finalCoverageResult.stdout + finalCoverageResult.stderr);
    }
    // Only measure coverage after if at least one test was written — otherwise the failing
    // generated files execute source code and report misleading 100% coverage. (Diff mode keeps
    // the reused before-report on disk — the full re-run was skipped — so this reads that; the
    // overall % isn't the diff-mode gate anyway, patch coverage is.)
    const coverageAfter = (options.dryRun || testsWritten === 0) ? coverageBefore : await getCoverageRate(config, cwd);
    // Diff mode after-number, computed CHEAPLY: the accurate before-report already holds every
    // other test's coverage, so we only need the NEW test's incremental coverage of the changed
    // files. Run a narrow related/scoped pass (seconds), then UNION its hits with the before-report
    // — a line is covered-after if it was covered before OR the new test now covers it. (A narrow
    // run is safe as a union addend even though it was unsafe as a before REPLACEMENT.)
    let patchCoverageAfter = patchCoverageBefore;
    if (diffScope && !options.dryRun && testsWritten > 0) {
        let tmpCovDir = null;
        try {
            // Single changed target (`generate --file <src> @diff`): measure the NEW test's coverage by
            // running THAT test file under its own package, instrumenting only the changed source, with
            // the lcov forced into a temp dir we own. This actually executes the test (package setup/env)
            // and lands coverage where we read it — unlike `vitest related` from root, which balloons to
            // the whole suite and writes to the package's custom reportsDirectory. Falls back to the old
            // related/full run when we can't scope it (unsupported runner or the test file isn't found).
            const absTest = relTargetFile ? await findExistingTestFile(relTargetFile, cwd, config.sourceDir) : null;
            let covRun = null;
            if (absTest && relTargetFile) {
                tmpCovDir = await mkdtemp(join(tmpdir(), 'lacuna-cov-'));
                covRun = await resolveIncrementalCoverageRun(env, absTest, join(cwd, relTargetFile), cwd, tmpCovDir);
                if (!covRun) {
                    await rm(tmpCovDir, { recursive: true, force: true }).catch(() => { });
                    tmpCovDir = null;
                }
            }
            const spin = startCoverageSpinner(chalk.dim(relTargetFile
                ? `\n  Measuring new coverage of ${relTargetFile}...`
                : '\n  Measuring new patch coverage...'), env.testRunner);
            let incremental;
            if (covRun && tmpCovDir) {
                const covRunResult = await runCommand(covRun.command, covRun.cwd, config.coverageTimeout * 1000, spin.onLine, options.abortSignal);
                spin.stop(covRunResult.stdout + covRunResult.stderr);
                incremental = await parseLcov(tmpCovDir, '');
            }
            else {
                const afterCmd = relTargetFile
                    ? (relatedCoverageCommand(env, relTargetFile) ?? env.coverageCommand)
                    : env.coverageCommand;
                const afterResult = await runCommand(afterCmd, cwd, config.coverageTimeout * 1000, spin.onLine, options.abortSignal);
                spin.stop(afterResult.stdout + afterResult.stderr);
                incremental = await loadCoverage(config, cwd);
            }
            // Monorepo/workspace reports key files by the PACKAGE-relative path while the git diff keys
            // them by the repo-relative path — realign BOTH to the trusted changed-file paths (separately,
            // before merging, so their keys line up), else the new test's fresh hits never match the
            // changed lines and patch coverage stays frozen at 0%.
            const merged = mergeReportHits(alignReportToChanged(report, diffScope.changed, cwd), alignReportToChanged(incremental, diffScope.changed, cwd), cwd);
            patchCoverageAfter = computePatchCoverage(merged, diffScope.changed, cwd, filesOutsideReport(scopedGaps, merged, cwd)).pct;
        }
        catch { /* keep the before value */ }
        finally {
            if (tmpCovDir)
                await rm(tmpCovDir, { recursive: true, force: true }).catch(() => { });
        }
    }
    // In improve mode we deliberately do NOT chase the threshold with contrived tests (see the
    // "COVERAGE IS A MEANS, NOT THE GOAL" prompt rule). So landing below the threshold is an
    // expected, healthy outcome — surface it as intentional so the reporter's red "FAIL" line
    // isn't read as a defect. (Diff mode gates on patch coverage instead — skip the note.)
    if (!options.dryRun && testsWritten > 0 && improveExisting && !diffMode && coverageAfter < config.threshold) {
        log(chalk.dim(`\n  Note: coverage is ${coverageAfter.toFixed(1)}% (under the ${config.threshold}% threshold). The remaining uncovered lines are defensive/edge branches left uncovered by design — a contrived test there (impossible inputs, quirk assertions) would be worse than the gap. This is expected, not a failure.`));
    }
    if (fixHandoffs > 0) {
        log(chalk.dim(`\n  Fix specialist: ${fixHandoffRecovered}/${fixHandoffs} exhausted file(s) recovered after generate gave up.`));
    }
    return {
        filesProcessed, testsWritten, coverageBefore, coverageAfter, hasCoverage: true,
        ...(diffScope ? { patchCoverageBefore, patchCoverageAfter, diffBase: diffScope.baseRef } : {}),
        errors,
        fixHandoffs,
        fixHandoffRecovered,
    };
}
// Unions two coverage reports at the line level: a line is covered in the result if it was
// covered in EITHER input (hit = max of the two). Used for the diff-mode after-number so the
// accurate full before-report and the cheap incremental new-test run combine correctly. Only
// line hits matter for patch coverage; functions are carried from `base` unchanged.
function mergeReportHits(base, incr, cwd) {
    const abs = (p) => (p.startsWith('/') ? p : join(cwd, p));
    const byPath = new Map();
    for (const f of base.files)
        byPath.set(abs(f.path), { ...f, lines: f.lines.map((l) => ({ ...l })) });
    for (const f of incr.files) {
        const key = abs(f.path);
        const existing = byPath.get(key);
        if (!existing) {
            byPath.set(key, { ...f, lines: f.lines.map((l) => ({ ...l })) });
            continue;
        }
        const hitByLine = new Map(existing.lines.map((l) => [l.line, l.hit]));
        for (const l of f.lines)
            hitByLine.set(l.line, Math.max(hitByLine.get(l.line) ?? 0, l.hit));
        existing.lines = [...hitByLine].map(([line, hit]) => ({ line, hit }));
    }
    return { files: [...byPath.values()], totalLineRate: base.totalLineRate, totalFunctionRate: base.totalFunctionRate };
}
// Absolute paths of gap files that have NO entry in the coverage report — their changed
// lines are assumed fully uncovered for patch-coverage purposes (untested-new-file case).
function filesOutsideReport(gaps, report, cwd) {
    const reportPaths = new Set(report.files.map((f) => (f.path.startsWith('/') ? f.path : join(cwd, f.path))));
    const outside = new Set();
    for (const g of gaps) {
        const abs = g.filePath.startsWith('/') ? g.filePath : join(cwd, g.filePath);
        if (!reportPaths.has(abs))
            outside.add(abs);
    }
    return outside;
}
//# sourceMappingURL=loop.js.map