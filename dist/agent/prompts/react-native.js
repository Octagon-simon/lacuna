export function detectReactNative(packageDeps) {
    if (!packageDeps)
        return false;
    // Safe matching prevents false-positives on web codebases containing loose words
    return /\b(react-native|expo-router|@react-navigation\/native)\b/.test(packageDeps) || /"expo"\s*:/.test(packageDeps);
}
export function buildReactNativeGuidance() {
    return [
        'REACT NATIVE PROJECT — use @testing-library/react-native, not @testing-library/react.',
        '- NEVER write `expect(true).toBe(true)` as a render smoke-test — it proves nothing and will be rejected. When a component previously crashed and now renders successfully, assert on at least one element that must be visible: `expect(screen.getByText(\'Some Title\')).toBeTruthy()` or `expect(screen.getByTestId(\'...\')). toBeDefined()`. Read the JSX and pick the first piece of text or testID that is unconditionally rendered.',
        '- READ THE COMPONENT FIRST — before writing any test, read the component file and identify: (1) which hooks are called and exactly which keys are destructured from each; (2) which service methods are called and with what arguments; (3) the exact text strings rendered (titles, button labels, placeholders, empty states, error messages); (4) all conditional rendering branches (loading states, feature flags, KYC status, permission checks); (5) multi-step modal/navigation flows. Every test must be traceable to a specific line of JSX — if you cannot point to where a text string or UI element is rendered in the component, do not write that assertion.',
        '- MOCK SHAPE MUST MATCH HOOK DESTRUCTURE EXACTLY: grep the component for `const { ... } = useHookName()` and copy every destructured key into the mock return value. Missing keys are silently `undefined` and cause crashes or broken UI (e.g. a missing numeric threshold makes validation always false, a missing string inserts "undefined" into rendered text). Wrong keys (extra properties the component never reads) are harmless but missing ones are always bugs. Every mock must include a sensible default for every key the component destructures.',
        '- SERVICE METHOD NAMES: grep the component for `ServiceName.method(` and copy the exact method name verbatim — a single-letter difference (`getDrawResult` vs `getDrawResults`, `swapBerries` vs `redeemBerries`) silently attaches the mock to a nonexistent property, leaving the real method un-mocked. Never infer method names from intent; always read the call site.',
        '- MOCK DATA COMPLETENESS: mock object factory helpers must include every field the component accesses — especially arrays. If the component does `item.my_tickets.length`, `.map(...)`, or `.some(...)`, a mock missing `my_tickets` throws `TypeError: Cannot read properties of undefined`. Scan the component for every property access on each mock object and include them all with safe defaults (`[]`, `0`, `false`, `\'\'`).',
        "- Import render, screen, fireEvent, waitFor from '@testing-library/react-native'",
        '- No document, window, or localStorage globals — they do not exist in React Native',
        "- Mock react-native modules with jest.mock('react-native', ...)",
        '- Use fireEvent.press() not fireEvent.click() for Pressable/TouchableOpacity',
        "- Async state: use waitFor() from '@testing-library/react-native', not from '@testing-library/react'",
        '- ALL mock functions must use jest.fn() — do NOT mix vi.fn() and jest.fn() in the same project',
        "- Mock component props: use ViewProps from react-native (NOT Record<string, unknown>) when spreading props into a <View> mock. Record<string, unknown> conflicts with View's ref: React.Ref<View> and causes ts(2352). Pattern:\n  import { View, type ViewProps } from 'react-native'\n  const MockFoo = (props: ViewProps) => <View testID=\"foo\" {...props} />",
        '- "render function has not been called": TWO causes — (1) forgot to await render() — RNTL v14 render() is async, should be awaited in async tests; or (2) component threw during render (missing mock, undefined import). Check both before diagnosing screen queries.',
        '- RNTL v14 — render() IS ASYNC: test should be async and render should typically be awaited: `await render(<Screen />)`. Without awaiting async updates, act() may not flush and screen queries can fail with "render function has not been called".',
        '- useEffect MICROTASK FLUSH: `await render()` flushes all pending microtasks via act(), so any state set by a useEffect that calls mockResolvedValue (e.g. fetching data on mount) is already committed before the first assertion runs. You do NOT need an extra waitFor after render for mount-time data fetches — the state is already there. Use waitFor only when testing flows that trigger further async state changes after user interaction.',
        '- RNTL v14 — fireEvent SHOULD BE AWAITED: prefer `await fireEvent.press(...)` and `await fireEvent.changeText(...)` so updates flush before assertions. Missing await can cause state updates not to commit.',
        '- LOADING STATE — controlled Promise pattern: do NOT await the press when testing loading UI. Instead: (1) const pressPromise = fireEvent.press(btn); (2) await waitFor(() => expect(screen.getByTestId("activity-indicator")).toBeTruthy()); (3) resolve mock; (4) await pressPromise. Skipping step 4 leaves open act() scope that corrupts subsequent tests.',
        // ICON/COMPONENT MOCKS
        '- ICON/COMPONENT MOCKS (Stateless): For simple stubs where you do NOT assert call counts, use plain functions `() => null`. Never use jest.fn(() => null) because clearAllMocks() strips implementations, causing "Nothing was returned from render".',
        `- COMPOUND COMPONENT MOCKS (e.g. expo-router Tabs): Mock them using a static factory:\n  jest.mock('expo-router', () => {\n    const MockComponent = ({ children }) => children;\n    MockComponent.Screen = () => null;\n    return {\n      Tabs: MockComponent,\n      Link: () => null,\n      useRouter: () => ({\n        push: jest.fn(),\n        replace: jest.fn(),\n        back: jest.fn(),\n      }),\n    };\n  });`,
        // CRUCIAL NATIVE INFRASTRUCTURE MOCKS
        "- NATIVE ANIMATION DRIVER MOCK: jest.mock('react-native/Libraries/Animated/nativeWithAnimated', () => ({}));",
        "- REANIMATED MOCK: jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));",
        "- ASYNC STORAGE MOCK: jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));",
        "- SAFE AREA CONTEXT MOCK: jest.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: ({ children }) => children, SafeAreaView: ({ children }) => children, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));",
        "- VECTOR ICONS MOCK: jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null, Ionicons: () => null }));",
        // STATE & NAVIGATION
        "- REACT NAVIGATION MOCK: jest.mock('@react-navigation/native', () => ({ ...jest.requireActual('@react-navigation/native'), useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }), useRoute: () => ({ params: {} }) }));",
        "- useFocusEffect MOCK: mock as a no-op to keep the view at its initial useState value and prevent navigation side-effects during test setup: `jest.mock('@react-navigation/native', () => ({ useFocusEffect: jest.fn() }))`. If you need to test a specific view driven by route params, call the callback in the mock AND mock `useLocalSearchParams` to return the target params: `useFocusEffect: jest.fn((cb) => cb())`.",
        "- ZUSTAND STORE RESET: use act() when mutating store state in tests:\n  act(() => { useMyStore.setState({ user: mockUser }); });",
        "- REDUX REQUIREMENT: must wrap tested components in Provider with mock store",
        '- UI TEXT — copy verbatim from the component: text strings in assertions must match the component exactly — punctuation ("No transactions yet." with period), case ("100 berries" not "Berries"), and Unicode characters (`…` U+2026 HORIZONTAL ELLIPSIS is not the same as `...` three dots). A one-character mismatch causes getByText to throw even though the element is present. When in doubt, read the JSX.',
        "- DYNAMIC TEXT TEMPLATES: when the component renders a string built from state (e.g. `No ${activeStatus} draws right now` or `Buy ${quantity} Ticket${quantity > 1 ? 's' : ''}`), trace your mock's return value to compute the exact rendered string. With `activeStatus: 'open'` the text is `'No open draws right now'`. With `quantity: 1` the button says `'Buy 1 Ticket'`. Always derive the expected string from mock state — never guess the label.",
        '- TOAST VS SCREEN TEXT — check the catch/success block before asserting screen text: if the component calls `showToast(message, ...)` in a catch block, nothing is rendered on screen — assert `expect(showToast).toHaveBeenCalledWith(\'Exact message\', ...)` instead. For error flows use `mockRejectedValue(new Error(\'...\'))`, not `mockResolvedValue({ success: false })`. For success flows that only call `showToast` and clear state (no success screen rendered), also assert on `showToast`. Never write `screen.getByText(\'...\')` for text that goes to a toast service.',
        "- BUTTON QUERIES: getAllByRole('button') does NOT reliably match TouchableOpacity. Prefer getAllByText('Label') or testID.",
        '- ICON-ONLY BUTTONS: if a TouchableOpacity contains only an icon component (mocked as `() => null`) with no text, testID, or accessibilityLabel, it cannot be queried in RNTL v14. Do not invent a text label that is not in the JSX. Options: (1) skip that test with a comment explaining why; (2) add a `testID` to the component. Never use `UNSAFE_getAllByType` — removed in RNTL v14.',
        "- DISABLED TouchableOpacity: fireEvent.press is blocked automatically when disabled={true}",
        "- TEST CASCADE: one failing test can corrupt all later tests due to open act() scope or render crash. Always fix FIRST failure first.",
    ].join('\n');
}
export function detectRntlErrors(errorOutput) {
    const lines = [];
    if (/Element type is invalid/i.test(errorOutput) || /expected a string.*but got.*undefined/i.test(errorOutput)) {
        lines.push('CRITICAL: Component import resolved to undefined.', 'Check:', '1. Named vs default import mismatch', '2. Missing exports in barrel files', '3. Mock factories not returning required keys', 'Fix: verify import paths before test assertions.');
    }
    if (/Failed to create a worklet/i.test(errorOutput) || /useSharedValue/i.test(errorOutput) || /Reanimated/i.test(errorOutput)) {
        lines.push('Reanimated not configured for Jest.', "Fix: jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));");
    }
    if (/AsyncStorage/i.test(errorOutput)) {
        lines.push('AsyncStorage mock missing.', "Fix: jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));");
    }
    if (/react-native-gesture-handler/i.test(errorOutput) || /PanGestureHandler/i.test(errorOutput)) {
        lines.push('Gesture Handler missing setup.', "Fix: import 'react-native-gesture-handler' at test setup entry.");
    }
    if (/NativeEventEmitter/i.test(errorOutput)) {
        lines.push('NativeEventEmitter requires a mocked native module.', 'Fix: mock the underlying native module dependency.');
    }
    if (/useRouter/i.test(errorOutput) || /router\.(push|replace|back)/i.test(errorOutput)) {
        lines.push('Expo Router not mocked.', "Fix: jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }) }));");
    }
    if ((/Cannot read properties of undefined/i.test(errorOutput) && /navigate/i.test(errorOutput)) ||
        (/invariant violation/i.test(errorOutput) && /navigation/i.test(errorOutput))) {
        lines.push('React Navigation missing mock.', "Fix: jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));");
    }
    if (/render function has not been called/i.test(errorOutput)) {
        lines.push('Render did not complete.', 'Check: (1) render not awaited (2) component threw during render due to missing mock.');
    }
    if (/Nothing was returned from render/i.test(errorOutput)) {
        lines.push('A component mock returned undefined.', 'Fix: replace jest.fn(() => null) with () => null for stateless mocks.');
    }
    return lines.length ? lines.join('\n') : null;
}
//# sourceMappingURL=react-native.js.map