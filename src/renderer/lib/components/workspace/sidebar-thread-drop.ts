import { threadStatusSortKey } from '$lib/stores/workspace.svelte'
import type { Thread } from '$shared/types'
import { groupThreadsByStatus } from './workspace-thread-helpers'

/**
 * Move a row next to another row in a list the user is looking at.
 *
 * Returns the arrangement that would be rendered, or `null` when the drop says
 * nothing: the row was dropped on itself, either row is not in this list, or the
 * row would land exactly where it already is.
 */
export function moveThreadInList(
  threads: readonly Thread[],
  draggedId: string,
  targetId: string,
  position: 'before' | 'after'
): Thread[] | null {
  if (draggedId === targetId) return null
  const from = threads.findIndex((thread) => thread.id === draggedId)
  if (from === -1) return null
  const next = threads.slice()
  const [dragged] = next.splice(from, 1)
  const target = next.findIndex((thread) => thread.id === targetId)
  if (target === -1) return null
  next.splice(position === 'before' ? target : target + 1, 0, dragged)
  // Dropping a row where it already is writes an anchor for a move nobody can
  // see; report it as no drop at all.
  if (next.every((thread, index) => thread.id === threads[index]?.id)) return null
  return next
}

export interface TimelineDropOptions {
  /** Whether the list renders status groups, or one flat list. */
  grouped: boolean
  draftThreadKeys?: ReadonlySet<string> | null
}

/**
 * Resolve a drop in the Threads list, which orders every row by its status.
 *
 * A row's place is decided by its own status, never by where it sits: the status
 * picks the group (when the list is grouped) and, inside it, the bucket the
 * status sort keeps together - to-do rows first, the working middle, done rows
 * last. So a drop that would carry a row out of the rows it may sit among cannot
 * be honoured: the next sort would put the row straight back, and a row that
 * snaps back is worse than one that never moved. Such a drop is clamped to the
 * edge of the rows the dragged row may join, on the side the pointer came from.
 *
 * The returned list is in the order the pane renders it: groups in display order
 * when grouped, the rows as handed over when flat.
 */
export function resolveTimelineDrop(
  threads: readonly Thread[],
  draggedId: string,
  targetId: string,
  position: 'before' | 'after',
  options: TimelineDropOptions
): Thread[] | null {
  if (draggedId === targetId) return null

  // The order the pane renders, plus the run of rows the dragged row may move
  // inside: its status group when the list is grouped, otherwise the bucket the
  // status sort would pull it back into.
  const sequence: Thread[] = []
  const runOf = new Map<string, number>()
  const bucketOf = new Map<string, number>()
  const place = (thread: Thread, run: number): void => {
    runOf.set(thread.id, run)
    bucketOf.set(thread.id, threadStatusSortKey(thread, options.draftThreadKeys))
    sequence.push(thread)
  }
  if (options.grouped) {
    groupThreadsByStatus([...threads], options.draftThreadKeys).forEach((group, index) => {
      for (const thread of group.threads) place(thread, index)
    })
  } else {
    for (const thread of threads)
      place(thread, threadStatusSortKey(thread, options.draftThreadKeys))
  }

  const draggedIndex = sequence.findIndex((thread) => thread.id === draggedId)
  const targetIndex = sequence.findIndex((thread) => thread.id === targetId)
  const draggedRun = runOf.get(draggedId)
  if (draggedIndex === -1 || targetIndex === -1 || draggedRun === undefined) return null
  const bucket = bucketOf.get(draggedId)

  // Rows the dragged row may sit among: the same run, and the same status bucket
  // inside it, since the bucket order outranks any anchor.
  const isPeer = (index: number): boolean => {
    const thread = sequence[index]
    return runOf.get(thread.id) === draggedRun && bucketOf.get(thread.id) === bucket
  }

  if (isPeer(targetIndex)) return moveThreadInList(sequence, draggedId, targetId, position)

  const peers: number[] = []
  for (let index = 0; index < sequence.length; index += 1) {
    if (isPeer(index)) peers.push(index)
  }
  const edge = targetIndex < draggedIndex ? peers[0] : peers[peers.length - 1]
  const edgeThread = edge === undefined ? undefined : sequence[edge]
  if (edgeThread === undefined) return null
  return moveThreadInList(
    sequence,
    draggedId,
    edgeThread.id,
    targetIndex < draggedIndex ? 'before' : 'after'
  )
}
