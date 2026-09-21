export interface HookDestructure {
    hook: string;
    fields: string[];
}
/**
 * Extract the field set the component destructures from each `useXxx()` hook.
 * Renamed fields (`refresh: refreshTx`) yield the SOURCE key (`refresh`) — that's what
 * the mock's return object must expose. Rest elements and defaults' RHS are ignored.
 */
export declare function extractHookDestructures(sourceCode: string): HookDestructure[];
/**
 * True when the error looks like a mock returned an object missing a field the component
 * reads — the class of failure a completeness hint addresses. Assertion/type errors are
 * excluded so the hint doesn't pollute unrelated retries.
 */
export declare function isMissingFieldError(errorOutput: string): boolean;
/**
 * True for an interaction/query failure — an element that never appeared after an action
 * (waitFor timeout, "Unable to find"). In a component whose rendering is driven by mocked
 * hooks, this is very often an INCOMPLETE MOCK SHAPE: a missing sub-field (e.g. a guard reads
 * `activeProfile.kycVerified`, the mock omits it, so the press opens the wrong modal and the
 * awaited element never renders). Surfacing the full hook shape — including object sub-fields —
 * gives the model the fix without a crash to point at.
 */
export declare function isInteractionFailure(errorOutput: string): boolean;
/**
 * Build a "provide the whole hook shape" hint, or null when it doesn't apply.
 * Gated on: (1) the current error is a missing-field error, (2) the component destructures
 * from at least one hook that the test file references (i.e. mocks). Only such hooks are
 * listed, so we never tell the model to mock something it doesn't.
 */
export declare function buildHookMockHint(sourceCode: string | null | undefined, testCode: string | null | undefined, errorOutput: string | null): string | null;
/**
 * Ground assertions about callback outcomes (`expect(showToast).toHaveBeenCalledWith('…')`) in the
 * calls the component ACTUALLY makes. For each hook-provided function field, list the literal
 * first-arguments it's called with in the source. Prevents the model inventing a call the code
 * never makes — e.g. asserting `showToast('Withdrawal method added successfully','success')` when
 * the success path opens a modal and only the ERROR path toasts. Returns null when no such calls
 * exist. Ungated (grounding is always useful); testCode null at generation lists all hooks.
 */
export declare function buildCallbackOutcomeHint(sourceCode: string | null | undefined, testCode: string | null | undefined): string | null;
//# sourceMappingURL=hook-mock-hints.d.ts.map