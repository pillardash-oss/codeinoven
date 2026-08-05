/**
 * Shared sidebar state for every collapsible sidebar in the app
 * (Projects, Chats, Settings). One width for all of them — resizing
 * any sidebar resizes them all. When collapsed the sidebar undocks:
 * hovering near the left edge reveals it as a floating overlay instead
 * of taking layout space. Width and collapsed state survive reloads.
 */

import { APP_SLUG } from '$shared/brand'

export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 420
export const SIDEBAR_DEFAULT_WIDTH = 264

const STORAGE_KEY = `${APP_SLUG}.sidebar.v1`

interface SidebarSnapshot {
  width: number
  collapsed: boolean
}

function clamp(w: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w))
}

function load(): SidebarSnapshot {
  const fallback = { width: SIDEBAR_DEFAULT_WIDTH, collapsed: false }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<SidebarSnapshot>
    return {
      width: typeof parsed.width === 'number' ? clamp(parsed.width) : fallback.width,
      collapsed: parsed.collapsed === true
    }
  } catch {
    return fallback
  }
}

class SidebarState {
  /** Whether the sidebar is undocked (hidden from layout). */
  collapsed = $state(load().collapsed)
  /** Docked sidebar width in px (user-adjustable, shared by all sidebars). */
  width = $state(load().width)
  /** Whether the overlay is currently revealed via edge hover. */
  hoverOpen = $state(false)

  /** True when the sidebar occupies layout space. */
  get docked(): boolean {
    return !this.collapsed
  }

  /** True when the sidebar is visible in any form. */
  get visible(): boolean {
    return !this.collapsed || this.hoverOpen
  }

  toggle(): void {
    this.collapsed = !this.collapsed
    if (this.collapsed) this.hoverOpen = false
    this.persist()
  }

  redock(): void {
    this.collapsed = false
    this.hoverOpen = false
    this.persist()
  }

  clampWidth(w: number): number {
    return clamp(w)
  }

  /** Save the current width/collapsed state (called after a resize drag ends). */
  persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ width: this.width, collapsed: this.collapsed })
      )
    } catch {
      // Sidebar layout is cosmetic; unavailable storage must not break the app.
    }
  }
}

export const sidebarState = new SidebarState()
