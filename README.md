# lacuna

**Agentic test coverage — finds gaps, writes tests, verifies they pass.**

Lacuna is a CLI tool that uses AI to analyze your codebase, identify untested code, generate meaningful tests, run them, and retry if they fail — all in one command.

```bash
lacuna generate
```

---

## How it works

```
lacuna analyze / lacuna generate            lacuna fix
  │                                           │
  ├── 1. Collect coverage                     ├── 1. Find failing files
  │     ├── If report is < 10 min old:        │     ├── --file: run that file only (fast)
  │     │     reuse cached report             │     ├── No --file + cache < 5 min old: use cache
  │     └── Otherwise: run full suite         │     └── Otherwise: run full suite
  ├── 2. Find files below threshold           │
  │                                           └── For each failing test file:
  └── For each gap: (generate only)                 ├── Runs file alone → captures error output
        ├── Reads source + existing tests           ├── Reads the test file + its source file
        ├── Extracts used symbol definitions        ├── Reads imported type definitions
        │   (hook return shapes, service            ├── Reads tsconfig paths, deps, setup file
        │   method sigs, transitive types)          ├── Detects network mocking issues
        ├── Reads tsconfig paths, deps,             ├── AI reasons in <thinking>, writes fix
        │   and test setup file                     ├── Writes the fixed file
        ├── Sends full context to AI model          ├── ✅ Pass → next file
        ├── AI reasons then writes tests            └── ❌ Fail → records what failed,
        ├── Runs the tests                                       detects oscillation (stops early),
        ├── ✅ Pass → next file                                  retries with negative constraints
        └── ❌ Fail → records what failed,                       restores original on final failure
                      detects oscillation (stops early),
                      retries with negative constraints
                      restores original on final failure
```

---

## Install

```bash
npm install -g lacuna-cli
```

---

## Quick start

```bash
lacuna --version   # or -V
lacuna --help      # or -h

cd your-project
lacuna init        # interactive setup wizard — installs test runner if missing
lacuna analyze     # see what's uncovered (read-only)
lacuna generate    # AI fills the gaps
```

---

## Supported stacks

Lacuna's AI prompts are tuned for frameworks that have been field-tested. Runner support (coverage collection + test generation) exists for other languages, but prompt guidance quality will vary.

### Tested — works well

| Stack | Test runner | What's tuned |
|---|---|---|
| **TypeScript / JavaScript** (utilities, services, hooks) | Vitest, Jest | Hook return shape extraction, service method verification, TypeScript type-safety rules (`T[]` not `Array<T>`, no `as any` on mock shapes), mock structure (object vs factory), `jest.mocked()` / `vi.mocked()` pattern, factory hoisting rules |
| **React** | Vitest, Jest | RTL query hierarchy, `act()` async rules, loading state (unmounted vs disabled button), unhandled rejection handling, mock lifecycle (`mockResolvedValueOnce`), `findBy` over `waitFor` preference |
| **React Native** / Expo | Jest (`jest-expo`) | RNTL v14 async contract (`render()` + `fireEvent` must be awaited), infra mocks (Reanimated, AsyncStorage, safe area, vector icons), compound component factories, mock shape accuracy (hook destructure matching, service method names), dynamic text template resolution, toast vs screen text, icon-only button handling, `useFocusEffect` mocking, test cascade detection |
| **Next.js** | Vitest | Server/client boundary mocks, `next/navigation`, `next/headers`, `next/cache`, server actions, `'use client'`/`'use server'` directive detection |

### Supported — not yet field-tested

| Stack | Test runner | Status |
|---|---|---|
| Vue | Vitest | Runner works. `@testing-library/vue` guidance included. Field-testing pending. |
| Python | pytest | Runner + coverage detection works. AI prompt guidance is generic — framework-specific tuning (pytest-django, FastAPI, etc.) will be added once field-tested. |
| PHP | PHPUnit, Pest | Runner + coverage detection works. Framework-specific prompt tuning coming once field-tested. |

### Runner support only

Go, Ruby (RSpec), Rust (cargo test), C# (dotnet test), Java (Gradle / Maven), Swift — lacuna can run their suites and collect coverage, but AI prompt guidance is not yet tuned for these.

---

## Commands

### `lacuna init`
Interactive setup wizard. Configures your model, test runner, source directory, coverage threshold, and mock file. Creates `.lacuna.json` in your project root.

Works from any subdirectory — lacuna finds the project root automatically.

For **React** projects, `lacuna init` also:
- Installs `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, and `jsdom`
- Creates `vitest.config.ts` with `environment: 'jsdom'` and `restoreMocks: true` + `clearMocks: true`
- Creates a setup file with `@testing-library/jest-dom` and `beforeEach`/`afterEach` mock cleanup hooks

For **Next.js** projects, the setup is different — Next.js and plain React are not compatible:
- Installs the same testing-library packages but does **not** add `environment: 'jsdom'` to vitest config (Next.js manages its own environment)
- Adds `@/` alias (from your `tsconfig.json`) and a `server-only` stub alias to vitest config
- Creates a setup file with global `vi.mock()` calls for `next/navigation`, `next/headers`, `next/cache`, `next/image`, and `next/font` — these are Next.js-specific mocks that would crash a plain React project
- If test dependencies are found in `node_modules` but not declared in `package.json` (e.g. from a different branch), lacuna will prompt you to add them — undeclared deps break CI on a fresh checkout

```bash
lacuna init
```

### `lacuna analyze`
Runs your test suite, collects coverage, and prints which files and functions are below threshold. **Does not write any files.**

```bash
lacuna analyze
lacuna analyze --threshold 90
lacuna analyze --format json --output report.json
lacuna analyze --format markdown
```

### `lacuna generate`
The main command. Runs the full agent loop — analyzes gaps, writes tests, runs them, retries failures.

When `--file` is given, lacuna skips the coverage suite entirely and goes straight to the AI — no waiting for a full suite run. The generated tests are verified by running just that file. Use this to increase coverage on a specific file without touching the rest of the project.

If you ran `lacuna analyze` recently (within 10 minutes), `generate` will reuse the existing coverage report instead of running the suite again. Use `--fresh` to force a new run.

If all retries fail, the original test file is restored — your workspace is never left with a half-written file. If the model oscillates (produces the same code twice), the retry loop stops early rather than burning remaining iterations.

If a fix attempt breaks an import and causes the test runner to collect 0 tests, lacuna detects this and sends the model the original error alongside an explicit warning — so it knows it over-reached and what it was actually supposed to fix. The same applies if a fix reduces the number of passing tests: the model is told it caused a regression and shown what the baseline was.

```bash
lacuna generate
lacuna generate --file src/utils/math.ts   # target one file
lacuna generate --dry-run                  # preview without writing
lacuna generate --verbose                  # live code panel as model writes each file
lacuna generate --workers 4                # run 4 files in parallel
lacuna generate --fresh                    # force a new coverage run
lacuna generate --format json --output report.json
```

### `lacuna fix`
Finds all failing tests and repairs them using AI. Sends each failing file along with its error output and source code to the model, which surgically fixes what's broken and retries until it passes. If all fix retries fail, lacuna automatically deletes the broken test and regenerates it from the source file — a clean slate rather than another round of patchwork.

```bash
lacuna fix
lacuna fix --workers 4                     # fix 4 files in parallel
lacuna fix --file src/utils/math.test.ts   # fix a single test file (skips full suite run)
lacuna fix --dry-run                       # preview fixes without writing
lacuna fix --verbose                       # live code panel as model writes each fix
lacuna fix --fresh                         # re-run the suite even if cache is recent
lacuna fix --no-regenerate-on-failure      # disable the regen fallback (fix only, no delete)
lacuna fix --fix-polluters                 # also handle tests that pass alone but fail in suite
```

Unlike `lacuna generate`, which creates new tests, `lacuna fix` operates on existing failing tests and preserves all test logic where possible.

**Regeneration fallback (default on):** When fix retries are exhausted, lacuna deletes the test file and regenerates it from scratch using the generate path. This works better than continued repair for structurally broken tests — the AI starts with a clean conversation and full source context instead of carrying forward a chain of failed hypotheses. Use `--no-regenerate-on-failure` to disable this and get fix-only behaviour.

**Passing in isolation, failing in suite (`--fix-polluters`):** Some tests pass when run alone but fail in the full suite. `--fix-polluters` handles these in two phases: (1) bisect the test suite to find if another file is leaking state (e.g. an uncleaned mock or global), and fix the polluter; (2) if no polluter can be isolated (the test has an internal spy lifecycle bug), delete and regenerate the victim file directly.

If all retries fail or the model oscillates (identical output detected), the original file is restored automatically. If a fix attempt breaks an import or reduces passing tests, lacuna detects the regression and anchors the next retry to the original error.

When `--file` is given, lacuna skips the full suite and runs only the target file. Without `--file`, the failing-files list is cached for 30 minutes. After a fix run, the cache is updated to contain only the still-failing files — so re-running immediately picks up where the last run left off.

### `lacuna run`
Runs your test suite and reports coverage. No AI involved.

```bash
lacuna run
```

---

## Configuration — `.lacuna.json`

Created by `lacuna init`. All fields are optional with sensible defaults.

```json
{
  "provider": "openai-compatible",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "testRunner": "jest",
  "coverageFormat": "lcov",
  "coverageDir": "coverage",
  "sourceDir": "src",
  "threshold": 80,
  "maxIterations": 3,
  "mocksFile": "src/test/mocks.ts",
  "setupFile": "src/test/setup.ts",
  "ignore": ["src/graphql/", "src/theme/"]
}
```

| Field | Default | Description |
|---|---|---|
| `provider` | `openai-compatible` | `anthropic` or `openai-compatible` |
| `model` | `deepseek-chat` | Model name |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Env var holding your API key |
| `baseURL` | `https://api.deepseek.com/v1` | API base URL — required for `openai-compatible` provider |
| `testRunner` | auto-detect | `jest` \| `vitest` \| `pytest` \| `mocha` \| `go-test` |
| `coverageFormat` | `lcov` | `lcov` \| `json-summary` |
| `coverageDir` | `coverage` | Where your test runner writes coverage |
| `sourceDir` | `"src"` | Source directory to scan. Accepts a string or an array — `["src", "lib", "utils"]` scans multiple directories |
| `threshold` | `80` | Minimum line coverage % to pass |
| `maxIterations` | `3` | How many times to retry a failing generated test |
| `coverageTimeout` | `300` | Seconds before the test suite is killed (prevents hanging on open handles) |
| `mocksFile` | — | Path to shared mock file (see Enterprise Mocks below) |
| `setupFile` | — | Path to your test setup file — lacuna passes its contents to the AI so it knows which globals and matchers are already available |
| `ignore` | `[]` | Extra path substrings to exclude from gap detection (e.g. `"src/graphql/"`) |
| `maxTokens` | `16000` | Maximum output tokens per model call. Lower this for providers with strict limits (Groq free tier: ~8000, Ollama: depends on model). Raise it if large test files are being cut off mid-generation. |

---

## Supported models

Lacuna works with any AI model — local or cloud.

| Preset | Model | API key env | Notes |
|---|---|---|---|
| **DeepSeek (default)** | `deepseek-chat` | `DEEPSEEK_API_KEY` | Best value — fast, cheap, no rate-limit issues |
| DeepSeek R1 | `deepseek-reasoner` | `DEEPSEEK_API_KEY` | Reasoning model |
| Claude Sonnet | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` | High quality |
| Claude Opus | `claude-opus-4-7` | `ANTHROPIC_API_KEY` | Most capable |
| DeepSeek R1 | `deepseek-reasoner` | `DEEPSEEK_API_KEY` | Reasoning model |
| GPT-4o | `gpt-4o` | `OPENAI_API_KEY` | |
| Groq | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Fast, free tier |
| Gemini 2.5 Pro | `gemini-2.5-pro` | `GEMINI_API_KEY` | Google's most capable |
| Gemini 2.5 Flash | `gemini-2.5-flash` | `GEMINI_API_KEY` | Fast & cheap |
| OpenRouter | any model | `OPENROUTER_API_KEY` | 100+ models, one key |
| Ollama | any local model | none | Fully local, free |
| LM Studio | any local model | none | Fully local, free |
| Custom | configurable | configurable | Any OpenAI-compatible API |

Switch models any time by re-running `lacuna init` or editing `.lacuna.json` directly.

---

## Enterprise mocks

For large codebases, ad-hoc mocks in every test file create maintenance nightmares. Lacuna supports a **shared mock file** — a single source of truth for all mocks that every generated test imports from.

### Setup

1. Create `src/test/mocks.ts`:

```ts
import { vi } from 'vitest'

// API clients
export const mockAxios = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}

// Router
export const mockNavigate = vi.fn()
export const mockUseNavigate = () => mockNavigate
vi.mock('react-router-dom', () => ({
  useNavigate: mockUseNavigate,
  useParams: vi.fn(() => ({})),
}))

// Auth
export const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  role: 'admin',
}
export const mockUseAuth = vi.fn(() => ({ user: mockUser, isLoading: false }))

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks()
})
```

2. Add `mocksFile` to `.lacuna.json`:

```json
{
  "mocksFile": "src/test/mocks.ts"
}
```

3. Run lacuna normally:

```bash
lacuna generate
```

Every generated test will import from `src/test/mocks.ts` instead of creating its own `vi.fn()` calls. If a test needs a mock that doesn't exist yet, lacuna will add it to the mocks file and import it — keeping everything centralized.

### How lacuna reads and updates the shared mock file

Lacuna parses your mock file before every prompt and builds a **mock inventory** — a structured table of every `vi.mock()` call, its line number, and all the keys it exports:

```
'react-router-dom'  → useNavigate, useParams
'axios'             → get, post, put, delete
```

This inventory is injected into every prompt so the AI knows exactly which modules are already mocked and what they export. When the AI needs to add a new export (e.g. a new API client method), it updates the **existing** `vi.mock()` block with the full list of old + new exports — never appending a second block for the same module.

**Structure rules the AI follows:**
- Module already in inventory → update the existing block (never a duplicate)
- New mock variable → declare near same-domain exports, reset in existing `beforeEach`
- New module → append at end before the final `beforeEach`

For fix prompts, the mock file is **compressed** before sending (multi-line React component stub bodies are collapsed to `vi.fn()`) to reduce token cost while preserving all `vi.mock()` blocks and factory functions. For generate prompts, only the inventory and exports list are sent — the raw file is skipped entirely since the AI only needs to know what to import, not re-read every implementation.

---

## CI / GitHub Actions

Add lacuna to your PR workflow to automatically generate tests and block merges below threshold.

Create `.github/workflows/lacuna.yml`:

```yaml
name: lacuna coverage

on:
  pull_request:
    branches: [main]

jobs:
  coverage:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.head_ref }}
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci

      - name: Run lacuna
        id: lacuna
        uses: Octagon-simon/lacuna@v1
        continue-on-error: true         # allow commit step to run even if coverage is below threshold
        with:
          threshold: 80
          workers: 2                    # parallel workers — increase for larger repos
          model: deepseek               # default — cost-effective, no rate-limit issues
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}

      # Runs even when lacuna exits with code 1 (below threshold) so generated
      # tests are never lost. Skips the commit if nothing was written.
      - name: Commit generated tests
        if: steps.lacuna.outcome != 'cancelled'
        run: |
          git config user.name "lacuna[bot]"
          git config user.email "lacuna[bot]@users.noreply.github.com"
          git add -A
          git diff --staged --quiet || git commit -m "chore: lacuna — add generated tests"
          git push
```

On every PR lacuna will:
- Generate missing tests
- Post a coverage report as a PR comment (updated on each push, no spam)
- Block the merge if coverage stays below your threshold

### Switching models

Pass any lacuna model preset or full model name via the `model` input, along with the matching API key:

```yaml
# GPT-4o
with:
  model: gpt-4o
  openai-api-key: ${{ secrets.OPENAI_API_KEY }}

# Gemini 2.5 Pro
with:
  model: gemini
  gemini-api-key: ${{ secrets.GEMINI_API_KEY }}

# DeepSeek (cost-effective)
with:
  model: deepseek
  deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}

# Groq (free tier available)
with:
  model: groq
  groq-api-key: ${{ secrets.GROQ_API_KEY }}
```

---

## Output formats

All commands support `--format` and `--output`:

```bash
# Terminal (default)
lacuna analyze

# JSON — for scripts and CI pipelines
lacuna analyze --format json
lacuna generate --format json --output lacuna-report.json

# Markdown — for PR comments and docs
lacuna analyze --format markdown
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Pass — coverage meets threshold |
| `1` | Fail — coverage below threshold or some files could not be tested |
| `2` | Error — test runner failed, config issue, or zero tests generated |

---

## Contextual tips

While tests are generating, lacuna shows rotating tips in the terminal — hints about flags and config options you might not be using yet. Tips are context-aware: if you're already using a flag, its tip won't appear.

**Tips shown during `lacuna generate`:**
- Use `-w 4` (`--workers`) to process multiple files in parallel
- Use `-f src/utils/math.ts` (`--file`) to target a single file
- Use `--dry-run` to preview without writing files
- Use `-v` (`--verbose`) to watch a live code panel as the AI writes each test file
- Use `-m claude-opus-4-7` (`--model`) to switch to a more capable model
- Use `--fresh` to force a new coverage run instead of reusing a cached report
- Use `-t 90` (`--threshold`) to raise the coverage bar
- Use `--format json --output report.json` to export results
- Set `mocksFile` in `.lacuna.json` to share mocks across all generated tests
- Add paths to `ignore[]` in `.lacuna.json` to skip directories
- Run `lacuna fix` to repair failing tests
- Run `lacuna analyze` to inspect gaps without writing files
- Increase `coverageTimeout` in `.lacuna.json` if your suite is being killed
- Set `maxTokens` in `.lacuna.json` if tests are cut off mid-generation (lower for Groq/Ollama, raise for large files)

**Tips shown during `lacuna fix`** are the same, minus flags that `fix` doesn't support (`--threshold`, `--format`).

In parallel mode (`--workers`), tips rotate every ~5 seconds in the live worker display. In single-worker mode, a different tip appears before each file is processed.

---

## What gets skipped

Lacuna automatically skips files that have no testable runtime logic — no point generating tests for them.

**Skipped by directory name** (anywhere in the path):
`types/`, `constants/`, `assets/`, `images/`, `icons/`, `fonts/`, `styles/`, `generated/`, `__generated__/`, `mocks/`, `fixtures/`, `migrations/`, `i18n/`, `locales/`, `translations/`

**Skipped by file name pattern:**
`*.d.ts`, `*.test.*`, `*.spec.*`, `*.stories.*`, `*.config.*`, `*.mock.*`, `*.types.ts`, `*.constants.ts`, `*.enum.*`, `index.*`

**Skipped by content:** Even if a file doesn't match the patterns above, lacuna reads it and skips it if it contains no functions, arrow functions, or classes — i.e. only type/interface/enum/constant exports.

**Add your own exclusions** via `.lacuna.json`:

```json
{
  "ignore": ["src/graphql/", "src/theme/", "src/generated/"]
}
```

`ignore` entries are matched as path substrings — any file whose path contains the string is excluded.

---

## Test placement

Lacuna follows your project's existing conventions:

- If test files exist **next to source files** (co-located), new tests go there too
- Otherwise, tests go in `__tests__/` inside the same directory as the source file
- `__tests__/` is created automatically if it doesn't exist

---

## Project structure

```
lacuna/
├── src/
│   ├── commands/          # CLI commands (analyze, generate, fix, run, init)
│   ├── agent/             # AI agent loop
│   │   ├── loop.ts        # main generate → run → retry loop
│   │   ├── fix-loop.ts    # fix → run → retry loop for failing tests
│   │   ├── context.ts     # builds context for the AI (source + tests + mocks + type definitions)
│   │   ├── generator.ts   # calls the AI model, manages conversation history
│   │   └── prompts/       # prompt builders split by framework
│   │       ├── index.ts           # system prompt + generate/fix/retry prompt assembly
│   │       ├── react-native.ts    # RNTL v14 rules, infra mock guidance, error detectors
│   │       ├── nextjs.ts          # Next.js boundary analysis, server action mocks
│   │       ├── react.ts           # React web testing rules (act, RTL, timers)
│   │       └── vue.ts             # Vue testing guidance
│   ├── lib/
│   │   ├── config.ts      # cosmiconfig loader + zod schema
│   │   ├── detector.ts    # auto-detects test runner and language
│   │   ├── runner.ts      # spawns test commands, captures output
│   │   ├── reporter.ts    # terminal / JSON / markdown reporters
│   │   ├── skeleton.ts    # collapses already-covered function bodies to reduce prompt size
│   │   ├── extract-error.ts  # strips passing-test noise from runner output before retry
│   │   ├── validate.ts    # checks generated code has real test calls; detects regressions and broken imports in retry output
│   │   ├── streaming-viewer.ts  # live bordered code panel for --verbose mode (typewriter effect)
│   │   ├── typecheck.ts   # post-vitest tsc pass; retries if type errors found
│   │   ├── providers/     # AI provider abstraction
│   │   │   ├── anthropic.ts
│   │   │   ├── openai-compatible.ts
│   │   │   └── types.ts   # ModelProvider interface + presets
│   │   └── coverage/
│   │       ├── lcov.ts    # LCOV parser
│   │       ├── json.ts    # JSON summary parser
│   │       ├── gaps.ts    # gap extractor
│   │       └── types.ts   # shared coverage types
│   └── ci/
│       ├── comment.ts     # posts coverage report as GitHub PR comment
│       └── parse-outputs.ts  # sets GitHub Actions step outputs
├── app/                   # SaaS dashboard (Next.js + Postgres + Payaza)
├── action.yml             # GitHub Action definition
└── .github/workflows/
    └── example.yml        # example CI workflow to copy into your repo
```

---

## Contributing

Issues and PRs welcome. The codebase is TypeScript throughout.

```bash
git clone https://github.com/Octagon-simon/lacuna
cd lacuna
npm install
npm run build
npm link          # makes `lacuna` available globally from your local build
```

---

## License

MIT
