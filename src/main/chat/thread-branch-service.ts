import { createWorkQueue } from '../../lib/bounded-work'
import type { Thread } from '../../lib/types'
import { Logger } from '../system/logger'

/** Resolves the current git branch for a local directory (null when unavailable). */
interface BranchResolver {
  getCurrentBranch(projectPath: string): Promise<string | null>
}

/** Persists a thread's settled branch and returns the updated row. */
interface BranchStore {
  /**
   * `expectedWorkingDirectory` is the checkout the branch was read from. A
   * settle that started before a scope move must never relabel the row it has
   * since left, so the store refuses the write when the thread now lives
   * somewhere else.
   */
  setBranch(
    projectId: string,
    threadId: string,
    branch: string,
    expectedWorkingDirectory?: string
  ): Promise<Thread>
}

export interface ThreadBranchDeps {
  resolver: BranchResolver
  store: BranchStore
  onSettled(thread: Thread): void
}

const branchWork = createWorkQueue(2, 64)
const resolving = new WeakMap<BranchResolver, Map<string, Promise<string | null>>>()

function resolveBranch(resolver: BranchResolver, directory: string): Promise<string | null> {
  let directories = resolving.get(resolver)
  if (!directories) {
    directories = new Map()
    resolving.set(resolver, directories)
  }
  const existing = directories.get(directory)
  if (existing) return existing
  const current = branchWork(() => resolver.getCurrentBranch(directory))
  directories.set(directory, current)
  void current.finally(() => directories.delete(directory)).catch(() => undefined)
  return current
}

const pending = new Set<string>()

/**
 * Settle a thread's git branch without blocking the caller: resolve, persist,
 * and notify through `onSettled`. Creation-time detection is deliberately
 * fire-and-forget, so an app restart or a transient git failure between
 * persistence and detection would otherwise leave the thread branchless
 * forever   every later read re-queues this until the branch is known.
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
  // The checkout is part of the identity of a settle: a move between scopes
  // reshapes the same thread onto a different root while an earlier settle may
  // still be in flight, and only the branch read from the current root may
  // land.
  const key = `${thread.projectId}:${thread.id}:${workingDirectory}`
  if (pending.has(key)) return
  pending.add(key)
  void (async () => {
    const branch = await resolveBranch(deps.resolver, workingDirectory)
    if (!branch) return
    const updated = await deps.store.setBranch(
      thread.projectId,
      thread.id,
      branch,
      workingDirectory
    )
    deps.onSettled(updated)
  })()
    .catch((error) => {
      Logger.error('Thread branch settle failed', { threadId: thread.id, error: String(error) })
    })
    .finally(() => {
      pending.delete(key)
    })
}
