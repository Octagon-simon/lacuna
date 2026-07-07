# Why the agent kept failing `createRepositories.test.ts`

A second post-mortem, companion to the PostgresClient one. This one is more
important because the agent didn't just write a bad test — it got **stuck** and
couldn't fix it across repeated attempts. There are two independent causes: a
subtle real bug, and a harness diagnostic that actively points away from it.

---

## 1. Symptom

3 of 13 tests fail, all with the same shape:

```
FAIL  createRepositories > should call createBusinessRoleRepository with BusinessRole model
AssertionError: expected "vi.fn()" to be called with arguments: [ Any<Object> ]
Number of calls: 0
```

The other 10 tests pass — including near-identical ones like "should pass sql to
createMarketPlaceAskRepository". So the harness (and the agent) sees: *most of the
file works, only these three assert 0 calls.*

---

## 2. The real bug: two mocks for one symbol, assertion bound to the wrong one

`createRepositories.ts` pulls its repo factories from **two** kinds of import:

```ts
// MOST come from the barrel:
import {createPersonRepository, createMarketPlaceAskRepository, ...} from './index.js';

// but THREE come from their DIRECT module files:
import {createBusinessRoleRepository}        from './createBusinessRoleRepository.js';
import {createBusinessPoolAccountRepository} from './createBusinessPoolAccountRepository.js';
import {createBusinessRFIRepository}         from './createBusinessRFIRepository.js';
```

The test mocked **both boundaries** for those three symbols:

```ts
// (a) inside the barrel mock:
vi.mock('.../repositories/index.js', () => ({
  ...
  createBusinessRoleRepository: vi.fn(() => ({name: 'businessRoleRepo'})),   // instance #1
  ...
}));

// (b) and again as a direct-module mock:
vi.mock('.../repositories/createBusinessRoleRepository.js', () => ({
  createBusinessRoleRepository: vi.fn(() => ({name: 'businessRoleRepo'})),   // instance #2
}));
```

`#1` and `#2` are **different `vi.fn()` objects**. Mocking `index.js` does NOT
intercept `import ... from './createBusinessRoleRepository.js'` — module mocks are
keyed by the exact specifier the importer uses. So:

- **The source** imports from the direct path → calls **instance #2**.
- **The test** imported its assertion target from the barrel:

  ```ts
  import {createBusinessRoleRepository} from '.../repositories/index.js';   // instance #1
  expect(vi.mocked(createBusinessRoleRepository)).toHaveBeenCalledWith(...); // checks #1
  ```

  → checks **instance #1**, which nothing ever called → `Number of calls: 0`.

The 10 passing tests pass only because their symbols really do come from the
barrel, so the test's barrel import and the source's barrel call hit the *same*
instance. The three failures are exactly — and only — the symbols the source
imports directly. That 1:1 correspondence is the fingerprint of this bug.

### The fix (one edit, no intent change)

Import the three assertion targets from the **same direct paths the source uses**:

```ts
import {createBusinessRoleRepository}        from '.../repositories/createBusinessRoleRepository.js';
import {createBusinessPoolAccountRepository} from '.../repositories/createBusinessPoolAccountRepository.js';
import {createBusinessRFIRepository}         from '.../repositories/createBusinessRFIRepository.js';
```

Now the assertion references instance #2 — the one the source calls. 13/13 pass.
No test was deleted, no title changed, no assertion inverted.

> Rule: **a module mock is keyed by the exact import specifier.** If the source
> imports `X` from a direct file but the test imports `X` from a barrel that
> re-exports it, the test is holding a *different* mock than the code runs.
> Always import your spy from the same path the code-under-test imports it from.

---

## 3. Why the agent got STUCK (this is the part to fix in the agent)

The failure report the agent was handed ends with this, in bold:

```
⚠️  REAL HTTP REQUEST DETECTED — the test is hitting the actual network.
    This is the root cause of the failure.
    Intercepted URL: https://vite.dev/rolldown
    Required fix: find which module the source imports for its API calls and mock THAT module.
```

**This is a false positive, and it is the reason the agent kept failing.**

That URL was scraped out of a completely harmless log line emitted by the Vite
SWC plugin on every run:

```
[vite:react-swc] We recommend switching to `@vitejs/plugin-react` ... More information at https://vite.dev/rolldown
```

No HTTP request occurred. The harness heuristic is roughly "if an `https://` URL
appears anywhere in the output, assume an un-mocked network call and declare it
the root cause." It pattern-matched a *recommendation link* in a plugin banner.

The damage: the harness didn't just add noise — it asserted a **wrong root cause
with high confidence** ("This is the root cause of the failure") and prescribed a
**wrong fix** ("mock the module it makes API calls through"). So the agent spends
its attempts hunting for a network/service mock that was never needed, in a test
that never touches the network, and never looks at the barrel-vs-direct import
mismatch — which emits *no* diagnostic text at all, just a silent "0 calls".

This is the classic trap: **a loud, confident, wrong signal beats a quiet, correct
one.** The agent optimizes toward the explicit instruction in the prompt over the
actual assertion error.

---

## 4. Fixes to encode in the agent

**A. Distrust the harness's "ROOT CAUSE / REAL HTTP REQUEST" banner; verify it.**
Before acting on a network-mock directive, confirm a real request actually
happened. Cheap checks:
  - Does the "intercepted URL" appear only inside a build-tool banner
    (`[vite:...]`, `[esbuild]`, deprecation notices, "More information at ...")?
    Those are logs, not requests. Ignore them.
  - Does the source file under test even import an HTTP client / service module?
    `createRepositories.ts` imports only repo factories — there is no network
    surface. A "real HTTP request" claim is incoherent here.
  - Is the actual assertion error a network error (ECONNREFUSED / 401 / timeout)?
    Here it's `Number of calls: 0` — a pure spy-wiring failure, categorically not
    a network problem.
  If those checks fail, treat the banner as noise and go to the real error.

**B. Diagnose from the assertion message, not the harness summary.**
`toHaveBeenCalledWith ... Number of calls: 0` has a small, fixed differential:
  1. the code path that should call the spy didn't run (guard/branch/throw earlier), or
  2. the code called a **different function instance** than the spy you asserted on
     (wrong import path, barrel vs direct, un-hoisted mock, re-created mock after
     `resetModules`), or
  3. the mock was reset/cleared between the call and the assertion.
  When *some* "was-called" assertions pass and others fail in the same file,
  suspect (2) and diff the import specifiers of the passing vs failing symbols
  against how the **source** imports them.

**C. When you mock a symbol at two module boundaries, make them one instance.**
If both a barrel and a direct module must be mocked for the same export, don't
declare two independent `vi.fn()`s. Share one via `vi.hoisted`:
```ts
const {roleSpy} = vi.hoisted(() => ({roleSpy: vi.fn(() => ({name: 'businessRoleRepo'}))}));
vi.mock('.../index.js', () => ({..., createBusinessRoleRepository: roleSpy}));
vi.mock('.../createBusinessRoleRepository.js', () => ({createBusinessRoleRepository: roleSpy}));
```
Then it doesn't matter which path anyone imports — there is only one spy.

**D. Import spies from the path the code-under-test imports from.**
The assertion target and the code's call must resolve to the same module record.
Mirror the source's import specifier exactly.

**E. "Most of the file passes, a minority fails identically" is a wiring smell.**
Genuine logic bugs rarely fail a clean subset of structurally-identical
assertions. A 0-calls failure isolated to specific symbols almost always means
those specific symbols are wired through a different module path than the rest.
