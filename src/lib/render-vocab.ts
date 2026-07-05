// Render-vocabulary extraction.
//
// Testing-library assertions (`getByText`, `getByRole`, `getByTestId`, `getByPlaceholderText`,
// `getByLabelText`) target strings the component actually renders. When a large component is
// skeletonized for the prompt, or when the generator hasn't yet seen the render body, the model
// invents plausible-but-wrong labels (e.g. asserting `getByText('Total Balance')` when the
// component renders `'Available Balance'`). This extracts the real render vocabulary from the
// FULL source so the prompt can ground assertions in it.

export interface RenderVocab {
  text: string[]
  testIds: string[]
  placeholders: string[]
  labels: string[]
  roles: string[]
}

function pushMatches(re: RegExp, source: string, sink: Set<string>, opts?: { requireLetter?: boolean; maxLen?: number }): void {
  const requireLetter = opts?.requireLetter ?? true
  const maxLen = opts?.maxLen ?? 60
  for (const m of source.matchAll(re)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!raw || raw.length > maxLen) continue
    if (requireLetter && !/[A-Za-z]/.test(raw)) continue
    sink.add(raw)
  }
}

/**
 * Extract rendered text, testIDs, placeholders, accessibility labels and roles from JSX source.
 * Deliberately conservative — single-line literal captures only, dynamic `{expr}` content skipped.
 */
export function extractRenderedStrings(sourceCode: string): RenderVocab {
  const text = new Set<string>()
  const testIds = new Set<string>()
  const placeholders = new Set<string>()
  const labels = new Set<string>()
  const roles = new Set<string>()

  // JSX leaf text: `>Some Text</` — text immediately followed by a CLOSING tag. Requiring `</`
  // (not a bare `<`) is what separates real JSX text from `<`/`>` used as comparison operators or
  // TS generics in code (`a > b`, `useState<Foo>`), which never have `</` after. No braces/newlines
  // inside, so `>{expr}<` dynamic content and multi-line code spans are skipped.
  pushMatches(/>\s*([^<>{}\n]*[A-Za-z][^<>{}\n]*?)\s*<\//g, sourceCode, text)

  // testID="x" | 'x' | {"x"}
  pushMatches(/testID=(?:"([^"]+)"|'([^']+)'|\{\s*['"]([^'"]+)['"]\s*\})/g, sourceCode, testIds, { requireLetter: false })

  // placeholder / placeholderText
  pushMatches(/placeholder(?:Text)?=(?:"([^"]+)"|'([^']+)')/g, sourceCode, placeholders)

  // accessibilityLabel / accessibilityHint / aria-label / title / label
  pushMatches(/(?:accessibilityLabel|accessibilityHint|aria-label|title|label)=(?:"([^"]+)"|'([^']+)')/g, sourceCode, labels)

  // accessibilityRole / role
  pushMatches(/(?:accessibilityRole|role)=(?:"([^"]+)"|'([^']+)')/g, sourceCode, roles, { requireLetter: false, maxLen: 30 })

  return {
    text: [...text],
    testIds: [...testIds],
    placeholders: [...placeholders],
    labels: [...labels],
    roles: [...roles],
  }
}

const CAP = 50

function line(label: string, items: string[], quote: boolean): string | null {
  if (items.length === 0) return null
  const shown = items.slice(0, CAP).map(s => (quote ? `"${s}"` : s))
  const more = items.length > CAP ? `, …(+${items.length - CAP} more)` : ''
  return `  ${label}: ${shown.join(', ')}${more}`
}

/**
 * Build a compact "COMPONENT RENDERS" prompt section, or null if the source renders nothing
 * assertable (non-component files). Grounds getBy* assertions in the real render output.
 */
export function buildRenderVocabSection(sourceCode: string | null | undefined): string | null {
  if (!sourceCode || !/<[A-Za-z]/.test(sourceCode)) return null   // no JSX → not a component
  const v = extractRenderedStrings(sourceCode)
  const rows = [
    line('Text', v.text, true),
    line('testID', v.testIds, false),
    line('placeholder', v.placeholders, true),
    line('accessibilityLabel/title', v.labels, true),
    line('role', v.roles, false),
  ].filter((r): r is string => r !== null)
  if (rows.length === 0) return null

  return (
    'COMPONENT RENDERS — assert ONLY against these actual rendered strings. Do NOT invent labels or values: ' +
    'getByText / getByRole / getByTestId / getByPlaceholderText must use text that appears below. ' +
    'If a displayed number is computed (e.g. a sum), read the JSX expression in the source and assert the computed result, not a raw mock field.\n' +
    rows.join('\n')
  )
}
