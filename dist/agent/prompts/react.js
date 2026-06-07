// React web component testing guidance (non-RN, non-Next.js)
export function buildReactCauses(isJSRunner, mockApi) {
    if (!isJSRunner)
        return '';
    return `
    - "renders without crashing" tests: NEVER write \`expect(true).toBe(true)\` as a render smoke-test. It proves nothing and will be rejected. Instead, assert on at least one element that must be visible: \`expect(screen.getByText('Some Heading')).toBeTruthy()\` or \`expect(screen.getByTestId('...')).toBeDefined()\`. Read the component's JSX to find a reliable element — a title, a label, a button text.

    - React 18 act() async rule: ALWAYS await act() when it wraps async code. Unawaited act() calls cause state to leak across tests, producing "Cannot read properties of null" failures in unrelated tests.

    - Act batching boundary: multiple state updates triggered in the same tick must be wrapped in a single act() block to avoid partial render assertions.

    - React 18 Strict Mode double-invocation: effects and event handlers may run twice in test environment. Assertions must tolerate idempotent execution or explicitly assert call counts when needed.

    - Loading state architecture: before asserting a button is disabled during loading, verify whether the element is replaced or unmounted. If unmounted, getByText("Submit") will throw — assert spinner or fallback UI instead.

    - Unhandled promise rejections: after triggering async actions with mockRejectedValueOnce, always resolve state using waitFor or findBy queries within bounded time to ensure rejection is handled inside test scope.

    - waitFor safety rule: always provide a timeout (e.g. { timeout: 2000 }). Never allow unbounded waitFor loops in agent-generated tests.

    - findBy over waitFor: prefer findByRole/findByText/findByLabelText over waitFor(() => getByRole(...)). findBy has built-in timeout, is semantically clearer, and avoids unnecessary waitFor nesting. Use waitFor only when asserting on non-element state (e.g. mock call counts, store updates).

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

    - React 18 act() flush rule: wrap async mock resolutions in await act(async () => {}) before test exit to flush pending updates.
`;
}
//# sourceMappingURL=react.js.map