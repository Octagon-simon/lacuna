# lacuna — Project Map

> Read this file at the start of every session before touching any code.
> Update it whenever a file is added, removed, or its purpose meaningfully changes.

---

## What lacuna does

CLI tool that uses AI to close test coverage gaps. Three commands:
- `lacuna analyze` — read-only: runs coverage, shows gaps
- `lacuna generate` — generates new tests for untested/undertested source files
- `lacuna fix` — repairs existing failing tests without rewriting them

---

## Entry point

| File | Purpose |
|------|---------|
| `bin/run.js` | oclif CLI bootstrap — executed when user runs `lacuna` |
| `package.json` | bin → `./bin/run.js`, oclif config points to `dist/commands/` |

---

## Commands — `src/commands/`

Each is an oclif `Command` subclass. All flags are defined here.

| File | Command | What it does |
|------|---------|-------------|
| `analyze.ts` | `lacuna analyze` | Runs coverage suite, loads LCOV, calls `filterTestableGaps` + `findUncoveredFiles`, prints report. Flags: `--threshold`, `--format`, `--output`, `--verbose` |
| `generate.ts` | `lacuna generate` | Calls `runAgentLoop`. Flags: `--file`, `--dry-run`, `--verbose`, `--model`, `--threshold`, `--format`, `--output`, `--workers`, `--fresh`, `--report-to`, `--api-key` |
| `fix.ts` | `lacuna fix` | Calls `runFixLoop`. Flags: `--file`, `--dry-run`, `--verbose`, `--model`, `--workers`, `--fresh` |
| `init.ts` | `lacuna init` | Interactive wizard using `@inquirer/prompts`. Writes `.lacuna.json`. Detects runner, lists model presets |
| `run.ts` | `lacuna run` | Just runs the test suite and reports coverage. No AI. |

---

## Agent — `src/agent/`

The AI loop. Reads source files, calls the model, writes test files, retries on failure.

| File | Purpose |
|------|---------|
| `loop.ts` | `runAgentLoop()` — main generate loop. **Single-file fast path**: when `--file` is given, skips the coverage suite entirely and builds a synthetic `CoverageGap` (lineCoverage: 0, empty uncoveredLines/Functions). Passes `parallel=true` to `processGap` so it uses `fileTestCommand` (not the full suite) to verify the generated tests. Returns immediately after that one file. **Full suite path**: runs coverage suite (or reuses cached report if < 10 min old via `coverageAgeSeconds`). Finds gaps. In parallel mode: `runWorkerPool()` with `WorkerDisplay`. In sequential mode: iterates gaps with tip + memory update after each success. Builds `ProjectMemory` once before loop starts. **File restoration**: `processGap()` reads the pre-existing test file content before the retry loop (`originalTestContent`). On `OscillationError` or max-iterations failure, calls `restoreTestFile(testPath, original)`. **Regression detection**: stores `firstError` and `firstPassCount` from the first failed test run; subsequent failures use `buildStructureBrokenMessage` or `buildRegressionMessage`. **Verbose streaming**: in `--verbose` sequential mode, creates a `StreamingFileViewer` per attempt, calls `generator.setTokenCallback(t => viewer.append(t))`, then `viewer.start()` before and `viewer.stop()` after the generate/retry call (in a try/finally via the catch block path). Generator is created with no `onToken` — the viewer owns it entirely. |
| `fix-loop.ts` | `runFixLoop()` — fix loop. Discovery: if `--file` given, runs only that file (no full suite). Otherwise checks `.lacuna-fix-cache.json` (5-min TTL, bypassed by `--fresh`); if stale, runs full suite and saves result to cache. `fixFile()` runs the file alone to get focused error output, calls `generator.fix()`, retries with `generator.retry()`. Handles `TruncatedOutputError`, `OscillationError` (restores original file on both). On max-iterations failure, restores original file. Handles `// ---MOCKS_FILE---` separator. **Type definitions**: after reading `sourceCode`, calls `collectTypeDefinitions(sourceCode, sourceFilePath, cwd)` and passes result as `typeDefinitions` to `generator.fix()`. **Regression detection**: stores `initialErrorOutput` and `baselinePassCount` from the pre-fix run; uses `buildStructureBrokenMessage` / `buildRegressionMessage` on regression. **Verbose streaming**: same `StreamingFileViewer` pattern as `loop.ts` — viewer created per attempt, `setTokenCallback` wired, started/stopped around the fix/retry call. Parallel via `runFixWorkers()`. |
| `context.ts` | `buildFileContext()` — builds `FileContext` for a single source file: reads source, finds existing test file, computes suggested test path, computes `sourceImportPath` (relative import from test to source, no extension), reads mocks file (always computes `mocksImportPath` even if mocks file doesn't exist yet), reads setup file, reads `packageDeps`, `tsconfigPaths`, and `typeDefinitions`. Also exports: `buildFixFileContext(absTestPath, cwd, config?)` — lightweight context for fix-loop (no inferred paths, no spurious dir creation); `computeRelativeImport(fromFile, toFile)` — relative import path helper; `collectTypeDefinitions(sourceCode, absoluteSourcePath, cwd)` — BFS traversal of locally-imported files that extracts `interface`/`type`/`enum` declarations and returns them as a formatted string (see invariant). `readTsconfigAliases(cwd)` reads raw path aliases for import resolution. `resolveLocalImport` handles both relative paths and tsconfig aliases. `extractTypeDeclarations(code)` uses brace-depth tracking to extract only type-shaped declarations (not functions or classes). Caps: 10 files / 4000 chars. |
| `generator.ts` | `TestGenerator` class. Wraps the model provider. Methods: `generate(context, gap, projectMemory?)`, `fix(args)`, `retry(failureOutput)`, `setTokenCallback(cb)`. Maintains `history[]` for multi-turn retries. `parseStructuredResponse(raw)` extracts `<thinking>` (hypothesis) and `<code_output>` (code); uses `isCodeIncomplete()` (brace balance + last-char check) to detect mid-generation cutoff; throws `TruncatedOutputError` if truncated. `failedAttempts[]` accumulates `{ attemptNumber, hypothesis, failureReason }` across retries — injected as negative constraints via `buildRetryPrompt`. State resets on each `generate()` / `fix()` call. `retry()` trims `history[]` to `[original, latestCode, newError]`. `maxTokens` taken from `config.maxTokens` (default 16000), passed to every `provider.generate()` call. **Token streaming**: stores `rawOnToken` (unwrapped); each `generate()`/`fix()`/`retry()` call creates a fresh `codeOnlyStream(rawOnToken)` wrapper — this resets the filter state per call so `<thinking>` blocks from subsequent files cannot bleed through. `codeOnlyStream` buffers silently until `<code_output>` appears then streams from there; 3000-char fallback for non-XML responses. `setTokenCallback(cb)` swaps `rawOnToken` between files so callers can attach a per-file `StreamingFileViewer`. **Temperature**: `GENERATE_TEMPERATURE = 0.4` for `generate()`/`fix()`; `RETRY_TEMPERATURE = 0.1` for `retry()`. **Oscillation detection**: `previousCodes[]` stores `normalizeCode()` result of every attempt. On `retry()`, if the new code matches any previous, throws `OscillationError`. Exports `TruncatedOutputError`, `OscillationError`, `TRUNCATION_RETRY_MESSAGE`. |
| `prompts.ts` | All prompt builders. `buildSystemPrompt(env)` — senior QA engineer persona; rules 11–13 require `<thinking>` + `<code_output>` XML output structure; includes barrel-file vi.mock() guidance in common-failure list. `buildGeneratePrompt(args)` — includes projectMemory, deps, tsconfig, **TYPE DEFINITIONS** (if present: `interface`/`type`/`enum` declarations from imported files with instruction "use these exact shapes, do NOT invent properties or guess types"), setup file, mocks (with `parseMockExports` inventory), source skeleton + import path, existing tests, uncovered items, network mocking guidance. `buildFixPrompt(args)` — same TYPE DEFINITIONS section; repair-focused; adds `detectRealRequestInError` warning if error output shows a real HTTP call; adds `detectUnhandledRejection` warning if output shows an unhandled `mockRejectedValueOnce`; adds wrong-mock warning if test has `vi.mock('axios')` but source uses `axios.create()`. `buildRetryPrompt(failureOutput, failedAttempts?)` — prepends negative-constraint block listing past hypotheses and their failure reasons before the error output; also injects `detectRealRequestInError` and `detectUnhandledRejection` warnings; includes barrel-file mock miss in common causes. `parseMockExports(code)` — extracts exported names from mocks file. `analyzeNetworkDeps(sourceCode)` — detects axios/fetch usage and API module imports (directory and file-level patterns). `buildNetworkMockingGuidance(analysis, file)` — returns targeted mocking instructions. `detectRealRequestInError(errorOutput)` — scans for real URLs, 4xx/5xx status codes, ECONNREFUSED. `detectUnhandledRejection(errorOutput)` — scans for "Unhandled Rejection" / "Vitest caught N unhandled" + `mockRejectedValue` in the same output; returns fix guidance. Exports `FailedAttempt` interface. |
| `project-memory.ts` | `ProjectMemory` class. `initialize()` scans up to 5 existing test files (first 35 lines each) as style examples. `recordSuccess(file, code)` extracts import paths from newly written tests and appends to session observations. `toPromptSection()` returns formatted string injected into every prompt. In parallel mode: static snapshot only. In sequential: grows after each success. |

---

## Library — `src/lib/`

Pure utilities. No AI, no CLI.

| File | Purpose |
|------|---------|
| `config.ts` | `loadConfig()` — cosmiconfig loader. Zod schema with defaults. Config fields: `testRunner`, `coverageFormat`, `coverageDir` (default `coverage`), `sourceDir` (default `src`), `threshold` (80), `maxIterations` (3), `coverageTimeout` (300s), `maxTokens` (16000), `ignore[]`, `mocksFile`, `setupFile`, `provider`, `model`, `baseURL`, `apiKeyEnv`. `applyModelOverride(config, model)` — applies `-m` / `--model` flag. Checks PRESET by key first (e.g. `"gemini"`), then by preset model name (e.g. `"gemini-2.5-pro"`); if matched, applies full preset (provider, model, baseURL, apiKeyEnv) so the right endpoint is used. Falls back to setting only `config.model` for unknown model strings. Used by both `fix.ts` and `generate.ts`. |
| `detector.ts` | `detectEnvironment()` — reads `package.json` deps to auto-detect runner. `envForRunner()` — returns `DetectedEnvironment` for a named runner. `fileTestCommand()` — builds per-runner command to run a single test file (used by parallel workers to avoid racing on full suite). Supports: vitest, jest, mocha, pytest, go-test. |
| `runner.ts` | `runCommand(command, cwd, timeoutMs, onLine?)` — spawns shell command, streams stdout/stderr via `onLine` callback, kills process group with SIGKILL on timeout. Returns `RunResult { stdout, stderr, exitCode, success, timedOut? }`. Default timeout: 300s. |
| `reporter.ts` | `reportTerminal()`, `buildJsonReport()`, `buildMarkdownReport()`, `getExitCode()`. Accepts `ReportInput { type, threshold, analyze?, generate?, untouchedCount }`. Exit codes: 0=pass, 1=below threshold, 2=error. |
| `report-upload.ts` | `uploadReport(serverUrl, report, apiKey)` — POSTs `JsonReport` to a lacuna server. Used by `generate --report-to`. |
| `coverage-spinner.ts` | `startCoverageSpinner(label, runner)` — live terminal spinner during coverage run. Parses vitest/jest/pytest file lines from stdout, shows last 7 files with pass/fail icons. `stop()` collapses to summary line. Non-TTY fallback: plain lines. **Critical**: `rendered` counts `\n` chars in output string, NOT `lines.length`. |
| `typecheck.ts` | `typeCheckFile(absTestPath, cwd, env)` — runs `npx tsc --noEmit --skipLibCheck`, filters output to errors in the specific test file only (ignores pre-existing errors in other files). Returns null for non-TypeScript projects or when no errors found. Called in both `loop.ts` and `fix-loop.ts` after vitest passes — if type errors found, retries with the error message. |
| `skeleton.ts` | `buildSourceSkeleton(code, expandFunctions)` — for files > 80 lines, collapses non-target function bodies to `{ /* ... (N lines) */ }` while keeping imports, types, interfaces, and full implementations for `expandFunctions` (the uncovered ones). `shouldUseSkeleton(code)` — threshold check. Used in `prompts.ts` generate prompt (expands uncovered functions) and fix prompt (threshold 150, no expansion — signatures only). |
| `extract-error.ts` | `extractTestFailure(rawOutput)` — three-pass filter: (1) marks signal lines (failure markers, assertion errors, project-file stack frames, TS errors); (2) expands each signal line into a `[-2, +3]` context window; (2.5) **dynamic diff expansion** — for any included line immediately followed by `+/-` diff lines not yet in the window, extends the window through the contiguous diff block (cap: 40 lines). This preserves full JSON object diffs that Vitest/Jest can render as 20-30 line blocks. (3) builds output, deduplicates blanks, inserts separators between gaps. Strips `node_modules`, `node:internal`, and `@vitest/runner` frames. Falls back to raw slice if over-stripped. Used in both loops. |
| `validate.ts` | `hasTestFunctions(code)` — checks generated code contains `it()`/`test()` calls before writing. `enrichNoTestsError(output)` — replaces "0 tests / no tests" runner output with a structured explanation and required fix pattern. `isZeroTestsOutput(raw)` — detects "0 tests collected" in runner output at runtime (import-level failure). `parsePassCount(output)` — extracts "N passed" count from runner output. `buildStructureBrokenMessage(initialError, currentError)` — retry message for when a fix caused 0 tests to be collected; anchors model to original error + rules (don't touch imports, only fix the failing assertion). `buildRegressionMessage(initialError, currentError, baselinePass, currentPass)` — retry message for when a fix reduced the passing-test count; anchors model to original error + rules (don't touch passing tests). |
| `worker-display.ts` | `WorkerDisplay(workerCount, total, tips?)` — live ANSI display for parallel workers. Shows per-worker state (idle/generating/writing/running/retrying/passed/failed), progress bar, stats line (✓ N passed · ✗ N failed · N remaining), rotating tip line. Tip rotates every 62 ticks (≈5s at 80ms interval). **Same critical `rendered` counting rule as spinner.** |
| `streaming-viewer.ts` | `StreamingFileViewer(filename)` — live bordered panel that shows a test file being written token-by-token in `--verbose` mode. `start()` begins the 80ms redraw timer. `append(token)` accumulates content (timer picks it up on next tick). `stop()` clears the panel and resets. Shows last 12 lines of accumulated code in a scrolling bordered box with a blinking `▌` cursor at the end. Line count in footer grows in real time. Non-TTY fallback: streams tokens directly to stdout with a plain header. **Same `rendered` counting rule** as `WorkerDisplay` and `coverage-spinner`. |
| `tips.ts` | `getActiveTips(ctx)` — returns filtered tip strings based on `TipContext` (suppresses tips for flags already in use, tips irrelevant to current command). `createTipRotator(tips)` — returns closure that cycles tips. `formatTip(text)` — chalk-formatted tip line. 13 tips total covering all flags and config options. |

### `src/lib/coverage/`

| File | Purpose |
|------|---------|
| `types.ts` | `CoverageReport`, `FileCoverage`, `CoverageGap`, `LineCoverage`, `FunctionCoverage` interfaces |
| `lcov.ts` | `parseLcov(coverageDir, cwd)` — reads `{coverageDir}/lcov.info`, parses `SF:/DA:/FN:/FNDA:` records. Paths stored as-is from `SF:` field (may be absolute or relative). |
| `json.ts` | `parseJsonSummary(coverageDir, cwd)` — reads `{coverageDir}/coverage-summary.json` |
| `index.ts` | `loadCoverage(config, cwd)` — delegates to `parseLcov` or `parseJsonSummary`. `coverageAgeSeconds(config, cwd)` — returns seconds since coverage file was last written (used by generate to skip re-running if < 10 min old). |
| `gaps.ts` | Core gap detection. Key functions: `extractGaps(report, threshold)` — files below threshold from LCOV. `filterTestableGaps(gaps, userIgnore)` — filters by: user ignore list, `shouldIgnore()` (dirs + filename patterns), `testFileExists()` (skips if test already written), `hasTestableCode()` (content scan for functions/classes). `findUncoveredFiles(report, sourceDir, cwd, userIgnore)` — walks sourceDir, skips files in LCOV report (normalises relative LCOV paths to absolute before set lookup), skips if `testFileExists`, skips if no testable code. `findTestFiles(cwd, env, config)` — returns all test files in sourceDir (used by `ProjectMemory`). |

### `src/lib/providers/`

| File | Purpose |
|------|---------|
| `types.ts` | `ModelProvider` interface (`generate(messages, system, onToken?, maxTokens?, temperature?) → Promise<string>`), `ChatMessage`, `ProviderPreset`. `PRESETS` map: claude, claude-opus, deepseek, deepseek-r1, gpt-4o, groq, openrouter, ollama, lm-studio, gemini, gemini-flash, custom. |
| `anthropic.ts` | `AnthropicProvider` — uses `@anthropic-ai/sdk`. Streams tokens if `onToken` provided. `max_tokens` from param (default 16000). `stop_sequences: ['</code_output>']`. `temperature` passed as optional spread. Catches prompt-too-large errors (`prompt is too long` / `max_tokens.*exceed`) and re-throws a user-friendly message with remediation steps. |
| `openai-compatible.ts` | `OpenAICompatibleProvider` — uses `openai` SDK with custom `baseURL`. Covers DeepSeek, Groq, OpenRouter, Ollama, LM Studio, GPT-4o. `max_tokens` from param (default 16000). `stop: ['</code_output>']`. `temperature` optional spread. **Custom fetch override**: intercepts non-2xx responses, decodes gzip bodies (falls back to raw UTF-8 when `content-encoding: gzip` is a lie, as Gemini does), normalizes non-OpenAI error shapes (Google's `[{error:{code,message,status}}]` array → `{error:{message,type,code}}` object) so the SDK extracts a real error message instead of "(no body)". |
| `index.ts` | `createProvider(config)` — returns `AnthropicProvider` or `OpenAICompatibleProvider` based on `config.provider`. |

---

## CI — `src/ci/`

Runs inside GitHub Actions, not as CLI commands.

| File | Purpose |
|------|---------|
| `comment.ts` | Reads `lacuna-report.json`, builds markdown via `buildMarkdownReport()`, upserts a single PR comment (finds existing by `<!-- lacuna-coverage-report -->` marker, PATCHes if found, POSTs if not). Uses `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_PR_NUMBER` env vars. |
| `parse-outputs.ts` | Reads `lacuna-report.json`, writes `coverage-before`, `coverage-after`, `passed` to `GITHUB_OUTPUT` for use in workflow `if:` conditions. |

---

## App — `app/`

SaaS dashboard (Next.js). Separate from the CLI.

| Path | Purpose |
|------|---------|
| `app/src/app/api/checkout/route.ts` | Payaza checkout — POST to `/live/checkout/initialize`, returns `checkout_url` |
| `app/src/app/api/webhooks/payaza/route.ts` | Payaza webhook — HMAC-SHA512 verification, handles `charge.success` → upgrade plan, `subscription.cancelled` → downgrade |
| `app/src/app/dashboard/billing/page.tsx` | Billing UI — Pro/Enterprise plan cards, calls `/api/checkout`, shows success on `?success=1` |
| `app/prisma/schema.prisma` | Org model has `payazaCustomerId String?` |
| `app/.env.example` | `PAYAZA_SECRET_KEY`, `PAYAZA_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL` |

---

## Key data flows

### `lacuna generate` (sequential, single worker)
```
generate.ts
  → runAgentLoop (loop.ts)
      → coverageAgeSeconds → skip suite if fresh, else runCommand(coverageCommand)
      → loadCoverage → filterTestableGaps + findUncoveredFiles → gaps[]
      → ProjectMemory.initialize() → samples existing tests
      → for each gap:
          → formatTip() → log
          → processGap()
              → buildFileContext() → source, existing test, mocks, setup, deps, paths
              → generator.generate(context, gap, memory.toPromptSection())
                  → buildGeneratePrompt() → prompt with all context
                  → provider.generate() → model response
                  → stripCodeFences()
              → split // ---MOCKS_FILE--- if present → write mocks file
              → write test file
              → runCommand(testCommand) → pass? done. fail? generator.retry()
          → result.success → memory.recordSuccess() → update session patterns
```

### `lacuna fix` (sequential)
```
fix.ts
  → runFixLoop (fix-loop.ts)
      → if --file: run that file only → absTarget
        else:      check .lacuna-fix-cache.json (< 5 min) → use or run full suite + save cache
      → for each file:
          → formatTip() → log
          → fixFile()
              → runCommand(fileTestCommand) → focused error output
              → readFile(testFile) → testCode
              → findSourceFile() → sourceCode
              → buildFixFileContext() → ctx (mocks, setup, deps, paths)
              → generator.fix({ testCode, sourceCode, errorOutput, ...ctx })
                  → buildFixPrompt() → repair-focused prompt (+ network/mock warnings)
                  → provider.generate() → <thinking> + <code_output>
                  → parseStructuredResponse() → { hypothesis, code }
              → split // ---MOCKS_FILE--- if present → write mocks
              → write test file
              → runCommand(fileTestCommand) → pass? done.
                fail? → generator.retry(errorOutput)
                         → records failedAttempt { hypothesis, failureReason }
                         → buildRetryPrompt(error, failedAttempts) → negative constraints
                         → provider.generate()
              → TruncatedOutputError? → retry with shorter-output message
```

### Gap detection
```
LCOV report → extractGaps (below threshold)
           → filterTestableGaps:
               skip: userIgnore, shouldIgnore (dirs/patterns), testFileExists, !hasTestableCode

sourceDir walk → findUncoveredFiles:
               skip: shouldIgnore, coveredPaths (normalised abs paths), testFileExists, !hasTestableCode
```

---

## Important invariants / non-obvious decisions

- **`rendered` line counting**: Both `coverage-spinner.ts` and `worker-display.ts` count `\n` chars in the output string (`(out.match(/\n/g) ?? []).length`), NOT `lines.length`. This is because `['a', ''].join('\n')` = `'a\n'` (1 newline) but `length` = 2. Over-counting causes `\x1B[N]A` to overshoot and clear previous terminal output.

- **`mocksImportPath` always computed**: In `context.ts`, `mocksImportPath` is computed even when the mocks file doesn't exist yet. The prompt then tells the AI either "here's the file, use it" or "this file doesn't exist yet, create it via `// ---MOCKS_FILE---`". This ensures the AI always knows the expected path.

- **`sourceImportPath` always provided**: `buildFileContext` computes the exact relative import path from the test file to the source file (no extension, with `./` prefix if needed). The prompts include a `SOURCE FILE IMPORT PATH: use exactly '${path}'` line so the AI never guesses. `fix-loop.ts` computes this via `computeRelativeImport(absTestPath, sourceFilePath)` and passes it to `buildFixPrompt`.

- **Source skeleton**: For files > 80 lines (generate) or > 150 lines (fix), `buildSourceSkeleton` collapses function bodies the AI doesn't need. For generate, only the `uncoveredFunctions` from the gap are expanded. For fix, all bodies are collapsed to signatures — the AI derives which function matters from the test file. Reduces prompt size 60–80% on large files.

- **Smart error extraction**: `extractTestFailure` strips passing-test noise before feeding errors to the AI. Strips: `✓` lines, `PASS` lines, `RUN v4.x` header, timing footers, `node_modules` stack frames, consecutive blank lines. Keeps: failure markers, assertion errors (Expected/Received), project-file stack frames, TS errors. Falls back to raw output if it over-strips.

- **Retry history cap**: `generator.retry()` trims `history[]` to 3 messages before each retry: original prompt (all context) + latest code attempt + new error. Prevents the conversation from growing across retries and degrading model attention.

- **`runFixLoop` uses ProjectMemory**: Same as the generate loop — `ProjectMemory.initialize()` runs once before the parallel/sequential branch. Parallel passes a static `memorySnapshot`; sequential calls `memory.toPromptSection()` per file (but does not call `recordSuccess` since fix doesn't write new tests from scratch).

- **LCOV path normalisation**: LCOV `SF:` paths can be relative or absolute depending on the runner. `findUncoveredFiles` normalises them to absolute before building `coveredPaths` set. `filterTestableGaps` calls `testFileExists` directly on `gap.filePath` which works for both (relative paths use process.cwd() implicitly via `access`).

- **Coverage cache TTL**: `runAgentLoop` skips the coverage suite if the report file is < 600 seconds (10 min) old. Allows running `lacuna analyze` then `lacuna generate` without double-running the suite. Override with `--fresh`.

- **Parallel vs sequential test command**: Parallel workers call `fileTestCommand(env, file)` per file, not the full suite. This prevents workers from racing on suite-level state. A final full-suite run happens after all workers complete.

- **`// ---MOCKS_FILE---` separator**: Both `loop.ts` (generate) and `fix-loop.ts` (fix) split on this separator. Test file content goes before it, mocks file content after. Both write to `config.mocksFile`. Fix-loop was missing this handling — fixed.

- **`testFileExists` in `filterTestableGaps`**: LCOV-reported files below threshold that already have a test file are now excluded from gaps. Previously only `findUncoveredFiles` checked for existing tests; files that appeared in LCOV (even below threshold) would slip through.

- **`ProjectMemory` parallel vs sequential**: In parallel mode, all workers share the same static startup snapshot. No rolling updates (concurrent writes would be unsafe). In sequential mode, `memory.recordSuccess()` is called after each success, accumulating import patterns for subsequent files.

- **Unhandled rejection pattern**: AI is told in all three prompts (system, fix, retry) to always `await waitFor(...)` after actions that trigger `mockRejectedValueOnce` — the rejection must be resolved inside the test scope or Vitest flags it as unhandled even if the component catches it.

- **Thinking blocks + episodic memory**: System prompt rules 11–13 require all model output to use `<thinking>` + `<code_output>` XML structure. `parseStructuredResponse` extracts both. The hypothesis from `<thinking>` is stored as `lastHypothesis` in `TestGenerator`. On each `retry()`, the previous attempt's hypothesis + error are recorded as a `FailedAttempt` and injected into `buildRetryPrompt` as explicit negative constraints ("Do NOT repeat: Attempt 1 tried [X], failed with [Y]"). State resets on every `generate()` / `fix()` call. **Fallback for non-XML models (e.g. Gemini)**: if no `<code_output>` tag is found, `parseStructuredResponse` scans for all fenced code blocks and returns the LAST one — Gemini often emits prose + multiple draft blocks before the final answer, so the last block is correct. Only if no fenced blocks exist at all does it strip a single fence pair and use the raw response.

- **Truncation recovery**: If `<code_output>` is opened but never closed (model hit token limit mid-response), `parseStructuredResponse` returns `truncated: true` and the caller throws `TruncatedOutputError`. Both `loop.ts` and `fix-loop.ts` catch it specifically, log "Output truncated", and feed a retry message asking for a shorter, more focused file. `max_tokens` is 16000 on both providers to reduce truncation frequency.

- **Network mocking intelligence**: `analyzeNetworkDeps` scans source code for axios/fetch usage and API module imports (both directory-level `/services/` and file-level `/apiClient`). `buildNetworkMockingGuidance` generates targeted instructions — including the critical `axios.create()` caveat. `detectRealRequestInError` scans error output for real URLs, 4xx/5xx status codes, and `ECONNREFUSED`/`ENOTFOUND` — if detected, the fix prompt gets a `⚠️ REAL HTTP REQUEST DETECTED` block. `buildFixPrompt` also cross-checks `vi.mock('axios')` in test code against `axios.create()` in source and flags the incompatible combination explicitly.

- **Fix cache (TTL: 30 min)**: `runFixLoop` writes discovered failing files to `.lacuna-fix-cache.json` after a full suite run. After the fix loop completes, the cache is **overwritten with only the still-failing files** — so the next `lacuna fix` invocation resumes exactly where it left off without re-scanning the suite. If all files were fixed, `clearFixCache` deletes the file so the next run does a clean suite scan. Not used in `--file` mode or when `--fresh` is passed.

- **`maxTokens` and truncation recovery**: `config.maxTokens` (default 16000) is passed to every provider call. `isCodeIncomplete()` checks extracted code for unmatched braces and incomplete last characters to detect mid-generation cutoffs. When truncated, `TruncatedOutputError` is thrown and caught by both loops, which retry with `TRUNCATION_RETRY_MESSAGE` — explicitly telling the model it was cut off and to write fewer tests. For providers with lower caps (Groq free tier ~8k, Ollama depends on model), set `maxTokens` accordingly in `.lacuna.json`.

- **`codeOnlyStream` is stateful and must be created per API call**: `codeOnlyStream` wraps an `onToken` callback and buffers all output until it sees `<code_output>`, then streams from there. It carries a `streaming` boolean in its closure. If the same instance were reused across multiple `generate()`/`retry()` calls, the `streaming = true` flag from file 1 would persist to file 2, causing the second file's `<thinking>` block to stream to the terminal immediately. The fix: `TestGenerator` stores `rawOnToken` (unwrapped) and calls `codeOnlyStream(this.rawOnToken)` fresh inside each `generate()`, `fix()`, and `retry()` call. This resets the filter state automatically per invocation. `setTokenCallback` swaps `rawOnToken` between files.

- **Oscillation detection**: If the agent keeps generating identical code across retries (model stuck in a local minimum), `normalizeCode()` (strips all whitespace) + `previousCodes[]` catches the repeat immediately in `retry()`. `OscillationError` is thrown before writing the file or running tests — saving both API cost and a test run. Both loops log `"⚠ Agent loop detected"`, restore the workspace, and return failure without burning remaining iterations.

- **File state restoration**: Both loops read the pre-existing test file before entering the retry loop. On any terminal failure (max iterations exceeded or oscillation), the file is restored to its original content (or deleted if it was newly created). The workspace is never left with a half-written test file after a failed attempt.

- **Temperature control**: `GENERATE_TEMPERATURE = 0.4` on initial generation and `fix()` — enough creativity to match existing code patterns without wild invention. `RETRY_TEMPERATURE = 0.1` on all `retry()` calls — more deterministic, correct-rather-than-creative mode when the model is debugging a specific error. Both values are constants in `generator.ts`; only `generator.ts` is responsible for choosing temperature.

- **Regression detection in retry loops**: Both `loop.ts` and `fix-loop.ts` track a baseline error and pass-count from the first failed run. If a subsequent retry produces 0 tests collected (`isZeroTestsOutput`) — which happens when the model breaks an import — the next error message is `buildStructureBrokenMessage`, which quotes the original failing-test error and adds explicit rules (don't change imports, only fix the one failing assertion). If a retry reduces the number of passing tests, `buildRegressionMessage` anchors the model to the original error with "don't touch passing tests" constraints. Without this, the model loses sight of the original goal and iterates on a progressively worse problem.

- **Dynamic diff expansion**: Vitest/Jest can emit 20–30 line JSON object diffs after an assertion failure. `extractTestFailure`'s Pass 2.5 extends any included-line window through contiguous `+/-` diff lines (lines starting with `+ ` or `- `, or deeply-indented context lines) so the model sees the full diff rather than an arbitrary 3-line clip. The extension is capped at 40 lines to prevent runaway inclusion from pathological output.

- **Transitive type collection (BFS)**: `collectTypeDefinitions` in `context.ts` traverses the source file's imports and their imports recursively via BFS. This ensures types like `type User { name: NameProp }` where `NameProp` is defined in a separately-imported file are still visible to the AI. Each resolved file's `interface`/`type`/`enum` declarations are extracted using brace-depth tracking and included in the prompt under `TYPE DEFINITIONS`. Files with no type declarations are still enqueued so their own imports can be followed. The `visited` set prevents cycles. Hard caps (10 files, 4000 chars) keep prompt size bounded regardless of type-chain depth. The source file itself is pre-added to `visited` so it is never re-processed as a type file. `loop.ts` gets type definitions automatically via `buildFileContext()`; `fix-loop.ts` calls `collectTypeDefinitions` directly after reading the source file and passes the result to `generator.fix()`.
