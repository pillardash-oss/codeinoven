import type {
  DisplayAvailability as DisplayPresenceSnapshot,
  DisplayThreadActivity
} from '$shared/ipc/display'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'

/**
 * Whether the display panel exists for this session, and which threads are driving
 * a display target.
 *
 * The panel is a view of work an agent started on its own, so it has no rail item
 * until that happens. This store is the whole of what the app keeps loaded for it:
 * two event subscriptions and two flags. The panel's module, its store and the
 * main process's capture code stay unfetched until the item is opened.
 */
class DisplayAvailabilityState {
  /** True once main has seen an agent start or attach to a display target. */
  available = $state(false)

  /** Threads wearing the "driving a display target" mark, by thread id. */
  activity = $state<Record<string, number>>({})

  private cleanups: Array<() => void> = []
  private started = false
  /** Last working-thread list reported, so a busy badge changing costs no round trip. */
  private reportedThreads: string | null = null

  init(): void {
    if (this.started) return
    this.started = true
    this.cleanups.push(
      subscribe('display:available', () => {
        this.available = true
      })
    )
    this.cleanups.push(
      subscribe('display:activity', (activity: DisplayThreadActivity) => {
        this.applyActivity(activity)
      })
    )
    // A reload loses the events that already fired, so the state is read once.
    void invoke('display:presence')
      .then((presence: DisplayPresenceSnapshot) => {
        if (presence.available) this.available = true
        for (const threadId of presence.threads) {
          if (this.activity[threadId] === undefined) this.activity[threadId] = Date.now()
        }
      })
      .catch((error: unknown) =>
        logRendererError('The display panel presence could not be read', error)
      )
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
    this.started = false
  }

  /** Whether this thread's agent is driving a display target right now. */
  isThreadUsingDisplay(threadId: string): boolean {
    return this.activity[threadId] !== undefined
  }

  /** When this thread started driving a display target, or 0 when it is not. */
  threadActivityAt(threadId: string): number {
    return this.activity[threadId] ?? 0
  }

  /**
   * Report the threads an agent is working in.
   *
   * Presence costs one device probe plus one process-table read, so main only
   * looks while this is non-empty. An idle app never scans for a device.
   */
  noteWorkingThreads(threadIds: readonly string[]): void {
    const key = [...threadIds].sort().join(',')
    if (this.reportedThreads === key) return
    this.reportedThreads = key
    void invoke('display:noteWorkingThreads', [...threadIds]).catch((error: unknown) =>
      logRendererError('The agent working threads could not be reported', error)
    )
  }

  private applyActivity(activity: DisplayThreadActivity): void {
    if (!activity.active) {
      if (this.activity[activity.threadId] === undefined) return
      const next = { ...this.activity }
      delete next[activity.threadId]
      this.activity = next
      return
    }
    this.activity = { ...this.activity, [activity.threadId]: activity.at }
  }
}

export const displayAvailability = new DisplayAvailabilityState()
