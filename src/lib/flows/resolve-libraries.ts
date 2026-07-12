// Import-chain-aware UI-library detection for --inject-testids.
//
// detectUiLibraries (ui-libraries.ts) reads a component's own imports, which a barrel re-export
// defeats: `import { Button } from '../components'` hides whether Button is a library component or
// a custom one. This resolver follows local/barrel imports to the actual files, so:
//   - a barrel that re-exports from a UI library is detected (the library guidance fires), and
//   - a barrel of purely CUSTOM components yields NO library (no false MUI/Radix guidance for a
//     hand-rolled <Button>) — the exact false positive the dependency fallback would cause.
// The installed-dependency fallback is used ONLY when the chain can't be resolved (an unresolvable
// alias, a re-export we couldn't follow, or a depth/size cap), so it stays a genuine last resort.
//
// Resolution is module-level (it follows local imports and checks the resolved files' own imports)
// rather than tracking each re-exported name. A barrel that mixes custom and library components can
// therefore over-report, but the empirical interactive-element verify-and-revert still backstops it.

import { access, readFile } from 'fs/promises'
import { readTsconfigAliases, resolveLocalImport } from '../../agent/context.js'
import { libraryForModule, librariesFromDeps, type UiLibrary } from './ui-libraries.js'

const MAX_DEPTH = 4          // page -> barrel -> component -> one more
const MAX_FILES = 25         // bound the work on a large barrel
const EXT_PROBE = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js']

// Module specifiers from `import … from 'x'` and `export … from 'x'` statements.
function importModuleSpecifiers(code: string): string[] {
  const specs: string[] = []
  const re = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?\bfrom\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) specs.push(m[1])
  return specs
}

async function resolveToFile(basePath: string): Promise<string | null> {
  for (const suffix of EXT_PROBE) {
    try { await access(basePath + suffix); return basePath + suffix } catch { /* next */ }
  }
  return null
}

// Detect the UI libraries a component actually uses, following its local/barrel imports. Falls back
// to installed dependencies only when the chain couldn't be fully resolved.
export async function resolveComponentLibraries(
  sourceCode: string,
  fileAbs: string,
  cwd: string,
  depNames: string[] = [],
): Promise<UiLibrary[]> {
  const aliases = await readTsconfigAliases(cwd)
  const found = new Map<string, UiLibrary>()
  const visited = new Set<string>([fileAbs])
  let reads = 0
  let unresolved = false   // a local import we couldn't follow → we're uncertain → allow deps fallback

  const walk = async (code: string, fromAbs: string, depth: number): Promise<void> => {
    for (const spec of importModuleSpecifiers(code)) {
      const lib = libraryForModule(spec)
      if (lib) { found.set(lib.name, lib); continue }

      const base = resolveLocalImport(spec, fromAbs, cwd, aliases)
      if (base === null) continue        // a bare, non-UI package (react, lodash, …) — definitively not a UI lib

      // A local/aliased import we should follow to see what it really re-exports.
      if (depth >= MAX_DEPTH || reads >= MAX_FILES) { unresolved = true; continue }
      const file = await resolveToFile(base)
      if (!file || file.includes('node_modules')) { unresolved = true; continue }
      if (visited.has(file)) continue
      visited.add(file)
      const childCode = await readFile(file, 'utf-8').catch(() => null)
      if (childCode === null) { unresolved = true; continue }
      reads++
      await walk(childCode, file, depth + 1)
    }
  }

  await walk(sourceCode, fileAbs, 0)

  if (found.size > 0) return [...found.values()]   // resolved a real library (directly or via barrel)
  if (unresolved) return librariesFromDeps(depNames) // couldn't fully resolve → deps safety net
  return []                                          // fully resolved, no UI library → genuinely custom
}
