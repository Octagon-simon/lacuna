# Seeding & Test Data

Many real flows can't reach success from an empty account: "add a menu item" needs a **category** to select; "create an order" needs a **product**. On a fresh test user those prerequisites don't exist, so the flow dead-ends at validation — and **no test, however good, can get past it**.

This matters specifically because `--deep` *drives* flows (fills, submits, asserts the real outcome). If a required field can't be satisfied, the honest deepest result is the validation message. Seed the prerequisite and the same run reaches the success toast / created row.

Docs: README → "Seeding test data". (Lacuna documents the pattern; the seed scripts live in the app under test.)

## What makes data "seeded" (not just inserted)
- **Deterministic** — the same fixed records every run (fixed IDs/keys), so specs can rely on them and cleanup is exact.
- **Isolated** — scoped to the *test* user, never real data.
- **Set up before, torn down after** — created in Playwright `globalSetup`, removed in `globalTeardown` (runs on every `playwright test`, including Lacuna's verify runs).

## The recommended pattern
Seed through the backend's **admin/service-role client** (fast, bypasses the UI and security rules), keyed to the test user — e.g. `seedTestData()` / `cleanupTestData()` with fixed keys, called from `global-setup.ts` / `global-teardown.ts`. A standalone script must load its own `.env` and use service credentials.

## Gotchas worth knowing
- **Ctrl+C skips `globalTeardown`** — an interrupted run leaves the seed behind. Provide a manual clear (a tiny `tsx e2e/clear-seed.ts` script), **not** a `playwright test --project=cleanup` (that would boot the dev server and re-seed via globalSetup before deleting).
- **Don't mix** `globalTeardown` *and* a cleanup project — redundant and confusing. Pick auto-clean (global) or persist + manual clear.
- A cleanup project that isn't ignored by your main project will **run mid-suite and wipe the seed** — guard with `testIgnore`.
- Deep create-flows leave their *own* records (separate from the seed); extend cleanup to also sweep test-prefixed rows if they pile up.

## Why it's hard
It's the boundary where fully-autonomous generation meets reality: some prerequisites simply must exist, and they're app-specific. The right split is a strong generic pass **plus a thin, declared per-project layer** (fixtures/seed) for what can't be inferred.

## Open-source potential — 🟢 as a guide
A framework-agnostic **"seeding for AI-generated E2E tests"** guide (the deterministic + isolated + setup/teardown pattern, the Ctrl+C clear, the cleanup-project trap) is genuinely useful and not app-specific. Ships as documentation.
