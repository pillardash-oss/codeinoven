import { Logger } from '../system/logger'

export interface ProjectDeletionJob {
  projectId: string
  /** Erase the project's own folder from the user's device as well. */
  deleteFolder: boolean
}

export type ProjectDeletionRunner = (job: ProjectDeletionJob) => Promise<void>

/** Let the event loop turn between jobs so IPC, painting and streams breathe. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * The single line every project deletion goes through.
 *
 * One project is erased at a time, in the order the requests arrived, because
 * the work is database writes, session teardown, and filesystem walks: running
 * twenty of those at once is what makes the app feel hung. Accepting twenty
 * requests costs nothing, though, so the queue takes every one immediately and
 * the caller never waits for it. A request for a project that is already queued
 * joins that job instead of starting a second one, which is what keeps a
 * double-click from deleting the same project twice.
 */
export class ProjectDeletionQueue {
  private tail: Promise<void> = Promise.resolve()
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly run: ProjectDeletionRunner) {}

  /** Accept the job now; it runs after everything already queued. */
  enqueue(job: ProjectDeletionJob): Promise<void> {
    const existing = this.inFlight.get(job.projectId)
    if (existing) return existing

    const started = this.tail.then(async () => {
      // The caller already saw its request accepted; this turn is the one that
      // lets the renderer paint the row it just greyed before the work begins.
      await yieldToEventLoop()
      await this.run(job)
    })
    // The chain must advance even when a job fails, or one bad project would
    // block every deletion queued behind it.
    this.tail = started.catch((error: unknown) => {
      Logger.error('Project deletion queue job failed', {
        projectId: job.projectId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    const settled = started.finally(() => {
      if (this.inFlight.get(job.projectId) === settled) this.inFlight.delete(job.projectId)
    })
    this.inFlight.set(job.projectId, settled)
    return settled
  }

  /** Whether any deletion is accepted or running right now. */
  get isIdle(): boolean {
    return this.inFlight.size === 0
  }

  /** Ids accepted but not finished, so the UI can grey them before it hears back. */
  pendingIds(): string[] {
    return [...this.inFlight.keys()]
  }
}
