import type { LacunaConfig } from '../lib/config.js'
import type { DetectedEnvironment } from '../lib/detector.js'
import type { ModelProvider, ChatMessage } from '../lib/providers/index.js'
import { createProvider } from '../lib/providers/index.js'
export { ModelStallError } from '../lib/providers/types.js'
import { buildSystemPrompt, buildGeneratePrompt, buildFixPrompt, buildRetryPrompt, buildPollutionFixPrompt } from './prompts/index.js'
import type { FailedAttempt } from './prompts/index.js'
import type { FileContext } from './context.js'
import type { CoverageGap } from '../lib/coverage/types.js'

// Thrown when the model's output was cut off before </code_output> was emitted.
// The partial code is attached so callers can include it in the retry message.
export class TruncatedOutputError extends Error {
  constructor(public readonly partialCode: string) {
    super('Model output was truncated before the response was complete.')
    this.name = 'TruncatedOutputError'
  }
}

export class OscillationError extends Error {
  constructor() {
    super('Agent detected a loop — the generated code is identical to a previous attempt.')
    this.name = 'OscillationError'
  }
}

// Injected as the error message on the retry after oscillation is detected.
// Tells the model its last approach was a dead end and forces a different strategy.
export const OSCILLATION_ESCAPE_MESSAGE =
  'STOP — you have generated IDENTICAL code to a previous attempt. Your current approach is not working.\n' +
  'Do NOT repeat the same structure, mock setup, or assertion style.\n' +
  'Try a completely different strategy:\n' +
  '  - Simplify drastically: fewer tests, focus only on the single most critical behavior\n' +
  '  - Different mock structure (e.g. mock at a higher level if sub-dependencies are causing issues)\n' +
  '  - If the component/hook is untestable in its current form, write one minimal smoke test that confirms it mounts/runs without throwing\n' +
  'ONE passing test is better than zero.'

const GENERATE_TEMPERATURE = 0.4  // some creativity to match existing patterns
const RETRY_TEMPERATURE = 0.1     // precise and deterministic when fixing errors

// Estimate output token budget from source line count.
// 2000 tokens reserved for the <thinking> block; ~40 tokens per source line covers
// ~2-3 generated test lines × ~15 tokens/line. Clamped between 4000 (floor for small
// files) and the user's configured ceiling.
function estimateMaxTokens(sourceCode: string | null | undefined, configMax: number): number {
  if (!sourceCode) return configMax
  const lines = (sourceCode.match(/\n/g) ?? []).length + 1
  return Math.min(configMax, Math.max(4000, 2000 + lines * 40))
}

// Wraps a token callback so that <thinking> content is suppressed.
// Buffers silently until <code_output> or <code_patch> is seen, then streams from there.
// Falls back to streaming everything if neither tag appears (e.g. non-XML response).
function codeOnlyStream(onToken: (t: string) => void): (t: string) => void {
  let buf = ''
  let streaming = false
  return (token: string) => {
    if (streaming) { onToken(token); return }
    buf += token
    const outputIdx = buf.includes('<code_output>') ? buf.indexOf('<code_output>') : Infinity
    const patchIdx = buf.includes('<code_patch>') ? buf.indexOf('<code_patch>') : Infinity
    const idx = Math.min(outputIdx, patchIdx)
    if (idx < Infinity) {
      streaming = true
      const marker = outputIdx <= patchIdx ? '<code_output>' : '<code_patch>'
      const after = buf.slice(idx + marker.length)
      if (after) onToken(after)
      buf = ''
      return
    }
    // If no <code_output> or <code_patch> after 3000 chars the model skipped the XML wrapper — flush and stream
    if (buf.length > 3000) { streaming = true; onToken(buf); buf = '' }
  }
}

function normalizeCode(code: string): string {
  return code.replace(/\s+/g, '')
}

export interface GeneratorOptions {
  config: LacunaConfig
  env: DetectedEnvironment
  onToken?: (token: string) => void
}

const TRUNCATION_RETRY_MESSAGE =
  'Your previous output produced no valid code — either it was cut off before completion, or your thinking block was not closed ' +
  'before writing code (a <thinking> block was detected but no <code_output> section followed). ' +
  'IMMEDIATELY write the code — do NOT plan in a <thinking> block this time. ' +
  'Write a short, focused test file. Cover the most important behaviors only — skip exhaustive edge cases. ' +
  'Every function body must be closed. Use <code_output> tags.'

// Detect a prose repetition loop: the model wrote the same planning sentence 3+ times
// without ever producing code. Only applied to the fallback path (no XML/fence tags).
function isRepetitionLoop(text: string): boolean {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 45)
  const seen = new Map<string, number>()
  for (const line of lines) {
    const count = (seen.get(line) ?? 0) + 1
    seen.set(line, count)
    if (count >= 3) return true
  }
  return false
}

// Detect syntactically incomplete code — a strong signal that output was cut off mid-generation.
function isCodeIncomplete(code: string): boolean {
  if (!code.trim()) return true

  // Strip string literals to avoid false positives from braces inside strings
  const stripped = code
    .replace(/`(?:[^`\\]|\\.)*`/gs, '``')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")

  // Unmatched opening braces (allow +1 tolerance for edge cases)
  const opens = (stripped.match(/\{/g) ?? []).length
  const closes = (stripped.match(/\}/g) ?? []).length
  if (opens > closes + 1) return true

  // Last meaningful character suggests an incomplete expression
  const lastChar = code.trimEnd().slice(-1)
  if (',(=+-&|?:'.includes(lastChar)) return true

  return false
}

// Parse the structured <thinking> + <code_output> response.
// The stop sequence </code_output> is registered with the API, so the closing tag
// is normally absent from the raw response — that is a clean stop, not truncation.
// True truncation (model hit max_tokens mid-code) is detected syntactically.
// Strip thinking-bleed artifacts: </thinking> or <thinking>...</thinking> blocks that
// leaked into the code output. The model occasionally forgets to close the thinking block
// before opening <code_output>, so the code starts with stray XML closing tags or prose.
function stripThinkingBleed(code: string): string {
  // Claude uses <thinking>...</thinking>; DeepSeek R1 uses <think>...</think>.
  // Handle both tag names, plus unclosed variants where the model looped without finishing.
  let s = code
  // Remove stray closing tags
  s = s.replace(/^\s*<\/(thinking|think)>\s*/i, '')
  // Remove complete blocks
  s = s.replace(/^\s*<(thinking|think)>[\s\S]*?<\/\1>\s*/i, '')
  // Remove unclosed blocks (model got stuck — no real code follows)
  s = s.replace(/^\s*<(thinking|think)>[\s\S]*/i, '')
  return s
}

function parseStructuredResponse(raw: string): { hypothesis: string; code: string; truncated: boolean; isPatch: boolean } {
  const thinkingMatch = raw.match(/<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/i)
  const hypothesis = thinkingMatch ? thinkingMatch[1].trim() : ''

  // Check for <code_patch> FIRST — patch blocks are individually complete, skip truncation check.
  const lineAnchoredPatch = /(?:^|\n)<code_patch>[ \t]*(?:\n|$)/i
  const patchMatch = lineAnchoredPatch.exec(raw)
  if (patchMatch) {
    const patchEnd = patchMatch.index + patchMatch[0].length
    const code = stripThinkingBleed(raw.slice(patchEnd).trim())
    return { hypothesis, code, truncated: false, isPatch: true }
  }

  // The real <code_output> delimiter is always on its own line (preceded by \n or start-of-string).
  // References to it inside planning text ("output in <code_output> tags") appear mid-sentence,
  // never on their own line. Use a line-anchored search to skip prose mentions entirely.
  const lineAnchoredOpen = /(?:^|\n)<code_output>[ \t]*(?:\n|$)/i
  const lineAnchoredClose = /(?:^|\n)<\/code_output>[ \t]*(?:\n|$)/i

  const openMatch = lineAnchoredOpen.exec(raw)
  if (openMatch) {
    const openEnd = openMatch.index + openMatch[0].length
    const closeMatch = lineAnchoredClose.exec(raw.slice(openEnd))
    if (closeMatch) {
      const code = stripThinkingBleed(raw.slice(openEnd, openEnd + closeMatch.index).trim())
      return { hypothesis, code, truncated: isCodeIncomplete(code), isPatch: false }
    }
    // No closing tag — normal when stop sequence fires cleanly
    const code = stripThinkingBleed(raw.slice(openEnd).trim())
    return { hypothesis, code, truncated: isCodeIncomplete(code), isPatch: false }
  }

  // No XML tags — extract the last fenced code block if present.
  // Gemini and other models sometimes emit prose + multiple draft blocks before
  // settling on a final answer; the last block is the intended output.
  // After extracting, check whether the content looks like patch ops (// @@@ headers) —
  // models that skip <code_patch> tags but follow the @@@-format still get patch mode.
  const fenceMatches = [...raw.matchAll(/```(?:typescript|tsx?|javascript|jsx?|python|go)?\s*\n([\s\S]*?)```/g)]
  if (fenceMatches.length > 0) {
    const code = stripThinkingBleed(fenceMatches[fenceMatches.length - 1][1].trim())
    const isPatch = /^\/\/ @@@ (REPLACE_TEST|DELETE_TEST|ADD_AFTER_DESCRIBE|ADD_IMPORT|ADD_AFTER_IMPORTS|REPLACE):/m.test(code)
    return { hypothesis, code, truncated: isCodeIncomplete(code), isPatch }
  }
  // No fenced blocks at all — strip any single fence pair and use as code.
  // Also catch repetition loops: if the raw text has the same prose sentence 3+ times,
  // the model was looping instead of writing code — treat as truncated so the
  // TRUNCATION_RETRY_MESSAGE fires and forces immediate code output next turn.
  let fallback = raw.trim()
  fallback = fallback.replace(/^```(?:typescript|tsx?|javascript|jsx?|python|go)?\s*\n/, '')
  fallback = fallback.replace(/\n```\s*$/, '')
  const code = stripThinkingBleed(fallback.trim())
  const isPatch = /^\/\/ @@@ (REPLACE_TEST|DELETE_TEST|ADD_AFTER_DESCRIBE|ADD_IMPORT|ADD_AFTER_IMPORTS|REPLACE):/m.test(code)
  return { hypothesis, code, truncated: isCodeIncomplete(code) || isRepetitionLoop(raw), isPatch }
}

export class TestGenerator {
  private provider: ModelProvider
  private env: DetectedEnvironment
  private rawOnToken?: (token: string) => void   // unwrapped callback; filter recreated per call
  private rawFirstTokenCallback?: () => void
  private maxTokens: number
  private history: ChatMessage[] = []
  private lastHypothesis: string = ''
  private failedAttempts: FailedAttempt[] = []
  private previousCodes: string[] = []  // normalized codes from all attempts, for oscillation detection
  private lastIsPatch = false

  constructor(options: GeneratorOptions) {
    this.provider = createProvider(options.config)
    this.env = options.env
    this.rawOnToken = options.onToken
    this.maxTokens = options.config.maxTokens ?? 16000
  }

  // Swap the token callback between files (e.g. to attach a StreamingFileViewer per file).
  // A fresh codeOnlyStream filter is created on every generate/fix/retry call anyway,
  // so calling this resets streaming state automatically.
  setTokenCallback(cb: ((token: string) => void) | undefined) {
    this.rawOnToken = cb
  }

  // Register a one-shot callback that fires on the very first token of the next provider call.
  // Used by the loop to transition the worker display from 'waiting' to 'generating' as soon
  // as the model starts responding.
  setFirstTokenCallback(cb: (() => void) | undefined) {
    this.rawFirstTokenCallback = cb
  }

  // Build a combined onToken handler that fires the first-token callback immediately (before
  // any codeOnlyStream filtering) and routes display tokens through codeOnlyStream as usual.
  private buildOnToken(): ((token: string) => void) | undefined {
    const { rawOnToken, rawFirstTokenCallback } = this
    if (!rawOnToken && !rawFirstTokenCallback) return undefined
    const display = rawOnToken ? codeOnlyStream(rawOnToken) : undefined
    let firstFired = false
    return (token: string) => {
      if (!firstFired) {
        firstFired = true
        rawFirstTokenCallback?.()
      }
      display?.(token)
    }
  }

  // Clears oscillation history so the next retry() call is treated as a fresh attempt.
  // Called by the fix/generate loop when giving one final escape-hatch attempt after
  // OscillationError fires but iterations remain.
  resetOscillationState() {
    this.previousCodes = []
  }

  get isPatch(): boolean { return this.lastIsPatch }

  async generate(context: FileContext, gap: CoverageGap, projectMemory?: string | null): Promise<string> {
    this.lastHypothesis = ''
    this.failedAttempts = []
    this.previousCodes = []

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
    ]

    const response = await this.provider.generate(
      this.history,
      buildSystemPrompt(this.env),
      this.buildOnToken(),
      estimateMaxTokens(context.sourceCode, this.maxTokens),
      GENERATE_TEMPERATURE,
    )
    const { hypothesis, code, truncated, isPatch } = parseStructuredResponse(response)
    this.lastHypothesis = hypothesis
    this.lastIsPatch = isPatch
    this.previousCodes.push(normalizeCode(code))
    this.history.push({ role: 'assistant', content: response })
    if (truncated) throw new TruncatedOutputError(code)
    return code
  }

  async fix(args: Parameters<typeof buildFixPrompt>[0]): Promise<string> {
    this.lastHypothesis = ''
    this.failedAttempts = []
    this.previousCodes = []

    this.history = [{ role: 'user', content: buildFixPrompt(args) }]
    const response = await this.provider.generate(
      this.history,
      buildSystemPrompt(this.env),
      this.buildOnToken(),
      estimateMaxTokens(args.sourceCode, this.maxTokens),
      GENERATE_TEMPERATURE,
    )
    const { hypothesis, code, truncated, isPatch } = parseStructuredResponse(response)
    this.lastHypothesis = hypothesis
    this.lastIsPatch = isPatch
    this.previousCodes.push(normalizeCode(code))
    this.history.push({ role: 'assistant', content: response })
    if (truncated) throw new TruncatedOutputError(code)
    return code
  }

  async fixPollution(args: Parameters<typeof buildPollutionFixPrompt>[0]): Promise<string> {
    this.lastHypothesis = ''
    this.failedAttempts = []
    this.previousCodes = []

    this.history = [{ role: 'user', content: buildPollutionFixPrompt(args) }]
    const response = await this.provider.generate(
      this.history,
      buildSystemPrompt(this.env),
      this.buildOnToken(),
      this.maxTokens,
      RETRY_TEMPERATURE,
    )
    const { hypothesis, code, truncated, isPatch } = parseStructuredResponse(response)
    this.lastHypothesis = hypothesis
    this.lastIsPatch = isPatch
    this.previousCodes.push(normalizeCode(code))
    this.history.push({ role: 'assistant', content: response })
    if (truncated) throw new TruncatedOutputError(code)
    return code
  }

  async retry(failureOutput: string): Promise<string> {
    // Record what the previous attempt planned and why it failed
    this.failedAttempts.push({
      attemptNumber: this.failedAttempts.length + 1,
      hypothesis: this.lastHypothesis,
      failureReason: failureOutput,
    })

    // Trim history to: original prompt + latest code + new retry message
    // This keeps memory flat regardless of iteration count.
    const original = this.history[0]
    let latestCode: ChatMessage | undefined
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === 'assistant') { latestCode = this.history[i]; break }
    }
    this.history = latestCode && latestCode !== original
      ? [original, latestCode]
      : [original]

    this.history.push({
      role: 'user',
      content: buildRetryPrompt(failureOutput, this.failedAttempts),
    })

    const response = await this.provider.generate(
      this.history,
      buildSystemPrompt(this.env),
      this.buildOnToken(),
      this.maxTokens,
      RETRY_TEMPERATURE,
    )
    const { hypothesis, code, truncated, isPatch } = parseStructuredResponse(response)
    this.lastHypothesis = hypothesis
    this.lastIsPatch = isPatch
    this.history.push({ role: 'assistant', content: response })
    if (truncated) throw new TruncatedOutputError(code)

    // Oscillation check: if this code is identical to any prior attempt, break early
    const norm = normalizeCode(code)
    if (this.previousCodes.includes(norm)) throw new OscillationError()
    this.previousCodes.push(norm)

    return code
  }
}

export { TRUNCATION_RETRY_MESSAGE }
