import { createContext } from 'svelte'

/**
 * What a panel offers the controls it hosts, so an interaction that opens
 * outside the panel can keep the panel on screen.
 *
 * A collapsible sidebar undocks when collapsed and reveals itself as a floating
 * overlay that closes as soon as the pointer leaves it. A popover opened from a
 * row inside that panel (a search, which portals to the body and lands beside
 * the panel) therefore reads as the user walking away: the panel closes
 * underneath the search and takes the half-typed query with it. A control that
 * starts such an interaction takes a hold for as long as it is open, and the
 * panel stays put until the hold is released.
 */
export interface SidebarPanelContext {
  /** Keep the panel on screen until the matching `releaseHold`. */
  hold(): void
  /** Release one hold, which gives the panel back to the pointer. */
  releaseHold(): void
}

/** `[get, set, has]`, so a control outside any panel can ask before reading:
 *  it only ever holds the panel it actually lives in. */
export const [getSidebarPanelContext, setSidebarPanelContext, hasSidebarPanelContext] =
  createContext<SidebarPanelContext>()
