# Fixing the `PostgresClient.test.ts` Unhandled Rejections

A post-mortem of a test-authoring bug, written so an AI agent can learn the
pattern and stop reproducing it.

---

## 1. Symptom

`PostgresClient.test.ts` failed the run with repeated **Unhandled Rejection**
errors, not ordinary assertion failures:

```
⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
Error: process.exit unexpectedly called with "1"
 ❯ process.exit  node_modules/vitest/.../base.js:109:9
 ❯ PostgresClient.getInstance  src/infra/db/postgres/PostgresClient.ts:70:15
 ❯ test/unit/infra/db/postgres/PostgresClient.test.ts:137:31

 Test Files  1 failed
      Tests  7 failed | 13 passed (20)
     Errors  12 errors
```

Key tell: the stack bottoms out in **production** code (`process.exit(1)` inside
`getInstance`) and in vitest's runner — *not* on an `expect(...)` line. That
means the promise was never awaited/handled, so its rejection escaped the test
body entirely.

---

## 2. Root cause: the test was stale against its source

The production `getInstance` had evolved into an **async, fail-loud** method:

```ts
// src/infra/db/postgres/PostgresClient.ts
public static async getInstance(config: PostgresConfig): Promise<PostgresClient> {
  if (PostgresClient.#instance) return PostgresClient.#instance;
  const instance = new PostgresClient(config);
  try {
    await instance.#sql`SELECT 1`;   // health check: proves conn + creds + SSL
    logger.info('postgres connected', {...});
    PostgresClient.#instance = instance;
    return instance;
  } catch (err) {
    logger.error('Postgres connection failed!');
    logger.error(err);
    process.exit(1);                 // <-- mirrors MongooseClient: never half-start
  }
}
```

The test that the agent wrote assumed the **old, synchronous** contract, and had
two concrete defects:

### Defect A — the mock `sql` was not callable

```ts
// what the agent wrote
const mockPostgresSql = {end: mockSqlEnd};              // plain object
const mockPostgres = vi.fn().mockReturnValue(mockPostgresSql);
```

But `postgres.js` returns `sql` as a **tagged-template function** that *also*
carries an `.end()` method. So when `getInstance` ran `sql\`SELECT 1\``, it tried
to **call an object** → `TypeError` → the `catch` fired → `process.exit(1)`.

### Defect B — `getInstance` was called without `await`

```ts
// what the agent wrote
const client = PostgresClient.getInstance(testConfig); // returns a Promise, not a client
expect(client).toBeInstanceOf(PostgresClient);         // asserts against a Promise
```

Because the promise was never awaited, its rejection (triggered by Defect A) had
no handler, and vitest reported it as an **Unhandled Rejection** that fails the
whole file — instead of a clean assertion failure the agent might have caught.

The two defects compound: A guarantees the promise rejects; B guarantees the
rejection is never handled.

---

## 3. The fix (test-only — production code was correct)

### Fix A — make the mocked `sql` a real callable that resolves

```ts
const {mockPostgres, mockPostgresSql, mockSqlEnd} = vi.hoisted(() => {
  const mockSqlEnd = vi.fn().mockResolvedValue(undefined);
  // postgres.js returns a callable tagged-template `sql` that ALSO has `.end()`.
  // getInstance runs `sql`SELECT 1`` to prove the connection, so the mock must be
  // callable (and resolve) — an inert `{end}` object throws when tagged, which
  // trips the process.exit(1) path.
  const mockPostgresSql = Object.assign(
    vi.fn().mockResolvedValue([{'?column?': 1}]),
    {end: mockSqlEnd},
  );
  const mockPostgres = vi.fn().mockReturnValue(mockPostgresSql);
  return {mockPostgres, mockPostgresSql, mockSqlEnd};
});
```

`Object.assign(fn, {end})` is the trick: it produces a value that is **both**
callable (for the tagged-template health check) and has the `.end` method (for
`close()`), matching the real `postgres.js` surface.

### Fix B — await every `getInstance` call site

```ts
const client = await PostgresClient.getInstance(testConfig);
expect(client).toBeInstanceOf(PostgresClient);
```

Applied to all 9 call sites. Result: `20 passed`, zero unhandled rejections.

---

## 4. Why one leftover log is NOT a bug

After the fix, the run still prints one line:

```
[warn] "Suppressed promise rejection" | {"err":{"errorMessage":"Revert also failed", ...}}
```

This is **not** an unhandled rejection and **not** from a stale test. It comes
from a *different* file (`runOrRevertAllOnError.test.ts`) that deliberately
exercises `swallowRejection` — a production helper whose entire job is to attach
a handler to a fire-and-forget promise and log it:

```ts
// src/lib/utils/errorUtils.ts
export const swallowRejection = (err: unknown): void => {
  logger.warn('Suppressed promise rejection', {err: getErrorDetails(err)});
};
```

A passing test emitting an expected `warn` log ≠ a failure. Don't "fix" it.

---

## 5. Generalizable rules for the agent

These are the lessons to encode so this class of bug stops recurring.

1. **Read the source signature before writing the test.** The single biggest
   miss was asserting a synchronous contract against an `async` method. When a
   method is `async` / returns a `Promise`, every call site in the test must
   `await` it (or use `await expect(promise).rejects/resolves`).

2. **`process.exit unexpectedly called` in a stack = an unhandled rejection from
   an unawaited promise.** The fix is almost never to touch production code — it
   is to await the call and/or make the mock stop throwing.

3. **Mock the real *shape* of a dependency, not a convenient subset.** Many
   library objects are "a function that also has methods" (`postgres.js` `sql`,
   axios instances, express apps, some SDK clients). If the code *calls* the
   dependency, the mock must be **callable** — use
   `Object.assign(vi.fn()..., {method})`, not a plain `{method}` object.

4. **When code has a `catch { process.exit / throw }` health-check path, mock the
   happy path to resolve.** Otherwise the test silently drives the failure
   branch and you get exit/rejection noise instead of the behavior you meant to
   assert.

5. **A stack that bottoms out in production + runner code (never on an `expect`
   line) means the assertion never ran.** Treat that as "my promise leaked,"
   not "my assertion is wrong."

6. **Distinguish an expected `warn`/`error` *log* from a test *failure*.** Logs
   from deliberately-exercised error paths are normal. Only treat vitest's
   `Unhandled Rejection` / `Unhandled Error` banners (and non-zero exit) as
   failures.

7. **Prefer failing loud over failing leaked.** If you must call an async method
   you expect to reject, wrap it: `await expect(fn()).rejects.toThrow(...)`. That
   converts a would-be unhandled rejection into a clean, attributable assertion.
