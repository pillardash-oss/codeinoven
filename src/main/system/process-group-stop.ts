import { execFile } from 'node:child_process'

/**
 * Terminate a child process the app spawned as its own process-group leader.
 *
 * `child.kill()` signals exactly one pid, and the agents the app runs fork
 * helpers that outlive it: cursor-agent starts a `worker-server`, and when the
 * leader is signalled that daemon re-parents to launchd and keeps running (a
 * live PPID 1 orphan was observed doing this). A child spawned with
 * `detached: true` leads its own group on POSIX, so one negative-pid signal
 * reaches every process it started.
 *
 * Only call this for a pid the app spawned detached. A negative pid reaches
 * whichever group owns the id, which is CodeInOven's own group when the child
 * was never given one.
 */
export function stopProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  if (process.platform === 'win32') {
    // Windows has no process groups to signal; a tree kill is the equivalent.
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    return
  }
  try {
    globalThis.process.kill(-pid, signal)
  } catch {
    // The whole group is already gone.
  }
}
