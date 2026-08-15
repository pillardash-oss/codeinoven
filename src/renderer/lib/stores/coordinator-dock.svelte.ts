import { APP_SLUG } from '$shared/brand'
import { untrack } from 'svelte'
import type { Component, Snippet } from 'svelte'

const AUTO_OPEN_STORAGE_KEY = `${APP_SLUG}.coordinator-auto-open.v1`

export interface CoordinatorDockRegistration {
  projectId: string
  threadId: string
  /** Rail tooltip, accessible name, and sidebar tab title. */
  label: string
  icon: Component
  /** The panel body, owned by the thread that coordinates the work. */
  panel: Snippet
}

/**
 * The coordinator panel lives in the context sidebar, but everything it needs
 * (the assignment, its workers, the auditor, and a dozen callbacks) belongs to
 * the thread. So the thread publishes the panel as a snippet and the sidebar
 * renders it — no props travel through the workspace.
 *
 * Only one registration exists at a time: the visible thread is the only thread
 * that can be coordinating on screen.
 */
class CoordinatorDockState {
  /** Raw, not proxied — the payload holds a component and a snippet. */
  private registration = $state.raw<CoordinatorDockRegistration | null>(null)
  /** Whether a coordinator docks itself when its thread opens. Cleared when the
   *  user closes the tab, so a dismissed coordinator stays dismissed. */
  autoOpen = $state(loadAutoOpen())

  /** The coordinator for `projectId`/`threadId`, or null when that thread has none. */
  forThread(
    projectId: string | undefined,
    threadId: string | undefined
  ): CoordinatorDockRegistration | null {
    const current = this.registration
    if (!current || !projectId || !threadId) return null
    return current.projectId === projectId && current.threadId === threadId ? current : null
  }

  /**
   * Publish a coordinator. Re-registering identical values keeps the existing
   * object so the sidebar never remounts the panel mid-coordination. Returns a
   * disposer for the caller's effect cleanup.
   *
   * Callers invoke this from inside a `$effect`. Reading/writing `registration`
   * without `untrack` would make that effect depend on its own write — every
   * rerun (even for unrelated reasons) nulls the registration in cleanup and
   * immediately rewrites it, which is exactly the "effect reads and writes the
   * same state" cycle Svelte's loop guard trips on. `untrack` keeps this
   * bookkeeping invisible to the caller's reactive graph.
   */
  register(next: CoordinatorDockRegistration): () => void {
    untrack(() => {
      const current = this.registration
      const unchanged =
        current !== null &&
        current.projectId === next.projectId &&
        current.threadId === next.threadId &&
        current.label === next.label &&
        current.icon === next.icon &&
        current.panel === next.panel
      if (!unchanged) this.registration = next
    })
    return () => {
      untrack(() => {
        const active = this.registration
        if (active && active.projectId === next.projectId && active.threadId === next.threadId) {
          this.registration = null
        }
      })
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
