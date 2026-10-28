import { Logger } from '../../system/logger'
import type { BrowserInspectorEvent } from '../../../lib/ipc/browser'
import type { ReportedInspectorEvent } from './browser-inspector'
import { permissionResolutions } from './browser-permissions'
import type { BrowserService } from '../browser-service'

/**
 * The browser service's own lifetime: start-up hydration, relocation and teardown.
 *
 * Everything a tab does on its own is another unit's concern. What is left is the
 * service as a whole: the element-inspector wiring that has to know every tab, the
 * durable permission memory loaded at boot, the work folder that moves when a thread
 * does, and the teardown that gives every page and view back.
 */

/**
 * What `browser-service-lifecycle` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface LifecycleHost {
  readonly abandonedReveals: BrowserService['abandonedReveals']
  activeTabBounds: BrowserService['activeTabBounds']
  activeTabId: BrowserService['activeTabId']
  readonly agentReveals: BrowserService['agentReveals']
  readonly agentTabIds: BrowserService['agentTabIds']
  readonly capture: BrowserService['capture']
  readonly clearStatusDelay: BrowserService['clearStatusDelay']
  readonly configuredSessions: BrowserService['configuredSessions']
  displayedTab: BrowserService['displayedTab']
  readonly downloads: BrowserService['downloads']
  readonly extensions: BrowserService['extensions']
  readonly injectedDialogLabels: BrowserService['injectedDialogLabels']
  readonly inspector: BrowserService['inspector']
  readonly mountedPopupViews: BrowserService['mountedPopupViews']
  readonly mountedSidePanelViews: BrowserService['mountedSidePanelViews']
  readonly nativeStrip: BrowserService['nativeStrip']
  readonly nativeToasts: BrowserService['nativeToasts']
  readonly overlay: BrowserService['overlay']
  readonly parkedOrder: BrowserService['parkedOrder']
  readonly pendingParks: BrowserService['pendingParks']
  readonly pendingPermissions: BrowserService['pendingPermissions']
  pendingShow: BrowserService['pendingShow']
  readonly permissionDenies: BrowserService['permissionDenies']
  readonly permissionGrants: BrowserService['permissionGrants']
  readonly permissionLedgers: BrowserService['permissionLedgers']
  readonly permissionMemory: BrowserService['permissionMemory']
  readonly playheads: BrowserService['playheads']
  readonly popupViewFrames: BrowserService['popupViewFrames']
  readonly popupWindows: BrowserService['popupWindows']
  readonly promptWindow: BrowserService['promptWindow']
  readonly publishState: BrowserService['publishState']
  readonly relaxedUntil: BrowserService['relaxedUntil']
  readonly resolvePermission: BrowserService['resolvePermission']
  readonly screenShare: BrowserService['screenShare']
  readonly sidePanels: BrowserService['sidePanels']
  readonly sidePanelViewFrames: BrowserService['sidePanelViewFrames']
  readonly stage: BrowserService['stage']
  statusDelayElapsed: BrowserService['statusDelayElapsed']
  readonly tabHistory: BrowserService['tabHistory']
  readonly tabs: BrowserService['tabs']
  readonly threads: BrowserService['threads']
  toastVisible: BrowserService['toastVisible']
}

export class BrowserServiceLifecycle {
  constructor(private readonly host: LifecycleHost) {}

  /**
   * Give a reported element its place in the window's own coordinates.
   *
   * The page reports rectangles in its own CSS pixels, and the comment bubble
   * that anchors to one is app DOM placed by a child window in window
   * coordinates. The frame the page sits at and the page's zoom are known here,
   * beside the view they belong to, so the conversion happens once rather than in
   * a renderer that can see neither. Attaching it here is also what keeps the
   * place out of the page's hands: a page cannot choose where the app draws its
   * bubble.
   */
  anchorInspectorEvent(tabId: string, event: ReportedInspectorEvent): BrowserInspectorEvent {
    if (event.kind === 'closed') return event
    const rect = event.kind === 'pick' ? event.target.rect : event.rect
    const tab = this.host.tabs.get(tabId)
    // A tab that is already gone has no frame left to place a bubble against, so
    // the page's own rectangle is the best answer available; the surface that
    // asked for the bubble is going away with the tab.
    if (!tab || tab.view.webContents.isDestroyed()) return { ...event, anchor: rect }
    const frame =
      this.host.displayedTab?.tabId === tabId ? this.host.displayedTab.bounds : tab.view.getBounds()
    const zoom = tab.view.webContents.getZoomFactor()
    return {
      ...event,
      anchor: {
        x: Math.round(frame.x + rect.x * zoom),
        y: Math.round(frame.y + rect.y * zoom),
        width: Math.round(rect.width * zoom),
        height: Math.round(rect.height * zoom)
      }
    }
  }

  /**
   * Merge the permission decisions the user already made into the live
   * ledgers. The bootstrap awaits this before the service accepts browser IPC,
   * so a site's permission request can never race the read and re-prompt for a
   * permission the user already granted.
   */
  async hydratePermissionMemory(): Promise<void> {
    try {
      await this.host.permissionMemory.load(this.host.permissionLedgers())
    } catch (error: unknown) {
      Logger.error('Browser permission memory could not be loaded:', error)
    }
  }

  dispose(): void {
    this.host.pendingShow = null
    this.host.popupWindows.closeAll('the browser was torn down')
    this.host.mountedPopupViews.clear()
    this.host.popupViewFrames.clear()
    this.host.sidePanels.closeAll('the browser was torn down')
    this.host.mountedSidePanelViews.clear()
    this.host.sidePanelViewFrames.clear()
    this.host.activeTabId = null
    this.host.toastVisible = false
    this.host.activeTabBounds = null
    this.host.displayedTab = null
    for (const handle of this.host.pendingParks.values()) clearTimeout(handle)
    this.host.pendingParks.clear()
    this.host.clearStatusDelay()
    this.host.statusDelayElapsed = false
    this.host.injectedDialogLabels.clear()
    this.host.parkedOrder.length = 0
    this.host.agentReveals.clear()
    this.host.abandonedReveals.clear()
    this.host.relaxedUntil.clear()
    this.host.stage.dispose()
    this.host.promptWindow.dispose()
    this.host.overlay.dispose()
    this.host.nativeToasts.dispose()
    this.host.nativeStrip.dispose()
    this.host.screenShare.dispose()
    for (const requestId of [...this.host.pendingPermissions.keys()]) {
      this.host.resolvePermission(requestId, permissionResolutions.dismiss)
    }
    for (const tab of this.host.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    this.host.tabs.clear()
    this.host.agentTabIds.clear()
    // Downloads belong to the session, not to this window: a download keeps
    // running while the window is parked, so teardown only stops this window's
    // tab lookup from being consulted. The manager survives and keeps the
    // records, the live items and the bytes.
    this.host.downloads.setTabResolver(null)
    this.host.downloads.setExtensionObserver(null)
    this.host.downloads.setDownloadWatcher(null)
    this.host.configuredSessions.clear()
    // Extensions are unloaded from every jar before the sessions go: a loaded
    // extension holds a renderer and an open file inside a partition this service
    // is about to stop tracking.
    void this.host.extensions.dispose()
    this.host.permissionGrants.clear()
    this.host.permissionDenies.clear()
    this.host.playheads.clear()
    this.host.capture.dispose()
    this.host.inspector.dispose()
    // The views are closed two lines above, taking every stack with them. The last
    // commit is normally `flushTabHistory()`, awaited by whoever is tearing this
    // service down before it calls in here; this is the safety net for a teardown
    // that did not. It is not merely a no-op in that case: a flush that finds a
    // write still running waits for it and retries if it failed, which is the one
    // window a fire-and-forget teardown would otherwise close on a lost stack.
    void this.host.tabHistory.flush()
  }

  relocateWorkFolder(
    projectId: string,
    from: string,
    to: string,
    /**
     * The assistant that owns the moved folder, when the project id is the shared
     * assistant container.
     *
     * Every assistant task reports the same container id, so without this a rename
     * in one assistant would re-point a tab in another that happened to show a
     * folder of the same relative name.
     */
    assistantId?: string | null
  ): void {
    for (const [tabId, tab] of this.host.tabs) {
      if (
        tab.projectId !== projectId ||
        (tab.design?.directory !== from && tab.composition?.directory !== from)
      )
        continue
      if (assistantId !== undefined) {
        const owner = this.host.threads.get(tab.threadId)?.assistantId ?? null
        if (owner !== assistantId) continue
      }
      if (tab.design?.directory === from) tab.design = { ...tab.design, directory: to }
      if (tab.composition?.directory === from)
        tab.composition = { ...tab.composition, directory: to }
      this.host.publishState(tabId)
    }
  }
}
