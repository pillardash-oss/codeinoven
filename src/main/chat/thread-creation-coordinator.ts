/// <reference types="node" />
import { Logger } from '../system/logger'

/**
 * Coordinates optimistic thread creation for the renderer-facing path.
 *
 * `thread:create` returns the thread object immediately; persistence (upsert,
 * lazy capacity eviction, branch detection) is finalized in the background,
 * serialized so concurrent creates never overlap their evictions. Only the
 * send path (`session:ensure`, `agent:send`) awaits finalization via
 * `awaitReady` before dispatching a prompt — typing, switching threads, and
 * every read never wait. A message sent in the window between create and
 * finalize is rendered optimistically by the renderer and queued here behind
 * the finalization before it reaches the harness.
 *
 * A failed finalization is logged and `awaitReady` still resolves, so a
 * best-effort create never wedges the send path.
 */
export class ThreadCreationCoordinator {
  private finalizing = new Map<string, Promise<void>>()
  private tail: Promise<void> = Promise.resolve()

  /** Schedule `work` to run serialized with every other finalization. */
  begin(threadId: string, work: () => Promise<void>, onError?: (error: unknown) => void): void {
    // Yield a full event-loop turn before starting even the worker-backed
    // preparation. This lets Electron deliver the optimistic IPC response
    // before finalization competes for main-process scheduling time.
    const run = this.tail
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(work)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    this.finalizing.set(threadId, run)
    void run
      .catch((error) => {
        Logger.error('Thread finalization failed', { threadId, error: String(error) })
        onError?.(error)
      })
      .finally(() => {
        if (this.finalizing.get(threadId) === run) this.finalizing.delete(threadId)
      })
  }

  /** Resolve once the thread's finalization has settled (succeeded or failed). */
  async awaitReady(threadId: string): Promise<void> {
    const pending = this.finalizing.get(threadId)
    if (pending) await pending.catch(() => undefined)
  }
}
