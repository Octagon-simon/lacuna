import { spawn } from 'child_process'

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
  timedOut?: boolean
}

export async function runCommand(
  command: string,
  cwd: string = process.cwd(),
  timeoutMs = 300_000,
  onLine?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, { cwd, shell: true, detached: false })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { process.kill(-proc.pid!, 'SIGKILL') } catch { proc.kill('SIGKILL') }
      resolve({ stdout, stderr, exitCode: 1, success: false, timedOut: true })
    }, timeoutMs)

    function handleChunk(str: string, dest: 'stdout' | 'stderr') {
      if (dest === 'stdout') stdout += str
      else stderr += str
      if (onLine) {
        for (const line of str.split('\n')) {
          if (line.trim()) onLine(line)
        }
      }
    }

    proc.stdout.on('data', (chunk) => handleChunk(chunk.toString(), 'stdout'))
    proc.stderr.on('data', (chunk) => handleChunk(chunk.toString(), 'stderr'))

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 1, success: (code ?? 1) === 0 })
    })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr: err.message, exitCode: 1, success: false })
    })
  })
}
