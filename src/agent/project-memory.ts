import { readFile } from 'fs/promises'
import { join, relative } from 'path'
import type { DetectedEnvironment } from '../lib/detector.js'
import type { LacunaConfig } from '../lib/config.js'
import { findTestFiles } from '../lib/coverage/gaps.js'

const MAX_SAMPLE_FILES = 5
const SAMPLE_LINES = 35

export class ProjectMemory {
  private samples: Array<{ file: string; snippet: string }> = []
  private observations: string[] = []

  async initialize(cwd: string, _env: DetectedEnvironment, config: LacunaConfig): Promise<void> {
    const allTestFiles = await findTestFiles(cwd, {}, config).catch(() => [])
    const picked = allTestFiles.slice(0, MAX_SAMPLE_FILES)

    await Promise.all(
      picked.map(async (absPath) => {
        try {
          const code = await readFile(absPath, 'utf-8')
          const snippet = code.split('\n').slice(0, SAMPLE_LINES).join('\n')
          const rel = relative(cwd, absPath)
          this.samples.push({ file: rel, snippet })
        } catch { /* skip unreadable */ }
      }),
    )
  }

  recordSuccess(testFile: string, testCode: string): void {
    const imports = testCode.match(/^import .+$/gm) ?? []
    if (imports.length === 0) return
    const sources = imports
      .map((line) => {
        const m = line.match(/from ['"]([^'"]+)['"]/)
        return m ? m[1] : null
      })
      .filter(Boolean)
      .join(', ')
    if (sources) {
      this.observations.push(`${testFile} → imports: ${sources}`)
    }
  }

  toPromptSection(): string | null {
    const parts: string[] = []

    if (this.samples.length > 0) {
      parts.push('PROJECT TEST EXAMPLES (study these — follow the same import style, utilities, and mock usage):')
      for (const { file, snippet } of this.samples) {
        parts.push(`\n// ${file}`)
        parts.push('```')
        parts.push(snippet)
        parts.push('```')
      }
    }

    if (this.observations.length > 0) {
      parts.push('\nPATTERNS FROM THIS SESSION (already-written tests in this run — stay consistent):')
      for (const obs of this.observations) {
        parts.push(`  • ${obs}`)
      }
    }

    return parts.length > 0 ? parts.join('\n') : null
  }
}
