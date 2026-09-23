import type { Thread } from '../types'
import { isWorkflowCoordinatorThread } from '../types'

/**
 * The Sr. Engineer coordinator that owns the workflow `threadId` belongs to, or
 * `null` when the thread is not part of one. A coordinator is its own root; a
 * worker or auditor walks up its `coordinatorThreadId` chain. Pure over the
 * passed snapshot.
 */
export function resolveWorkflowCoordinatorThreadId(
  threads: Thread[],
  threadId: string
): string | null {
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  let current = byId.get(threadId)
  if (!current) return null
  if (isWorkflowCoordinatorThread(current)) return current.id
  const seen = new Set<string>()
  while (current.coordinatorThreadId) {
    if (seen.has(current.id)) return null
    seen.add(current.id)
    const parentId = current.coordinatorThreadId
    const parent = byId.get(parentId)
    if (!parent) return parentId
    if (isWorkflowCoordinatorThread(parent)) return parent.id
    current = parent
  }
  return null
}

/**
 * Every thread of a coordinated workflow: the Sr. Engineer coordinator first,
 * then its worker/auditor descendants (deepest first). Pure over the passed
 * snapshot, so it never triggers a read of its own.
 *
 * A workflow is the unit of instance ownership, not a single thread: the
 * coordinator and its children are driven by one process and move together, so
 * this is the set that a transfer or a recovery pass acts on as a whole.
 */
export function workflowGroupThreads(threads: Thread[], coordinatorThreadId: string): Thread[] {
  const coordinator = threads.find((thread) => thread.id === coordinatorThreadId)
  if (!coordinator) return []
  return [coordinator, ...orchestrationDescendants(threads, coordinatorThreadId)]
}

/**
 * Every orchestration descendant of `coordinatorThreadId` (worker sub-agent
 * threads dispatched by this coordinator, transitively), deepest first.
 * Reads only the passed snapshot, so it is a pure graph walk.
 */
export function orchestrationDescendants(threads: Thread[], coordinatorThreadId: string): Thread[] {
  const byCoordinator = new Map<string, Thread[]>()
  for (const thread of threads) {
    if (!thread.coordinatorThreadId) continue
    const children = byCoordinator.get(thread.coordinatorThreadId) ?? []
    children.push(thread)
    byCoordinator.set(thread.coordinatorThreadId, children)
  }
  const descendants: Thread[] = []
  const visit = (parentId: string): void => {
    const children = (byCoordinator.get(parentId) ?? []).sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    )
    for (const child of children) {
      visit(child.id)
      descendants.push(child)
    }
  }
  visit(coordinatorThreadId)
  return descendants
}
