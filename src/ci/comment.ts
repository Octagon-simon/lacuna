import { readFile } from 'fs/promises'
import { buildMarkdownReport } from '../lib/reporter.js'
import type { ReportInput } from '../lib/reporter.js'

const COMMENT_MARKER = '<!-- lacuna-coverage-report -->'

interface GitHubComment {
  id: number
  body: string
}

async function githubFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is not set')

  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
}

async function findExistingComment(repo: string, prNumber: string): Promise<number | null> {
  const res = await githubFetch(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`)
  if (!res.ok) return null

  const comments = (await res.json()) as GitHubComment[]
  const existing = comments.find((c) => c.body.includes(COMMENT_MARKER))
  return existing?.id ?? null
}

async function upsertComment(repo: string, prNumber: string, body: string): Promise<void> {
  const existingId = await findExistingComment(repo, prNumber)

  if (existingId) {
    await githubFetch(`/repos/${repo}/issues/comments/${existingId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    })
    console.log(`Updated existing PR comment #${existingId}`)
  } else {
    await githubFetch(`/repos/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
    console.log('Posted new PR comment')
  }
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY
  const prNumber = process.env.GITHUB_PR_NUMBER
  const reportFile = process.env.LACUNA_REPORT_FILE ?? 'lacuna-report.json'

  if (!repo || !prNumber) {
    console.log('Not a PR context — skipping comment.')
    return
  }

  let report: Record<string, unknown>
  try {
    const raw = await readFile(reportFile, 'utf-8')
    report = JSON.parse(raw)
  } catch {
    console.error(`Could not read ${reportFile}`)
    process.exit(1)
  }

  const coverage = report.coverage as Record<string, number> | undefined
  const threshold = (report.threshold as number) ?? 80

  const input: ReportInput = {
    type: report.type as 'analyze' | 'generate',
    threshold,
    untouchedCount: (report.untouchedCount as number) ?? 0,
    generate:
      report.type === 'generate'
        ? {
            filesProcessed: (report.filesProcessed as number) ?? 0,
            testsWritten: (report.testsWritten as number) ?? 0,
            coverageBefore: coverage?.before ?? 0,
            coverageAfter: coverage?.after ?? 0,
            errors: (report.errors as string[]) ?? [],
          }
        : undefined,
    analyze:
      report.type === 'analyze'
        ? {
            testRunner: (report.testRunner as string) ?? '',
            language: (report.language as string) ?? '',
            threshold,
            coveragePct: coverage?.lines ?? 0,
            functionCoveragePct: coverage?.functions ?? 0,
            gaps: [],
            untouchedCount: 0,
            passed: (report.passed as boolean) ?? false,
          }
        : undefined,
  }

  const markdown = COMMENT_MARKER + '\n' + buildMarkdownReport(input)
  await upsertComment(repo, prNumber, markdown)
}

main().catch((err) => {
  console.error('Failed to post comment:', err.message)
  process.exit(1)
})
