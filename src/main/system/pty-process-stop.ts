import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Logger } from './logger'

const execFileAsync = promisify(execFile)

/** How long a stopped process tree gets to exit on its own before it is killed outright. */
const DEFAULT_GRACE_MS = 1_000

export interface StopPtyProcessesOptions {
  /**
   * How long the processes get between the polite hangup and SIGKILL. Zero
   * kills immediately, which is what a cancelled start wants.
   */
  graceMs?: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/** Send `signal` to a pid or (with a negative id) a whole process group. */
function signal(target: number, signal: NodeJS.Signals | number): boolean {
  try {
    globalThis.process.kill(target, signal)
    return true
  } catch {
    return false
  }
}

/** The process group `pid` belongs to, or undefined when it is already gone. */
async function processGroupOf(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)])
    const group = Number.parseInt(stdout.trim(), 10)
    return Number.isInteger(group) && group > 0 ? group : undefined
  } catch {
    return undefined
  }
}

/** Kill every process a stopped pty session started, on Windows. */
async function stopWindowsTree(pid: number): Promise<void> {
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  } catch {
    // Already gone, or nothing left in the tree.
  }
}

/**
 * End every process a pty session started, not just the shell facing the user.
 *
 * `node-pty`'s own `kill()` is `process.kill(pid, 'SIGHUP')`: it signals the pty
 * leader alone and leaves the master fd open, so nothing hangs up the rest of
 * the session. Every child the leader forked keeps running   a documented
 * installer script (`sh -lc 'curl … | sh'`), `npm install` and the node process
 * it spawns, `brew`'s build steps   and finishes its work long after the user
 * pressed stop. The install then lands anyway, which reads as "stop did
 * nothing".
 *
 * Closing a real terminal hangs up the whole foreground process group, so that
 * is what this does: SIGHUP the group (the pty child leads its own session and
 * group, see `setsid` in node-pty's spawn helper), then SIGKILL whatever
 * ignored the hangup once the grace period is over. Installers trap signals to
 * finish a step, and a stop the user asked for must not lose that race.
 */
export async function stopPtyProcesses(
  pid: number,
  options: StopPtyProcessesOptions = {}
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) return
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS

  if (process.platform === 'win32') {
    await stopWindowsTree(pid)
    return
  }

  const group = await processGroupOf(pid)
  if (group === undefined) {
    // The leader has already exited. Its group outlives it while any of the
    // work it started is still running, and a group id is the pid of its
    // leader, so a group under this id can only be the orphaned session.
    if (signal(-pid, 0)) {
      signal(-pid, 'SIGHUP')
      await delay(graceMs)
      signal(-pid, 'SIGKILL')
    }
    return
  }
  // Only signal a negative pid once the process is confirmed to lead its own
  // group: `kill(-n)` reaches whichever group owns `n`, which is CodeInOven's
  // own group when the child was never given one.
  const target = group === pid ? -pid : pid
  if (target === pid) {
    Logger.dev(
      `[pty] Process ${pid} does not lead its own process group (pgid ${group}); stopping it alone`
    )
  }

  signal(target, 'SIGHUP')
  if (!signal(target, 0)) return
  await delay(graceMs)
  if (!signal(target, 0)) return
  Logger.dev(`[pty] Process tree ${pid} ignored the hangup; killing it`)
  signal(target, 'SIGKILL')
}
