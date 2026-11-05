import { isPawnWorkerThread, isThreadWorking, type Thread } from '$shared/types'
import { scopeState } from './scope.svelte'

/**
 * The pawn agents every thread owns.
 *
 * A pawn is a real thread of its own (see `isPawnWorkerThread`), so the thread
 * that spawned it already holds its row: no IPC read, no board refresh, and no
 * second source of truth. This store folds the thread memory the app has already
 * loaded into one index, once per change, so a row asking "do I own pawns?"
 * costs a map lookup instead of a walk over every thread in the app.
 *
 * Two surfaces read it: the spawner's row wears the pawn mark from
 * `hasWorkers`, and the pawn board lists `workersOf` rows under that thread.
 */
class PawnAgentsState {
  /** Pawn threads per spawner thread id, newest activity first. */
  #workers = $derived.by((): ReadonlyMap<string, Thread[]> => {
    // One pass over the loaded threads. The list holds every row the app knows,
    // orchestration children included, which is exactly where pawns live.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- A derived read-only index, rebuilt whole on every change and never mutated by a reader.
    const index = new Map<string, Thread[]>()
    for (const thread of scopeState.allScopeThreads) {
      if (!isPawnWorkerThread(thread)) continue
      const spawnerId = thread.coordinatorThreadId
      if (spawnerId === undefined) continue
      const workers = index.get(spawnerId)
      if (workers === undefined) index.set(spawnerId, [thread])
      else workers.push(thread)
    }
    for (const workers of index.values()) {
      workers.sort((a, b) => b.lastActivity - a.lastActivity)
    }
    return index
  })

  /** Whether a thread row should wear the pawn mark. */
  hasWorkers(threadId: string): boolean {
    return this.#workers.has(threadId)
  }

  /** Every pawn thread one spawner owns, newest activity first. */
  workersOf(threadId: string): Thread[] {
    return this.#workers.get(threadId) ?? []
  }

  /** How many of a spawner's pawns are still working. */
  runningCount(threadId: string): number {
    return this.workersOf(threadId).filter((worker) => isThreadWorking(worker)).length
  }
}

/** The one source every surface reads for pawn ownership. */
export const pawnAgentsState = new PawnAgentsState()
