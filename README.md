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
       ├─ Pass → next file                                   retry, keep the best attempt
       └─ Fail → retry with the error,
                 keep the best attempt
```

Two rules hold throughout: lacuna never leaves a half-written file behind, and it never removes passing tests. If it can't fully fix a file, it keeps the attempt with the most passing tests — and if nothing beat the starting point, it puts the original back.

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
lacuna analyze @diff:origin/main    # patch coverage of the lines your branch changed
lacuna analyze @diff packages/api   # ...scoped to one directory (monorepo package)
lacuna analyze --threshold 90
lacuna analyze --format json --output report.json
lacuna analyze --format markdown
```

### `lacuna generate`

The main command: find gaps, write tests, run them, retry failures.

```bash
lacuna generate
lacuna generate --file src/utils/math.ts   # one file, skips the coverage run
lacuna generate @diff:origin/main           # patch coverage: only the lines your branch changed
lacuna generate --dry-run                   # preview, write nothing
lacuna generate --verbose                   # live panel as the model writes
lacuna generate --workers 4                  # process 4 files in parallel
lacuna generate --fresh                      # ignore the cached coverage report
lacuna generate --format json --output report.json
lacuna generate --e2e                        # generate Playwright end-to-end specs (see below)
```

If you ran `analyze` in the last 10 minutes, `generate` reuses that report instead of running the suite again (`--fresh` forces a new run). When retries are exhausted, lacuna keeps the best attempt **only if it adds passing tests** and points you to `lacuna fix` for the rest; otherwise it restores the original. If the model produces the same output twice, the loop stops early instead of wasting iterations.

#### Patch coverage (`@diff`) — close a Codecov gap on a PR

Codecov (and similar gates) judge **patch coverage**: the coverage of only the lines your PR *changed*, not the whole repo. A file can sit at 94% overall and still fail the gate because the four lines you just added aren't tested. `lacuna generate @diff` targets exactly that scope — the same lines Codecov flags — so a green lacuna run predicts a green patch check.

```bash
lacuna generate @diff                       # diff vs the repo's default branch (origin/HEAD → main/master)
lacuna generate @diff:origin/main           # explicit base ref
lacuna generate @diff packages/api          # narrow to the changed lines inside ONE directory (monorepo package)
lacuna generate @diff -f src/lib/Service.ts # narrow to ONE changed file's uncovered lines
lacuna analyze  @diff:origin/main           # read-only: report patch coverage + the gap, write nothing
```

**The workflow (fast + accurate):**

```bash
# 1. Produce a FULL coverage report once (or reuse the lcov your CI already uploaded to Codecov).
npm run test:cov                       # writes coverage/lcov.info

# 2. Generate tests for just the changed-and-uncovered lines. lacuna reuses the report from step 1
#    instantly — no suite re-run — and writes tests scoped to the exact gap.
lacuna generate @diff:origin/main

# 3. Commit.
git add -A && git commit -m "test: cover patch"
```

Why step 1 matters: patch coverage is only meaningful against the **same measurement Codecov used** — your whole suite. A line can be covered by a test in a *different* file (an integration or DI test), so lacuna must read a full-suite report to know what's genuinely uncovered. It therefore **reuses an existing `coverage/lcov.info` regardless of age** rather than running a narrower, misleading subset. If none exists it runs the full suite (accurate but slow) and warns you; `--fresh` forces a full re-run. The after-number is measured cheaply — just the new test's incremental coverage, unioned onto the report, no second full run.

**In CI** — gate the PR on patch coverage without waiting on Codecov's round-trip:

```yaml
- run: npm run test:cov                        # your normal coverage step; leaves coverage/lcov.info
- run: npx lacuna generate @diff:origin/main   # reads that lcov, covers the gap; exit 1 if still below threshold
- run: git diff --exit-code || (git add -A && git commit -m "test: cover patch" && git push)
```

**How it decides what to target:** it diffs from the `git merge-base` with the base ref (exactly Codecov's patch semantics — only what your branch added since it forked), intersects those changed lines with the uncovered lines in the coverage report, and generates tests for just that intersection. The report gains a `Patch coverage` before/after line and the exit code gates on it (below threshold → `1`).

**Edge cases:** a docs-only diff exits `0` ("nothing to cover"); an unresolvable base (e.g. a shallow CI clone) exits `2` with a `git fetch --unshallow` hint; a changed file whose tests never ran counts as fully uncovered. Note: lacuna currently parses line coverage (`DA`) but not branch coverage (`BRDA`), so a half-covered conditional Codecov shows as a yellow `n/m` branch isn't targeted yet — full line misses are.

### `lacuna fix`

Finds failing tests and repairs them. Each failing file goes to the model with its error output and source; the model patches what's broken and lacuna reruns until it passes. A fix that makes the tests pass is kept even if minor type warnings remain. `fix` never reverts a working change — and when it can't reach all-green, it keeps the attempt with the most passing tests rather than discarding a partial improvement.

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
- **Type errors (`--types`).** Selects files by TypeScript errors instead of test failures, finding every test file that fails type-checking even if its tests pass. Type-checking runs against each file's **governing `tsconfig`** (the nearest one walking up), not the repo root — so in a monorepo a package's `@/` path aliases, `jsx`, and `moduleResolution` resolve correctly and a clean file isn't flagged with false `Cannot find module`/`Cannot use JSX` errors. It also respects that config's rules: if the nearest one disables `noImplicitAny` (common in monorepo packages), implicit-`any` isn't treated as an error. Files are grouped by config and checked one scoped `tsc` run per package.
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

You don't have to set Playwright up by hand. `lacuna init` offers to do it for React and Next.js projects, and if you run `--e2e` without it, lacuna offers to install it on the spot (interactive terminals only — in CI it prints the command and exits so nothing hangs). Setting it up means: installing `@playwright/test` and the browser binaries, **scaffolding a `playwright.config.ts`** (framework-aware `webServer` command + `baseURL`, `testDir: ./e2e`) if you don't already have one — an existing config is never overwritten — and scaffolding the auth helpers described below. After the browser download, on Linux lacuna detects Playwright's "host system is missing dependencies" warning and tells you to run `sudo npx playwright install-deps` (that step needs sudo, so it can't be automated).

The scaffolded config's `webServer.command`/`url` and `baseURL` are derived from your project — the package manager comes from the lockfile, the dev command from your `dev`/`start` script, and the port from that script (`-p`/`--port`/`PORT=`) or the framework default (`:3000` Next.js/CRA, `:5173` Vite). It can't infer a non-localhost host, so double-check it. A correct `webServer`/`baseURL` is also what lets `--workers` run in parallel (without it, lacuna can't confirm a shared app server and falls back to running specs one at a time).

```bash
lacuna generate --e2e                  # discover routes, generate a spec for each
lacuna generate --e2e --route /login   # just one route
lacuna generate --e2e --workers 4      # generate in parallel
lacuna generate --e2e --deep           # walk multi-step flows: fill + SUBMIT forms (test/staging only)
lacuna generate --e2e --dry-run        # list which routes would get specs (no app, no API call)
lacuna fix --e2e                       # repair failing Playwright specs
```

How generation works:

1. **Discover** the routes from your router (e.g. `app/login/page.tsx` → `/login`, or a `<Route path="/login">`).
2. **Snapshot** each page: lacuna starts your app once via the `webServer` config and captures the accessibility tree plus any `data-testid`s, so the model writes specs against the elements that are *really there*. If you've set up authentication (below), routes that redirect to login are re-snapshotted **signed in**, so the captured DOM is the real logged-in page.
3. **Generate** one spec per route. Selectors follow a strict order: `getByRole`, `getByLabel`, `getByPlaceholder`, then `getByTestId` (only for testids actually present on the page, never invented), with `getByText` as a last resort. Brittle CSS, XPath, and arbitrary sleeps are forbidden; assertions are auto-waiting and validate the outcome of each action. Protected routes become `*.auth.spec.ts` specs that run signed in; un-set-up auth means a login redirect is asserted rather than fabricated.
4. **Verify**: lacuna runs each spec, confirms it isn't flaky, and retries on failure. A spec that goes green and stays green is kept; one that never passes is **kept on disk for repair** (run `lacuna fix --e2e` to iterate on it) rather than discarded — only a route that never yielded a runnable spec at all is cleaned up. Retries may not **shrink the suite**: an attempt that deletes a test to go green is rejected, and lacuna keeps the attempt with the most passing tests (so coverage never silently drops across retries — this applies to `fix` too).

**Going deeper (`--deep`).** By default lacuna writes one focused spec per route plus the actions a single click reveals. With `--deep` it *walks* multi-step journeys in a real browser — filling inputs (type-aware values), driving custom ARIA comboboxes/selects that a plain fill can't (Radix/Headless UI/MUI), clicking the advance/submit control, dismissing onboarding/cookie interrupts, and capturing the real success/validation **toast** to assert — step by step until the flow ends. Because it fills and **submits real forms**, use a test/staging environment (and see [Seeding](#seeding-test-data-when-flows-need-existing-records) for flows that need existing data, like an item that requires a category). Progress streams per flow so a long walk never looks stuck.

If your project already uses `data-testid`s, lacuna picks them up from the snapshot and prefers them where a semantic locator isn't enough. It reads testids from your components but does not add them, it only touches test files.

Specs are written to your Playwright `testDir`. Routes that already have a spec are skipped, so re-running only fills the gaps. `--dry-run` is a free preview: it lists what would be generated without starting your app or calling the model.

**Repairing specs (`lacuna fix --e2e`).** When a spec breaks, lacuna captures a fresh snapshot of the page, then asks the model to diagnose the root cause (selector drift, a timing gap, an auth redirect, a removed feature) and apply the smallest fix that preserves what the test checks. It fixes selectors and synchronization rather than weakening or deleting assertions to force a pass.

### Authenticated coverage (testing signed-in pages)

Most of an app lives behind a login. lacuna can cover those pages too — it logs in as a test user, captures the **signed-in** DOM of each protected route, and writes specs that run authenticated. You provide the test user; lacuna never invents or commits credentials.

**1. Set Playwright up** (if you haven't). `lacuna init` (choose end-to-end) or just `lacuna generate --e2e --dry-run` scaffolds everything without running the app or calling the model:

| File | What it is |
|---|---|
| `playwright.config.ts` | Three projects: `setup` (logs in), `chromium` (public specs), `authenticated` (`*.auth.spec.ts`, reuses the saved session). |
| `e2e/test-config.ts` | Exports `testUser { email, password }` (env-backed) and `authRoutes { login, afterLogin }` — **you fill these in**. |
| `e2e/auth.setup.ts` | A setup spec that logs in and saves the session to `playwright/.auth/user.json`. |
| `.gitignore` | `playwright/.auth/` is added so the saved session is never committed. |

On Linux, run `sudo npx playwright install-deps` once so the browsers can launch.

**2. Fill in the test user.** Edit `e2e/test-config.ts` with a real seeded account (or set `E2E_EMAIL` / `E2E_PASSWORD`), and set `authRoutes.login` to your login path:

```ts
export const testUser = {
  email: process.env.E2E_EMAIL ?? 'qa@yourapp.com',
  password: process.env.E2E_PASSWORD ?? 'a-real-test-password',
}
export const authRoutes = { login: '/login', afterLogin: '/dashboard' }
```

**3. Point the login helper at your form.** The scaffolded `e2e/auth.setup.ts` uses generic selectors — adjust them to your actual login form (the field labels and the submit button), and change the post-login wait to a real signal:

```ts
await page.getByLabel(/email/i).fill(testUser.email)
await page.getByLabel(/password/i).fill(testUser.password)
await page.getByRole('button', { name: /sign in/i }).click()
await page.waitForURL('**/dashboard')   // a real "you're logged in" signal
```

**4. Capture the session.** Run the setup project once — it logs in and writes the saved session:

```bash
npx playwright test --project=setup
ls playwright/.auth/user.json    # success = this file now exists
```

**5. Generate.** Now `lacuna generate --e2e` does a two-pass capture: public routes are snapshotted normally; routes that redirect to login are **re-snapshotted signed in** and get `*.auth.spec.ts` specs that exercise the logged-in UI. Token sessions (Firebase/Supabase/JWT) expire after ~1 hour, so if the saved session is stale or missing lacuna **auto-refreshes** it by running the `setup` project before capturing (you'll see `✓ Login session refreshed.`); if no valid credentials are configured it falls back gracefully.

```bash
lacuna generate --e2e
# Generating: /admin (authenticated) → e2e/admin.auth.spec.ts
```

**6. Run everything.** Plain `npx playwright test` runs the `setup` project first (fresh login), then the public and authenticated specs:

```bash
npx playwright test
```

Notes:
- Public routes stay `*.spec.ts`; protected routes become `*.auth.spec.ts`. Re-running `generate --e2e` skips a route if **either** variant already exists, so there are no duplicates.
- lacuna's own snapshot/verify runs never need the credentials — only the `authenticated` project and the saved session do. So generating specs works even before you've filled in the test user (protected routes just stay shallow until you do).
- If a protected route still snapshots as the login page, the saved session didn't unlock it — re-check the selectors in `auth.setup.ts` and re-run `npx playwright test --project=setup`.
- **Firebase / Supabase / Amplify auth** keep the session in **IndexedDB**, which `storageState()` does *not* capture by default — so the saved session is empty and protected pages stay locked even though login succeeded. The scaffolded `auth.setup.ts` saves with `storageState({ path, indexedDB: true })` (Playwright ≥ 1.51) to handle this; if you wrote your own setup, add `indexedDB: true`.

#### How a route is detected as protected (and what it can't see)

lacuna decides a route is auth-gated when its signed-out snapshot either **redirects to a login URL** (`/login`, `/users/sign_in`, `/auth/...`, etc.) or **renders a login form inline** (a password field, an OAuth "Continue with…" button, or a sign-in/up button next to an email field). It then re-snapshots that route with your saved session and only treats it as authenticated if the login wall is *gone*. This is a heuristic with a safety net — a wrong guess never produces a broken spec:

- A **false positive** (a public page that looks login-ish, e.g. a newsletter "Sign up" box) is re-checked signed in, still looks the same, and **stays a public `*.spec.ts`**. Cost is one extra snapshot.
- A **false negative** (a login screen lacuna doesn't recognise) just falls back to a normal unauthenticated spec — same as if auth weren't set up.

Cases it currently does **not** auto-detect, so they fall back to public specs (write the `*.auth.spec.ts` by hand, or `lacuna fix --e2e` it):
- **Magic-link / passwordless** screens (email only, no password or OAuth button).
- **Non-English** login UIs — the keywords it matches (`password`, `sign in`, `login`) are English.

And one that's about *which* session you save, not detection:
- **Role-based pages** (e.g. `/admin`): capture the session as a user who actually has that role. A logged-in-but-unauthorized session makes lacuna write a spec against the "access denied" page. The saved-session path is read from your config's `authenticated` project, so a custom `storageState` location works too.

### Seeding test data (when flows need existing records)

Many real flows can't reach success from an empty account. "Add a menu item" needs a **category** to select; "create an order" needs a **product**; "assign a teammate" needs an **invite**. On a fresh test user those prerequisites don't exist, so the flow dead-ends at validation — and **no test, however well written, can get past it**. The fix is *seeding*: put known, controlled data into your database **before** tests run.

This matters for lacuna specifically because `lacuna generate --e2e --deep` *drives* each flow (filling forms, submitting, and asserting the real outcome). If a required field can't be satisfied, the deepest it can honestly go is the validation message. Seed the prerequisite and the same run reaches the success toast / created row instead.

What makes data "seeded" (not just inserted):
- **Deterministic** — the same fixed records every run (use fixed IDs/keys), so specs can rely on them and cleanup is exact.
- **Isolated** — scoped to the *test* user, never real data.
- **Set up before, torn down after** — created in Playwright's `globalSetup`, removed in `globalTeardown`, so re-runs don't pile up duplicates. (`globalSetup` is not a project, so it runs on every `playwright test` invocation — including lacuna's own verify runs — which is what you want: the data is present whenever specs run.)

The recommended pattern — seed through your backend's **admin/service-role client** (fast, bypasses the UI and security rules), keyed to the test user:

```ts
// e2e/seed.ts  — example shape; swap in your own DB client (Firebase Admin, Supabase service role, Prisma…)
export async function seedTestData() {
  const uid = await getTestUserId()                 // resolve the test user once
  await db.set(`categories/${'e2e-seed-category'}`, {  // FIXED key → idempotent + exact cleanup
    userId: uid, name: 'E2E Seed Category', order: 0,
  })
}
export async function cleanupTestData() {
  await db.remove(`categories/${'e2e-seed-category'}`)
}
```

```ts
// e2e/global-setup.ts                      // e2e/global-teardown.ts
import { seedTestData } from './seed'       // import { cleanupTestData } from './seed'
export default async () => { await seedTestData() }   // export default async () => { await cleanupTestData() }
```

```ts
// playwright.config.ts — add at the top level
globalSetup: './e2e/global-setup.ts',
globalTeardown: './e2e/global-teardown.ts',
```

Notes:
- A standalone setup script doesn't get your framework's automatic `.env` loading. Load it yourself (e.g. `dotenv`), and make sure the script uses **service-account / service-role** credentials, not the public client keys.
- The test user must already exist in your auth provider (the same one in `e2e/test-config.ts`).
- Match the seeded record's fields to your app's real model — the same shape your create-form would write.
- Seed only the *prerequisites* a flow needs to start. lacuna still drives the actual create/edit/delete and asserts their outcomes; seeding just gets the flow off the ground.

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
| `format` | `true` | Run your project's local `eslint --fix` + `prettier` on each generated/fixed test so it matches your repo style and clears lint. Best-effort; set `false` to disable |
| `nodeEnvRouting` | `true` | When a generated test is DOM-free (services, utils, validators), add a `@vitest-environment node` / `@jest-environment node` docblock so it skips jsdom startup and runs much faster. Verified per file and reverted if it breaks the test; set `false` to disable |
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

### Gating on Codecov patch coverage

The workflow above covers the whole repo to a threshold. If your gate is a **Codecov patch check** (coverage of only the lines the PR changed), use `@diff` instead — it targets exactly those lines and is far cheaper because it reuses the coverage report your test step already produced. See [Patch coverage (`@diff`)](#patch-coverage-diff--close-a-codecov-gap-on-a-pr) for the full workflow. Minimal step, after your coverage step has written `coverage/lcov.info`:

```yaml
      - run: npm run test:cov                        # your coverage step → coverage/lcov.info
      - run: npx lacuna generate @diff:origin/main   # cover the changed-and-uncovered lines
      - run: |
          git add -A
          git diff --staged --quiet || (git commit -m "test: cover patch" && git push)
```

Fetch enough history for the merge-base first (`actions/checkout` with `fetch-depth: 0`, or `git fetch --unshallow`), otherwise `@diff` can't resolve the base ref and exits `2`.

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
