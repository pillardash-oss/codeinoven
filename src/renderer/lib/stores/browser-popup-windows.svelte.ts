import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { BrowserExtension, BrowserPopupWindow, BrowserViewBounds } from '$shared/ipc-contract'
import type { BrowserPopupWindowContextTab } from './context-sidebar-types'
import { browserExtensions } from './browser-extensions.svelte'
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

  /**
   * The popup the rail is showing. Only the id is kept, so a popup that ends
   * cannot leave a stale record behind, and a pick survives the reports that
   * rewrite the list around it.
   */
  private selectedId = $state<string | null>(null)

  /**
   * Whether {@link start} has wired the listener. Popups belong to the browser,
   * and the browser is not part of the first paint, so this stays inert until the
   * runtime seam asks for it.
   */
  private started = false

  /** Register the runtime's one subscription. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
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
    // A popup that ended hands the rail to the newest one left rather than
    // leaving a pick that no longer exists.
    if (this.selectedId !== null && !live.has(this.selectedId)) this.selectedId = null
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

  /**
   * One rail tab per popup a browser tab holds, in the order they opened.
   *
   * The tab is the popup: the rail's strip is the list of windows and a popup
   * that ends simply stops appearing here, so no surface has to prune the strip.
   * An extension's popup is named after the extension and wears its icon, because
   * that page is the extension's own UI and the title it sets is not its name.
   */
  tabsFor(tabId: string): BrowserPopupWindowContextTab[] {
    return this.forTab(tabId).map((popup) => {
      const extension = this.extensionFor(popup)
      return {
        id: popup.id,
        kind: 'popup-window' as const,
        title: extension?.name ?? (popup.title || popup.url || 'Popup window'),
        openerTabId: popup.tabId,
        favicon: extension?.iconDataUrl ?? popup.favicon ?? undefined
      }
    })
  }

  /** The extension one extension-popup belongs to, or null for a page's popup. */
  private extensionFor(popup: BrowserPopupWindow): BrowserExtension | null {
    if (popup.extensionId === null) return null
    return (
      browserExtensions.extensions.find((extension) => extension.id === popup.extensionId) ?? null
    )
  }

  /**
   * Open one extension's own popup in the rail.
   *
   * An extension's action popup has no toolbar to hang from here, so the rail is
   * its host. Main answers with the popup's id, which is the popup already open
   * when that extension already has one in this tab, and the rail then draws it
   * like any other popup: a tab of its own, placed by the panel, closed from the
   * strip.
   */
  async openExtension(
    projectId: string,
    tabId: string,
    extensionId: string
  ): Promise<string | null> {
    try {
      const popupId = await invoke('browser:openExtensionPopup', projectId, tabId, extensionId)
      this.select(popupId)
      return popupId
    } catch (error: unknown) {
      reportError(error, 'That extension popup could not be opened.')
      return null
    }
  }

  /** One popup by id, or null once it is gone. */
  find(popupId: string): BrowserPopupWindow | null {
    return this.popups.get(popupId) ?? null
  }

  /**
   * The popup the rail shows for a browser tab: the one the user picked, or the
   * newest still open. Null when that tab holds none, which is when the rail has
   * nothing left to display.
   */
  activeFor(tabId: string): BrowserPopupWindow | null {
    const popups = this.forTab(tabId)
    if (popups.length === 0) return null
    const picked = popups.find((popup) => popup.id === this.selectedId)
    if (picked) return picked
    return popups[popups.length - 1] ?? null
  }

  /** Show one popup: the rail's frame places it and its tab reads as current. */
  select(popupId: string): void {
    this.selectedId = popupId
  }

  /**
   * Close every popup one browser tab holds, for the rail's own close control:
   * the windows end and their tabs leave the strip with them.
   */
  closeForTab(tabId: string): void {
    for (const popup of this.forTab(tabId)) this.close(popup.id)
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
