import { APP_SLUG } from '$shared/brand'
import type { Component } from 'svelte'
import type {
  AchievementCoordinatorPanelProps,
  AssignmentCoordinatorPanelProps,
  IndependentAuditCoordinatorPanelProps
} from '$shared/types'

const AUTO_OPEN_STORAGE_KEY = `${APP_SLUG}.coordinator-auto-open.v1`

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
 * sidebar renders it — no props travel through the workspace.
 *
 * Only one registration exists at a time: the visible thread is the only thread
 * that can be coordinating on screen.
 */
class CoordinatorDockState {
  /** Raw, not proxied — the payload holds a component and prop records. */
  private registration = $state.raw<CoordinatorDockRegistration | null>(null)
  /** Whether a coordinator docks itself when its thread opens. Cleared when the
   *  user closes the tab, so a dismissed coordinator stays dismissed. */
  autoOpen = $state(loadAutoOpen())

  /** The coordinator for `projectId`/`threadId`, or null when that thread has none. */
  forThread(
    projectId: string | null | undefined,
    threadId: string | null | undefined
  ): CoordinatorDockRegistration | null {
    const current = this.registration
    if (!current || !projectId || !threadId) return null
    return current.projectId === projectId && current.threadId === threadId ? current : null
  }

  /**
   * Publish a coordinator. The registration is replaced on every call so the
   * panel always renders current props; the sidebar keeps the same component
   * instance because it selects the component from the registration rather
   * than from a snippet identity. Returns a disposer for the caller's effect
   * cleanup that never clears a newer registration (an old child unmounting
   * must not tear down the panel the new child just published).
   */
  register(next: CoordinatorDockRegistration): () => void {
    this.registration = next
    return () => {
      if (this.registration === next) {
        this.registration = null
      }
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
