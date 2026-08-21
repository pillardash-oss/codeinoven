/// <reference types="node" />
import { Logger } from '../system/logger'

/**
 * Acknowledges user-requested deletion before session, database, and file
 * cleanup begins. Duplicate requests for the same thread share one background
 * operation, while unrelated deletions may queue independently on their own
 * async services and the serialized database worker.
 */
export class ThreadDeletionCoordinator {
  private deleting = new Map<string, Promise<void>>()

  begin(
    projectId: string,
    threadId: string,
    work: () => Promise<void>,
    onError?: (error: unknown) => void
  ): void {
    const key = `${projectId}:${threadId}`
    if (this.deleting.has(key)) return

    const run = new Promise<void>((resolve) => setImmediate(resolve)).then(work)
    this.deleting.set(key, run)
    void run
      .catch((error) => {
        Logger.error('Thread deletion failed', { projectId, threadId, error: String(error) })
        onError?.(error)
      })
      .finally(() => {
        if (this.deleting.get(key) === run) this.deleting.delete(key)
      })
  }
}
