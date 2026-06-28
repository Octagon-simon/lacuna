# Authenticated Coverage

Most of an app lives behind a login. Lacuna covers those pages: it logs in as a **test user you provide**, captures the **signed-in** DOM, and writes specs that run authenticated — and it self-heals an expiring session.

Files: `src/lib/playwright.ts` (scaffolding, config, auth, refresh), `src/agent/e2e-loop.ts` (dual-pass).

## Scaffolding (`ensureE2EAuthScaffolding` + `ensurePlaywrightConfig`)
- `e2e/test-config.ts` — exports `testUser { email, password }` (env-backed) and `authRoutes` — **you fill these in**.
- `e2e/auth.setup.ts` — a setup project that logs in and saves `storageState` to `playwright/.auth/user.json`; `.gitignore`d.
- A **3-project** config: `setup` (logs in), `chromium` (public specs — what Lacuna's own snapshot/verify runs use), `authenticated` (`*.auth.spec.ts`, reuses the saved session). The session is scoped to the authenticated project so a missing session never breaks the default runs.

## Detecting protected routes
A route is auth-gated when its signed-out snapshot either **redirects to a login URL** *or* **renders a login form inline** (`looksLikeAuthWall`: a password field, an OAuth "continue with…" button, or a sign-in/up CTA next to an email field — catches client-side guards with no URL change). Gated routes are re-snapshotted **signed in**; only those where the wall is *gone* become `*.auth.spec.ts`. A safety net means a wrong guess never produces a broken spec (false positive stays public; false negative falls back to an unauthenticated spec).

## Two subtle, important fixes
- **IndexedDB auth** — Firebase/Supabase/Amplify keep the session in **IndexedDB**, which `storageState()` ignores by default, so the saved session was empty and pages stayed locked. The scaffolded setup saves with `storageState({ path, indexedDB: true })`.
- **Auto-refresh expiring sessions** — token sessions (Firebase/JWT) expire ~1h, and Lacuna runs verify with `--no-deps` (no per-attempt re-login), so a stale session silently failed every authed spec. Now, when the saved session is **stale (>45 min) or missing** (and a setup file exists), `refreshAuthState` runs the `setup` project to log in fresh, only accepting it if a *newer* session file lands. Fails gracefully (no creds → falls back / skips). This is the "✓ Login session refreshed." line.
- **Auth-rehydration wait** — a signed-in SPA often shows a spinner while restoring the session (`if (authLoading) return <Spinner/>`). Authenticated specs are told to wait for `networkidle` then a signed-in landmark with a generous timeout before asserting, so the dashboard isn't asserted cold.

## Why it's hard
Auth is the gate to *all* deep coverage, and every framework stores it differently (cookies vs localStorage vs IndexedDB), expires it, and rehydrates it asynchronously. Getting a *real* logged-in DOM — reliably, and re-acquiring it mid-run — is most of the battle.

## Open-source potential — 🟡 partial
The **detection heuristics** (`redirectedToLogin` + `looksLikeAuthWall`) and the **`indexedDB:true` + auto-refresh** pattern are genuinely reusable knowledge, but they're woven into Lacuna's snapshot/scaffold flow. Best open-sourced as a **documented recipe / blog post** ("authenticated Playwright that survives IndexedDB auth and 1-hour tokens") rather than a library — the value is the know-how more than the code.
