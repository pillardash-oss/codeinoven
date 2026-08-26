import type { Thread } from '../../lib/types'
import { Logger } from '../system/logger'

/** Resolves the current git branch for a local directory (null when unavailable). */
interface BranchResolver {
  getCurrentBranch(projectPath: string): Promise<string | null>
}

/** Persists a thread's settled branch and returns the updated row. */
interface BranchStore {
  setBranch(projectId: string, threadId: string, branch: string): Promise<Thread>
}

export interface ThreadBranchDeps {
  resolver: BranchResolver
  store: BranchStore
  onSettled(thread: Thread): void
}

const pending = new Set<string>()

/**
 * Settle a thread's git branch without blocking the caller: resolve, persist,
 * and notify through `onSettled`. Creation-time detection is deliberately
 * fire-and-forget, so an app restart or a transient git failure between
 * persistence and detection would otherwise leave the thread branchless
 * forever — every later read re-queues this until the branch is known.
 * Duplicate work is collapsed per thread while a settle is in flight; calls
 * are no-ops once `branch` is already known or there is no local working
 * directory (standalone inbox chats, SSH projects).
 */
export function settleThreadBranch(
  deps: ThreadBranchDeps,
  thread: Pick<Thread, 'projectId' | 'id' | 'branch' | 'workingDirectory'>
): void {
  const workingDirectory = thread.workingDirectory?.trim()
  if (thread.branch || !workingDirectory) return
  const key = `${thread.projectId}:${thread.id}`
  if (pending.has(key)) return
  pending.add(key)
  void (async () => {
    const branch = await deps.resolver.getCurrentBranch(workingDirectory)
    if (!branch) return
    const updated = await deps.store.setBranch(thread.projectId, thread.id, branch)
    deps.onSettled(updated)
  })()
    .catch((error) => {
      Logger.error('Thread branch settle failed', { threadId: thread.id, error: String(error) })
    })
    .finally(() => {
      pending.delete(key)
    })
}
