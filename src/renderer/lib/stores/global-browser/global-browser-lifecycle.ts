import { invoke, subscribe } from '$lib/ipc.svelte'
import { HIBERNATION_SWEEP_INTERVAL_MS } from '../global-browser.svelte'
import type { GlobalBrowserState } from '../global-browser.svelte'

/** GlobalBrowserState lifecycle: one concern, moved verbatim from the composition root. */
export class GlobalBrowserStateLifecycle {
  constructor(private readonly host: GlobalBrowserState) {}

  /**
   * Wire the runtime and read the stored tab list.
   *
   * This is the whole of the browser's startup cost, which is why it is not in
   * the constructor. `startBrowserRuntime` calls it from the runtime seam once the
   * first frame has painted, or sooner when something reaches for the browser.
   * Idempotent, so every caller can ask without coordinating.
   */
  start(): void {
    if (this.host.started) return
    this.host.started = true
    // One app-lifetime subscription keeps every tab's runtime state current,
    // including tabs with no surface mounted: a background tab that starts
    // playing audio must still light up its indicator in the strip.
    subscribe('browser:state', (state) => this.host.applyPageState(state))
    // A page that opens a window (an OAuth redirect, a wallet popup, a site's
    // own "open in new window") is routed by main into a new tab under this same
    // reserved context, so the strip adopts it instead of losing it.
    subscribe('browser:openRequested', (url, context) => this.host.adoptOpenRequest(url, context))
    // A popup window is a window the user asked for by clicking something, so the
    // first one a page opens for the tab on screen reveals the rail's popup panel,
    // exactly as the operating system would have put a window in front of them,
    // and the other direction of the same rule closes the panel when the last one
    // ends.
    subscribe('browser:popupWindows', (popups) =>
      this.host.units['panels'].applyPopupWindows(popups)
    )
    // A page asking to share its screen, on a platform with no native picker, is
    // offered the app's own source picker; a padlock's Site permissions entry
    // opens the modal that lists every permission this browser exposes.
    subscribe('browser:screenShareSources', (prompt) => (this.host.screenSharePrompt = prompt))
    subscribe('browser:sitePermissions', (prompt) => (this.host.sitePermissionsPrompt = prompt))
    // An extension that asks to show its own side panel is asking for a place
    // beside the page, so the first panel for the tab on screen reveals the rail's
    // side panel tool, exactly as a popup window does, and the last one leaving
    // closes it again. This listener is registered before the side panel store's
    // own, so inside this dispatch the open/close decision answers from the report
    // itself rather than from a mirror that is one report behind.
    subscribe('browser:extensionSidePanels', (panels) =>
      this.host.units['panels'].applyExtensionSidePanels(panels)
    )
    // The app is quitting, so the coalesced write is the last chance the stored
    // list has to carry what the user just did. The shutdown pipeline keeps the
    // renderer alive for it, which is what makes this write land.
    subscribe('window:beforeQuit', () => this.host.units['runtime'].flushPendingSave())
    if (typeof window !== 'undefined') {
      this.host.sweepTimer = window.setInterval(
        () => this.host.sweepIdleTabs(),
        HIBERNATION_SWEEP_INTERVAL_MS
      )
    }
    // The read is kept rather than dropped: a caller that has to resolve a tab
    // against the list (opening an address, switching to a tab) awaits it through
    // `whenHydrated` instead of racing it.
    this.host.hydration = this.host.units['runtime'].hydrate()
  }

  /** Release the sweep timer and the pending write. The store lives for the
   *  renderer's lifetime, so this exists for tests and a deliberate teardown
   *  rather than normal use. */
  dispose(): void {
    this.host.started = false
    if (this.host.sweepTimer !== null) window.clearInterval(this.host.sweepTimer)
    this.host.sweepTimer = null
    if (this.host.saveTimer !== null) window.clearTimeout(this.host.saveTimer)
    this.host.saveTimer = null
  }

  // ─── The active tab ───────────────────────────────────────────────────────

  /**
   * Put a tab on screen and count the moment as use, which is what resets its
   * hibernation clock and revives a released page.
   */
  activate(tabId: string): void {
    const tab = this.host.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    this.host.units['runtime'].setActiveTab(tabId)
    tab.lastUsedAt = Date.now()
    if (tab.hibernated) tab.hibernated = false
    this.host.units['queries'].persist()
  }

  /** Reveal the rail on the browser's downloads. Downloads are the one browser
   *  tool that needs no tab, so this is also how the rail stays present with the
   *  strip empty. */
  showDownloadsSidebar(): void {
    this.host.units['queries'].dismissNotifications()
    this.host.contextSidebarTool = 'downloads'
    this.host.contextSidebarVisible = true
  }

  toggleDownloadsSidebar(): void {
    if (this.host.contextSidebarTool === 'downloads' && this.host.contextSidebarVisible) {
      this.host.closeDownloadsSidebar()
      return
    }
    this.host.showDownloadsSidebar()
  }

  closeDownloadsSidebar(): void {
    if (this.host.contextSidebarTool === 'downloads') this.host.contextSidebarVisible = false
  }

  /** Read a tab's picked image icon into a data URL, once. Best-effort: a
   *  missing file leaves the tab on its favicon or colour/SVG icon. */
  async ensureTabIconLoaded(tabId: string): Promise<void> {
    const tab = this.host.tabs.find((candidate) => candidate.id === tabId)
    if (!tab?.imagePath) {
      this.host.tabIconUrls.delete(tabId)
      return
    }
    if (this.host.tabIconUrls.has(tabId)) return
    try {
      const url = await invoke('file:readAsDataUrl', tab.imagePath)
      if (url) this.host.tabIconUrls.set(tabId, url)
    } catch {
      // Icon loading is best-effort; the resolver's fallback remains.
    }
  }

  /** Read a group's picked image icon into a data URL, once. Best-effort: a
   *  missing or unreadable file leaves the group on its colour/SVG icon. */
  async ensureGroupIconLoaded(groupId: string): Promise<void> {
    const group = this.host.groupById(groupId)
    if (!group?.imagePath) {
      this.host.groupIconUrls.delete(groupId)
      return
    }
    if (this.host.groupIconUrls.has(groupId)) return
    try {
      const url = await invoke('file:readAsDataUrl', group.imagePath)
      if (url) this.host.groupIconUrls.set(groupId, url)
    } catch {
      // Icon loading is best-effort; the resolver's fallback remains.
    }
  }

  /** Read a box's picked image icon into a data URL, once. Best-effort: a missing
   *  or unreadable file leaves the box on its colour/SVG icon. */
  async ensureBoxIconLoaded(boxId: string): Promise<void> {
    const box = this.host.boxById(boxId)
    if (!box?.imagePath) {
      this.host.boxIconUrls.delete(boxId)
      return
    }
    if (this.host.boxIconUrls.has(boxId)) return
    try {
      const url = await invoke('file:readAsDataUrl', box.imagePath)
      if (url) this.host.boxIconUrls.set(boxId, url)
    } catch {
      // Icon loading is best-effort; the resolver's fallback remains.
    }
  }
}
