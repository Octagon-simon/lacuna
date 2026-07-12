// App-under-test lifecycle for E2E generation.
//
// Each `npx playwright test` invocation normally starts (and stops) the project's webServer
// itself. That's fine when runs are sequential, but with parallel workers several invocations
// fire at once and each tries to start its own server on the same port — a strictPort race that
// makes some runs fail spuriously. So for a parallel run we start the webServer ONCE here and
// keep it up for the whole run; the per-spec invocations then find it already reachable (via
// reuseExistingServer) and attach instead of starting their own.
//
// If the server is already reachable (someone's dev server, or a previous run), we attach and do
// NOT manage it — stop() is a no-op so we never kill a server we didn't start.

import { spawn } from 'child_process'
import type { PlaywrightConfig } from '../playwright.js'

export interface AppServerHandle {
  // True when a server was already reachable and we just attached (we won't stop it).
  alreadyRunning: boolean
  // True when we started the server and own its lifecycle.
  managed: boolean
  // Stop the server if we started it; no-op otherwise.
  stop: () => void
  // Set when we could neither reach nor start a server (caller can warn / fall back).
  error?: string
}

const NOOP = () => {}

// Resolve the URL to probe: the webServer.url if set, else the configured baseURL.
function serverUrl(pw: PlaywrightConfig): string | null {
  return pw.webServerUrl ?? pw.baseURL
}

async function isReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    // Any HTTP response (even 404) means a server is listening, which is all we need.
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}

// Ensure the app is up for the duration of a parallel run. Returns a handle whose stop() tears
// down only a server we started.
export async function ensureAppServer(pw: PlaywrightConfig, cwd: string, timeoutMs = 120_000): Promise<AppServerHandle> {
  const url = serverUrl(pw)
  if (!url) return { alreadyRunning: false, managed: false, stop: NOOP, error: 'No baseURL/webServer URL in playwright config.' }

  if (await isReachable(url)) {
    return { alreadyRunning: true, managed: false, stop: NOOP }
  }

  if (!pw.webServerCommand) {
    // Nothing running and no command to start it. Leave it to the caller to surface a useful
    // message; per-spec runs will simply fail to reach the app.
    return { alreadyRunning: false, managed: false, stop: NOOP, error: `App not reachable at ${url} and no webServer command is configured to start it.` }
  }

  // Start the webServer in its own process group so we can kill the whole tree on stop().
  const proc = spawn(pw.webServerCommand, { cwd, shell: true, detached: true, stdio: 'ignore' })

  const stop = () => {
    try { if (proc.pid) process.kill(-proc.pid, 'SIGTERM') }
    catch { try { proc.kill('SIGTERM') } catch { /* already gone */ } }
  }

  // Poll until the URL responds or we time out.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isReachable(url)) {
      return { alreadyRunning: false, managed: true, stop }
    }
    if (proc.exitCode !== null) {
      // The command died before serving — don't leave a dangling handle.
      return { alreadyRunning: false, managed: false, stop: NOOP, error: `webServer command exited (code ${proc.exitCode}) before ${url} became reachable.` }
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  stop()
  return { alreadyRunning: false, managed: false, stop: NOOP, error: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${url} to start.` }
}
