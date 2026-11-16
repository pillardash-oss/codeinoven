import type {
  DisplayAvailability as DisplayPresenceSnapshot,
  DisplayPanelTarget,
  DisplayTargetOffer,
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

  /**
   * A device the panel should be showing, waiting for the workspace to open it.
   *
   * The watch in main decides which device was booted or moved to; opening the
   * tab needs the thread and project the workspace is standing in, which a store
   * cannot know, so the offer waits here until a surface drains it.
   */
  pendingTarget = $state<DisplayTargetOffer | null>(null)

  private cleanups: Array<() => void> = []
  private started = false
  /**
   * The display tabs last reported to main, by tab id, with the project each
   * belongs to.
   *
   * Reported as a set rather than as one "current" target, because the docks hold
   * mirrors in more than one project at a time: closing the tab in one project
   * must end that project's mirror and nothing else, and the other project's
   * threads keep their marks.
   */
  private reportedPanels = new Map<string, { projectId: string; key: string }>()

  init(): void {
    if (this.started) return
    this.started = true
    this.cleanups.push(
      subscribe('display:available', () => {
        this.available = true
      })
    )
    this.cleanups.push(
      subscribe('display:target', (offer: DisplayTargetOffer) => {
        this.available = true
        this.pendingTarget = offer
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
    this.reportedPanels = new Map()
    this.pendingTarget = null
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
   * Tell main which devices the docks are mirroring, and which thread owns each.
   *
   * The whole set is reported, not just the visible project's tab: a mirror that
   * ends is a tab that disappeared, and the project it belonged to is what says
   * whose marks to clear. Reading only the docks on screen made a project switch
   * look like every mirror in the app ending at once, which wiped the marks of
   * threads in projects the person was not looking at.
   *
   * A tab whose target or owning thread changes is announced again, so main can
   * follow a retargeted panel and let go of the device it no longer shows.
   */
  notePanelTargets(panels: DisplayPanelTarget[]): void {
    const closedProjects: string[] = []
    for (const [tabId, previous] of [...this.reportedPanels]) {
      if (panels.some((panel) => panel.tabId === tabId)) continue
      this.reportedPanels.delete(tabId)
      const stillOpen = [...this.reportedPanels.values()].some(
        (panel) => panel.projectId === previous.projectId
      )
      if (
        !stillOpen &&
        previous.projectId.length > 0 &&
        !closedProjects.includes(previous.projectId)
      )
        closedProjects.push(previous.projectId)
    }
    for (const projectId of closedProjects) {
      void invoke('display:notePanel', null, projectId).catch((error: unknown) =>
        logRendererError('The display panel target could not be reported', error)
      )
    }
    for (const panel of panels) {
      const key = `${panel.kind}:${panel.sourceId}:${panel.threadId ?? ''}`
      const previous = this.reportedPanels.get(panel.tabId)
      this.reportedPanels.set(panel.tabId, { projectId: panel.projectId ?? '', key })
      if (previous?.key === key) continue
      void invoke('display:notePanel', panel, panel.projectId).catch((error: unknown) =>
        logRendererError('The display panel target could not be reported', error)
      )
    }
  }

  /** Drop the offer the workspace just acted on, so nothing opens twice. */
  clearPendingTarget(at: number): void {
    if (this.pendingTarget?.at === at) this.pendingTarget = null
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
