import { SvelteMap } from 'svelte/reactivity'
import type { BrowserHistoryEntry } from '$shared/browser/browser-library'

/**
 * The history drawer one thread browser tab has open under its address field.
 *
 * The field owns the drawer: it holds the draft, the ranking, the highlight and
 * the keys, so the drawer's behaviour and its rows stay one thing. What it cannot
 * own is the drawer's place in the layout. The page is a native view the
 * compositor paints above every DOM node, so a drawer drawn over it can only be
 * seen by parking the page (the visibility store's occlusion answer), and the user
 * is left watching their page blank while they type an address.
 *
 * The drawer is therefore a row of the browser column, exactly like the find bar:
 * it shrinks the content rect and the panel's observers place the page under it.
 * A row has to be drawn by the column, not by the field inside the toolbar, so the
 * field publishes what it has open here and the panel reads it
 * (`BrowserPanel.svelte`).
 *
 * Published per tab rather than globally because a tab can be mounted twice (the
 * sidebar copy and the full screen one, each with its own field): a field owns the
 * entry it published, so the copy that never typed can neither show its stale rows
 * nor clear the drawer the other copy is typing into. Only the panel that is really
 * on screen draws the row (`panelVisible`).
 */
export interface BrowserAddressDrawer {
  /** The list's stable id, so the field can point `aria-controls` at it. */
  readonly listId: string
  /** The pages offered, best first. The field owns the ranking. */
  readonly entries: readonly BrowserHistoryEntry[]
  /** The highlighted row, or -1 while the field's own text is what Enter opens. */
  readonly highlight: number
}

/** One mounted field's claim on its tab's drawer. */
export type BrowserAddressDrawerOwner = symbol

interface PublishedDrawer {
  owner: BrowserAddressDrawerOwner
  drawer: BrowserAddressDrawer
}

class BrowserAddressDrawerState {
  private drawers = new SvelteMap<string, PublishedDrawer>()

  /** The drawer a tab's field has open, or null while it has none. */
  forTab(tabId: string): BrowserAddressDrawer | null {
    return this.drawers.get(tabId)?.drawer ?? null
  }

  /**
   * Publish the drawer `owner` has open, or drop it with null. A null from a field
   * that is not the current publisher is ignored, so the other copy of the same
   * tab closing its own drawer cannot take the visible one's away.
   */
  publish(
    tabId: string,
    owner: BrowserAddressDrawerOwner,
    drawer: BrowserAddressDrawer | null
  ): void {
    const current = this.drawers.get(tabId)
    if (drawer) {
      this.drawers.set(tabId, { owner, drawer })
      return
    }
    if (current?.owner === owner) this.drawers.delete(tabId)
  }
}

export const browserAddressDrawer = new BrowserAddressDrawerState()
