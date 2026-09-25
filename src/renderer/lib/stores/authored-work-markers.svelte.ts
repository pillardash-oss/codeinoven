import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import type { AuthoredWorkKind } from '$shared/ipc-contract'

/**
 * The authored-work marker a thread row draws.
 *
 * A row cannot answer "is this a design or a video thread" by itself: the answer is the
 * folder the thread previewed plus the session tags it typed, and both are persisted in
 * main. Asking once per row would be one round trip per row on the path that renders the
 * sidebar, so every row that mounts adds its id to a pending set and the whole set is
 * asked for in one call on the next microtask. Only the rows on screen ever ask, so the
 * cost follows the list and not the project's history.
 *
 * A request is stamped with the thread's activity: a turn can start a session, so a row
 * re-asks when its thread has moved on, and never when nothing has happened. The stamp
 * is kept off the reactive graph so answering a request cannot re-trigger the row that
 * asked.
 */
class AuthoredWorkMarkersState {
  /** The answered marker per thread id. Reactive, because a row renders from it. */
  private readonly kinds = new SvelteMap<string, AuthoredWorkKind | null>()
  /** The activity stamp already answered per thread, so a render never re-asks. */
  private readonly answeredAt = new Map<string, number>()
  /** Thread ids waiting for the next batch, mapped to the project that owns them.
   *  Keyed by thread id, so a row that asks twice in one tick is still one request,
   *  and a thread belongs to exactly one project. */
  private readonly pending = new Map<string, string>()
  private flushScheduled = false

  /**
   * The marker for a thread, or null before the answer arrives or when it is in no
   * session.
   *
   * Null covers both on purpose: a row must not wait for an answer to draw itself, and
   * the two states render the same, which is a row with no marker.
   */
  kindFor(threadId: string): AuthoredWorkKind | null {
    return this.kinds.get(threadId) ?? null
  }

  /** Ask for one thread's marker, once per activity stamp. */
  request(projectId: string, threadId: string, activityAt: number): void {
    if (this.answeredAt.get(threadId) === activityAt) return
    this.answeredAt.set(threadId, activityAt)
    this.pending.set(threadId, projectId)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      void this.flush()
    })
  }

  private async flush(): Promise<void> {
    if (this.pending.size === 0) return
    // Taken before the first await, so a row that mounts while a batch is in flight is
    // collected by the next flush instead of being dropped with this one. One call per
    // project, because the answer is scoped to a project on the main side. Grouped over
    // a plain array because a flush is a local computation with no reader to keep in
    // sync, and the number of projects behind one list is one or two.
    const batches: Array<{ projectId: string; threadIds: string[] }> = []
    for (const [threadId, projectId] of this.pending) {
      const batch = batches.find((entry) => entry.projectId === projectId)
      if (batch) batch.threadIds.push(threadId)
      else batches.push({ projectId, threadIds: [threadId] })
    }
    this.pending.clear()
    for (const { projectId, threadIds } of batches) {
      try {
        const kinds = await invoke('design:kinds', projectId, threadIds)
        for (const threadId of threadIds) this.kinds.set(threadId, kinds[threadId] ?? null)
      } catch {
        // A failed read leaves the rows as they are and forgets the stamps it could not
        // answer, so the next activity asks again rather than caching the failure.
        for (const threadId of threadIds) this.answeredAt.delete(threadId)
      }
    }
  }
}

export const authoredWorkMarkers = new AuthoredWorkMarkersState()
