import { writeFile, appendFile, mkdir } from 'fs/promises';
import { basename, extname, dirname } from 'path';
import { createProvider } from '../lib/providers/index.js';
export { ModelStallError } from '../lib/providers/types.js';
import { buildSystemPrompt, buildGeneratePrompt, buildFixPrompt, buildRetryPrompt, buildPollutionFixPrompt, PATCH_MODE_LINE_THRESHOLD } from './prompts/index.js';
// When debug is enabled (config `debug: true` or the LACUNA_DEBUG env var), every raw model
// exchange is written to a per-file log. Each target file gets its own log (e.g.
// lacuna-debug.MessagingService.txt), cleared at the start of that file's generate()/fix() and
// appended through its retries — so parallel workers and multi-file runs never share/clobber
// one stream. The base is fixed; perFileDebugPath appends the target file name.
// Usage: LACUNA_DEBUG=1 lacuna generate   |   { "debug": true } in .lacuna.json
const DEFAULT_DEBUG_BASE = 'lacuna-debug.txt';
// Resolves the debug base path, or null when disabled. Debug is a simple on/off switch.
// Env var wins: any LACUNA_DEBUG value enables it (default base) except an explicit off
// (0/false/no/off). Otherwise config `debug: true` enables it; false/absent → off.
function resolveDebugBase(configDebug) {
    const env = process.env.LACUNA_DEBUG;
    if (env != null && env !== '')
        return /^(0|false|no|off)$/i.test(env) ? null : DEFAULT_DEBUG_BASE;
    return configDebug === true ? DEFAULT_DEBUG_BASE : null;
}
// User-facing pattern of where per-file debug logs are written, or null when disabled.
// e.g. "lacuna-debug.<file>.txt". Used by the command headers to surface debug state.
export function debugLogPattern(configDebug) {
    const base = resolveDebugBase(configDebug);
    if (!base)
        return null;
    const ext = extname(base);
    return `${ext ? base.slice(0, -ext.length) : base}.<file>${ext}`;
}
const SEP = '═'.repeat(72);
// Derives a per-file debug path from the configured base by inserting the target file's
// name before the extension: "lacuna-debug.txt" + "MessagingService.test.ts" →
// "lacuna-debug.MessagingService.txt". Returns null when debug is disabled.
function perFileDebugPath(base, filePath) {
    if (!base)
        return null;
    const slug = basename(filePath)
        .replace(/\.(test|spec)\.[jt]sx?$/, '')
        .replace(/\.[jt]sx?$/, '')
        .replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    const ext = extname(base);
    const baseNoExt = ext ? base.slice(0, -ext.length) : base;
    return `${baseNoExt}.${slug}${ext}`;
}
async function debugWrite(file, label, content, clear = false) {
    if (!file)
        return;
    const header = `\n${SEP}\n${label} — ${new Date().toISOString()}\n${SEP}\n`;
    try {
        if (clear) {
            await mkdir(dirname(file), { recursive: true }); // support a custom base in a subdir
            await writeFile(file, header + content + '\n', 'utf-8');
        }
        else {
            await appendFile(file, header + content + '\n', 'utf-8');
        }
    }
    catch { /* best-effort — never crash the agent for debug I/O */ }
}
// Thrown when the model's output was cut off before </code_output> was emitted.
// The partial code is attached so callers can include it in the retry message.
export class TruncatedOutputError extends Error {
    partialCode;
    constructor(partialCode) {
        super('Model output was truncated before the response was complete.');
        this.partialCode = partialCode;
        this.name = 'TruncatedOutputError';
    }
}
export class OscillationError extends Error {
    constructor() {
        super('Agent detected a loop — the generated code is identical to a previous attempt.');
        this.name = 'OscillationError';
    }
}
// Injected as the error message on the retry after oscillation is detected.
// Tells the model its last approach was a dead end and forces a different strategy.
export const OSCILLATION_ESCAPE_MESSAGE = 'STOP — you have generated IDENTICAL code to a previous attempt. Your current approach is not working.\n' +
    'Do NOT repeat the same structure, mock setup, or assertion style.\n' +
    'Try a completely different strategy:\n' +
    '  - Simplify drastically: fewer tests, focus only on the single most critical behavior\n' +
    '  - Different mock structure (e.g. mock at a higher level if sub-dependencies are causing issues)\n' +
    '  - If the component/hook is untestable in its current form, write one minimal smoke test that confirms it mounts/runs without throwing\n' +
    'ONE passing test is better than zero.';
const GENERATE_TEMPERATURE = 0.4; // some creativity to match existing patterns
const RETRY_TEMPERATURE = 0.1; // precise and deterministic when fixing errors
// Estimate output token budget from source line count.
// 2000 tokens reserved for the <thinking> block; ~40 tokens per source line covers
// ~2-3 generated test lines × ~15 tokens/line. Clamped between 4000 (floor for small
// files) and the user's configured ceiling.
function estimateMaxTokens(sourceCode, configMax) {
    if (!sourceCode)
        return configMax;
    const lines = (sourceCode.match(/\n/g) ?? []).length + 1;
    return Math.min(configMax, Math.max(4000, 2000 + lines * 40));
}
// Wraps a token callback so that <thinking> content is suppressed.
// Buffers silently until <code_output> or <code_patch> is seen, then streams from there.
// Falls back to streaming everything if neither tag appears (e.g. non-XML response).
function codeOnlyStream(onToken) {
    let buf = '';
    let streaming = false;
    return (token) => {
        if (streaming) {
            onToken(token);
            return;
        }
        buf += token;
        const outputIdx = buf.includes('<code_output>') ? buf.indexOf('<code_output>') : Infinity;
        const patchIdx = buf.includes('<code_patch>') ? buf.indexOf('<code_patch>') : Infinity;
        const idx = Math.min(outputIdx, patchIdx);
        if (idx < Infinity) {
            streaming = true;
            const marker = outputIdx <= patchIdx ? '<code_output>' : '<code_patch>';
            const after = buf.slice(idx + marker.length);
            if (after)
                onToken(after);
            buf = '';
            return;
        }
        // If no <code_output> or <code_patch> after 3000 chars the model skipped the XML wrapper — flush and stream
        if (buf.length > 3000) {
            streaming = true;
            onToken(buf);
            buf = '';
        }
    };
}
function normalizeCode(code) {
    return code.replace(/\s+/g, '');
}
const TRUNCATION_RETRY_MESSAGE = 'Your previous output produced no valid code — either it was cut off before completion, or your thinking block was not closed ' +
    'before writing code (a <thinking> block was detected but no code section followed). ' +
    'IMMEDIATELY write the code — do NOT plan in a <thinking> block this time. ' +
    'Keep it short and focused. Cover the most important behaviors only — skip exhaustive edge cases. ' +
    'Every function body must be closed. Write the code immediately in the required output format (the closing instruction below says which tag to use).';
// Detect a prose repetition loop: the model wrote the same planning sentence 3+ times
// without ever producing code. Only applied to the fallback path (no XML/fence tags).
function isRepetitionLoop(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 45);
    const seen = new Map();
    for (const line of lines) {
        const count = (seen.get(line) ?? 0) + 1;
        seen.set(line, count);
        if (count >= 3)
            return true;
    }
    return false;
}
// Detect syntactically incomplete code — a strong signal that output was cut off mid-generation.
function isCodeIncomplete(code) {
    if (!code.trim())
        return true;
    // Strip string literals to avoid false positives from braces inside strings
    const stripped = code
        .replace(/`(?:[^`\\]|\\.)*`/gs, '``')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''");
    // Unmatched opening braces (allow +1 tolerance for edge cases)
    const opens = (stripped.match(/\{/g) ?? []).length;
    const closes = (stripped.match(/\}/g) ?? []).length;
    if (opens > closes + 1)
        return true;
    // Last meaningful character suggests an incomplete expression
    const lastChar = code.trimEnd().slice(-1);
    if (',(=+-&|?:'.includes(lastChar))
        return true;
    return false;
}
// Parse the structured <thinking> + <code_output> response.
// The stop sequence </code_output> is registered with the API, so the closing tag
// is normally absent from the raw response — that is a clean stop, not truncation.
// True truncation (model hit max_tokens mid-code) is detected syntactically.
// Strip thinking-bleed artifacts: </thinking> or <thinking>...</thinking> blocks that
// leaked into the code output. The model occasionally forgets to close the thinking block
// before opening <code_output>, so the code starts with stray XML closing tags or prose.
function stripThinkingBleed(code) {
    // Claude uses <thinking>...</thinking>; DeepSeek R1 uses <think>...</think>.
    // Handle both tag names, plus unclosed variants where the model looped without finishing.
    let s = code;
    // Remove stray closing tags
    s = s.replace(/^\s*<\/(thinking|think)>\s*/i, '');
    // Remove complete blocks
    s = s.replace(/^\s*<(thinking|think)>[\s\S]*?<\/\1>\s*/i, '');
    // Remove unclosed blocks (model got stuck — no real code follows)
    s = s.replace(/^\s*<(thinking|think)>[\s\S]*/i, '');
    return s;
}
// Strip a stray markdown code fence wrapping the output. Despite being told not to, models
// sometimes add an opening ```lang and/or a closing ``` around <code_output>/<code_patch>
// content. Written verbatim, a trailing ``` becomes an "Unterminated string literal" at EOF
// and a leading one breaks line 1. Only a fence occupying its own line at the very start or
// end is removed, so backticks inside template literals or string assertions are untouched.
function stripCodeFences(code) {
    return code
        .replace(/^\s*```(?:[a-zA-Z0-9]+)?[ \t]*\n/, '') // leading ```lang line
        .replace(/\n[ \t]*```[ \t]*$/, '') // trailing ``` line
        .replace(/^\s*```[ \t]*$/, '') // degenerate: output is only a fence
        .trimEnd();
}
// Patch-operation header anchored at line start. Used to recognize patch output
// regardless of whether the model wrapped it in <code_patch> or — when nudged by the
// truncation retry message ("Use <code_output> tags") — inside <code_output>.
const PATCH_OP_RE = /^\/\/ @@@ (?:REPLACE_TEST|DELETE_TEST|ADD_AFTER_DESCRIBE|ADD_IMPORT|ADD_AFTER_IMPORTS|REPLACE):/m;
function parseStructuredResponse(raw) {
    const thinkingMatch = raw.match(/<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/i);
    const hypothesis = thinkingMatch ? thinkingMatch[1].trim() : '';
    // Check for <code_patch> FIRST — patch blocks are individually complete, skip truncation check.
    const lineAnchoredPatch = /(?:^|\n)<code_patch>[ \t]*(?:\n|$)/i;
    let patchMatch = lineAnchoredPatch.exec(raw);
    // Relaxed fallback: a real <code_patch> tag is sometimes glued to the end of a prose
    // sentence ("...replace it.<code_patch>\n// @@@ REPLACE_TEST: ...") when the model skips
    // the <thinking> wrapper and reasons in the open. Accept a non-line-anchored tag ONLY when
    // actual patch ops follow it — so prose mentions ("use <code_patch> tags") never match.
    if (!patchMatch) {
        const glued = /<code_patch>[ \t]*\n/i.exec(raw);
        if (glued && PATCH_OP_RE.test(raw.slice(glued.index + glued[0].length)))
            patchMatch = glued;
    }
    if (patchMatch) {
        const patchEnd = patchMatch.index + patchMatch[0].length;
        const code = stripCodeFences(stripThinkingBleed(raw.slice(patchEnd).trim()));
        return { hypothesis, code, truncated: false, isPatch: true };
    }
    // The real <code_output> delimiter is always on its own line (preceded by \n or start-of-string).
    // References to it inside planning text ("output in <code_output> tags") appear mid-sentence,
    // never on their own line. Use a line-anchored search to skip prose mentions entirely.
    const lineAnchoredOpen = /(?:^|\n)<code_output>[ \t]*(?:\n|$)/i;
    const lineAnchoredClose = /(?:^|\n)<\/code_output>[ \t]*(?:\n|$)/i;
    const openMatch = lineAnchoredOpen.exec(raw);
    if (openMatch) {
        const openEnd = openMatch.index + openMatch[0].length;
        // Closing tag is usually absent — the </code_output> stop sequence fires cleanly.
        const closeMatch = lineAnchoredClose.exec(raw.slice(openEnd));
        const code = stripCodeFences(stripThinkingBleed((closeMatch ? raw.slice(openEnd, openEnd + closeMatch.index) : raw.slice(openEnd)).trim()));
        // A model told to "use <code_output> tags" (notably by the truncation retry message)
        // may emit PATCH ops inside <code_output> rather than <code_patch>. Patch blocks are
        // individually complete and embed intentionally unbalanced code fragments as anchors,
        // so the full-file truncation check (isCodeIncomplete) would wrongly flag them as cut
        // off and loop forever. Detect patch ops and treat them exactly like a <code_patch> block.
        if (PATCH_OP_RE.test(code)) {
            return { hypothesis, code, truncated: false, isPatch: true };
        }
        return { hypothesis, code, truncated: isCodeIncomplete(code), isPatch: false };
    }
    // No XML tags — extract the last fenced code block if present.
    // Gemini and other models sometimes emit prose + multiple draft blocks before
    // settling on a final answer; the last block is the intended output.
    // After extracting, check whether the content looks like patch ops (// @@@ headers) —
    // models that skip <code_patch> tags but follow the @@@-format still get patch mode.
    //
    // IMPORTANT: skip fenced blocks when the entire response is inside an unclosed
    // <thinking> block.  DeepSeek sometimes quotes large test-file excerpts inside its
    // analysis using backtick fences; picking up the last one as "output" produces a code
    // snippet with no it() calls and fires a spurious "no tests" error.  When thinking is
    // unclosed, those fenced blocks are analysis, not code output — ignore them entirely.
    const hasOpenThinking = /<(?:thinking|think)>/i.test(raw);
    const hasCloseThinking = /<\/(?:thinking|think)>/i.test(raw);
    const thinkingIsUnclosed = hasOpenThinking && !hasCloseThinking;
    if (!thinkingIsUnclosed) {
        const fenceMatches = [...raw.matchAll(/```(?:typescript|tsx?|javascript|jsx?|python|go)?\s*\n([\s\S]*?)```/g)];
        if (fenceMatches.length > 0) {
            const code = stripThinkingBleed(fenceMatches[fenceMatches.length - 1][1].trim());
            const isPatch = PATCH_OP_RE.test(code);
            // Patches are individually complete — don't run the full-file truncation check on them.
            return { hypothesis, code, truncated: isPatch ? false : isCodeIncomplete(code), isPatch };
        }
    }
    // No fenced blocks at all — strip any single fence pair and use as code.
    // Also catch repetition loops: if the raw text has the same prose sentence 3+ times,
    // the model was looping instead of writing code — treat as truncated so the
    // TRUNCATION_RETRY_MESSAGE fires and forces immediate code output next turn.
    let fallback = raw.trim();
    fallback = fallback.replace(/^```(?:typescript|tsx?|javascript|jsx?|python|go)?\s*\n/, '');
    fallback = fallback.replace(/\n```\s*$/, '');
    let code = stripThinkingBleed(fallback.trim());
    // DeepSeek sometimes writes an unclosed <thinking> block and puts the entire patch
    // inside it without a <code_patch> delimiter.  stripThinkingBleed strips everything
    // after the opening tag, leaving an empty string.  Recover by scanning the raw
    // response for the first patch-op header and using everything from there onward.
    const PATCH_HEADER_RE = /\/\/ @@@ (?:REPLACE_TEST|DELETE_TEST|ADD_AFTER_DESCRIBE|ADD_IMPORT|ADD_AFTER_IMPORTS|REPLACE):/m;
    if (!code.trim() && PATCH_HEADER_RE.test(raw)) {
        const idx = raw.search(PATCH_HEADER_RE);
        code = raw.slice(idx).trim();
    }
    const isPatch = PATCH_HEADER_RE.test(code);
    // Patches are individually complete — only non-patch output can be syntactically truncated.
    return { hypothesis, code, truncated: isPatch ? false : (isCodeIncomplete(code) || isRepetitionLoop(raw)), isPatch };
}
export class TestGenerator {
    provider;
    env;
    rawOnToken; // unwrapped callback; filter recreated per call
    rawFirstTokenCallback;
    maxTokens;
    history = [];
    lastHypothesis = '';
    failedAttempts = [];
    previousCodes = []; // normalized codes from all attempts, for oscillation detection
    lastIsPatch = false;
    patchMode = false; // file is large enough to require <code_patch> mode — retries must stay in it
    reactish = false; // React/RN project — gates React-specific retry guidance
    debugFile; // configured base path (or null)
    activeDebugFile = null; // per-file path for the file currently being processed
    constructor(options) {
        this.provider = createProvider(options.config);
        this.env = options.env;
        this.rawOnToken = options.onToken;
        this.maxTokens = options.config.maxTokens ?? 16000;
        // Resolve the debug base from config.debug (boolean | string) and LACUNA_DEBUG (env wins).
        this.debugFile = resolveDebugBase(options.config.debug);
    }
    // Swap the token callback between files (e.g. to attach a StreamingFileViewer per file).
    // A fresh codeOnlyStream filter is created on every generate/fix/retry call anyway,
    // so calling this resets streaming state automatically.
    setTokenCallback(cb) {
        this.rawOnToken = cb;
    }
    // Register a one-shot callback that fires on the very first token of the next provider call.
    // Used by the loop to transition the worker display from 'waiting' to 'generating' as soon
    // as the model starts responding.
    setFirstTokenCallback(cb) {
        this.rawFirstTokenCallback = cb;
    }
    // Build a combined onToken handler that fires the first-token callback immediately (before
    // any codeOnlyStream filtering) and routes display tokens through codeOnlyStream as usual.
    buildOnToken() {
        const { rawOnToken, rawFirstTokenCallback } = this;
        if (!rawOnToken && !rawFirstTokenCallback)
            return undefined;
        const display = rawOnToken ? codeOnlyStream(rawOnToken) : undefined;
        let firstFired = false;
        return (token) => {
            if (!firstFired) {
                firstFired = true;
                rawFirstTokenCallback?.();
            }
            display?.(token);
        };
    }
    // Clears oscillation history so the next retry() call is treated as a fresh attempt.
    // Called by the fix/generate loop when giving one final escape-hatch attempt after
    // OscillationError fires but iterations remain.
    resetOscillationState() {
        this.previousCodes = [];
    }
    get isPatch() { return this.lastIsPatch; }
    async generate(context, gap, projectMemory) {
        this.lastHypothesis = '';
        this.failedAttempts = [];
        this.previousCodes = [];
        // Mirrors buildGeneratePrompt's patch-mode decision so retries stay in the same mode.
        this.patchMode = (context.existingTestCode?.split('\n').length ?? 0) > PATCH_MODE_LINE_THRESHOLD;
        this.reactish = context.reactMajorVersion != null;
        this.history = [
            {
                role: 'user',
                content: buildGeneratePrompt({
                    sourceFile: context.sourceFile,
                    sourceCode: context.sourceCode,
                    existingTestCode: context.existingTestCode,
                    uncoveredFunctions: gap.uncoveredFunctions,
                    uncoveredLines: gap.uncoveredLines,
                    env: this.env,
                    sourceImportPath: context.sourceImportPath,
                    mocksCode: context.mocksCode,
                    mocksImportPath: context.mocksImportPath,
                    setupFileCode: context.setupFileCode,
                    packageDeps: context.packageDeps,
                    tsconfigPaths: context.tsconfigPaths,
                    typeDefinitions: context.typeDefinitions,
                    localImportPaths: context.localImportPaths,
                    localImportContents: context.localImportContents,
                    reactMajorVersion: context.reactMajorVersion,
                    projectMemory,
                    existingTestLineCount: context.existingTestCode?.split('\n').length ?? 0,
                }),
            },
        ];
        const prompt = this.history[this.history.length - 1].content;
        this.activeDebugFile = perFileDebugPath(this.debugFile, context.sourceFile);
        await debugWrite(this.activeDebugFile, 'PROMPT (generate)', prompt, /* clear= */ true);
        const response = await this.provider.generate(this.history, buildSystemPrompt(this.env), this.buildOnToken(), estimateMaxTokens(context.sourceCode, this.maxTokens), GENERATE_TEMPERATURE);
        await debugWrite(this.activeDebugFile, 'RESPONSE (generate)', response);
        const { hypothesis, code, truncated, isPatch } = parseStructuredResponse(response);
        this.lastHypothesis = hypothesis;
        this.lastIsPatch = isPatch;
        this.previousCodes.push(normalizeCode(code));
        this.history.push({ role: 'assistant', content: response });
        if (truncated)
            throw new TruncatedOutputError(code);
        return code;
    }
    async fix(args) {
        this.lastHypothesis = '';
        this.failedAttempts = [];
        this.previousCodes = [];
        // Mirrors buildFixPrompt's patch-mode decision so retries stay in the same mode.
        this.patchMode = (args.existingTestLineCount ?? 0) > PATCH_MODE_LINE_THRESHOLD;
        this.reactish = args.reactMajorVersion != null;
        this.history = [{ role: 'user', content: buildFixPrompt(args) }];
        this.activeDebugFile = perFileDebugPath(this.debugFile, args.testFile);
        await debugWrite(this.activeDebugFile, 'PROMPT (fix)', this.history[0].content, /* clear= */ true);
        const response = await this.provider.generate(this.history, buildSystemPrompt(this.env), this.buildOnToken(), estimateMaxTokens(args.sourceCode, this.maxTokens), GENERATE_TEMPERATURE);
        await debugWrite(this.activeDebugFile, 'RESPONSE (fix)', response);
        const { hypothesis, code, truncated, isPatch } = parseStructuredResponse(response);
        this.lastHypothesis = hypothesis;
        this.lastIsPatch = isPatch;
        this.previousCodes.push(normalizeCode(code));
        this.history.push({ role: 'assistant', content: response });
        if (truncated)
            throw new TruncatedOutputError(code);
        return code;
    }
    async fixPollution(args) {
        this.lastHypothesis = '';
        this.failedAttempts = [];
        this.previousCodes = [];
        this.history = [{ role: 'user', content: buildPollutionFixPrompt(args) }];
        const response = await this.provider.generate(this.history, buildSystemPrompt(this.env), this.buildOnToken(), this.maxTokens, RETRY_TEMPERATURE);
        const { hypothesis, code, truncated, isPatch } = parseStructuredResponse(response);
        this.lastHypothesis = hypothesis;
        this.lastIsPatch = isPatch;
        this.previousCodes.push(normalizeCode(code));
        this.history.push({ role: 'assistant', content: response });
        if (truncated)
            throw new TruncatedOutputError(code);
        return code;
    }
    async retry(failureOutput) {
        // Record what the previous attempt planned and why it failed
        this.failedAttempts.push({
            attemptNumber: this.failedAttempts.length + 1,
            hypothesis: this.lastHypothesis,
            failureReason: failureOutput,
        });
        // Trim history to: original prompt + latest code + new retry message
        // This keeps memory flat regardless of iteration count.
        const original = this.history[0];
        let latestCode;
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (this.history[i].role === 'assistant') {
                latestCode = this.history[i];
                break;
            }
        }
        this.history = latestCode && latestCode !== original
            ? [original, latestCode]
            : [original];
        this.history.push({
            role: 'user',
            content: buildRetryPrompt(failureOutput, this.failedAttempts, this.patchMode, this.reactish),
        });
        await debugWrite(this.activeDebugFile, `PROMPT (retry ${this.failedAttempts.length})`, this.history[this.history.length - 1].content);
        const response = await this.provider.generate(this.history, buildSystemPrompt(this.env), this.buildOnToken(), this.maxTokens, RETRY_TEMPERATURE);
        await debugWrite(this.activeDebugFile, `RESPONSE (retry ${this.failedAttempts.length})`, response);
        const { hypothesis, code, truncated, isPatch } = parseStructuredResponse(response);
        this.lastHypothesis = hypothesis;
        this.lastIsPatch = isPatch;
        this.history.push({ role: 'assistant', content: response });
        if (truncated)
            throw new TruncatedOutputError(code);
        // Oscillation check: if this code is identical to any prior attempt, break early
        const norm = normalizeCode(code);
        if (this.previousCodes.includes(norm))
            throw new OscillationError();
        this.previousCodes.push(norm);
        return code;
    }
}
export { TRUNCATION_RETRY_MESSAGE };
//# sourceMappingURL=generator.js.map