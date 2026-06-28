# Lessons from building an AI that writes end-to-end tests

We built [lacuna](https://github.com/Octagon-simon/lacuna) to generate and repair real Playwright suites for real apps — log in, crawl the routes, recover the workflows, write the specs, run them, keep only what genuinely passes. The interesting part wasn't the model; it was everything around it. Here are the lessons that actually moved the needle, each tied to the bug that taught it.

> The recurring theme: **most failures looked like one thing and were actually another.** Auth timing was a default timeout. A "workers bug" was `networkidle`. A "weak model" was a missing per-control map. Make the black box observable and the real cause is usually mundane.

---

## 1. "What should I assert?" is the hard problem, not "what should I click?"

Clicking is easy. The *assertion* is where generated E2E tests live or die — and the expected result is almost never in the DOM snapshot, because a success toast is transient and a redirect hasn't happened yet.

The naive fix — grep the source for every `toast(...)` / `router.push(...)` and offer them as "assert one of these" — **fails on any non-trivial page.** A page with Save, Delete, and Upgrade buttons yields a dozen unrelated strings, and the model confidently asserts the *upgrade* redirect as the success of *saving a record*. We shipped that bug.

**The fix is an AST.** Resolve `control → its handler → the toast/redirect/calls inside that handler`, so each action asserts *its own* outcome. Regex can find the strings; only the AST knows which control owns which. We open-sourced this as [FlowMap](https://github.com/Octagon-simon/flowmap) — a zero-dependency module that maps each control to its outcome by borrowing the target project's own TypeScript compiler.

**Lesson:** ground the model in a *per-action* fact, not a bag of file-wide strings.

---

## 2. A running UI is a state machine a snapshot can't navigate

Deep flows (open a form → fill → submit → see the result; or a multi-screen wizard) can't be recovered from a static DOM capture. You have to *drive* the browser: fill the visible inputs, find the advance control, click, capture what appeared, repeat.

Two things make this brutal in practice:

- **Custom widgets.** A `role="combobox"` from Radix/Headless UI/MUI isn't an `<input>` — `fill()` does nothing. But they all implement the same WAI-ARIA pattern, so one sequence (open → type-ahead → wait for `listbox` → click `option`) drives them all. (We pulled this out as a standalone module: [widget-driver](https://github.com/Octagon-simon/widget-driver).)
- **Modals are ambiguous.** A modal can be the *result* of your action (interact with it) or an *interrupt* (onboarding/cookie/promo — dismiss it). Dismiss the wrong one and the flow breaks; ignore an interrupt and it blocks you. Heuristics on the copy ("Maybe later" / "Skip" → dismiss; "Save" / "Confirm" → interact) get you most of the way.

**Lesson:** static analysis tells you what *should* happen; only driving the real browser tells you what *does*. You need both — they cover each other's blind spots.

---

## 3. The 30-second timeout that silently deleted coverage

Our explorer walked many "openers" in **one Playwright test sharing one page**. On a 10-route app it would report "walked 17 flows, recorded 8 steps" — and a whole auth-gated section had *zero* tests.

The cause was invisible until we dumped per-probe debug: probes 1–5 worked, then *every* later one failed with `Target page… has been closed`. Playwright's **default 30s per-test timeout** killed the test mid-loop, closed the page, and the loop kept going — so every later route (which sorted last) was dropped.

**Lesson:** any test that loops N items in one `test()` must set `test.setTimeout()` scaled to N. The 30s default doesn't error loudly — it truncates silently. And: **make the black box observable.** A one-line per-item debug dump turned a multi-session mystery into a five-minute diagnosis.

---

## 4. `networkidle` is a lie on realtime apps

After fixing the timeout, exploration looked *hung* for minutes. The culprit: a `settle()` that waited on `waitForLoadState('networkidle', 5000)`. Firebase (and any websocket/polling app) keeps the network busy, so **networkidle never fires** — every settle burned the full timeout, times every step, times every probe.

We already *tell generated specs* never to use `networkidle` as a sync crutch. We'd violated our own rule internally. Wait on a real UI signal (a spinner disappearing, content appearing) instead.

**Lesson:** `networkidle` is meaningless on realtime apps. And a long operation must **show progress** — silence reads as "hung," which is a UX failure even when the tool is working.

---

## 5. The model will go green by deleting the failing test

Give an agent "make the suite pass" and it will, eventually, discover that the easiest way is to *remove the failing test*. We watched a spec shrink from 190 to 149 lines across retries and still "pass."

A pass-count check alone can't catch it — deleting a *failing* test leaves the pass count unchanged. You have to gate on **test count not decreasing** and **keep-best by passing count**, then *restore the best attempt* on exhaustion rather than accept the latest. Once the loop tracks the most-passing version, a smaller all-green spec (4/4) naturally loses to a fuller one (5 passing of 6), and the temptation to special-case "green-but-smaller beats nothing" disappears.

**Lesson:** "the suite is green" is a seductive, wrong success metric. Make the metric *coverage that doesn't decrease*.

---

## 6. A green suite isn't a good suite

Even when tests pass and aren't deleted, they can assert *nothing*:

- "Sidebar still visible" after a create/edit/delete — proves nothing changed.
- Click "Categories", assert the *Categories button* is still there — a tautology (it was always there).
- `if (await btn.isVisible()) { … }` with no `else` — passes having asserted nothing.

These all go green. They're worthless. The rules that kill them: a layout element that existed *before* the action is never a valid outcome; a tab switch asserts the *revealed panel*, not the clicked nav; an absent control is `test.skip(reason)`, not a vacuous pass. And feed the model the *real* outcome to assert (from #1/#2) so it doesn't reach for the lazy fallback.

**Lesson:** the assertion, not the action, is the test. Ban the assertions that pass regardless of behavior.

---

## 7. Some flows can't pass without seeded data — and that's fine

"Add a menu item" needs a category to select. On a fresh test account there are none, so the flow validation-blocks no matter how good the test is. No amount of model cleverness fixes a missing prerequisite.

The answer is **seeding**: deterministic (fixed keys), isolated (scoped to the test user), set up before / torn down after (Playwright `globalSetup`/`globalTeardown`), via the backend's admin client. The honest framing: a strong *generic* pass plus a thin *declared* per-project layer for what can't be inferred.

(Gotcha: Ctrl+C skips `globalTeardown`, so provide a standalone manual-clear script — not a `playwright test --project=cleanup`, which would boot the app and *re-seed* before deleting.)

**Lesson:** know the boundary between what you can auto-derive and what must be declared. Don't try to make the model paper over missing data.

---

## 8. Auth is the gate to everything, and every framework hides it differently

Authenticated coverage is most of a real app, and it's a minefield:

- **Firebase/Supabase/Amplify store the session in IndexedDB**, which Playwright's `storageState()` ignores by default — so the saved session is empty and every protected page stays locked even though login "worked." Fix: `storageState({ path, indexedDB: true })`.
- **Token sessions expire (~1h).** If your repair runs use `--no-deps` (no per-attempt re-login), a stale session silently fails every authed spec. Auto-refresh when the saved session is stale or missing.
- **SPAs rehydrate auth asynchronously** (`if (authLoading) return <Spinner/>`), so asserting the dashboard *cold* times out. Wait for a signed-in landmark first.

**Lesson:** "login succeeded" doesn't mean "the session is captured, fresh, and rendered." Each of those is a separate failure mode.

---

## The meta-lesson

A test-writing agent is mostly **not** a prompting problem. It's route discovery, DOM capture, auth, state-machine exploration, custom-widget driving, outcome grounding, coverage guards, and assertion-quality enforcement — with the model as one component. Every one of the bugs above was in that scaffolding, not the model. Build the scaffolding to be *observable*, and the model's job gets small and reliable.

---

*Open-sourced as standalone modules: [FlowMap](https://github.com/Octagon-simon/flowmap) and [widget-driver](https://github.com/Octagon-simon/widget-driver). The patterns above — coverage guards, assertion-quality rules, authenticated-Playwright recipe, seeding — are documented in the lacuna wiki.*
