export function detectReactNative(packageDeps: string | null): boolean {
  if (!packageDeps) return false
  // Safe matching prevents false-positives on web codebases containing loose words
  return /\b(react-native|expo-router|@react-navigation\/native)\b/.test(packageDeps) || /"expo"\s*:/.test(packageDeps)
}

export function buildReactNativeGuidance(): string {
  return [
    'REACT NATIVE PROJECT — use @testing-library/react-native, not @testing-library/react.',
    '- NEVER write `expect(true).toBe(true)` as a render smoke-test — it proves nothing and will be rejected. When a component previously crashed and now renders successfully, assert on at least one element that must be visible: `expect(screen.getByText(\'Some Title\')).toBeTruthy()` or `expect(screen.getByTestId(\'...\')). toBeDefined()`. Read the JSX and pick the first piece of text or testID that is unconditionally rendered.',
    '- READ THE COMPONENT FIRST — before writing any test, read the component file and identify: (1) which hooks are called and exactly which keys are destructured from each; (2) which service methods are called and with what arguments; (3) the exact text strings rendered (titles, button labels, placeholders, empty states, error messages); (4) all conditional rendering branches (loading states, feature flags, KYC status, permission checks); (5) multi-step modal/navigation flows. Every test must be traceable to a specific line of JSX — if you cannot point to where a text string or UI element is rendered in the component, do not write that assertion.',

    '- MOCK SHAPE MUST MATCH HOOK DESTRUCTURE EXACTLY: grep the component for `const { ... } = useHookName()` and copy every destructured key into the mock return value. Missing keys are silently `undefined` and cause crashes or broken UI (e.g. a missing numeric threshold makes validation always false, a missing string inserts "undefined" into rendered text). Wrong keys (extra properties the component never reads) are harmless but missing ones are always bugs. Every mock must include a sensible default for every key the component destructures.',

    '- SERVICE METHOD NAMES: grep the component for `ServiceName.method(` and copy the exact method name verbatim — a single-letter difference (`getDrawResult` vs `getDrawResults`, `swapBerries` vs `redeemBerries`) silently attaches the mock to a nonexistent property, leaving the real method un-mocked. Never infer method names from intent; always read the call site.',

    '- MOCK DATA COMPLETENESS: mock object factory helpers must include every field the component accesses — especially arrays. If the component does `item.my_tickets.length`, `.map(...)`, or `.some(...)`, a mock missing `my_tickets` throws `TypeError: Cannot read properties of undefined`. Scan the component for every property access on each mock object and include them all with safe defaults (`[]`, `0`, `false`, `\'\'`).',

    '- MOCK ALL SERVICE METHODS IN beforeEach: grep the component for every method called on each mocked service — not just the methods a particular test exercises. The component may reach other methods via useEffect on mount or via user interaction in other branches. Every method must have a mockResolvedValue (or mockReturnValue for sync) in beforeEach. A missing method returns undefined, and `undefined.then(...)` in a useEffect crashes ALL tests silently.',

    '- MODULE-LEVEL HOOK MOCK MUST BE jest.fn(): when a hook is mocked at module level with `jest.mock(\'../useHook\', () => ({ useHook: ... }))`, the returned value must be `jest.fn()` — not a plain object. A plain object has no `.mockImplementation` / `.mockReturnValue` methods, so tests that try to override the mock per-test will throw "is not a function". Always:\n  jest.mock(\'../useHook\', () => ({ useHook: jest.fn() }))\n  beforeEach(() => { (useHook as jest.Mock).mockReturnValue({ loading: false, ... }) })',

    '- FACTORY FUNCTIONS FOR DEFAULT MOCK CONTEXTS: any default mock return value that contains jest.fn() must be defined as a factory function, NOT a plain object:\n  // WRONG — jest.fn() instances created once; jest.clearAllMocks() clears them, all tests share stale refs\n  const defaultCtx = { signIn: jest.fn(), showToast: jest.fn() };\n  // RIGHT — fresh jest.fn() instances per test\n  const defaultCtx = () => ({ signIn: jest.fn(), showToast: jest.fn() });\n  beforeEach(() => { (useApp as jest.Mock).mockReturnValue(defaultCtx()); })\n  This matters because jest.clearAllMocks() (in afterEach) strips implementations from every jest.fn() — if tests share module-level instances, subsequent tests see undefined returns.',

    '- UNIQUE MOCK LIST DATA: when generating arrays of mock objects, use unique values for every field the test will query on. A factory stamping the same `description: \'Survey reward\'` onto 3 transactions causes `getByText(\'Survey reward\')` to throw "Found multiple elements". Use:\n  [mockTx({ description: \'Survey reward\' }), mockTx({ description: \'Referral bonus\' })]',
    "- Import render, screen, fireEvent, waitFor from '@testing-library/react-native'",
    '- No document, window, or localStorage globals — they do not exist in React Native',
    "- Mock react-native modules with jest.mock('react-native', ...)",
    '- Use fireEvent.press() not fireEvent.click() for Pressable/TouchableOpacity',
    "- Async state / act() warnings: ALWAYS use waitFor() from '@testing-library/react-native' (not '@testing-library/react') when asserting on state that changes after an async service call. waitFor() wraps polling in act() automatically and handles multi-hop promise chains. Do NOT use `await act(async () => { ... })` as a substitute — it only flushes one microtask level and misses state updates from mockResolvedValue chains. Exact pattern:\n  await fireEvent.press(submitButton)\n  await waitFor(() => expect(screen.getByText('Success')).toBeTruthy())\n  If you see the console.error 'An update to X inside a test was not wrapped in act(...)' it means this waitFor() is missing after an event that triggers async setState.",
    '- ALL mock functions must use jest.fn() — do NOT mix vi.fn() and jest.fn() in the same project',
    "- Mock component props: use ViewProps from react-native (NOT Record<string, unknown>) when spreading props into a <View> mock. Record<string, unknown> conflicts with View's ref: React.Ref<View> and causes ts(2352). Pattern:\n  import { View, type ViewProps } from 'react-native'\n  const MockFoo = (props: ViewProps) => <View testID=\"foo\" {...props} />",

    '- "render function has not been called": TWO causes — (1) forgot to await render() — RNTL v14 render() is async, should be awaited in async tests; or (2) component threw during render (missing mock, undefined import). Check both before diagnosing screen queries.',

    '- RNTL v14 — render() IS ASYNC: test should be async and render should typically be awaited: `await render(<Screen />)`. Without awaiting async updates, act() may not flush and screen queries can fail with "render function has not been called".',

    '- useEffect MICROTASK FLUSH: `await render()` flushes all pending microtasks via act(), so any state set by a useEffect that calls mockResolvedValue (e.g. fetching data on mount) is already committed before the first assertion runs. You do NOT need an extra waitFor after render for mount-time data fetches — the state is already there. Use waitFor only when testing flows that trigger further async state changes after user interaction.',

    '- RNTL v14 — fireEvent SHOULD BE AWAITED: prefer `await fireEvent.press(...)` and `await fireEvent.changeText(...)` so updates flush before assertions. Missing await is the hardest bug to diagnose — the handler fires with stale state (e.g. redeemValid=false) and returns early silently. The tree dump is misleading: by the time it prints, async state has settled so it shows the correct value even though the handler already ran with the wrong one.',

    '- LOADING STATE — controlled Promise pattern: do NOT await the press when testing loading UI. Instead: (1) const pressPromise = fireEvent.press(btn); (2) await waitFor(() => expect(screen.getByTestId("activity-indicator")).toBeTruthy()); (3) resolve mock; (4) await pressPromise. Skipping step 4 leaves open act() scope that corrupts subsequent tests.',

    '- ACT IMPORT RULE: NEVER import or call `act` from `@testing-library/react-native` directly. RNTL registers an afterEach that calls cleanup() using its own internal act — if your test code also calls RNTL\'s exported `act`, the scopes overlap and corrupt RNTL\'s internal `screen` state, making ALL subsequent screen.* queries in the file throw "render function has not been called". Use `waitFor` from RNTL for async assertions. If you need to flush Promises at the top level of a test outside of waitFor, use:\n  import { act } from \'react\'  // safe — base implementation, no RNTL scope conflict\n  await act(async () => {})    // flushes pending microtasks/state updates',

    // ICON/COMPONENT MOCKS
    '- ICON LIBRARY MOCKS — GREP EVERY IMPORT: before writing a mock for any icon library (lucide-react-native, @expo/vector-icons, react-native-vector-icons, etc.), grep the COMPONENT FILE for every icon name imported from that library and add each one to the mock. Missing even one causes "Element type is invalid: expected a string or class/function but got: undefined" at render. Pattern:\n  jest.mock(\'lucide-react-native\', () => ({\n    User: () => null,\n    Mail: () => null,   // ← was missing — add every icon the component imports\n    ChevronRight: () => null,\n  }))',
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

    '- FRAGMENT-WRAPPED BUTTON TEXT: when a TouchableOpacity\'s text is wrapped in a Fragment (`<>{...}</>`) or a conditional branch, `getByText(\'Label\')` returns the inner `<Text>` node. RNTL\'s fiber traversal upward to find `onPress` can fail at the Fragment boundary — `fireEvent.press` silently does nothing. Fix: add `testID` to the outer `TouchableOpacity` or `Pressable` and press by ID:\n  // Component: <TouchableOpacity testID="submit-btn" onPress={handleSubmit}>\n  await fireEvent.press(screen.getByTestId(\'submit-btn\'))\n  `Pressable` handles this more reliably than `TouchableOpacity` for the same reason.',

    '- MODAL CONTENT IN TEST ENV: React Native\'s `<Modal>` mock may render its children even when `visible={false}`. This puts hidden modal content into the query tree. A regex like `/Withdraw/i` may match both the "Withdraw" button AND "Berries to Withdraw" inside a closed modal. Prefer exact string matching for short/common words:\n  screen.getByText(\'Withdraw\')           // exact — safe\n  screen.getByText(/Withdraw/i)           // regex — may multi-match\n  Also: after pressing a button that calls setState to open a Modal, the re-render is async — wrap post-press Modal assertions in waitFor:\n  await fireEvent.press(screen.getByText(\'Open\'))\n  await waitFor(() => expect(screen.getByText(\'Modal Title\')).toBeTruthy())',

    "- DISABLED TouchableOpacity: fireEvent.press is blocked automatically when disabled={true}",

    "- TEST CASCADE: one failing test can corrupt all later tests due to open act() scope or render crash. Always fix FIRST failure first.",
  ].join('\n')
}

export function detectRntlErrors(errorOutput: string): string | null {
  const lines: string[] = []

  if (/Element type is invalid/i.test(errorOutput) || /expected a string.*but got.*undefined/i.test(errorOutput)) {
    lines.push(
      'CRITICAL: A component resolved to undefined — most likely an icon not in the mock.',
      'Check in this order:',
      '1. ICON LIBRARY MOCK INCOMPLETE: grep the component for every icon imported from lucide-react-native / @expo/vector-icons / react-native-vector-icons. Add every missing icon to the mock. A single missing icon causes this error at render.',
      '2. Named vs default import mismatch in another mock.',
      '3. Missing exports in a barrel file mock.',
      '4. Mock factory not returning the required key.',
      'Fix: grep the component file for all imports from the failing module and ensure each one appears in the mock.'
    )
  }

  if (/Failed to create a worklet/i.test(errorOutput) || /useSharedValue/i.test(errorOutput) || /Reanimated/i.test(errorOutput)) {
    lines.push(
      'Reanimated not configured for Jest.',
      "Fix: jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));"
    )
  }

  if (/AsyncStorage/i.test(errorOutput)) {
    lines.push(
      'AsyncStorage mock missing.',
      "Fix: jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));"
    )
  }

  if (/react-native-gesture-handler/i.test(errorOutput) || /PanGestureHandler/i.test(errorOutput)) {
    lines.push(
      'Gesture Handler missing setup.',
      "Fix: import 'react-native-gesture-handler' at test setup entry."
    )
  }

  if (/NativeEventEmitter/i.test(errorOutput)) {
    lines.push(
      'NativeEventEmitter requires a mocked native module.',
      'Fix: mock the underlying native module dependency.'
    )
  }

  if (/useRouter/i.test(errorOutput) || /router\.(push|replace|back)/i.test(errorOutput)) {
    lines.push(
      'Expo Router not mocked.',
      "Fix: jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }) }));"
    )
  }

  if (
    (/Cannot read properties of undefined/i.test(errorOutput) && /navigate/i.test(errorOutput)) ||
    (/invariant violation/i.test(errorOutput) && /navigation/i.test(errorOutput))
  ) {
    lines.push(
      'React Navigation missing mock.',
      "Fix: jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));"
    )
  }

  if (/not wrapped in act\b/i.test(errorOutput) || /An update to .+ inside a test was not wrapped in act/i.test(errorOutput)) {
    lines.push(
      'ACT() WARNING: An async state update (setX / setState) fired after the test finished flushing.',
      'Root cause: an event handler awaits a service call (mockResolvedValue), then calls setState.',
      'The test fired the event but did not wait for those async state changes to settle before asserting.',
      'REQUIRED FIX — use waitFor() after the triggering event:',
      '  await fireEvent.press(submitButton)     // or fireEvent.changeText, etc.',
      '  await waitFor(() => {',
      '    expect(screen.getByText("Success")).toBeTruthy()  // assert on state AFTER the async work',
      '  })',
      'waitFor() polls the assertion inside act() automatically and drains all microtask hops.',
      'Do NOT try to fix this with `await act(async () => { ... })` — act() only flushes one',
      'microtask level and will miss state updates from multi-hop mockResolvedValue chains.',
      'Import waitFor from your project\'s testing library (@testing-library/react-native or @testing-library/react).',
    )
  }

  if (/render function has not been called/i.test(errorOutput)) {
    lines.push(
      'Render did not complete — three possible causes:',
      '(1) render() not awaited — in RNTL v14 render() is async, must be awaited.',
      '(2) Component threw during render — check for missing mocks or undefined imports.',
      '(3) `act` imported from @testing-library/react-native — this overlaps with RNTL\'s',
      '    internal cleanup act and corrupts screen state for ALL queries in the file.',
      '    Fix: remove that import. Use `waitFor` for assertions; use `import { act } from \'react\'`',
      '    only if you need top-level promise flushing outside of waitFor.'
    )
  }

  if (/Nothing was returned from render/i.test(errorOutput)) {
    lines.push(
      'A component mock returned undefined.',
      'Fix: replace jest.fn(() => null) with () => null for stateless mocks.'
    )
  }

  return lines.length ? lines.join('\n') : null
}