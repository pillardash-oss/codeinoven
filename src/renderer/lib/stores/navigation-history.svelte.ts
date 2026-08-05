/**
 * Global back/forward navigation history for the app's locations.
 *
 * A location is the combination of the current top-level view and the thread
 * open in it. Every visible change — switching tabs, or moving from one thread
 * to another inside the same view — is recorded so the header's back/forward
 * buttons can walk the whole journey, not just tab switches.
 *
 * Recording is driven by App.svelte's location observer. View transitions that
 * restore a thread asynchronously (e.g. entering Chats) first land on the new
 * view with no thread and only settle a moment later; a short settle window
 * absorbs that so a single user action produces a single history entry.
 * Back/forward wraps its own navigation in a traversal, which suppresses the
 * observer until the target location has been fully restored.
 */
import type { MainView, SelectedThreadReference } from './renderer-recovery'

const MAX_HISTORY_DEPTH = 50
/** After a view change, thread churn within this window is treated as settling. */
const SETTLE_WINDOW_MS = 250

/** The project workspace can be viewed as Projects, Scope, or Threads. */
export type ProjectViewMode = 'projects' | 'scope' | 'threads'

/** A place in the app: a top-level view plus the thread open in it. */
export interface NavigationLocation {
  view: MainView
  thread: SelectedThreadReference | null
}

function isProjectView(view: MainView): view is ProjectViewMode {
  return view === 'projects' || view === 'scope' || view === 'threads'
}

function sameThread(a: SelectedThreadReference | null, b: SelectedThreadReference | null): boolean {
  if (a === null || b === null) return a === b
  return a.projectId === b.projectId && a.threadId === b.threadId
}

function sameLocation(a: NavigationLocation, b: NavigationLocation): boolean {
  return a.view === b.view && sameThread(a.thread, b.thread)
}

class NavigationHistoryState {
  /** Locations visited before the current one, oldest first. */
  backStack: NavigationLocation[] = $state([])
  /** Locations the user backed away from, nearest first. */
  forwardStack: NavigationLocation[] = $state([])
  /** The location currently on screen, mirroring the app's active state. */
  current: NavigationLocation = $state({ view: 'projects', thread: null })
  /** The last project view visited — what the header button shows away from it. */
  lastProjectView: ProjectViewMode = $state('projects')
  /** Non-zero while a back/forward traversal is applying its target location. */
  private traversalDepth = 0
  /** Until this timestamp, same-view thread changes are treated as settling. */
  private settlingUntil = 0

  /** Seed the history with the recovered location. */
  init(initialView: MainView, initialThread: SelectedThreadReference | null): void {
    this.current = { view: initialView, thread: initialThread }
    if (isProjectView(initialView)) this.lastProjectView = initialView
    this.backStack = []
    this.forwardStack = []
    this.settlingUntil = Date.now() + SETTLE_WINDOW_MS
  }

  beginTraversal(): void {
    this.traversalDepth++
  }

  endTraversal(): void {
    this.traversalDepth--
  }

  /** Sync the history with the app's current location. */
  observe(location: NavigationLocation): void {
    if (this.traversalDepth > 0) return
    if (sameLocation(location, this.current)) return

    const viewChanged = location.view !== this.current.view
    if (!viewChanged && Date.now() < this.settlingUntil) {
      // Thread settling in right after a view change — merge, don't record.
      this.current = location
      return
    }

    this.backStack = [...this.backStack, this.current].slice(-MAX_HISTORY_DEPTH)
    this.forwardStack = []
    this.current = location
    if (viewChanged) {
      this.settlingUntil = Date.now() + SETTLE_WINDOW_MS
      if (isProjectView(location.view)) this.lastProjectView = location.view
    }
  }

  get canGoBack(): boolean {
    return this.backStack.length > 0
  }

  get canGoForward(): boolean {
    return this.forwardStack.length > 0
  }

  /** Pop the previous location; returns the target or null when the stack is empty. */
  back(currentLocation: NavigationLocation): NavigationLocation | null {
    const target = this.backStack.at(-1)
    if (!target) return null
    this.backStack = this.backStack.slice(0, -1)
    this.forwardStack = [...this.forwardStack, currentLocation].slice(-MAX_HISTORY_DEPTH)
    this.current = target
    this.settlingUntil = 0
    if (isProjectView(target.view)) this.lastProjectView = target.view
    return target
  }

  /** Pop the next location; returns the target or null when the stack is empty. */
  forward(currentLocation: NavigationLocation): NavigationLocation | null {
    const target = this.forwardStack.at(-1)
    if (!target) return null
    this.forwardStack = this.forwardStack.slice(0, -1)
    this.backStack = [...this.backStack, currentLocation].slice(-MAX_HISTORY_DEPTH)
    this.current = target
    this.settlingUntil = 0
    if (isProjectView(target.view)) this.lastProjectView = target.view
    return target
  }
}

export const navigationHistoryState = new NavigationHistoryState()
