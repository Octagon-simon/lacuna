import type { JsonReport } from './reporter.js'

export async function uploadReport(serverUrl: string, report: JsonReport, apiKey: string): Promise<void> {
  const res = await fetch(`${serverUrl}/api/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(report),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Failed to upload report (${res.status}): ${text}`)
  }
}
