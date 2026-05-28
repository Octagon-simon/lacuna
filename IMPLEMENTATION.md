# lacuna — Implementation Plan

A CLI-first agentic software that analyzes test coverage, generates tests, and verifies them in a loop.

---

## Architecture Overview

```
CLI (oclif + TypeScript)
  └── Agent Loop (provider-agnostic LLM)
        ├── Coverage Ingestion (LCOV / JSON)
        ├── Gap Analyzer (uncovered code paths)
        ├── Test Generator (LLM writes tests)
        ├── Test Runner (spawns test commands)
        └── Verify Loop (run → check → iterate)

CI Integration (GitHub Actions)
  ├── PR Comments (coverage delta)
  └── Status Checks (block/pass)

SaaS layer (Next.js + Postgres + Stripe)
  ├── REST API (ingest CLI results)
  ├── Dashboard (trends, org policy)
  └── Billing (free tier / pro)
```

---

## Tech Stack

| Layer | Tool |
|---|---|
| CLI framework | oclif |
| Language | TypeScript (strict) |
| LLM | Anthropic SDK + OpenAI SDK (provider abstraction) |
| Code parsing | Tree-sitter |
| Coverage format | LCOV + JSON summary |
| Config discovery | cosmiconfig |
| Test runner | child_process (spawn) |
| Interactive prompts | @inquirer/prompts |
| SaaS backend | Next.js + Postgres + Stripe |

## Supported Models / Providers ✅

| Preset | Provider | Model | API Key Env |
|---|---|---|---|
| `claude` | Anthropic | claude-sonnet-4-6 | `ANTHROPIC_API_KEY` |
| `claude-opus` | Anthropic | claude-opus-4-7 | `ANTHROPIC_API_KEY` |
| `deepseek` | DeepSeek | deepseek-chat | `DEEPSEEK_API_KEY` |
| `deepseek-r1` | DeepSeek | deepseek-reasoner | `DEEPSEEK_API_KEY` |
| `gpt-4o` | OpenAI | gpt-4o | `OPENAI_API_KEY` |
| `groq` | Groq | llama-3.3-70b-versatile | `GROQ_API_KEY` |
| `openrouter` | OpenRouter | any model | `OPENROUTER_API_KEY` |
| `ollama` | Local | any ollama model | none |
| `lm-studio` | Local | any LM Studio model | none |
| `custom` | Any OpenAI-compatible | configurable | configurable |

---

## Phases

### Phase 1 — Project Scaffold ✅
- [x] Initialize oclif project with TypeScript
- [x] Set up tsconfig, prettier
- [x] Set up project structure (src/commands, src/lib, src/agent)
- [x] Initialize git repository
- [x] Set up Anthropic SDK dependency
- [x] Create base CLI entry point
- [x] Write basic `lacuna --version` and `lacuna --help`

### Phase 2 — Config System ✅
- [x] cosmiconfig setup (reads `.lacuna.json`, `.lacuna.yaml`, or `lacuna` key in package.json)
- [x] Config schema + validation (zod)
- [x] Config options:
  - `testRunner` — jest | vitest | pytest | go test | mocha
  - `coverageFormat` — lcov | json-summary | cobertura
  - `coverageDir` — path to coverage output
  - `sourceDir` — path to source files
  - `threshold` — minimum coverage % (default: 80)
  - `model` — Claude model to use
  - `maxIterations` — agent loop max retries (default: 3)

### Phase 3 — Coverage Ingestion ✅
- [x] LCOV parser (reads lcov.info files)
- [x] JSON summary parser (jest --coverage output)
- [x] Coverage data model (file → line → covered/uncovered)
- [x] Gap extractor — identifies uncovered functions and branches
- [x] Coverage summary reporter (console output)

### Phase 4 — Framework Detection ✅
- [x] Auto-detect test runner from package.json scripts / config files
- [x] Auto-detect coverage format from test runner config
- [x] Auto-detect source directories
- [x] Framework-specific test file conventions (*.test.ts, *_test.go, test_*.py)
- [ ] Framework-specific import/setup patterns (handled in Phase 5 by context builder)

### Phase 5 — Core Agent Loop ✅
- [x] Anthropic SDK integration (claude-sonnet-4-6) — streaming
- [x] Context builder — reads source file + existing tests + coverage gaps
- [x] System prompt — instructs Claude to write meaningful tests (not coverage-gaming)
- [x] Test generator — Claude produces test code for a given gap (with conversation history)
- [x] Test file writer — writes generated tests to correct location
- [x] Test runner — spawns test command, captures stdout/stderr/exit code
- [x] Result interpreter — parses test output (pass/fail/error)
- [x] Verify loop — if tests fail, feeds error back to Claude, retries (up to maxIterations)
- [x] Coverage comparator — before vs after coverage delta

### Phase 6 — CLI Commands ✅
- [x] `lacuna analyze` — scan coverage, print gaps, no file changes
- [x] `lacuna generate` — scaffold wired, agent loop plugs in at Phase 5
- [x] `lacuna run` — run existing test suite and report coverage
- [x] `lacuna init` — scaffold .lacuna.json config interactively
- [x] Global flags: `--dry-run`, `--verbose`, `--model` (per-command)
- [ ] Global `--config` flag to specify custom config path

### Phase 7 — Output & Reporting ✅
- [x] Terminal reporter (colored output, coverage delta table)
- [x] JSON reporter (machine-readable, for CI) — `--format json --output report.json`
- [x] Markdown reporter (for PR comments) — `--format markdown`
- [x] Exit codes (0 = pass, 1 = below threshold, 2 = error)

### Phase 8 — GitHub Actions Integration ✅
- [x] `action.yml` — composite GitHub Action wrapping the CLI
- [x] PR comment poster — upserts a single comment per PR (no spam)
- [x] Action outputs: `coverage-before`, `coverage-after`, `passed`
- [x] Action inputs: `threshold`, `model`, `github-token`, `anthropic-api-key`, `mode`, `post-comment`
- [x] Example workflow at `.github/workflows/example.yml`
- [ ] Publish to GitHub Marketplace (requires GitHub repo + release tag)

### Phase 9 — SaaS Backend ✅
- [x] Next.js 15 app scaffold (`app/`)
- [x] Prisma schema — User, Org, Project, Run, FileCoverage, ApiKey
- [x] REST API `POST /api/runs` — ingests CLI results, enforces plan limits
- [x] Auth — GitHub OAuth via NextAuth v5
- [x] Dashboard — project list with latest coverage per project
- [x] Project detail page — coverage trend bar chart + run history table
- [x] API keys page — create / revoke keys
- [x] Stripe webhook — upgrades org plan on payment, downgrades on cancellation
- [x] CLI flag `--report-to` + `--api-key` (also reads `LACUNA_API_KEY` env var)
- [x] `.env.example` with all required env vars
- [x] Billing page — Payaza Checkout for PRO/Enterprise upgrade (wires to webhook)

---

## Current Status

**All phases complete.** Ready for first commit + npm publish + app deployment.

---

## File Structure (target)

```
lacuna/
├── src/
│   ├── commands/
│   │   ├── analyze.ts
│   │   ├── generate.ts
│   │   ├── run.ts
│   │   └── init.ts
│   ├── lib/
│   │   ├── config.ts          # cosmiconfig loader + zod schema
│   │   ├── coverage/
│   │   │   ├── lcov.ts        # LCOV parser
│   │   │   ├── json.ts        # JSON summary parser
│   │   │   └── types.ts       # shared coverage types
│   │   ├── detector.ts        # framework auto-detection
│   │   ├── runner.ts          # test runner (spawn)
│   │   └── reporter.ts        # output formatters
│   └── agent/
│       ├── loop.ts            # main agent loop
│       ├── context.ts         # context builder for Claude
│       ├── generator.ts       # test generation via Claude
│       └── prompts.ts         # system + user prompts
├── action.yml                 # GitHub Action definition
├── IMPLEMENTATION.md          # this file
├── package.json
├── tsconfig.json
└── .lacuna.json             # example config
```

---

## Notes

- Tests should be meaningful, not coverage-gaming. Claude is instructed to test behavior and edge cases, not just execute lines.
- The agent loop always verifies: if a generated test fails, it retries with the error as feedback.
- Dry-run mode (`--dry-run`) prints what would be written without touching the filesystem.
- The tool is language-agnostic at the CLI level — framework detection handles the specifics.
