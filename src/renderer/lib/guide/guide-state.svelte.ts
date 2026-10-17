import { APP_SLUG } from '$shared/brand'
import {
  VIEW_GUIDES,
  workspaceTourViewFor,
  type GuideAction,
  type GuideStop,
  type ViewGuide,
  type WorkspaceTourView
} from './guide-stops'

const STORAGE_KEY = `${APP_SLUG}.viewGuides.v1`

/** Views whose guide has been walked to its last stop. */
type SeenRecord = Partial<Record<WorkspaceTourView, true>>

function loadSeen(): SeenRecord {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const seen: SeenRecord = {}
    for (const [view, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) seen[view as WorkspaceTourView] = true
    }
    return seen
  } catch {
    // Storage that is corrupt or unavailable must not stop a guide from running.
    return {}
  }
}

/**
 * The guide that is on screen, and which stop of it.
 *
 * One guide runs at a time, and it belongs to a view rather than to whatever
 * started it. That ownership is the whole rule: a guide points at the app of the
 * view it belongs to, so `syncView` ends it the moment the user leaves that view
 * rather than leaving pointers behind for something they are no longer looking
 * at. Leaving does not mark the guide seen: only walking it to its last stop
 * does, which is what keeps an abandoned guide an invitation instead of a
 * crossed-off chore.
 *
 * There is one exception, and it is a step the user themselves took: when a
 * stop's own action opens another view (setup, for instance), the guide waits
 * instead of ending, holds its place, and comes back when the user returns to
 * the view it belongs to. Otherwise every onboarding step that hands the user
 * somewhere else would end the tour that asked them to go.
 */
class GuideStateStore {
  #view = $state<WorkspaceTourView | null>(null)
  #stopIndex = $state(0)
  #waiting = $state(false)
  #seen = $state<SeenRecord>(loadSeen())

  /** The action a stop asked the app to perform, waiting to be picked up. */
  #pendingAction: GuideAction | null = $state(null)
  #actionRequests = $state(0)
  #consumedActionRequests = 0

  /** True while a guide is active, whether or not it is on screen. */
  get running(): boolean {
    return this.#view !== null
  }

  /** True while the guide should be drawn. A guide waiting for the user to come
   *  back from a step it sent them to is active but not visible. */
  get visible(): boolean {
    return this.#view !== null && !this.#waiting
  }

  get view(): WorkspaceTourView | null {
    return this.#view
  }

  get guide(): ViewGuide | null {
    return this.#view ? VIEW_GUIDES[this.#view] : null
  }

  get stop(): GuideStop | null {
    const guide = this.guide
    return guide ? (guide.stops[this.#stopIndex] ?? null) : null
  }

  get stopIndex(): number {
    return this.#stopIndex
  }

  get stopCount(): number {
    return this.guide?.stops.length ?? 0
  }

  get onLastStop(): boolean {
    return this.stopCount > 0 && this.#stopIndex === this.stopCount - 1
  }

  /** Whether this view's guide has been walked to the end, at any time. */
  hasSeen(view: WorkspaceTourView): boolean {
    return this.#seen[view] === true
  }

  /** Start a view's guide from its first stop. */
  start(view: WorkspaceTourView): void {
    this.#view = view
    this.#stopIndex = 0
    this.#waiting = false
  }

  /** Advance, and finish the guide when it was the last stop. */
  next(): void {
    if (!this.#view) return
    if (this.onLastStop) {
      this.#markSeen(this.#view)
      this.#view = null
      this.#stopIndex = 0
      return
    }
    this.#stopIndex = Math.min(this.stopCount - 1, this.#stopIndex + 1)
  }

  back(): void {
    if (!this.#view) return
    this.#stopIndex = Math.max(0, this.#stopIndex - 1)
  }

  /** Jump to a stop from the dock's own dots. */
  goTo(index: number): void {
    if (!this.#view) return
    if (!Number.isInteger(index)) return
    this.#stopIndex = Math.max(0, Math.min(this.stopCount - 1, index))
  }

  /** Leave without finishing, so the guide stays unseen and can be offered again. */
  close(): void {
    this.#view = null
    this.#stopIndex = 0
    this.#waiting = false
  }

  /**
   * Ask the app to perform the current stop's action. The request is consumed by
   * the app shell, which is the only place that knows how to add a project or
   * open a settings page, and `completeAction` closes the loop afterwards.
   */
  requestAction(): void {
    this.#request(this.stop?.action ?? null)
  }

  /** The other way to take this step, for a user the primary does not fit. */
  requestAlternative(): void {
    this.#request(this.stop?.alternative ?? null)
  }

  #request(action: GuideAction | null): void {
    if (!action) return
    // A step that opens another view puts the guide in waiting *before* the
    // navigation lands, so the view change it causes is read as this step
    // rather than as the user wandering off.
    if (action.leavesTheView) this.#waiting = true
    this.#pendingAction = action
    this.#actionRequests += 1
  }

  /** One-shot read of the requested action, for the app shell. */
  consumeActionRequest(): GuideAction | null {
    if (this.#consumedActionRequests === this.#actionRequests) return null
    this.#consumedActionRequests = this.#actionRequests
    return this.#pendingAction
  }

  /**
   * Called once the app has performed the action: the step is done, so the guide
   * moves on, and a step that is still open (a modal waiting on the user) keeps
   * the guide where it is until they close it.
   */
  completeAction(): void {
    this.next()
  }

  /**
   * Keep the guide and the view in step. Called with the app's active view on
   * every change, so a guide can never outlive the view it explains.
   */
  syncView(activeView: string): void {
    if (!this.#view) return
    if (workspaceTourViewFor(activeView) === this.#view) {
      // Back in the guide's own view: the step that sent the user away is done.
      if (this.#waiting) this.#waiting = false
      return
    }
    // An action that deliberately opened another view is a step in the guide,
    // not the user wandering off, so the guide waits rather than dying.
    if (this.#waiting) return
    this.close()
  }

  #markSeen(view: WorkspaceTourView): void {
    if (this.#seen[view] === true) return
    this.#seen = { ...this.#seen, [view]: true }
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#seen))
    } catch {
      // A guide the user just finished must not fail loudly over storage.
    }
  }
}

export const guideState = new GuideStateStore()
