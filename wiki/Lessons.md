# Hard-Won Lessons

The non-obvious bugs that shaped Lacuna, and the rules they produced. Each is a trap that *looks* like something else.

## 1. The 30s shared-test timeout (silent truncation)
**Symptom:** `--deep` "walked 17 flows, recorded 8 steps," and `/admin` had zero coverage. The exploration debug showed probes 1–5 walked, then *every* later probe failed with `page.goto: Target page… has been closed`.
**Cause:** all probes/routes run in **one `test()` sharing one page**, with no `test.setTimeout`. Playwright's **default 30s** killed the test mid-loop, closed the page, and the loop kept going — so every later route (and `/admin` sorts last) was dropped.
**Rule:** any temp spec that loops N items in one test MUST set a timeout scaled to N. Fixed in all three shared specs (explore + both snapshots).

## 2. `networkidle` never fires on realtime apps
**Symptom:** after fixing the timeout, `--deep` looked *hung* for minutes.
**Cause:** `settle()` waited `waitForLoadState('networkidle', 5000)`. Firebase/websockets keep the network busy, so networkidle **never fires** and every settle burned the full timeout — × many calls × many probes.
**Rule:** don't use `networkidle` as a readiness signal on realtime apps (we already ban it in generated specs — we'd violated it ourselves internally). Trimmed to 1.5s; the loader-hidden wait is the real signal. Also added live `LACUNA_PROBE i/N` progress so long runs never look hung. **UX lesson: a long operation must show progress.**

## 3. The toast-junk capture
**Symptom:** the add-item test asserted `getByText("successfully")` instead of the real `"Menu item added successfully!"`.
**Cause:** `captureToast` matched `[role=status]`/`[class*=toast]` and read `textContent`, which grabbed the **Next.js dev-badge's embedded CSS** (`[data-next-badge-root]{--timing:cubic-bezier(…)`). The model saw garbage and fell back to a vague guess.
**Rule:** capture transient UI with `innerText` (skips `<style>`/`<script>`) and reject non-message text (braces, CSS vars, `data-next`). Require a real word.

## 4. The regression that birthed FlowMap
**Symptom:** a saved menu item asserted the *upsell* redirect (`/upgrade`) as its success.
**Cause:** an early approach regex-extracted **all** toast/redirect strings from a file and offered them as "assert one of these" — on a multi-flow page that's dozens of unrelated outcomes.
**Rule:** outcomes must be **per-control**, resolved `control → handler → calls`. That's **[FlowMap](FlowMap.md)** — and the prompt enforces "apply each outcome ONLY to its own control."

## 5. "Green by deletion" / shrinking suites
**Symptom:** a spec shrank 190 → 149 lines across retries and still "passed."
**Cause:** the loop accepted the first all-green attempt; deleting the failing test went green.
**Rule:** gate on **non-decreasing coverage** and **keep-best by passing count**. See **[Coverage Guards](Coverage-Guards.md)**.

## 6. Stale auth + cold assertions
**Symptom:** authed specs timed out finding signed-in content even though the snapshot saw it.
**Cause:** a ~5h-old token session (verify runs `--no-deps`, so nothing re-logs-in) + asserting the dashboard before the auth-rehydration spinner cleared.
**Rule:** auto-refresh stale/missing sessions (`refreshAuthState`), and have authed specs wait for a signed-in landmark before asserting. See **[Authenticated Coverage](Authenticated-Coverage.md)**.

## 7. `fix` was reading the unit mock for e2e
**Symptom:** `lacuna fix --e2e` printed `Mocks: test/mock.ts`.
**Cause:** the unit-test context (mock file, source-under-test) was built unconditionally; e2e repair never uses it.
**Rule:** skip unit context entirely in e2e mode (and don't print it). Small, but it's the kind of cross-wiring that misleads.

## The meta-lesson
Most of these *looked* like one thing (auth timing, a workers bug, a hung process, a weak model) and were actually another (a default timeout, networkidle, captured CSS, a missing per-control map). **Make the black box observable** — the exploration debug dump turned a multi-session mystery into a five-minute diagnosis.
