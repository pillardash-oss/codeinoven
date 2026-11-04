/**
 * Renderer-side presence of agent-scheduled thread wakes.
 *
 * A row only has to answer two questions: does this thread have a wake armed, and
 * when is the soonest one. The full set arrives once through `followUps:list` and
 * is then kept fresh by `followUps:changed`, so no row ever polls the scheduler
 * and a change made by a turn in another window still reaches this one.
 */
import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { FollowUpNotice } from '$shared/follow-up'

class FollowUpsState {
  /** Armed wakes per thread id. Thread ids are globally unique, so the map is
   *  project-agnostic like the note-presence set beside it. */
  private byThread = new SvelteMap<string, FollowUpNotice[]>()
  private initialized = false

  /** The soonest wake armed on a thread, or null when it has none. */
  next(threadId: string): FollowUpNotice | null {
    const entries = this.byThread.get(threadId)
    if (!entries || entries.length === 0) return null
    return entries.reduce((soonest, entry) => (entry.dueAt < soonest.dueAt ? entry : soonest))
  }

  /** Every wake armed on a thread, soonest first. */
  list(threadId: string): FollowUpNotice[] {
    return [...(this.byThread.get(threadId) ?? [])].sort((a, b) => a.dueAt - b.dueAt)
  }

  has(threadId: string): boolean {
    return this.byThread.has(threadId)
  }

  /** Load the armed set and follow it live. Idempotent. */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    void invoke('followUps:list')
      .then((notices) => this.replace(notices))
      .catch(() => {})
    const unsubscribeChanged = subscribe('followUps:changed', (notices) => {
      this.replace(notices)
    })
    const unsubscribeDeleted = subscribe('thread:deleted', (_projectId, threadId) => {
      this.byThread.delete(threadId)
    })
    // The whole renderer owns these for its lifetime; keep the unsubscribes
    // referenced so they are never collected while the window is open.
    this.dispose = () => {
      unsubscribeChanged()
      unsubscribeDeleted()
    }
  }

  private replace(notices: readonly FollowUpNotice[]): void {
    this.byThread.clear()
    // The armed set is a handful of records, so replacing each thread's array as
    // it is written keeps every reader reactive without a second map to carry.
    for (const notice of notices) {
      const entries = this.byThread.get(notice.threadId) ?? []
      this.byThread.set(notice.threadId, [...entries, notice])
    }
  }

  dispose: (() => void) | null = null
}

export const followUpsState = new FollowUpsState()
