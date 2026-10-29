import { SvelteSet } from 'svelte/reactivity'
import type { BrowserExtensionSidePanel, BrowserPopupWindow } from '$shared/ipc-contract'
import { browserExtensionSidePanels } from '../browser-extension-side-panels.svelte'
import { browserPopupWindows } from '../browser-popup-windows.svelte'
import type { GlobalBrowserState } from '../global-browser.svelte'

/** GlobalBrowserState panels: one concern, moved verbatim from the composition root. */
export class GlobalBrowserStatePanels {
  constructor(private readonly host: GlobalBrowserState) {}

  /**
   * Take main's popup windows into the rail.
   *
   * A popup opened by the tab on screen is shown, because the user asked for it by
   * clicking something: the rail comes up on it and the tab it just opened reads as
   * current. A popup opened by a background tab joins the browser-wide strip without
   * moving the user's focus away from the popup already on screen.
   */
  applyPopupWindows(popups: BrowserPopupWindow[]): void {
    const live = new SvelteSet(popups.map((popup) => popup.id))
    for (const id of [...this.host.popupWindowState.keys()]) {
      if (!live.has(id)) this.host.popupWindowState.delete(id)
    }
    for (const popup of popups) {
      const previous = this.host.popupWindowState.get(popup.id)
      this.host.popupWindowState.set(popup.id, {
        tabId: popup.tabId,
        activationSequence: popup.activationSequence
      })
      const newlyOpenedOrActivated =
        previous === undefined ||
        previous.tabId !== popup.tabId ||
        previous.activationSequence !== popup.activationSequence
      if (popup.tabId === this.host.activeTabId && newlyOpenedOrActivated) {
        browserPopupWindows.select(popup.id)
        this.host.showPopupsSidebar()
      }
    }
    // The panel belongs to the browser's visible popup windows, so it closes only
    // when the last one leaves the shared list.
    //
    // The answer comes from this report and not from the popup store's mirror of
    // it: this listener is registered before the popup store's own, so inside this
    // dispatch the mirror still holds the previous list. Reading it here would undo
    // the open above, and it would leave the panel up after the last window closed:
    // the two are the same mistake in opposite directions.
    this.closePopupsWithNoWindows(popups.length > 0)
  }

  /** Close the popup tool once the browser has no visible popup windows.
   *
   *  `hasOpenPopups` is passed in rather than read here because the report
   *  handler runs inside the popup report's own dispatch, where the popup store's
   *  mirror is still one report behind. Callers outside that dispatch answer with
   *  {@link hasOpenPopupWindows}. */
  closePopupsWithNoWindows(hasOpenPopups: boolean): void {
    if (!this.host.contextSidebarVisible) return
    if (this.host.contextSidebarTool !== 'popups') return
    if (hasOpenPopups) return
    this.host.contextSidebarVisible = false
  }

  /** Whether the browser has a visible popup in the popup store's mirror.
   *  Only for callers outside a popup report's own dispatch: the report handler
   *  answers from the report itself, because the mirror lags one event there. */
  hasOpenPopupWindows(): boolean {
    return browserPopupWindows.all().length > 0
  }

  /**
   * Take main's extension side panels into the rail.
   *
   * An extension's panel is the extension putting its own UI beside the page, so
   * the first panel for the tab on screen is shown: the rail comes up on it exactly
   * as it does for a popup window the user asked for, and a panel for a background
   * tab waits in that tab's own rail until the user goes back to it. A further
   * panel only joins the list, so an extension cannot move the panel under the
   * user's hands while they are using the one already up.
   */
  applyExtensionSidePanels(panels: BrowserExtensionSidePanel[]): void {
    const live = panels.map((panel) => this.extensionSidePanelKey(panel))
    for (const key of [...this.host.seenExtensionSidePanelIds]) {
      if (!live.includes(key)) this.host.seenExtensionSidePanelIds.delete(key)
    }
    const tabId = this.host.activeTabId
    for (const panel of panels) {
      const key = this.extensionSidePanelKey(panel)
      if (this.host.seenExtensionSidePanelIds.has(key)) continue
      this.host.seenExtensionSidePanelIds.add(key)
      if (tabId !== null && panel.appTabId === tabId) this.host.showExtensionSidePanelSidebar()
    }
    // The panel belongs to one tab's visit, so when that tab holds none there is
    // nothing left for the rail to show and it closes with the last of them rather
    // than sitting there as an empty frame. The answer comes from this report and
    // not from the store's mirror of it: this listener is registered before the
    // store's own, so inside this dispatch the mirror still holds the previous
    // list.
    this.closeExtensionSidePanelWithNoPanels(
      tabId !== null && panels.some((panel) => panel.appTabId === tabId)
    )
  }

  /** The identity of one extension side panel: one panel per extension per tab. */
  extensionSidePanelKey(panel: BrowserExtensionSidePanel): string {
    return `${panel.appTabId}\u0000${panel.extensionId}`
  }

  /** Close the side panel tool once the tab on screen holds no panel: the panel
   *  exists to show an extension's own UI and the rail only offers the tool while
   *  the tab has one, so it leaves with the last panel rather than lingering as an
   *  empty frame.
   *
   *  `activeTabHoldsPanel` is passed in rather than read here because the report
   *  handler runs inside the panel report's own dispatch, where the panel store's
   *  mirror is still one report behind. Callers outside that dispatch answer with
   *  {@link activeTabHoldsExtensionSidePanel}. */
  closeExtensionSidePanelWithNoPanels(activeTabHoldsPanel: boolean): void {
    if (!this.host.contextSidebarVisible) return
    if (this.host.contextSidebarTool !== 'extension-side-panel') return
    if (activeTabHoldsPanel) return
    this.host.contextSidebarVisible = false
  }

  /** Whether the tab on screen holds an extension side panel in the panel store's
   *  mirror. Only for callers outside a panel report's own dispatch. */
  activeTabHoldsExtensionSidePanel(): boolean {
    const tab = this.host.activeTab
    if (!tab) return false
    return browserExtensionSidePanels.hasPanelForTab(tab.id)
  }

  /** Hide browser-owned rail tools before the app-wide sticky note panel opens. */
  hideContextSidebarForAppPanel(): void {
    this.host.contextSidebarVisible = false
  }

  /**
   * Reveal the rail on the browser's popup windows.
   *
   * A popup window is a window the user asked for by clicking something in the
   * page, so it is shown rather than parked in silence. Its page stays in the
   * session of the tab and box that opened it while the rail remains browser-wide.
   */
  showPopupsSidebar(): void {
    this.host.units['queries'].dismissNotifications()
    this.host.contextSidebarTool = 'popups'
    this.host.contextSidebarVisible = true
  }

  togglePopupsSidebar(): void {
    if (this.host.contextSidebarTool === 'popups' && this.host.contextSidebarVisible) {
      this.host.closePopupsSidebar()
      return
    }
    this.host.showPopupsSidebar()
  }

  closePopupsSidebar(): void {
    if (this.host.contextSidebarTool === 'popups') this.host.contextSidebarVisible = false
  }

  /**
   * Reveal the rail on an extension's own side panel.
   *
   * The panel belongs to the tab on screen: it is the extension putting its UI
   * beside the page the user is reading, so it opens the way a popup window does.
   * Unlike the popup tool it is not offered by a strip or a dock button, because
   * the panel is the extension's to raise through its own API; the first panel to
   * arrive for the active tab calls this, and the close control in the panel ends
   * it.
   */
  showExtensionSidePanelSidebar(): void {
    if (!this.host.activeTab) return
    this.host.units['queries'].dismissNotifications()
    this.host.contextSidebarTool = 'extension-side-panel'
    this.host.contextSidebarVisible = true
  }

  /** Hide the side panel tool without ending the panel: main keeps the document
   *  running, so it is still there when the tool is shown again. */
  closeExtensionSidePanelSidebar(): void {
    if (this.host.contextSidebarTool === 'extension-side-panel')
      this.host.contextSidebarVisible = false
  }
}
