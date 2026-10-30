import { SvelteSet } from 'svelte/reactivity'
import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import { isThreadBusyStatus } from '$shared/thread-status-policy'
import type { OrchestrationDispatch, Thread } from '$shared/types'

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`
}

/**
 * The orchestrator board's data.
 *
 * A workstation-control turn starts real threads in other projects, and the
 * board that lists them belongs to the thread that asked for them, not to the
 * projects those runs live in. So this store answers one question per initiator
 * thread: every run it dispatched, with each run's own project, machine, model
 * and live status.
 *
 * Nothing here decides whether a thread is an orchestrator: main answers that,
 * from the dispatch ledger, which is what makes the board survive a restart and
 * appear the moment a dispatch lands instead of after the thread is reopened.
 */
class OrchestrationCoordinatorState {
  /** Last answer per initiator thread, so the board paints before its own read settles. */
  private readonly rows = new SvelteMap<string, OrchestrationDispatch[]>()
  /** Initiators with a read in flight, so a burst of activity cannot stack reads. */
  private readonly pending = new Set<string>()
  /** Initiators whose data changed while a read was in flight: read once more. */
  private readonly dirty = new Set<string>()
  /** Child thread id to the initiators whose boards list it, for live updates. */
  private readonly childIndex = new SvelteMap<string, SvelteSet<string>>()
  /** The coordinates behind each key, for a re-read that only has the key. */
  private readonly refs = new Map<string, { projectId: string; threadId: string }>()
  private listening = false

  /** Every run this thread dispatched, newest first. */
  rowsFor(projectId: string, threadId: string): OrchestrationDispatch[] {
    return this.rows.get(threadKey(projectId, threadId)) ?? []
  }

  /** How many of this thread's runs are still working. */
  runningCount(projectId: string, threadId: string): number {
    return this.rowsFor(projectId, threadId).filter((row) => isThreadBusyStatus(row.thread.status))
      .length
  }

  /** Whether this thread has dispatched anything, so no board should dock for it. */
  hasDispatches(projectId: string, threadId: string): boolean {
    return this.rowsFor(projectId, threadId).length > 0
  }

  /**
   * Ask main what this thread dispatched.
   *
   * Called when the on-screen thread changes and again whenever that thread sees
   * activity, because a dispatch can happen mid-thread: the board has to appear
   * then, without the user reopening anything. Reads are coalesced per thread,
   * and a change that arrives during a read schedules exactly one more.
   */
  async refresh(projectId: string, threadId: string): Promise<void> {
    if (!projectId || !threadId) return
    this.ensureListening()
    const key = threadKey(projectId, threadId)
    this.refs.set(key, { projectId, threadId })
    if (this.pending.has(key)) {
      this.dirty.add(key)
      return
    }
    this.pending.add(key)
    try {
      const next = await invoke('orchestration:dispatches', projectId, threadId)
      this.apply(key, next)
    } catch (error) {
      logRendererError(`Could not read the dispatches of thread ${threadId}`, error)
    } finally {
      this.pending.delete(key)
      if (this.dirty.delete(key)) void this.refresh(projectId, threadId)
    }
  }

  /** Replace one initiator's rows and keep the child index in step with them. */
  private apply(key: string, next: OrchestrationDispatch[]): void {
    const previous = this.rows.get(key) ?? []
    for (const row of previous) {
      this.childIndex.get(row.thread.id)?.delete(key)
    }
    this.rows.set(key, next)
    for (const row of next) {
      let owners = this.childIndex.get(row.thread.id)
      if (!owners) {
        owners = new SvelteSet<string>()
        this.childIndex.set(row.thread.id, owners)
      }
      owners.add(key)
    }
  }

  /**
   * Keep a board live while the user watches it.
   *
   * A dispatched run is a thread of its own in another project, so its progress
   * arrives as that thread's own update rather than as anything this thread
   * emits. Only the initiators that actually list the changed child are re-read,
   * which keeps this inert on every other thread update in the app.
   */
  private ensureListening(): void {
    if (this.listening) return
    this.listening = true
    subscribe('thread:updated', (thread: Thread) => {
      const owners = this.childIndex.get(thread.id)
      if (!owners || owners.size === 0) return
      for (const key of owners) {
        const ref = this.refs.get(key)
        if (ref) void this.refresh(ref.projectId, ref.threadId)
      }
    })
  }
}

export const orchestrationCoordinatorState = new OrchestrationCoordinatorState()
