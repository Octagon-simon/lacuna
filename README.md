# lacuna

> Find untested code, write tests for it, and verify they pass, in one command.

[![npm version](https://img.shields.io/npm/v/lacuna-cli.svg)](https://www.npmjs.com/package/lacuna-cli)
[![npm downloads](https://img.shields.io/npm/dm/lacuna-cli.svg)](https://www.npmjs.com/package/lacuna-cli)
[![Release](https://github.com/Octagon-simon/lacuna/actions/workflows/release.yml/badge.svg)](https://github.com/Octagon-simon/lacuna/actions/workflows/release.yml)
[![Node](https://img.shields.io/node/v/lacuna-cli.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/npm/l/lacuna-cli.svg)](#license)

Lacuna is a command-line tool that reads your code, finds the parts your tests don't cover, and writes tests to fill the gaps. It runs every test it writes and retries the ones that fail, so what lands in your repo actually passes.

It works with any OpenAI-compatible model (including local ones via Ollama or LM Studio), so you can run it without sending code to a hosted provider if you'd rather not.

```bash
$ lacuna generate
```

---

## Getting started

### 1. Install

```bash
$ npm install -g lacuna-cli
```

Requires Node 20 or newer.

### 2. Set an API key

Lacuna defaults to DeepSeek. Create a key at [platform.deepseek.com](https://platform.deepseek.com) and export it:

```bash
$ export DEEPSEEK_API_KEY=sk-...
```

Prefer a different model? See [Models](#models); every option, including free local ones, is listed there. You can pick one during `lacuna init`.

### 3. Configure your project

From your project root:

```bash
$ lacuna init
```

This is an interactive wizard. It detects your test runner, asks which model to use, and writes a `.lacuna.json`. For React, React Native, and Next.js projects it also installs the testing libraries and creates a working test config and setup file.

### 4. See what's untested

```bash
$ lacuna analyze
```

Read-only. It runs your suite, collects coverage, and lists the files and functions below your threshold. Nothing is written.

### 5. Generate the tests

```bash
$ lacuna generate
```

Lacuna writes tests for the gaps, runs them, and retries failures. When it finishes, the new tests are already passing.

To target a single file and skip the full coverage run:

```bash
$ lacuna generate --file src/utils/math.ts
```

That's the whole loop. The rest of this README is reference.

---

## How it works

```
lacuna generate                              lacuna fix
  │                                            │
  ├─ 1. Collect coverage                       ├─ 1. Find failing files
  │    ├─ report < 10 min old → reuse it       │    ├─ --file → that file only
  │    └─ otherwise → run the suite            │    ├─ cache < 30 min old → reuse it
  ├─ 2. Find files below threshold             │    └─ otherwise → run the suite
  │                                            │
  └─ For each gap:                             └─ For each failing file:
       ├─ Read source + existing tests              ├─ Run it alone, capture the error
       ├─ Extract used symbol definitions           ├─ Read the test + source + types
       │  (return shapes, method signatures)        ├─ Read tsconfig paths, deps, setup
       ├─ Read tsconfig paths, deps, setup          ├─ Model writes a surgical fix
       ├─ Send full context to the model            ├─ Pass → next file
       ├─ Run the generated tests                   └─ Fail → record it, detect loops,
       ├─ Pass → next file                                   retry, restore on giving up
       └─ Fail → retry with the error,
                 restore original if it can't
```

Two rules hold throughout: lacuna never leaves a half-written file behind, and it never removes passing tests. If it can't improve a file, it puts the original back.

This is the unit/integration layer. For browser-level tests, [`--e2e`](#end-to-end-testing-playwright) follows the same loop but targets routes instead of source files and verifies with a real browser run.

---

## Commands

### `lacuna init`

Sets up lacuna in your project. Detects the test runner, picks a model, and writes `.lacuna.json`. Run it from anywhere in the project; it finds the root on its own.

For React, it installs `@testing-library/react`, `jest-dom`, `user-event`, and `jsdom`, then writes a `vitest.config.ts` and setup file with mock cleanup hooks.

For Next.js it does the same but skips the `jsdom` environment (Next manages its own), adds your `@/` alias, and pre-mocks `next/navigation`, `next/headers`, `next/cache`, `next/image`, and `next/font`.

### `lacuna analyze`

Runs the suite, collects coverage, and reports what's below threshold. Writes nothing.

```bash
lacuna analyze
lacuna analyze --threshold 90
lacuna analyze --format json --output report.json
lacuna analyze --format markdown
```

### `lacuna generate`

The main command: find gaps, write tests, run them, retry failures.

```bash
lacuna generate
lacuna generate --file src/utils/math.ts   # one file, skips the coverage run
lacuna generate --dry-run                   # preview, write nothing
lacuna generate --verbose                   # live panel as the model writes
lacuna generate --workers 4                  # process 4 files in parallel
lacuna generate --fresh                      # ignore the cached coverage report
lacuna generate --format json --output report.json
lacuna generate --e2e                        # generate Playwright end-to-end specs (see below)
```

If you ran `analyze` in the last 10 minutes, `generate` reuses that report instead of running the suite again (`--fresh` forces a new run). When retries are exhausted, lacuna keeps the best attempt **only if it adds passing tests** and points you to `lacuna fix` for the rest; otherwise it restores the original. If the model produces the same output twice, the loop stops early instead of wasting iterations.

### `lacuna fix`

Finds failing tests and repairs them. Each failing file goes to the model with its error output and source; the model patches what's broken and lacuna reruns until it passes. A fix that makes the tests pass is kept even if minor type warnings remain. `fix` never reverts a working change.

```bash
lacuna fix
lacuna fix --file src/utils/math.test.ts    # one file, skips the full suite
lacuna fix --workers 4                       # 4 files in parallel
lacuna fix --types                           # repair files that pass but fail type-checking
lacuna fix --dry-run
lacuna fix --verbose
lacuna fix --fresh
lacuna fix --no-regenerate-on-failure        # don't fall back to regenerating
lacuna fix --fix-polluters                   # handle tests that pass alone but fail in the suite
lacuna fix --e2e                             # repair failing Playwright specs (see below)
```

A few behaviors worth knowing:

- **Regeneration fallback (on by default).** If repair is exhausted on a *genuinely broken* file (one with no passing tests to lose), lacuna deletes it and regenerates from source, since a clean start beats more patching. A file that already has passing tests is never deleted, and a regeneration that would lower the passing count is discarded. Turn it off with `--no-regenerate-on-failure`.
- **Type errors (`--types`).** Selects files by TypeScript errors instead of test failures: one project-wide `tsc` finds every test file that fails type-checking, even if its tests pass. It respects each file's governing `tsconfig`: if the nearest one disables `noImplicitAny` (common in monorepo packages), implicit-`any` isn't treated as an error.
- **Polluters (`--fix-polluters`).** For tests that pass alone but fail in the full suite, lacuna bisects the suite to find the file leaking state and fixes it; if none can be isolated, it regenerates the affected test.

Without `--file`, the failing-files list is cached for 30 minutes and trimmed to whatever's still failing after each run, so re-running picks up where you left off.

### `lacuna run`

Runs your suite and reports coverage. No model involved.

```bash
lacuna run
```

---

## End-to-end testing (Playwright)

Everything above writes unit and integration tests. With `--e2e`, lacuna instead works at the **browser** layer: it discovers your app's routes, drives a real browser to see what's actually on each page, and writes [Playwright](https://playwright.dev) specs that click and assert like a user.

Requirements: `@playwright/test` installed and a `playwright.config.ts` with a `webServer` block (so lacuna can start your app) and a `baseURL`. Route discovery currently supports **Next.js** (app and pages router) and **React Router**.

```bash
lacuna generate --e2e                  # discover routes, generate a spec for each
lacuna generate --e2e --route /login   # just one route
lacuna generate --e2e --workers 4      # generate in parallel
lacuna generate --e2e --dry-run        # list which routes would get specs (no app, no API call)
lacuna fix --e2e                       # repair failing Playwright specs
```

How generation works:

1. **Discover** the routes from your router (e.g. `app/login/page.tsx` → `/login`, or a `<Route path="/login">`).
2. **Snapshot** each page: lacuna starts your app once via the `webServer` config and captures the accessibility tree plus any `data-testid`s, so the model writes specs against the elements that are *really there*.
3. **Generate** one spec per route. Selectors follow a strict order: `getByRole`, `getByLabel`, `getByPlaceholder`, then `getByTestId` (only for testids actually present on the page, never invented), with `getByText` as a last resort. Brittle CSS, XPath, and arbitrary sleeps are forbidden; assertions are auto-waiting and validate the outcome of each action. Login redirects are detected and asserted rather than fabricated.
4. **Verify**: lacuna runs each spec, confirms it isn't flaky, and retries on failure. A spec that never goes green is removed rather than left broken.

If your project already uses `data-testid`s, lacuna picks them up from the snapshot and prefers them where a semantic locator isn't enough. It reads testids from your components but does not add them, it only touches test files.

Specs are written to your Playwright `testDir`. Routes that already have a spec are skipped, so re-running only fills the gaps. `--dry-run` is a free preview: it lists what would be generated without starting your app or calling the model.

**Repairing specs (`lacuna fix --e2e`).** When a spec breaks, lacuna captures a fresh snapshot of the page, then asks the model to diagnose the root cause (selector drift, a timing gap, an auth redirect, a removed feature) and apply the smallest fix that preserves what the test checks. It fixes selectors and synchronization rather than weakening or deleting assertions to force a pass.

---

## Configuration

`lacuna init` writes `.lacuna.json`. Every field is optional and has a sensible default.

The file includes a `$schema` line, so editors like VS Code give you key completion and inline docs as you type. To add it to an existing config, put this first:

```json
{
  "$schema": "https://raw.githubusercontent.com/Octagon-simon/lacuna/main/lacuna.schema.json"
}
```

A typical config:

```json
{
  "$schema": "https://raw.githubusercontent.com/Octagon-simon/lacuna/main/lacuna.schema.json",
  "provider": "openai-compatible",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "testRunner": "jest",
  "sourceDir": "src",
  "threshold": 80,
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
| `baseURL` | `https://api.deepseek.com/v1` | API base URL (required for `openai-compatible`) |
| `testRunner` | auto | `jest`, `vitest`, `pytest`, `mocha`, `go-test`, and more |
| `coverageFormat` | `lcov` | `lcov`, `json-summary`, or `cobertura` |
| `coverageDir` | `coverage` | Where your runner writes coverage |
| `sourceDir` | `src` | Directory to scan. A string, or an array like `["src", "lib"]` |
| `threshold` | `80` | Minimum line coverage % to pass |
| `maxIterations` | `3` | Retries per failing test before giving up |
| `coverageTimeout` | `300` | Seconds before the suite is killed (guards against hung handles) |
| `mocksFile` | (none) | Shared mock file every generated test imports from (see [Shared mocks](#shared-mocks)) |
| `setupFile` | (none) | Your test setup file; its contents are shown to the model so it knows what's already available |
| `ignore` | `[]` | Path substrings to skip, e.g. `"src/graphql/"` |
| `maxTokens` | `16000` | Max output tokens per call. Lower for strict providers (Groq free tier ~8000); raise if large files are cut off |
| `debug` | `false` | Log every prompt and response (see [Debugging](#debugging)) |

---

## Models

Lacuna works with any model behind an OpenAI-compatible API, plus Anthropic directly. Switch any time by re-running `lacuna init` or editing `.lacuna.json`.

| Preset | Model | API key | Notes |
|---|---|---|---|
| **DeepSeek** (default) | `deepseek-chat` | `DEEPSEEK_API_KEY` | Fast and cheap; a good default |
| DeepSeek R1 | `deepseek-reasoner` | `DEEPSEEK_API_KEY` | Reasoning model |
| Claude Sonnet | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` | High quality |
| Claude Opus | `claude-opus-4-7` | `ANTHROPIC_API_KEY` | Most capable |
| GPT-4o | `gpt-4o` | `OPENAI_API_KEY` | |
| Groq | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Fast, free tier |
| Gemini 2.5 Pro | `gemini-2.5-pro` | `GEMINI_API_KEY` | |
| Gemini 2.5 Flash | `gemini-2.5-flash` | `GEMINI_API_KEY` | Faster, cheaper |
| OpenRouter | any | `OPENROUTER_API_KEY` | One key, many models |
| Ollama | any local | none | Runs fully on your machine |
| LM Studio | any local | none | Runs fully on your machine |
| Custom | any | configurable | Any OpenAI-compatible endpoint |

---

## Supported stacks

Lacuna can run the suite and collect coverage for a wide range of languages. The quality of the *generated* tests depends on how much prompt tuning a stack has had.

**Tuned and tested:**

| Stack | Runner | Focus |
|---|---|---|
| TypeScript / JavaScript | Vitest, Jest | Hook return shapes, service method signatures, type-safe mocks, `vi.mocked()`/`jest.mocked()`, factory hoisting |
| React | Vitest, Jest | RTL queries, `act()` async rules, loading states, mock lifecycle, `findBy` over `waitFor` |
| React Native / Expo | Jest (`jest-expo`) | RNTL v14 async contract, infra mocks (Reanimated, AsyncStorage, vector icons), mock-shape accuracy, query isolation |
| Next.js | Vitest | Server/client boundaries, `next/navigation`, `next/headers`, `next/cache`, server actions, directive detection |

**Runner support, lighter tuning:** Vue (Vitest), Python (pytest), PHP (PHPUnit, Pest). These run and collect coverage, but framework-specific prompt tuning is still in progress.

**Runner only:** Go, Ruby (RSpec), Rust (cargo), C# (dotnet), Java (Gradle/Maven), Swift. Suites run and coverage is collected, but test generation isn't tuned for them yet.

**End-to-end (`--e2e`):** Playwright, with route discovery for Next.js (app and pages router) and React Router. See [End-to-end testing](#end-to-end-testing-playwright).

---

## Shared mocks

In a large codebase, redefining the same mocks in every test file gets painful fast. Point lacuna at a single mock file and every generated test imports from it.

Create the file:

```ts
// src/test/mocks.ts
import { vi } from 'vitest'

export const mockNavigate = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: vi.fn(() => ({})),
}))

export const mockUser = { id: 'user-1', email: 'test@example.com', role: 'admin' }
export const mockUseAuth = vi.fn(() => ({ user: mockUser, isLoading: false }))

beforeEach(() => vi.clearAllMocks())
```

Reference it in `.lacuna.json`:

```json
{ "mocksFile": "src/test/mocks.ts" }
```

Now generated tests import from that file instead of inventing their own mocks. If a test needs a mock that doesn't exist yet, lacuna adds it to the shared file and imports it.

Under the hood, lacuna parses the mock file before each run and builds an inventory of every `vi.mock()` call and its exports, so the model knows what's already mocked and edits it surgically instead of duplicating it. When a mock needs changing, the model patches the existing block rather than rewriting the file.

---

## CI / GitHub Actions

Run lacuna on pull requests to generate missing tests and block merges below threshold.

`.github/workflows/lacuna.yml`:

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
        continue-on-error: true        # let the commit step run even if coverage is low
        with:
          threshold: 80
          workers: 2
          model: deepseek
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}

      - name: Commit generated tests
        if: steps.lacuna.outcome != 'cancelled'
        run: |
          git config user.name "lacuna[bot]"
          git config user.email "lacuna[bot]@users.noreply.github.com"
          git add -A
          git diff --staged --quiet || git commit -m "chore: add lacuna-generated tests"
          git push
```

On each PR, lacuna generates the missing tests, posts a coverage report as a comment (updated in place, not re-posted), and fails the check if coverage stays below threshold.

To use a different model, pass its preset and key:

```yaml
with:
  model: gpt-4o
  openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

---

## Debugging

When a run behaves oddly (bad mock shapes, patches that won't apply, failures you can't reproduce), turn on debug logging to see exactly what the model received and returned.

Per run:

```bash
LACUNA_DEBUG=1 lacuna generate --file src/payments/processor.ts
```

Or persist it in `.lacuna.json`:

```json
{ "debug": true }
```

Lacuna writes one log per target file, named after its path: `src/queue/processor.ts` becomes `lacuna-debug.src_queue_processor.txt` (a file's `generate` and `fix` share the log). The full path is used, not just the file name, so identically-named files like `send-email/route.ts` and `login/route.ts` get separate logs instead of overwriting each other. Each log is cleared when that file's run starts and appended through its retries, so parallel runs never clobber each other. The env var wins over the config value, so you can override per run without editing anything.

Filing a bug? Attach the debug file; it has the exact prompt and raw response, which is what makes an issue reproducible.

---

## Reference

### Output formats

Every command takes `--format` and `--output`:

```bash
lacuna analyze                                   # terminal (default)
lacuna analyze --format json                     # for scripts and CI
lacuna analyze --format markdown                 # for PR comments
lacuna generate --format json --output report.json
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Coverage meets threshold |
| `1` | Coverage below threshold, or some files couldn't be tested |
| `2` | Error: runner failed, bad config, or no tests generated |

### Test placement

Lacuna follows your existing layout. If tests sit next to source files, new tests go there too. If they live in a separate tree (`test/`, `tests/`, `test/unit/`, …) that actually contains tests, it mirrors that. Otherwise it uses a `__tests__/` folder beside the source, creating it if needed.

### What gets skipped

Files with no testable logic are skipped automatically:

- **By directory:** `types/`, `constants/`, `assets/`, `images/`, `icons/`, `fonts/`, `styles/`, `generated/`, `__generated__/`, `mocks/`, `fixtures/`, `migrations/`, `i18n/`, `locales/`, `translations/`
- **By filename:** `*.d.ts`, `*.test.*`, `*.spec.*`, `*.stories.*`, `*.config.*`, `*.mock.*`, `*.types.ts`, `*.constants.ts`, `*.enum.*`, `index.*`
- **By content:** any file that exports only types, interfaces, enums, or constants

Add your own with `ignore` in `.lacuna.json`. Entries match as path substrings.

---

## Project structure

```
lacuna/
├── src/
│   ├── commands/          # CLI commands: analyze, generate, fix, run, init
│   ├── agent/
│   │   ├── loop.ts        # generate → run → retry loop
│   │   ├── fix-loop.ts    # fix → run → retry loop (+ --e2e repair)
│   │   ├── e2e-loop.ts    # E2E generate: discover → snapshot → generate → verify
│   │   ├── context.ts     # builds model context (source, tests, mocks, types)
│   │   ├── generator.ts   # calls the model, manages conversation history
│   │   └── prompts/       # prompt builders, split by framework and runner (incl. e2e.ts)
│   ├── lib/
│   │   ├── config.ts      # config loader + zod schema
│   │   ├── detector.ts    # detects test runner and language
│   │   ├── runner.ts      # spawns test commands, captures output
│   │   ├── reporter.ts    # terminal / JSON / markdown output
│   │   ├── validate.ts    # patch application, regression + broken-import detection
│   │   ├── typecheck.ts   # tsc pass and type-error scoping
│   │   ├── playwright.ts  # Playwright detection, config parse, result parsing
│   │   ├── flows/         # E2E route discovery, DOM snapshot, app-server lifecycle
│   │   ├── providers/     # model provider abstraction (anthropic, openai-compatible)
│   │   └── coverage/      # lcov / json parsers, gap extraction
│   └── ci/                # PR comment + GitHub Actions outputs
├── action.yml             # GitHub Action definition
└── .github/workflows/     # example workflow + release pipeline
```

---

## Contributing

Issues and PRs are welcome. The codebase is TypeScript throughout.

```bash
git clone https://github.com/Octagon-simon/lacuna
cd lacuna
npm install
npm run build
npm link        # makes `lacuna` point at your local build
```

When reporting a bug, the bug-report template asks for your test runner, model, lacuna version, and terminal output, the things needed to reproduce it.

---

## License

MIT
