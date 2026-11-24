import { BrowserWindow } from 'electron'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { GitPushProgress } from '../../lib/types'

/**
 * The pushes this app has in flight, one per checkout, and the signal that calls
 * one off.
 *
 * A push is a single git process that can spend a long time on a large set of
 * objects, so the panel offers a stop next to it. The control lives here rather
 * than in the git service because two callers ask the same push to stop: the
 * panel's button, over IPC, and the service's own abort path, and both need the
 * same key. One push runs per checkout, which the service guarantees by
 * serialising remote round trips per repository.
 *
 * Nothing here holds a result. The push that owns the controller reports its own
 * outcome; stopping it only makes that outcome an abort.
 */
export interface GitPushJob {
  /** Aborted by `cancelGitPushJob`, which simple-git turns into a killed process. */
  signal: AbortSignal
  /** Give the checkout's slot back. Only removes this job, never a later one's. */
  release(): void
}

const runningPushes = new Map<string, GitPushJob & { controller: AbortController }>()

/**
 * The key a push is filed under. Scope-aware because a project root and its
 * managed worktrees are separate checkouts pushing separate branches, and the
 * panel showing one must never stop the other.
 */
function pushKey(projectId: string, scopeBucketId?: string): string {
  return JSON.stringify([projectId, scopeBucketId ?? null])
}

/** Claim this checkout's push slot, so a stop click has something to abort. */
export function startGitPushJob(projectId: string, scopeBucketId?: string): GitPushJob {
  const key = pushKey(projectId, scopeBucketId)
  const controller = new AbortController()
  const job: GitPushJob & { controller: AbortController } = {
    signal: controller.signal,
    controller,
    release() {
      // A push queued behind this one may already have replaced the entry; its
      // slot is not this job's to take away.
      if (runningPushes.get(key) === job) runningPushes.delete(key)
    }
  }
  runningPushes.set(key, job)
  return job
}

/**
 * Stop the push running in this checkout, if there is one.
 *
 * Returns whether a push was still in flight, so a click that arrives after the
 * push already finished settles the panel's control instead of reporting a
 * failure the user cannot act on.
 */
export function cancelGitPushJob(projectId: string, scopeBucketId?: string): boolean {
  const running = runningPushes.get(pushKey(projectId, scopeBucketId))
  if (!running) return false
  running.controller.abort()
  return true
}

/**
 * Send one stage of a running push to every window. The panel reads it as the
 * percentage on the push button; no other surface depends on it, so a window that
 * is closing loses nothing.
 */
export function broadcastGitPushProgress(progress: GitPushProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    sendToRenderer(win.webContents, 'git:pushProgress', progress)
  }
}
