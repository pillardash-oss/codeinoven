import { reportError } from './app-errors.svelte'
import { browserPopupWindows } from './browser-popup-windows.svelte'

/**
 * The one extension dropdown the thread browser has open, if any.
 *
 * The global browser hosts an extension's action popup in its rail, as a tab of
 * its own. The thread browser has no rail, so the popup drops out of the toolbar
 * instead: the extension button opens this, and the extension's own document is
 * placed over the card under that button, at the size the extension asked for.
 *
 * One dropdown for the whole app rather than one per panel, because a tab can be
 * mounted twice (the sidebar and the full screen dialog) and only one of those
 * copies may place the native view. The state names the tab it belongs to, so the
 * panel that is actually on screen draws it and the other one draws nothing.
 */
export interface BrowserExtensionDropdownOwner {
  tabId: string
  projectId: string
  threadId: string
  boxId: string | null
}

/** The dropdown on screen: whose extension it is, and the popup hosting its page. */
export interface BrowserExtensionDropdownOpen extends BrowserExtensionDropdownOwner {
  extensionId: string
  popupId: string
}

class BrowserExtensionDropdownState {
  private open = $state<BrowserExtensionDropdownOpen | null>(null)

  /** The dropdown one tab owns, or null when it has none. */
  forTab(tabId: string): BrowserExtensionDropdownOpen | null {
    const current = this.open
    return current && current.tabId === tabId ? current : null
  }

  /** The open dropdown, whichever tab it belongs to. */
  get current(): BrowserExtensionDropdownOpen | null {
    return this.open
  }

  /**
   * Open one extension's popup in the dropdown, or close it when this is the
   * extension already showing.
   *
   * The popup itself belongs to main, which keeps it alive off screen for as long
   * as the jar runs, so opening one twice is the user coming back to it rather than
   * asking for a second copy: `openExtensionPopup` answers the retained popup's id
   * and this places that one.
   */
  async toggle(owner: BrowserExtensionDropdownOwner, extensionId: string): Promise<void> {
    const current = this.open
    // A window the extension asked the app for is not the extension's own popup, so
    // reaching for the icon while one is on screen opens the popup instead of
    // taking away a prompt the page underneath is still waiting on.
    const currentIsActionPopup =
      current !== null && browserPopupWindows.find(current.popupId)?.windowRequested !== true
    if (
      current &&
      currentIsActionPopup &&
      current.tabId === owner.tabId &&
      current.extensionId === extensionId
    ) {
      this.close()
      return
    }
    this.close()
    const popupId = await browserPopupWindows.openExtension(
      {
        projectId: owner.projectId,
        threadId: owner.threadId,
        tabId: owner.tabId,
        boxId: owner.boxId
      },
      extensionId
    )
    // Null means nothing opened: the extension asked for its own side panel
    // instead, which is a surface the thread browser does not have.
    if (popupId === null) {
      reportError(
        new Error('This extension opens a side panel instead of a popup.'),
        'That extension has no popup to show here.'
      )
      return
    }
    this.open = { ...owner, extensionId, popupId }
  }

  /** Take the dropdown down and park its page where main keeps it. */
  close(): void {
    const current = this.open
    if (!current) return
    this.open = null
    browserPopupWindows.dismiss(current.popupId)
  }

  /**
   * Show a window the extension opened for one of this tab's pages.
   *
   * A thread browser has no rail, so a window an extension asks the app for is
   * only ever on screen if this dropdown takes it: a passkey prompt is opened by a
   * page's ceremony, not by a click on the extension's icon, so nothing the user
   * does here would otherwise bring it up and the request would wait on a prompt
   * that was never drawn.
   *
   * One dropdown per tab, so a second window replaces the one on screen rather than
   * stacking native views over the same toolbar.
   */
  adopt(owner: BrowserExtensionDropdownOwner, extensionId: string, popupId: string): void {
    this.open = { ...owner, extensionId, popupId }
  }
}

export const browserExtensionDropdown = new BrowserExtensionDropdownState()
