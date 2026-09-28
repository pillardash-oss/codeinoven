import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { BrowserPopupWindow, BrowserViewBounds } from '$shared/ipc-contract'
import { reportError } from './app-errors.svelte'

/**
 * The popup windows the browser is holding, keyed by id in the order main
 * reported them.
 *
 * A popup window is a page's own `window.open` with a window in it, and main owns
 * every one of them: it hosts the page in a native view and decides when the popup
 * is gone. This store is the renderer's mirror of that list, so the rail can draw
 * one tab per popup and place the page it belongs to without asking for state it
 * would then have to re-read on every change.
 *
 * The same map instance is mutated for every update: replacing the whole map on a
 * refresh would leave a mounted panel subscribed to the list it read when it
 * rendered, and its tabs would stop moving.
 */
class BrowserPopupWindowsState {
  private readonly popups = new SvelteMap<string, BrowserPopupWindow>()

  constructor() {
    // One app-lifetime subscription: a popup that opens while the browser view is
    // closed still has to be there when the user opens it, and one that closes
    // itself while the rail is showing another tool must still leave the list.
    subscribe('browser:popupWindows', (popups) => this.apply(popups))
  }

  /** Apply main's whole list: entries it no longer holds are dropped. */
  private apply(popups: BrowserPopupWindow[]): void {
    const live = new Set(popups.map((popup) => popup.id))
    for (const id of [...this.popups.keys()]) {
      if (!live.has(id)) this.popups.delete(id)
    }
    for (const popup of popups) this.popups.set(popup.id, popup)
  }

  /** Re-read the popups a project holds, so a panel opened on a new session (or
   *  after a change this renderer missed) shows what main actually has. */
  async load(projectId: string): Promise<void> {
    let popups: BrowserPopupWindow[]
    try {
      popups = await invoke('browser:getPopupWindows', projectId)
    } catch (error: unknown) {
      reportError(error, 'Browser popup windows could not be loaded.')
      return
    }
    this.apply(popups)
  }

  /** One browser tab's popup windows, in the order they opened. */
  forTab(tabId: string): BrowserPopupWindow[] {
    const popups: BrowserPopupWindow[] = []
    for (const popup of this.popups.values()) {
      if (popup.tabId === tabId) popups.push(popup)
    }
    return popups
  }

  /** Place a popup's page over the frame the panel measured for it. */
  show(popupId: string, bounds: BrowserViewBounds): void {
    void invoke('browser:showPopupWindow', popupId, bounds).catch(() => {})
  }

  /** Take a popup's page off screen. It keeps running where main keeps it. */
  hide(popupId: string): void {
    void invoke('browser:hidePopupWindow', popupId).catch(() => {})
  }

  /** Give a popup's page the keyboard, for the popup the user just picked. */
  focus(popupId: string): void {
    void invoke('browser:focusPopupWindow', popupId).catch(() => {})
  }

  /** Close a popup on the user's behalf: its page stops and it leaves the rail. */
  close(popupId: string): void {
    void invoke('browser:closePopupWindow', popupId).catch((error: unknown) => {
      reportError(error, 'That popup window could not be closed.')
    })
  }
}

export const browserPopupWindows = new BrowserPopupWindowsState()
