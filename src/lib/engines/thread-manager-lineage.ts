import type { Thread } from '../types'

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
