import { SvelteSet } from 'svelte/reactivity'
import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import { isThreadBusyStatus } from '$shared/thread-status-policy'
import type { OrchestrationInitiator, Thread } from '$shared/types'

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}\u0000${threadId}`
}

/**
 * The orchestrator board's data.
 *
 * A workstation-control turn starts real threads in other projects, and the
 * board that lists them belongs to the thread that asked for them, not to the
 * projects those runs live in. So this store answers one question per initiator
 * thread: every thread it dispatched, as the thread rows their own projects
 * carry them.
 *
 * Nothing here decides whether a thread is an orchestrator: main answers that,
 * from the dispatch ledger, which is what makes the board survive a restart and
 * appear the moment a dispatch lands instead of after the thread is reopened.
 */
class OrchestrationCoordinatorState {
  /** Last answer per initiator thread, so the board paints before its own read settles. */
  private readonly rows = new SvelteMap<string, Thread[]>()
  /** Initiators with a read in flight, so a burst of activity cannot stack reads. */
  private readonly pending = new Set<string>()
  /** Initiators whose data changed while a read was in flight: read once more. */
  private readonly dirty = new Set<string>()
  /** Child thread id to the initiators whose boards list it, for live updates. */
  private readonly childIndex = new SvelteMap<string, SvelteSet<string>>()
  /** The coordinates behind each key, for a re-read that only has the key. */
  private readonly refs = new Map<string, { projectId: string; threadId: string }>()
  /**
   * How many runs each thread has dispatched, by thread id.
   *
   * This is the mark every thread row of every kind wears (a project thread, a
   * chat, an assistant task), so it is keyed by thread id alone and covers the
   * whole app rather than one project: a dispatch is a fact about the thread
   * that asked, wherever that thread lives.
   */
  private readonly initiators = new SvelteMap<string, number>()
  private initiatorsRequested = false
  private listening = false

  /** How many runs this thread has dispatched; 0 when it never has. */
  dispatchedCount(threadId: string): number {
    return this.initiators.get(threadId) ?? 0
  }

  /** Whether a row should wear the orchestrator mark. */
  hasDispatched(threadId: string): boolean {
    return this.dispatchedCount(threadId) > 0
  }

  /**
   * Read which threads have dispatched anything, once.
   *
   * Every thread row asks for the mark, so this is what keeps that question free:
   * one small read after first paint, then the map is maintained from the change
   * notice a new dispatch pushes. Idempotent, so a thousand rows cost one read.
   */
  ensureInitiators(): void {
    this.ensureListening()
    if (this.initiatorsRequested) return
    this.initiatorsRequested = true
    void invoke('orchestration:initiators')
      .then((entries) => this.applyInitiators(entries))
      .catch((error: unknown) => {
        // A row can live without its mark; it cannot live with a thrown read on
        // every sidebar mount, so the failure is reported and the flag stays set.
        logRendererError('Could not read the threads that dispatched runs', error)
      })
  }

  private applyInitiators(entries: readonly OrchestrationInitiator[]): void {
    for (const entry of entries) {
      if (entry.count > 0) this.initiators.set(entry.threadId, entry.count)
      else this.initiators.delete(entry.threadId)
    }
  }

  /** Every run this thread dispatched, newest first. */
  rowsFor(projectId: string, threadId: string): Thread[] {
    return this.rows.get(threadKey(projectId, threadId)) ?? []
  }

  /** How many of this thread's runs are still working. */
  runningCount(projectId: string, threadId: string): number {
    return this.rowsFor(projectId, threadId).filter((row) => isThreadBusyStatus(row.status)).length
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
  private apply(key: string, next: Thread[]): void {
    const previous = this.rows.get(key) ?? []
    for (const row of previous) {
      this.childIndex.get(row.id)?.delete(key)
    }
    this.rows.set(key, next)
    for (const row of next) {
      let owners = this.childIndex.get(row.id)
      if (!owners) {
        owners = new SvelteSet<string>()
        this.childIndex.set(row.id, owners)
      }
      owners.add(key)
    }
    // A thread with a board is by definition an initiator, so its row mark is
    // kept from the same read instead of waiting for the global pass.
    const threadId = key.slice(key.indexOf('\u0000') + 1)
    if (next.length > 0) this.initiators.set(threadId, next.length)
  }

  /**
   * Keep a board live while the user watches it, and keep every row's mark
   * current.
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
    // The mark's own channel: a thread that just dispatched a run is not on
    // screen in the board's terms yet, but its sidebar row is, so the count is
    // taken from the notice rather than from a board read.
    subscribe('orchestration:changed', (change) => {
      if (change.count > 0) this.initiators.set(change.threadId, change.count)
      else this.initiators.delete(change.threadId)
    })
  }
}

export const orchestrationCoordinatorState = new OrchestrationCoordinatorState()
