// React web component testing guidance (non-RN, non-Next.js)
export function buildReactCauses(isJSRunner: boolean, mockApi: string): string {
  if (!isJSRunner) return ''

  return `
    - "renders without crashing" tests: NEVER write \`expect(true).toBe(true)\` as a render smoke-test. It proves nothing and will be rejected. Instead, assert on at least one element that must be visible: \`expect(screen.getByText('Some Heading')).toBeTruthy()\` or \`expect(screen.getByTestId('...')).toBeDefined()\`. Read the component's JSX to find a reliable element — a title, a label, a button text.

    - React 18 act() async rule: ALWAYS await act() when it wraps async code. Unawaited act() calls cause state to leak across tests, producing "Cannot read properties of null" failures in unrelated tests.

    - Act batching boundary: multiple state updates triggered in the same tick must be wrapped in a single act() block to avoid partial render assertions.

    - React 18 Strict Mode double-invocation: effects and event handlers may run twice in test environment. Assertions must tolerate idempotent execution or explicitly assert call counts when needed.

    - Loading state architecture: before asserting a button is disabled during loading, verify whether the element is replaced or unmounted. If unmounted, getByText("Submit") will throw — assert spinner or fallback UI instead.

    - Unhandled promise rejections: after triggering async actions with mockRejectedValueOnce, always resolve state using waitFor or findBy queries within bounded time to ensure rejection is handled inside test scope.

    - waitFor safety rule: always provide a timeout (e.g. { timeout: 2000 }). Never allow unbounded waitFor loops in agent-generated tests.

    - findBy over waitFor: prefer findByRole/findByText/findByLabelText over waitFor(() => getByRole(...)). findBy has built-in timeout, is semantically clearer, and avoids unnecessary waitFor nesting. Use waitFor only when asserting on non-element state (e.g. mock call counts, store updates).

    - WEAK-WAIT RACE (passes locally, fails in CI) — the single most important async rule: NEVER assert hook/component STATE right after a waitFor whose body only checks that a mock was *called*. A mock is called synchronously, BEFORE its promise resolves and before the setState that consumes the result runs. So this races and reads the initial value in slow CI:
        // ❌ BROKEN — waits for the CALL, then reads STATE that isn't set yet
        await waitFor(() => { expect(service.getThing).toHaveBeenCalled(); });
        expect(result.current.items).toEqual(mockItems);   // reads [] in slow CI
      Fix: wait for the work to FINISH (a settle signal), then assert — or put the state assertion itself inside waitFor:
        // ✅ wait for the loading flag to clear (the work is done), THEN read state
        await waitFor(() => {
          expect(service.getThing).toHaveBeenCalled();
          expect(result.current.isLoading).toBe(false);    // settle signal
        });
        expect(result.current.items).toEqual(mockItems);
      Pick the settle signal in this order: (1) isLoading === false (or the hook's loading flag), (2) the asserted value itself inside waitFor, (3) a terminal error/empty state for failure-path tests. NEVER use a signal that is true BEFORE the work finishes (a "was called" check, a synchronously-set ref, or a call count of 1 when more calls are coming). For a hook whose mount effect fires several concurrent fetches that each toggle the same loading flag, wait for the flag to be false (terminal) — never for "the first call happened".

    - CALL-ARG assertions are the exception: reading mock.calls[...] (e.g. expect(service.getThing.mock.calls[0][0].page).toBe(0)) AFTER a call-only waitFor is fine — the call already happened. Only STATE reads (result.current.*, rendered output) need the stronger settle wait. Keep the two kinds distinct: a call-arg check after a call-only wait is correct; a state read after a call-only wait is the bug.

    - Failure-signature → diagnosis (when a CI assertion fails but the test passes locally, it is almost always a weak wait, NOT pollution): "expected [] to deeply equal [ {…} ]" = got initial state instead of resolved data; "expected true to be false" on a loading flag = work still in flight; "expected null to be <error>" = rejection handler hadn't run. Fix by strengthening the waitFor settle signal, not by hunting for pollution. (renderHook/render state is fresh per test and cannot be polluted across files — only module-level singletons/caches can.)

    - Query hierarchy rule:
      1. getByRole (preferred)
      2. getByLabelText
      3. getByPlaceholderText
      4. getByText
      5. getByTestId (last resort)

    - getByText / getByTestId ambiguity: generic strings and reused components may appear multiple times. Use getAllByText()[0], getByRole, or within(container) scoping.

    - Functional state updater assertions: when setState uses updater functions (e.g. setPage(p => p + 1)), do not assert raw mock args. Instead extract updater and execute it.

    - Mock lifecycle rule: prefer mockResolvedValueOnce / mockImplementationOnce for per-test isolation. Always reset mocks in afterEach to prevent leakage.

    - Test isolation rule: assume global state leakage unless explicitly cleaned.
      - afterEach(() => cleanup())
      - afterEach(() => ${mockApi}.clearAllMocks())
      - afterEach(() => ${mockApi}.useRealTimers() if timers are used)
      - never use shared mutable module-level variables between tests without resetting them in beforeEach/afterEach — tests must not depend on mutations from a previous test.

    - Timer determinism: when using fake timers (${mockApi}.useFakeTimers()), always advance explicitly with ${mockApi}.advanceTimersByTime(ms) — never rely on real delays or setTimeout chains. Always restore with ${mockApi}.useRealTimers() in afterEach; fake timers that leak between tests cause unrelated tests to hang or fire callbacks at wrong times.

    - Infinite retry guard: never generate recursive waitFor → trigger → waitFor chains. If a condition does not resolve within a single waitFor block, fail explicitly.

    - React 18 act() flush rule: when an event handler awaits a service mock and then calls setState, do NOT try to wrap the event in await act(async () => { ... }) — act flushes only one microtask level and misses multi-hop mockResolvedValue chains. The correct fix is await waitFor(() => expect(element).toBeInTheDocument()) after the triggering event. waitFor polls inside act until the assertion passes, draining all async hops.
`
}