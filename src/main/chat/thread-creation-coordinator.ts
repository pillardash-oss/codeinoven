/// <reference types="node" />
import { Logger } from '../system/logger'

/**
 * Coordinates optimistic thread creation for the renderer-facing path.
 *
 * `thread:create` returns the thread object immediately; persistence (upsert,
 * lazy capacity eviction) is finalized in the background, serialized so
 * concurrent creates never overlap their evictions. Only the send path
 * (`session:ensure`, `agent:send`) awaits finalization via `awaitReady`
 * before dispatching a prompt — typing, switching threads, and every read
 * never wait. A message sent in the window between create and finalize is
 * rendered optimistically by the renderer and queued here behind the
 * finalization before it reaches the harness.
 *
 * Optional enrichment (git branch detection) is scheduled through
 * `beginDetached`: it runs in the same serialized lane strictly after the
 * gated finalization, but is never awaited by `awaitReady`, so a slow git
 * resolve can never gate reads, sends, or hydration.
 *
 * A failed finalization is logged and `awaitReady` still resolves, so a
 * best-effort create never wedges the send path.
 */
export class ThreadCreationCoordinator {
  private finalizing = new Map<string, Promise<void>>()
  private failed = new Set<string>()
  private tail: Promise<void> = Promise.resolve()

  /**
   * Schedule `work` to run serialized with every other finalization. This is
   * the readiness-gated lane: `awaitReady` resolves only after these tasks for
   * a thread have settled, and every consumer (send path, `thread:get`, and
   * thread-scoped engine reads) waits on it. Keep this lane deliberately small —
   * persist the row and broadcast. Anything slow or optional (git branch
   * detection) must move to `beginDetached` so it can never gate a read.
   */
  begin(threadId: string, work: () => Promise<void>, onError?: (error: unknown) => void): void {
    // Yield a full event-loop turn before starting even the worker-backed
    // preparation. This lets Electron deliver the optimistic IPC response
    // before finalization competes for main-process scheduling time.
    const run = this.tail
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(work)
    this.failed.delete(threadId)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    this.finalizing.set(threadId, run)
    void run
      .catch((error) => {
        Logger.error('Thread finalization failed', { threadId, error: String(error) })
        // Remember the failure so scoped reads can report the real cause —
        // without a persisted row they would otherwise surface as a
        // misleading "thread does not belong to the project".
        this.failed.add(threadId)
        onError?.(error)
      })
      .finally(() => {
        if (this.finalizing.get(threadId) === run) this.finalizing.delete(threadId)
      })
  }

  /**
   * Schedule optional post-readiness work (e.g. resolving a git branch) after
   * a thread's finalization, in the same serialized lane. Unlike `begin`, this
   * task is never awaited by `awaitReady`: it runs strictly after the gated
   * work for the thread but resolves its result purely via a later broadcast.
   * `work` receives `aborted` — true when the thread's gated finalization
   * failed, so callers can skip work that assumes a persisted row.
   */
  beginDetached(
    threadId: string,
    work: (aborted: boolean) => Promise<void>,
    onError?: (error: unknown) => void
  ): void {
    // Capture the readiness outcome for the gated task. `this.finalizing` is
    // populated by `begin` synchronously, so by the time this is called the
    // gated task for the same thread is already scheduled ahead in `this.tail`.
    const gated = this.finalizing.get(threadId)
    const run = this.tail.then(() => {
      return (
        gated !== undefined
          ? gated.then(
              () => work(false),
              () => work(true)
            )
          : work(false)
      ).catch((error) => {
        Logger.error('Detached thread finalization failed', { threadId, error: String(error) })
        onError?.(error)
      })
    })
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
  }

  /** Resolve once the thread's finalization has settled (succeeded or failed). */
  async awaitReady(threadId: string): Promise<void> {
    const pending = this.finalizing.get(threadId)
    if (pending) await pending.catch(() => undefined)
  }

  /**
   * True when the thread's gated finalization ran and failed, meaning its row
   * never reached SQLite. Callers can use this to fail fast with an accurate
   * message instead of a confusing ownership/missing-row error downstream.
   */
  didFinalizationFail(threadId: string): boolean {
    return this.failed.has(threadId)
  }
}
