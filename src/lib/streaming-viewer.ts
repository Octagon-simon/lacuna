import chalk from 'chalk'

const PANEL_ROWS = 12    // visible code lines inside the panel
const BLINK_EVERY = 4    // ticks between cursor flips: 4 × 80ms = 320ms

// Live panel that shows a test file being written token-by-token.
// Draws a fixed-height bordered box; as lines accumulate the panel scrolls
// so the cursor is always visible at the bottom. Redraws at 80ms via setInterval.
//
// Non-TTY fallback: streams tokens directly to stdout (no panel, no cursor).
export class StreamingFileViewer {
  private content = ''
  private rendered = 0
  private tick = 0
  private timer: ReturnType<typeof setInterval> | null = null
  readonly isTTY: boolean

  constructor(private readonly filename: string) {
    this.isTTY = Boolean(process.stdout.isTTY)
  }

  start() {
    if (!this.isTTY) {
      process.stdout.write(`\n  ✍  ${this.filename}\n`)
      return
    }
    this.render()
    this.timer = setInterval(() => { this.tick++; this.render() }, 80)
  }

  append(token: string) {
    this.content += token
    if (!this.isTTY) process.stdout.write(token)
    // In TTY mode the setInterval render loop picks up the new content
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.isTTY && this.rendered > 0) {
      process.stdout.write(`\x1B[${this.rendered}A\x1B[0J`)
      this.rendered = 0
    }
    this.content = ''
  }

  private render() {
    if (!this.isTTY) return
    if (this.rendered > 0) process.stdout.write(`\x1B[${this.rendered}A\x1B[0J`)

    const cols = Math.max(60, process.stdout.columns ?? 80)
    const panelWidth = Math.min(cols - 4, 82)
    const innerWidth = panelWidth - 4   // space between "│ " and " │"

    const cursor = Math.floor(this.tick / BLINK_EVERY) % 2 === 0 ? '▌' : ' '
    const rawLines = (this.content + cursor).split('\n')
    const displayLines = rawLines.slice(-PANEL_ROWS)
    while (displayLines.length < PANEL_ROWS) displayLines.unshift('')

    const lines: string[] = ['']

    // Header
    const title = ` ✍  ${this.filename} `
    const headerFill = Math.max(0, panelWidth - title.length - 4) // 4 = '╭──' + '╮'
    lines.push(
      `  ${chalk.dim('╭──')}${chalk.bold.cyan(title)}${chalk.dim('─'.repeat(headerFill) + '╮')}`,
    )

    // Code rows
    for (const line of displayLines) {
      const text = line.length > innerWidth ? line.slice(0, innerWidth - 1) + '…' : line
      lines.push(`  ${chalk.dim('│')} ${chalk.white(text.padEnd(innerWidth))} ${chalk.dim('│')}`)
    }

    // Footer with running line count
    const lineCount = rawLines.length - 1  // -1 for the cursor appended to last line
    const footerText = ` ${lineCount} line${lineCount !== 1 ? 's' : ''} `
    const footerFill = Math.max(0, panelWidth - footerText.length - 2) // 2 = '╰' + '╯'
    lines.push(`  ${chalk.dim('╰' + '─'.repeat(footerFill))}${chalk.dim(footerText)}${chalk.dim('╯')}`)
    lines.push('')

    const out = lines.join('\n')
    process.stdout.write(out)
    // Count \n chars — NOT lines.length (same rule as WorkerDisplay and coverage-spinner)
    this.rendered = (out.match(/\n/g) ?? []).length
  }
}
