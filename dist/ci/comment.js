import { readFile } from 'fs/promises';
import { buildMarkdownReport } from '../lib/reporter.js';
const COMMENT_MARKER = '<!-- lacuna-coverage-report -->';
async function githubFetch(path, options = {}) {
    const token = process.env.GITHUB_TOKEN;
    if (!token)
        throw new Error('GITHUB_TOKEN is not set');
    return fetch(`https://api.github.com${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            ...(options.headers ?? {}),
        },
    });
}
async function findExistingComment(repo, prNumber) {
    const res = await githubFetch(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
    if (!res.ok)
        return null;
    const comments = (await res.json());
    const existing = comments.find((c) => c.body.includes(COMMENT_MARKER));
    return existing?.id ?? null;
}
async function upsertComment(repo, prNumber, body) {
    const existingId = await findExistingComment(repo, prNumber);
    if (existingId) {
        await githubFetch(`/repos/${repo}/issues/comments/${existingId}`, {
            method: 'PATCH',
            body: JSON.stringify({ body }),
        });
        console.log(`Updated existing PR comment #${existingId}`);
    }
    else {
        await githubFetch(`/repos/${repo}/issues/${prNumber}/comments`, {
            method: 'POST',
            body: JSON.stringify({ body }),
        });
        console.log('Posted new PR comment');
    }
}
async function main() {
    const repo = process.env.GITHUB_REPOSITORY;
    const prNumber = process.env.GITHUB_PR_NUMBER;
    const reportFile = process.env.LACUNA_REPORT_FILE ?? 'lacuna-report.json';
    if (!repo || !prNumber) {
        console.log('Not a PR context — skipping comment.');
        return;
    }
    let report;
    try {
        const raw = await readFile(reportFile, 'utf-8');
        report = JSON.parse(raw);
    }
    catch {
        console.error(`Could not read ${reportFile}`);
        process.exit(1);
    }
    const coverage = report.coverage;
    const threshold = report.threshold ?? 80;
    const input = {
        type: report.type,
        threshold,
        untouchedCount: report.untouchedCount ?? 0,
        generate: report.type === 'generate'
            ? {
                filesProcessed: report.filesProcessed ?? 0,
                testsWritten: report.testsWritten ?? 0,
                coverageBefore: coverage?.before ?? 0,
                coverageAfter: coverage?.after ?? 0,
                hasCoverage: coverage?.before !== undefined,
                errors: report.errors ?? [],
            }
            : undefined,
        analyze: report.type === 'analyze'
            ? {
                testRunner: report.testRunner ?? '',
                language: report.language ?? '',
                threshold,
                coveragePct: coverage?.lines ?? 0,
                functionCoveragePct: coverage?.functions ?? 0,
                gaps: [],
                untouchedCount: 0,
                passed: report.passed ?? false,
            }
            : undefined,
    };
    const markdown = COMMENT_MARKER + '\n' + buildMarkdownReport(input);
    await upsertComment(repo, prNumber, markdown);
}
main().catch((err) => {
    console.error('Failed to post comment:', err.message);
    process.exit(1);
});
//# sourceMappingURL=comment.js.map