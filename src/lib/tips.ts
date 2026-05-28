import chalk from 'chalk'

export interface TipContext {
  workers: number
  targetFile?: string
  verbose: boolean
  dryRun: boolean
  fresh?: boolean
  model: string
  threshold: number
  mocksFile?: string
  ignore?: string[]
  command?: 'generate' | 'fix'
}

interface TipDef {
  text: string
  hide: (ctx: TipContext) => boolean
}

const TIPS: TipDef[] = [
  {
    text: 'use -w 4 (--workers) to process multiple files in parallel',
    hide: (ctx) => ctx.workers > 1,
  },
  {
    text: 'use -f src/utils/math.ts (--file) to target a single file instead of the whole project',
    hide: (ctx) => Boolean(ctx.targetFile),
  },
  {
    text: 'use --dry-run to preview what would be written without touching any files',
    hide: (ctx) => ctx.dryRun,
  },
  {
    text: 'use -v (--verbose) to stream the AI\'s output token by token as it generates',
    hide: (ctx) => ctx.verbose,
  },
  {
    text: 'use -m claude-opus-4-7 (--model) to switch to a more capable model for tough files',
    hide: (ctx) => ctx.model.includes('opus'),
  },
  {
    text: 'use --fresh to force a new coverage run instead of reusing a cached report',
    hide: (ctx) => Boolean(ctx.fresh) || ctx.command === 'fix',
  },
  {
    text: 'use -t 90 (--threshold) to raise the minimum coverage bar',
    hide: (ctx) => ctx.threshold !== 80 || ctx.command === 'fix',
  },
  {
    text: 'set mocksFile in .lacuna.json to share mocks across all generated tests',
    hide: (ctx) => Boolean(ctx.mocksFile),
  },
  {
    text: 'add paths to ignore[] in .lacuna.json to skip directories (e.g. "src/graphql/")',
    hide: (ctx) => Boolean(ctx.ignore?.length),
  },
  {
    text: 'run lacuna fix to automatically repair failing tests without rewriting them from scratch',
    hide: (ctx) => ctx.command === 'fix',
  },
  {
    text: 'run lacuna analyze to inspect coverage gaps without writing any files',
    hide: () => false,
  },
  {
    text: 'use --format json --output report.json to export results for scripts or CI',
    hide: (ctx) => ctx.command === 'fix',
  },
  {
    text: 'increase coverageTimeout in .lacuna.json if your test suite is killed before finishing',
    hide: () => false,
  },
  {
    text: 'set maxTokens in .lacuna.json if tests are cut off mid-generation (lower for Groq/Ollama, raise for large files)',
    hide: () => false,
  },
]

export function getActiveTips(ctx: TipContext): string[] {
  return TIPS.filter((t) => !t.hide(ctx)).map((t) => t.text)
}

export function createTipRotator(tips: string[]): () => string | null {
  if (tips.length === 0) return () => null
  let idx = 0
  return () => {
    const tip = tips[idx % tips.length]
    idx++
    return tip ?? null
  }
}

export function formatTip(text: string): string {
  return `  ${chalk.cyan('Tip:')} ${chalk.dim(text)}`
}
