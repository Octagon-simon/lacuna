import { spawn } from 'child_process'

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  success: boolean
  timedOut?: boolean
  /** The run was killed by an external AbortSignal (the embedder "Stop"). NOT a test failure —
   * callers must bail, never treat the empty/partial output as a failure to "fix". */
  aborted?: boolean
}

export async function runCommand(
  command: string,
  cwd: string = process.cwd(),
  timeoutMs = 300_000,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve) => {
    // detached:true so the child leads its OWN process group — killing -pid then reaps the whole
    // tree (shell → test runner → worker processes), not just the shell. Both the timeout kill and
    // the external "Stop" (signal) depend on this to actually stop a running suite; with the old
    // detached:false the runner's worker children outlived the kill and the suite kept going.
    const proc = spawn(command, { cwd, shell: true, detached: true })

    let stdout = ''
    let stderr = ''
    let settled = false

    const killTree = () => {
      try { process.kill(-proc.pid!, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch { /* already gone */ } }
    }

    function cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      killTree()
      resolve({ stdout, stderr, exitCode: 1, success: false, aborted: true })
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      killTree()
      resolve({ stdout, stderr, exitCode: 1, success: false, timedOut: true })
    }, timeoutMs)

    // Cancelled before we even spawned — kill immediately rather than run to completion.
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })

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
      cleanup()
      resolve({ stdout, stderr, exitCode: code ?? 1, success: (code ?? 1) === 0 })
    })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ stdout, stderr: err.message, exitCode: 1, success: false })
    })
  })
}
