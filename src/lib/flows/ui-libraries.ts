// Library-aware data-testid injection.
//
// Most UI libraries forward data-* attributes straight to the root DOM element, so a plain
// `data-testid` on the component usage reaches the DOM. The notable exception is INPUT wrappers
// (e.g. Material UI's TextField), where the rendered root is a wrapper and the attribute must be
// routed to the inner <input> via a documented prop (`inputProps`). The conservative injection
// prompt forbids GUESSING prop bags; this module detects a known library from a component's
// imports and supplies its DOCUMENTED forwarding convention so the model can place the testid
// correctly instead of guessing or skipping. It is advisory — the empirical verify-and-revert in
// e2e-loop still backstops every injection (a testid that doesn't reach the DOM is reverted).

export interface UiLibrary {
  name: string
  guidance: string
}

interface LibrarySpec {
  name: string
  // Precise signal
  test: (code: string) => boolean
  // package.json fallback
  packages: string[]
  guidance: string
}

const GENERIC_GUIDANCE =
  'Do NOT add data-testid to fragments, providers, context wrappers, motion components, layout-only containers, Suspense boundaries, FormField/FormControl wrappers, or styling-only wrappers. Prefer attaching testids to the actual interactive DOM element a user can click, type into, focus, select, or submit.'

const LIBRARIES: LibrarySpec[] = [
  {
    name: 'Material UI',
    test: (c) =>
      /from\s+['"]@mui\/(?:material|joy|base)/.test(c) ||
      /from\s+['"]@material-ui\/core/.test(c),
    packages: ['@mui/', '@material-ui/'],
    guidance:
      'Material UI: most components (Button, IconButton, Chip, Link, Tab, MenuItem) forward data-testid to their root DOM element. TEXT INPUTS (TextField, Input, OutlinedInput, Select) render wrappers, so route testids via inputProps={{ "data-testid": "<id>" }} (v5) or slotProps={{ htmlInput: { "data-testid": "<id>" } }} (v6).'
  },
  {
    name: 'Radix UI',
    test: (c) => /from\s+['"]@radix-ui\//.test(c),
    packages: ['@radix-ui/'],
    guidance:
      'Radix UI primitives forward arbitrary props to the rendered element. Place data-testid directly on the component usage.'
  },
  {
    name: 'shadcn/ui',
    test: (c) =>
      /from\s+['"](?:@\/|[^'"]*\/)components\/ui\//.test(c),
    packages: [],
    guidance:
      'shadcn/ui components are usually thin wrappers around Radix primitives and forward props. Place data-testid directly on the usage.'
  },
  {
    name: 'Chakra UI',
    test: (c) =>
      /from\s+['"]@chakra-ui\//.test(c),
    packages: ['@chakra-ui/'],
    guidance:
      'Chakra UI components forward data-* attributes to underlying DOM elements.'
  },
  {
    name: 'Mantine',
    test: (c) =>
      /from\s+['"]@mantine\//.test(c),
    packages: ['@mantine/'],
    guidance:
      'Mantine components forward data-* attributes to the rendered root.'
  },
  {
    name: 'Ant Design',
    test: (c) =>
      /from\s+['"]antd(?:['"]|\/)/.test(c),
    packages: ['antd'],
    guidance:
      'Ant Design components generally forward data-testid to their root DOM element.'
  },
  {
    name: 'React Aria',
    test: (c) =>
      /from\s+['"]react-aria/.test(c) ||
      /from\s+['"]react-stately/.test(c),
    packages: [
      'react-aria',
      'react-stately'
    ],
    guidance:
      'React Aria components and hooks typically spread props onto rendered DOM elements. Put data-testid on the receiving element or component usage. Do not invent slot props.'
  },
  {
    name: 'Headless UI',
    test: (c) =>
      /from\s+['"]@headlessui\//.test(c),
    packages: ['@headlessui/'],
    guidance:
      'Headless UI components forward arbitrary props. When using the "as" prop, attach data-testid to the ultimately rendered element.'
  },
  {
    name: 'Ark UI',
    test: (c) =>
      /from\s+['"]@ark-ui\//.test(c),
    packages: ['@ark-ui/'],
    guidance:
      'Ark UI primitives forward arbitrary props to DOM elements. Place data-testid directly on the usage.'
  },
  {
    name: 'HeroUI / NextUI',
    test: (c) =>
      /from\s+['"]@(?:nextui-org|heroui)\//.test(c),
    packages: [
      '@nextui-org/',
      '@heroui/'
    ],
    guidance:
      'HeroUI/NextUI components generally forward data-* attributes to their rendered root.'
  },
  {
    name: 'React Hook Form',
    test: (c) =>
      /from\s+['"]react-hook-form/.test(c),
    packages: ['react-hook-form'],
    guidance:
      'React Hook Form wrappers such as FormField and FormControl are often composition helpers rather than DOM nodes. Prefer injecting testids onto the underlying input, textarea, select, checkbox, or button.'
  },
  {
    name: 'React Bootstrap',
    test: (c) =>
      /from\s+['"]react-bootstrap/.test(c),
    packages: ['react-bootstrap'],
    guidance:
      'React Bootstrap components forward arbitrary DOM props. Place data-testid directly on component usage.'
  },
  {
    name: 'Semantic UI React',
    test: (c) =>
      /from\s+['"]semantic-ui-react/.test(c),
    packages: ['semantic-ui-react'],
    guidance:
      'Semantic UI React components generally forward data-* attributes to their root DOM element.'
  },
  {
    name: 'PrimeReact',
    test: (c) =>
      /from\s+['"]primereact\//.test(c),
    packages: ['primereact'],
    guidance:
      'PrimeReact components generally forward data-* attributes to rendered elements. Prefer placing testids directly on the component usage.'
  },
  {
    name: 'BlueprintJS',
    test: (c) =>
      /from\s+['"]@blueprintjs\//.test(c),
    packages: ['@blueprintjs/'],
    guidance:
      'BlueprintJS components generally forward arbitrary DOM props to rendered elements.'
  }
]

export function detectUiLibraries(
  sourceCode: string,
  depNames: string[] = [],
): UiLibrary[] {

  const detected = new Map<string, LibrarySpec>()

  for (const lib of LIBRARIES) {
    if (lib.test(sourceCode)) {
      detected.set(lib.name, lib)
    }
  }

  for (const lib of LIBRARIES) {
    const matched = lib.packages.some((prefix) =>
      depNames.some(
        (dep) =>
          dep === prefix ||
          dep.startsWith(prefix),
      ),
    )

    if (matched) {
      detected.set(lib.name, lib)
    }
  }

  return [...detected.values()].map((l) => ({
    name: l.name,
    guidance: l.guidance,
  }))
}

// Match a SINGLE import module specifier to a known library (by package-name prefix, or shadcn's
// conventional components/ui/ path). Used by the import-chain resolver to identify a library from
// a direct import or a barrel re-export.
export function libraryForModule(spec: string): UiLibrary | null {
  for (const lib of LIBRARIES) {
    if (lib.packages.some((p) => spec === p || spec.startsWith(p))) {
      return { name: lib.name, guidance: lib.guidance }
    }
  }
  if (/(?:^|\/)components\/ui\//.test(spec)) {
    const sc = LIBRARIES.find((l) => l.name === 'shadcn/ui')
    if (sc) return { name: sc.name, guidance: sc.guidance }
  }
  return null
}

// Libraries present in the project's installed dependencies — the fallback signal when the import
// chain can't be resolved (e.g. an unresolvable alias or a re-export we couldn't follow).
export function librariesFromDeps(depNames: string[]): UiLibrary[] {
  return LIBRARIES
    .filter((l) => l.packages.some((p) => depNames.some((d) => d === p || d.startsWith(p))))
    .map((l) => ({ name: l.name, guidance: l.guidance }))
}

export function buildLibraryTestIdGuidance(
  libs: UiLibrary[],
): string | null {

  if (libs.length === 0) {
    return null
  }

  const lines = libs.map(
    (l) => `- ${l.guidance}`,
  )

  lines.push(`- ${GENERIC_GUIDANCE}`)

  return (
    'LIBRARY-SPECIFIC FORWARDING — this file imports or depends on known UI libraries. Follow their DOCUMENTED conventions below. The prop bags explicitly mentioned here ARE allowed because they are supported paths to the DOM, unlike guessing:\n' +
    lines.join('\n')
  )
}