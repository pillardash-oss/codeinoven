import { APP_SLUG } from '$shared/brand'
import type { Component } from 'svelte'
import type {
  AchievementCoordinatorPanelProps,
  AssignmentCoordinatorPanelProps,
  DesignCoordinatorPanelProps,
  IndependentAuditCoordinatorPanelProps
} from '$shared/types'

const AUTO_OPEN_STORAGE_KEY = `${APP_SLUG}.coordinator-auto-open.v1`
/** How many coordinator rows keep their last published panel for instant
 *  repaint after a thread switch. A row is one coordinator and its children, so
 *  a handful covers the coordinators a user moves between in one session. */
const MAX_RECALLED_COORDINATORS = 8

function coordinatorRowKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

/**
 * The panel body plus its full prop set. The sidebar picks the component from
 * `component`, so the same component instance survives while the coordinating
 * thread keeps updating its props. A worker/auditor switch therefore updates
 * the board instead of destroying and rebuilding it.
 */
export type CoordinatorDockPanel =
  | { component: 'assignment'; props: AssignmentCoordinatorPanelProps }
  | { component: 'achievement'; props: AchievementCoordinatorPanelProps }
  | { component: 'independent-audit'; props: IndependentAuditCoordinatorPanelProps }
  /** The authored-work coordinator: a thread's design or video composition, and the
   *  way back to it after a restart. Published for a thread that opened a session,
   *  whether or not any worker exists, because the work is what the user returns
   *  to. */
  | { component: 'design'; props: DesignCoordinatorPanelProps }

export interface CoordinatorDockRegistration {
  projectId: string
  /** The coordinator thread id. Children of one coordinator share this value,
   *  so moving between them never swaps the sidebar tab. */
  threadId: string
  /** Rail tooltip, accessible name, and sidebar tab title. */
  label: string
  icon: Component
  panel: CoordinatorDockPanel
}

/**
 * The coordinator panel lives in the context sidebar, but everything it needs
 * (the assignment, its workers, the auditor, and a dozen callbacks) belongs to
 * the thread. So the coordinating thread publishes the panel data and the
 * sidebar renders it, and no props travel through the workspace.
 *
 * Every view of one coordinator row (the Sr. Engineer plus its workers and
 * auditor) publishes under that row's thread id, and the last publish per row
 * is remembered. The panel therefore survives a thread switch: the row on
 * screen keeps its panel while the entering view hydrates, instead of blanking
 * the sidebar for a frame and rebuilding the whole board.
 */
class CoordinatorDockState {
  /** Raw, not proxied. The payload holds a component and prop records. The
   *  latest publish, and the reactive trigger every reader depends on. */
  private registration = $state.raw<CoordinatorDockRegistration | null>(null)
  /** Last panel published per coordinator row, most recent last. Recalling a
   *  row's panel is what removes the hydration gap on navigation; the bound
   *  keeps a long session from retaining panels for rows nobody returns to. */
  private recalled = new Map<string, CoordinatorDockRegistration>()
  /** Whether a coordinator docks itself when its thread opens. Cleared when the
   *  user closes the tab, so a dismissed coordinator stays dismissed. */
  autoOpen = $state(loadAutoOpen())

  /** The coordinator for `projectId`/`threadId`, or null when that thread has none. */
  forThread(
    projectId: string | null | undefined,
    threadId: string | null | undefined
  ): CoordinatorDockRegistration | null {
    if (!projectId || !threadId) return null
    const current = this.registration
    if (current && current.projectId === projectId && current.threadId === threadId) return current
    return this.recalled.get(coordinatorRowKey(projectId, threadId)) ?? null
  }

  /**
   * Publish a coordinator. The registration is replaced on every call so the
   * panel always renders current props; the sidebar keeps the same component
   * instance because it selects the component from the registration rather
   * than from a snippet identity.
   *
   * There is deliberately no unmount disposer: a view is only a prop provider
   * for its row, so a thread switch (which unmounts one view and mounts its
   * sibling) must not withdraw the panel. A view that settles without a
   * coordinator calls `withdraw` instead, and the panel is dropped when its
   * row stops coordinating or when the row falls out of the recall bound.
   */
  register(next: CoordinatorDockRegistration): void {
    const key = coordinatorRowKey(next.projectId, next.threadId)
    this.recalled.delete(key)
    this.recalled.set(key, next)
    while (this.recalled.size > MAX_RECALLED_COORDINATORS) {
      const oldest = this.recalled.keys().next().value
      if (oldest === undefined) break
      this.recalled.delete(oldest)
    }
    this.registration = next
  }

  /** Drop a row's panel, e.g. because its thread settled with no coordinator.
   *  The next publish re-registers it, so a coordinator that returns is never
   *  lost. */
  withdraw(projectId: string, threadId: string): void {
    this.recalled.delete(coordinatorRowKey(projectId, threadId))
    const current = this.registration
    if (current && current.projectId === projectId && current.threadId === threadId) {
      this.registration = null
    }
  }

  setAutoOpen(value: boolean): void {
    this.autoOpen = value
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(AUTO_OPEN_STORAGE_KEY, value ? '1' : '0')
    } catch {
      // The preference is cosmetic; unavailable storage must not break the app.
    }
  }
}

function loadAutoOpen(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(AUTO_OPEN_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export const coordinatorDockState = new CoordinatorDockState()
