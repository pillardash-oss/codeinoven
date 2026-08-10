/// <reference types="node" />
import { Logger } from './logger'

/**
 * Coordinates optimistic thread creation for the renderer-facing path.
 *
 * `thread:create` returns the thread object immediately; persistence (upsert,
 * lazy capacity eviction, branch detection) is finalized in the background,
 * serialized so concurrent creates never overlap their evictions. Any entry
 * point that needs the thread's persisted state — the session/message send
 * path, thread reads — calls `awaitReady` first, so a message sent in the
 * window between create and finalize is rendered optimistically by the
 * renderer and queued here behind the finalization before it reaches the
 * harness.
 *
 * A failed finalization is logged and `awaitReady` still resolves, so a
 * best-effort create never wedges the send path.
 */
export class ThreadCreationCoordinator {
  private finalizing = new Map<string, Promise<void>>()
  private tail: Promise<void> = Promise.resolve()

  /** Schedule `work` to run serialized with every other finalization. */
  begin(threadId: string, work: () => Promise<void>): void {
    const run = this.tail.then(work)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    this.finalizing.set(threadId, run)
    void run
      .catch((error) => {
        Logger.error('Thread finalization failed', { threadId, error: String(error) })
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
