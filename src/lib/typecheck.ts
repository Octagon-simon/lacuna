import { access } from 'fs/promises'
import { join, basename } from 'path'
import type { DetectedEnvironment } from './detector.js'
import { runCommand } from './runner.js'

// Run tsc --noEmit on the project and return type errors that belong to the given
// test file. Errors in other files are intentionally ignored — we only care about
// what the AI just wrote. Returns null when there are no errors or when type-checking
// is not applicable (non-TypeScript project, no tsconfig, tsc not available).
export async function typeCheckFile(
  absTestPath: string,
  cwd: string,
  env: Pick<DetectedEnvironment, 'language'>,
): Promise<string | null> {
  if (env.language !== 'typescript') return null

  try {
    await access(join(cwd, 'tsconfig.json'))
  } catch {
    return null
  }

  const result = await runCommand('npx tsc --noEmit --skipLibCheck', cwd, 60_000)
  if (result.success) return null

  const fileName = basename(absTestPath)
  const errors = (result.stdout + '\n' + result.stderr)
    .split('\n')
    .filter((l) => l.includes(fileName) && /error TS\d+/.test(l))
    .join('\n')
    .trim()

  return errors || null
}
