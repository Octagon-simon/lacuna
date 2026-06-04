import type { LacunaConfig } from '../lib/config.js'
import type { DetectedEnvironment } from '../lib/detector.js'
import type { ModelProvider, ChatMessage } from '../lib/providers/index.js'
import { createProvider } from '../lib/providers/index.js'
import { buildSystemPrompt, buildGeneratePrompt, buildFixPrompt, buildRetryPrompt, buildPollutionFixPrompt } from './prompts.js'
import type { FailedAttempt } from './prompts.js'
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

// Wraps a token callback so that <thinking> content is suppressed.
// Buffers silently until <code_output> is seen, then streams from there.
// Falls back to streaming everything if <code_output> never appears (e.g. non-XML response).
function codeOnlyStream(onToken: (t: string) => void): (t: string) => void {
  let buf = ''
  let streaming = false
  return (token: string) => {
    if (streaming) { onToken(token); return }
    buf += token
    const idx = buf.indexOf('<code_output>')
    if (idx !== -1) {
      streaming = true
      const after = buf.slice(idx + '<code_output>'.length)
      if (after) onToken(after)
      buf = ''
      return
    }
    // If no <code_output> after 3000 chars the model skipped the XML wrapper — flush and stream
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
  'Your previous output was cut off before the code was complete (unmatched braces or incomplete expression detected). ' +
  'Write a shorter, more focused test file. Cover the most important behaviors only — skip exhaustive edge cases if needed. ' +
  'Every function body must be closed.'

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
function parseStructuredResponse(raw: string): { hypothesis: string; code: string; truncated: boolean } {
  const thinkingMatch = raw.match(/<thinking>([\s\S]*?)<\/thinking>/i)
  const hypothesis = thinkingMatch ? thinkingMatch[1].trim() : ''

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
      const code = raw.slice(openEnd, openEnd + closeMatch.index).trim()
      return { hypothesis, code, truncated: isCodeIncomplete(code) }
    }
    // No closing tag — normal when stop sequence fires cleanly
    const code = raw.slice(openEnd).trim()
    return { hypothesis, code, truncated: isCodeIncomplete(code) }
  }

  // No XML tags — extract the last fenced code block if present.
  // Gemini and other models sometimes emit prose + multiple draft blocks before
  // settling on a final answer; the last block is the intended output.
  const fenceMatches = [...raw.matchAll(/```(?:typescript|tsx?|javascript|jsx?|python|go)?\s*\n([\s\S]*?)```/g)]
  if (fenceMatches.length > 0) {
    const code = fenceMatches[fenceMatches.length - 1][1].trim()
    return { hypothesis, code, truncated: isCodeIncomplete(code) }
  }
  // No fenced blocks at all — strip any single fence pair and use as code
  let fallback = raw.trim()
  fallback = fallback.replace(/^```(?:typescript|tsx?|javascript|jsx?|python|go)?\s*\n/, '')
  fallback = fallback.replace(/\n```\s*$/, '')
  const code = fallback.trim()
  return { hypothesis, code, truncated: isCodeIncomplete(code) }
}

export class TestGenerator {
  private provider: ModelProvider
  private env: DetectedEnvironment
  private rawOnToken?: (token: string) => void   // unwrapped callback; filter recreated per call
  private maxTokens: number
  private history: ChatMessage[] = []
  private lastHypothesis: string = ''
  private failedAttempts: FailedAttempt[] = []
  private previousCodes: string[] = []  // normalized codes from all attempts, for oscillation detection

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

  // Clears oscillation history so the next retry() call is treated as a fresh attempt.
  // Called by the fix/generate loop when giving one final escape-hatch attempt after
  // OscillationError fires but iterations remain.
  resetOscillationState() {
    this.previousCodes = []
  }

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
          reactMajorVersion: context.reactMajorVersion,
          projectMemory,
        }),
      },
    ]

    const response = await this.provider.generate(
      this.history,
      buildSystemPrompt(this.env),
      this.rawOnToken ? codeOnlyStream(this.rawOnToken) : undefined,
      this.maxTokens,
      GENERATE_TEMPERATURE,
    )
    const { hypothesis, code, truncated } = parseStructuredResponse(response)
    this.lastHypothesis = hypothesis
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
      this.rawOnToken ? codeOnlyStream(this.rawOnToken) : undefined,
      this.maxTokens,
      GENERATE_TEMPERATURE,
    )
    const { hypothesis, code, truncated } = parseStructuredResponse(response)
    this.lastHypothesis = hypothesis
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
      this.rawOnToken ? codeOnlyStream(this.rawOnToken) : undefined,
      this.maxTokens,
      RETRY_TEMPERATURE,
    )
    const { hypothesis, code, truncated } = parseStructuredResponse(response)
    this.lastHypothesis = hypothesis
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
      this.rawOnToken ? codeOnlyStream(this.rawOnToken) : undefined,
      this.maxTokens,
      RETRY_TEMPERATURE,
    )
    const { hypothesis, code, truncated } = parseStructuredResponse(response)
    this.lastHypothesis = hypothesis
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
