import { showBrowserNewTabMenu, validateBrowserNewTabMenuInput } from './browser-new-tab-menu'
import {
  validateNativeDockAck,
  validateNativeDockId,
  validateNativeDockCommit,
  validateNativeDockInteraction,
  validateNativeDockRequest
} from '../../../lib/native-dock'
import { ipcMain as electronIpcMain, Menu } from 'electron'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc-contract'
import { type BrowserTabHistoryRecord } from '../../../lib/browser/browser-tab-history'
import { trustedIpcMain as ipcMain } from '../../ipc/trusted-ipc-main'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { Logger } from '../../system/logger'
import {
  validateExtensionId,
  validateExtensionInstallInput,
  validateExtensionUpdatePatch
} from '../extensions/browser-extension-validation'
import { showBrowserBoxMenu } from './browser-box-menu'
import { showBrowserTabSelectionMenu } from './browser-tab-selection-menu'
import { showBrowserTabContextMenu } from './browser-tab-context-menu'
import { showBrowserAgentTabMenu } from './browser-agent-tab-menu'
import {
  showBrowserExtensionMenu,
  validateBrowserExtensionMenuInput
} from './browser-extension-menu'
import { permissionResolutions, sitePermissionDescriptor } from './browser-permissions'
import { PEEK_SNAPSHOT_MAX_WIDTH } from './browser-peek'
import {
  boundedBoxLabel,
  browserPartitionFor,
  validateBounds,
  validateBoundedHost,
  validateBrowserBoxMenuInput,
  validateBrowserSearchEngine,
  validateBrowserAppShortcutChords,
  validateBrowserShortcutBindings,
  validateBrowserStripInteraction,
  validateBrowserStripOverlayRequest,
  validateBrowserSwitcherBindings,
  validateBrowserTabSelectionMenuInput,
  validateBrowserTabContextMenuInput,
  validateBrowserAgentTabMenuInput,
  validateDownloadId,
  validateInspectorMarkers,
  validateInspectorReferenceId,
  validateInspectorTheme,
  validateOptionalBoxId,
  validatePermissionDecision,
  validatePermissionRequestId,
  validatePopupWindowId,
  validateProjectId,
  validateScrollbarTheme,
  validateSiteDataScopes,
  validateSiteMenuOrigin,
  validateSiteMenuPoint,
  validateSitePermissionId,
  validateSitePermissionState,
  validateTabDestroyReason,
  validateTabId,
  validateThreadBrowserPage,
  validateConversationScopeId,
  validateThreadId,
  validateToastOverlayAck,
  validateToastOverlayInteraction,
  validateToastOverlayRequest,
  validateTransportCommand,
  validateTransportValue
} from './browser-validation'
import {
  EXTENSION_PAGE_COMMAND_CHANNEL,
  EXTENSION_PAGE_TABS_CHANNEL
} from '../extensions/browser-extension-page-tabs'
import { validateBrowserFindRequest, validateBrowserFindStopAction } from './browser-find'
import type { BrowserService } from '../browser-service'
import { popupPageOwner } from './browser-service-popups'

/**
 * The browser's IPC surface: every channel the renderer may call or listen on.
 *
 * One place registers the whole contract and validates every input at the boundary,
 * so a caller can never hand the browser service a shape it did not agree to serve.
 * Nothing here owns behaviour: each handler validates, then asks the unit that owns
 * the concern.
 */

/**
 * What `browser-service-ipc-surface` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface IpcSurfaceHost {
  activeTabBounds: BrowserService['activeTabBounds']
  activeTabId: BrowserService['activeTabId']
  allowSiteKeymapOverride: BrowserService['allowSiteKeymapOverride']
  readonly applySitePermission: BrowserService['applySitePermission']
  appShortcutChords: BrowserService['appShortcutChords']
  readonly assistantPageTabIds: BrowserService['assistantPageTabIds']
  readonly captureCompositionFrame: BrowserService['captureCompositionFrame']
  readonly captureThumbnail: BrowserService['captureThumbnail']
  readonly childTabOpeners: BrowserService['childTabOpeners']
  readonly clearBoxData: BrowserService['clearBoxData']
  readonly closedTabHistory: BrowserService['closedTabHistory']
  compositionShortcutChords: BrowserService['compositionShortcutChords']
  contextMenuSearchEngine: BrowserService['contextMenuSearchEngine']
  readonly destroy: BrowserService['destroy']
  readonly downloads: BrowserService['downloads']
  readonly dropPendingPark: BrowserService['dropPendingPark']
  readonly dropProjectTabs: BrowserService['dropProjectTabs']
  readonly ensureExtensionPageTabsPreload: BrowserService['ensureExtensionPageTabsPreload']
  readonly ensureTab: BrowserService['ensureTab']
  readonly extensionPageTabForContents: BrowserService['extensionPageTabForContents']
  readonly extensions: BrowserService['extensions']
  readonly findInPage: BrowserService['findInPage']
  focusedChromeTabId: BrowserService['focusedChromeTabId']
  readonly focusPage: BrowserService['focusPage']
  readonly forgetBox: BrowserService['forgetBox']
  readonly guardAgainstStrandedView: BrowserService['guardAgainstStrandedView']
  readonly injectDialogContext: BrowserService['injectDialogContext']
  readonly inspector: BrowserService['inspector']
  readonly liveTab: BrowserService['liveTab']
  readonly load: BrowserService['load']
  readonly markRevealShown: BrowserService['markRevealShown']
  readonly mutedCompositions: BrowserService['mutedCompositions']
  readonly nativeStrip: BrowserService['nativeStrip']
  readonly nativeToasts: BrowserService['nativeToasts']
  readonly navigateFocusedHistory: BrowserService['navigateFocusedHistory']
  readonly noteDepartedReveal: BrowserService['noteDepartedReveal']
  readonly notifyExtensionActivated: BrowserService['notifyExtensionActivated']
  readonly openExtensionPopup: BrowserService['openExtensionPopup']
  readonly openNewTabFor: BrowserService['openNewTabFor']
  readonly openOptionsPageFromPage: BrowserService['openOptionsPageFromPage']
  readonly overlay: BrowserService['overlay']
  readonly parkTab: BrowserService['parkTab']
  readonly peekTabs: BrowserService['peekTabs']
  pendingShow: BrowserService['pendingShow']
  readonly popupWindowMenuItems: BrowserService['popupWindowMenuItems']
  readonly popupWindows: BrowserService['popupWindows']
  readonly promptWindow: BrowserService['promptWindow']
  readonly publishState: BrowserService['publishState']
  readonly refreshStatusOverlay: BrowserService['refreshStatusOverlay']
  readonly reloadKeepingPlayhead: BrowserService['reloadKeepingPlayhead']
  readonly reloadOriginTabs: BrowserService['reloadOriginTabs']
  readonly requireTab: BrowserService['requireTab']
  readonly resolvePermission: BrowserService['resolvePermission']
  readonly restoreTabHistory: BrowserService['restoreTabHistory']
  readonly schedulePark: BrowserService['schedulePark']
  readonly screenShare: BrowserService['screenShare']
  readonly setScrollbarTheme: BrowserService['setScrollbarTheme']
  readonly setToastVisible: BrowserService['setToastVisible']
  shortcutBindings: BrowserService['shortcutBindings']
  readonly showActiveView: BrowserService['showActiveView']
  readonly showPageMenu: BrowserService['showPageMenu']
  readonly sidePanels: BrowserService['sidePanels']
  readonly siteData: BrowserService['siteData']
  readonly stage: BrowserService['stage']
  readonly stateFor: BrowserService['stateFor']
  readonly stopFindInPage: BrowserService['stopFindInPage']
  switcherBindings: BrowserService['switcherBindings']
  readonly tabHistory: BrowserService['tabHistory']
  readonly tabs: BrowserService['tabs']
  readonly targetUrl: BrowserService['targetUrl']
  readonly threadBrowserPages: BrowserService['threadBrowserPages']
  readonly toastVisible: BrowserService['toastVisible']
  readonly toggleDevTools: BrowserService['toggleDevTools']
  readonly transport: BrowserService['transport']
  readonly transportState: BrowserService['transportState']
  readonly validateTabNavigationUrl: BrowserService['validateTabNavigationUrl']
  readonly window: BrowserService['window']
}

/**
 * Rebind a browser IPC channel.
 *
 * Reopening a window after a close-to-background rebuilds the browser service,
 * but the IPC handlers survive the old service's disposal, and Electron throws
 * when a channel is handled twice. Removing before registering makes the attach
 * safe to run once per window instead of once per process.
 */
export function replaceHandler(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1]
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, listener)
}

export class BrowserServiceIpcSurface {
  constructor(private readonly host: IpcSurfaceHost) {}

  register(): void {
    this.host.guardAgainstStrandedView()
    // The page-tabs preload is asked for on every document an extension surface
    // loads, before that page's own scripts exist, so the channel is synchronous
    // and deliberately raw: a trusted-IPC registration refuses any sender that is
    // not the app's own renderer, and an extension page is exactly the sender this
    // answers. The frame check below is that validation, and only a document the
    // app hosts for an extension can be told anything about a tab.
    electronIpcMain.removeAllListeners(EXTENSION_PAGE_TABS_CHANNEL)
    electronIpcMain.on(EXTENSION_PAGE_TABS_CHANNEL, (event, protocol) => {
      const frame = event.senderFrame
      event.returnValue =
        protocol === 'chrome-extension:' && frame && frame.url.startsWith('chrome-extension://')
          ? this.host.extensionPageTabForContents(event.sender.id)
          : null
    })
    // An extension page cannot reach main on its own, so the preload forwards the
    // one command a page asks for: `chrome.runtime.openOptionsPage` from a popup's
    // "More settings". Only a document the app hosts for an extension can make this
    // request, and only for itself.
    electronIpcMain.removeAllListeners(EXTENSION_PAGE_COMMAND_CHANNEL)
    electronIpcMain.on(EXTENSION_PAGE_COMMAND_CHANNEL, (event, command) => {
      const frame = event.senderFrame
      if (!frame || !frame.url.startsWith('chrome-extension://')) return
      if (command !== 'open-options') return
      this.host.openOptionsPageFromPage(event.sender.id)
    })
    // Started here so the file exists long before the first extension popup or
    // panel is created; every path that can wait for it does.
    void this.host.ensureExtensionPageTabsPreload()
    replaceHandler(
      'browser:show',
      async (_event, rawTabId, rawProjectId, rawThreadId, rawInitialUrl, rawBounds, rawBoxId) => {
        const tabId = validateTabId(rawTabId)
        const projectId = validateProjectId(rawProjectId)
        const threadId = validateThreadId(rawThreadId)
        const boxId = validateOptionalBoxId(rawBoxId)
        const initialUrl =
          rawInitialUrl === undefined ||
          rawInitialUrl === null ||
          rawInitialUrl === '' ||
          (rawInitialUrl === 'about:blank' && this.host.childTabOpeners.has(tabId))
            ? ''
            : this.host.validateTabNavigationUrl(projectId, boxId, rawInitialUrl)
        const bounds = validateBounds(rawBounds)
        const request = { tabId }
        this.host.pendingShow = request
        // Remove the outgoing page before waiting: native views cover the new
        // tab's DOM, including its loading and blank states.
        if (this.host.activeTabId && this.host.activeTabId !== tabId) {
          this.host.parkTab(this.host.activeTabId, { pausePlayback: true })
        }
        // The first document must not outrun extensions in its jar. If a page
        // navigates before Chromium has loaded an extension, its manifest content
        // scripts never get a receiver in that document, and later calls such as
        // Bitwarden's tabs.sendMessage fail until the page is reloaded. ensureTab
        // remains synchronous; this IPC path waits for the same single-flight load
        // before it creates and navigates a page.
        // Existing pages already have their jar prepared. Frame/bounds reports
        // must not reconcile extensions again on every animation frame.
        if (!this.host.tabs.get(tabId)?.initialNavigationStarted) {
          await this.host.extensions.ensureJarLoaded(projectId, boxId)
        }
        // A hide or a newer show may have arrived while the jar was loading.
        // Never let that old continuation recreate or display a departed tab.
        if (this.host.pendingShow !== request) throw new Error('Browser show was superseded')
        const tab = this.host.ensureTab(tabId, projectId, threadId, boxId)

        // A show that lands inside the grace window of a hide is a surface switch
        // or a visibility answer that flapped, not a departure: dropping the
        // deferred park keeps the page where it is instead of parking it and
        // re-parenting it straight back, which is the flicker the user sees.
        this.host.dropPendingPark(tabId)
        // Leaving a tab costs nothing now: the outgoing tab keeps running in an
        // invisible stage window instead of going dead behind the app window.
        const previousActiveTabId = this.host.activeTabId
        if (this.host.activeTabId && this.host.activeTabId !== tabId) {
          this.host.parkTab(this.host.activeTabId, { pausePlayback: true })
        }
        this.host.activeTabId = tabId
        this.host.activeTabBounds = bounds
        // A page that moved under a resting pointer keeps its preview where it is
        // relative to the page; a switch to another tab drops the one the old
        // page was showing, because the pointer is no longer over it.
        if (this.host.targetUrl !== null) this.host.refreshStatusOverlay()
        if (previousActiveTabId !== tabId) this.host.notifyExtensionActivated(tabId)
        // Remember the frame the page is on screen at. Parking lays the page out at
        // this size from now on, so leaving a tab never resizes the page away from
        // the size the user was reading it at.
        tab.displayedViewport = {
          viewport: { width: bounds.width, height: bounds.height },
          at: Date.now()
        }
        this.host.markRevealShown(tabId)
        if (this.host.toastVisible) {
          // A native view floats above every DOM surface, so while a toast is on
          // screen the tab stays parked at its on-screen size: the page keeps
          // the exact viewport the user was looking at, and keeps running. The
          // panel re-reports the same frame while the toast is up and the view is
          // already where it belongs, so only the first report parks it.
          if (!this.host.stage.isParked(tab.view)) {
            this.host.parkTab(tabId, {
              size: { width: bounds.width, height: bounds.height },
              keepActive: true
            })
          }
        } else {
          this.host.showActiveView()
        }
        // Refresh the alert/confirm context label on every activation so a
        // renamed project or thread is reflected without waiting for a reload.
        this.host.injectDialogContext(tabId)
        if (!tab.initialNavigationStarted) {
          tab.initialNavigationStarted = true
          // A tab restored after a restart or a hibernation gets its whole stack
          // back, and the restore already puts it on the address it was left on.
          // Only a tab with no stored stack loads that address as a single page.
          if (!this.host.restoreTabHistory(tabId, tab, initialUrl)) {
            // A blank tab has no address yet: nothing to load, and the tab must
            // not spin. A later show still reports the live page state.
            if (initialUrl) this.host.load(tabId, initialUrl)
          }
        }
        return this.host.stateFor(tabId, tab)
      }
    )

    replaceHandler('browser:hide', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      if (this.host.pendingShow?.tabId === tabId) this.host.pendingShow = null
      // Leaving a tab right after an agent revealed it is the signal that the
      // agent's reveal was not welcome; it stops being counted after a while.
      this.host.noteDepartedReveal(tabId)
      // A peek is the one tab whose hide is never a hand-off between two surfaces:
      // it is being destroyed or promoted into a tab of its own, and either way its
      // page has to be off screen before the flight that carries it away starts,
      // because a native view is painted over the DOM that flight happens in. The
      // grace period below would leave the page sitting over that flight for its
      // length.
      if (this.host.peekTabs.has(tabId)) this.host.parkTab(tabId)
      // Deferred by one tick, so a panel that unmounts because the same tab is
      // moving to another surface (the sidebar handing the tab to the full screen
      // browser) does not park a view that is about to be shown again.
      else this.host.schedulePark(tabId)
      // Missing tabs are silently ignored   the renderer may call hide
      // during teardown after the tab was already destroyed.
    })
    replaceHandler('browser:popupWindowMenu', (_event, rawId, x, y) => {
      const record = this.host.popupWindows.find(validatePopupWindowId(rawId))
      if (!record || this.host.window.isDestroyed()) return
      Menu.buildFromTemplate(this.host.popupWindowMenuItems(record)).popup({
        window: this.host.window,
        x: Math.max(0, Math.round(Number(x) || 0)),
        y: Math.max(0, Math.round(Number(y) || 0))
      })
    })
    replaceHandler('browser:openPopupAsTab', (_event, rawId, duplicate, rawBoxId) => {
      const record = this.host.popupWindows.find(validatePopupWindowId(rawId))
      if (!record || record.view.webContents.isDestroyed()) return
      if (typeof duplicate !== 'boolean') throw new Error('Invalid popup action')
      const boxId = rawBoxId === undefined ? record.boxId : validateOptionalBoxId(rawBoxId)
      const url = this.host.validateTabNavigationUrl(
        record.projectId,
        boxId,
        record.view.webContents.getURL()
      )
      this.host.openNewTabFor({ ...popupPageOwner(record), boxId }, url)
      if (!duplicate) this.host.popupWindows.close(record.id, 'opened as a browser tab')
    })
    replaceHandler('browser:showPopupWindow', (_event, rawPopupId, rawBounds) => {
      this.host.popupWindows.show(validatePopupWindowId(rawPopupId), validateBounds(rawBounds))
    })
    replaceHandler('browser:hidePopupWindow', (_event, rawPopupId) => {
      this.host.popupWindows.hide(validatePopupWindowId(rawPopupId))
    })
    replaceHandler('browser:focusPopupWindow', (_event, rawPopupId) => {
      this.host.popupWindows.focus(validatePopupWindowId(rawPopupId))
    })
    replaceHandler('browser:dismissPopupWindow', (_event, rawPopupId) => {
      this.host.popupWindows.dismiss(validatePopupWindowId(rawPopupId))
    })
    replaceHandler('browser:closePopupWindow', (_event, rawPopupId) => {
      this.host.popupWindows.close(validatePopupWindowId(rawPopupId), 'the user closed its window')
    })
    replaceHandler('browser:getPopupWindows', (_event, rawProjectId) =>
      this.host.popupWindows.list(validateProjectId(rawProjectId))
    )
    /**
     * Extension side panels: the rail measures a frame and these place the
     * extension's own document in it, exactly as the popup channels do.
     */
    replaceHandler('browser:showExtensionSidePanel', (_event, rawExtensionId, rawBounds) => {
      this.host.sidePanels.show(validateExtensionId(rawExtensionId), validateBounds(rawBounds))
    })
    replaceHandler('browser:hideExtensionSidePanel', (_event, rawExtensionId) => {
      this.host.sidePanels.hide(validateExtensionId(rawExtensionId))
    })
    replaceHandler('browser:focusExtensionSidePanel', (_event, rawExtensionId) => {
      this.host.sidePanels.focus(validateExtensionId(rawExtensionId))
    })
    replaceHandler('browser:closeExtensionSidePanel', (_event, rawExtensionId) => {
      this.host.sidePanels.close(validateExtensionId(rawExtensionId), 'the user closed it')
    })
    replaceHandler('browser:getExtensionSidePanels', (_event, rawProjectId) =>
      this.host.sidePanels.list(validateProjectId(rawProjectId))
    )
    /**
     * Open an extension's own action popup, which the app hosts because Electron
     * draws no toolbar and no action popup for one to hang from.
     */
    replaceHandler(
      'browser:openExtensionPopup',
      (_event, rawProjectId, rawTabId, rawThreadId, rawBoxId, rawExtensionId) =>
        this.host.openExtensionPopup(
          validateProjectId(rawProjectId),
          validateTabId(rawTabId),
          validateThreadId(rawThreadId),
          validateOptionalBoxId(rawBoxId),
          validateExtensionId(rawExtensionId)
        )
    )
    replaceHandler('browser:setToastVisible', (_event, rawVisible) => {
      this.host.setToastVisible(rawVisible === true)
    })
    replaceHandler('browser:setToastOverlay', (_event, rawRequest) => {
      const request = validateToastOverlayRequest(rawRequest)
      return this.host.nativeToasts.apply(request)
    })
    replaceHandler('browser:toastOverlayHeight', (event, rawHeight) => {
      if (!this.host.nativeToasts.owns(event.sender.id)) return
      this.host.nativeToasts.setHeight(rawHeight)
    })
    replaceHandler('browser:setStripOverlay', (_event, rawRequest) =>
      this.host.nativeStrip.apply(validateBrowserStripOverlayRequest(rawRequest))
    )
    replaceHandler('browser:warmStripOverlay', (_event, warm) =>
      this.host.nativeStrip.setWarm(warm === true)
    )
    replaceHandler('browser:warmOverlayWindow', (_event, warm) =>
      this.host.overlay.setWarm(warm === true)
    )
    // The renderer's first gesture rather than the browser view: from that moment
    // the session is drawing modals into the shared window, so it is loaded for
    // the rest of the session. See `renderer/lib/overlay-host-warm.ts`.
    replaceHandler('browser:warmOverlayHostForSession', () => this.host.overlay.warmForSession())
    replaceHandler('browser:setDockOverlay', (_event, rawId, rawRequest) => {
      const id = validateNativeDockId(rawId)
      const request = rawRequest === null ? null : validateNativeDockRequest(rawRequest)
      if (request && request.id !== id) throw new TypeError('Native dock identities differ')
      return id === 'browser-tab-strip'
        ? this.host.nativeStrip.applyDock(request)
        : this.host.overlay.applyDock(id, request)
    })
    replaceHandler('browser:overlayDockInteract', (_event, rawReport) => {
      const report = validateNativeDockInteraction(rawReport)
      // Which control a modal's document has focused is state the window needs
      // when it forwards a key, not an interaction to hand back to the app.
      if (report.kind === 'focus') {
        this.host.overlay.setDockFocus(report.id, report.target)
        return
      }
      sendToRenderer(this.host.window.webContents, 'browser:overlay:dockEvent', report)
    })
    replaceHandler('browser:overlayDockDrawn', (_event, rawAck) => {
      sendToRenderer(
        this.host.window.webContents,
        'browser:overlay:dockDrawn',
        validateNativeDockAck(rawAck)
      )
    })
    replaceHandler('browser:commitDockOverlay', (_event, rawRequest) =>
      this.host.overlay.commitDock(validateNativeDockCommit(rawRequest))
    )
    replaceHandler('browser:focusDockOverlay', (_event, rawId) =>
      this.host.overlay.focusDock(validateNativeDockId(rawId))
    )
    replaceHandler('browser:overlayReady', (event) =>
      this.host.nativeToasts.owns(event.sender.id)
        ? { stack: this.host.nativeToasts.currentStack(), docks: [], strip: null, status: null }
        : this.host.nativeStrip.owns(event.sender.id)
          ? {
              stack: null,
              docks: this.host.nativeStrip.currentDocks(),
              strip: this.host.nativeStrip.currentStrip(),
              status: null
            }
          : this.host.overlay.currentState()
    )
    replaceHandler('browser:overlayInteract', (_event, rawReport) => {
      // The overlay carries no handlers, so an interaction is only a fact about
      // what the user did: the app renderer owns the toast and runs its handler.
      const report = validateToastOverlayInteraction(rawReport)
      sendToRenderer(this.host.window.webContents, 'browser:overlay:event', report)
    })
    replaceHandler('browser:overlayStripInteract', (_event, rawReport) => {
      // The same contract one surface over: the overlay reports what the user did
      // to the strip, and the app renderer owns what it means.
      const report = validateBrowserStripInteraction(rawReport)
      sendToRenderer(this.host.window.webContents, 'browser:overlay:stripEvent', report)
    })
    replaceHandler('browser:overlayDrawn', (_event, rawAck) => {
      // The content the overlay drew carries handlers that live in the app
      // renderer, so this is the overlay proving it can still reach them. It is
      // relayed rather than answered here: only the renderer that published a
      // revision knows which one it is waiting for.
      const ack = validateToastOverlayAck(rawAck)
      sendToRenderer(this.host.window.webContents, 'browser:overlay:drawn', ack)
    })
    replaceHandler('browser:overlayPointer', (_event, rawOverContent) => {
      this.host.overlay.setPointerOverContent(rawOverContent === true)
    })
    replaceHandler('browser:overlayCursor', () => this.host.overlay.pointerInClientSpace())
    replaceHandler(
      'browser:navigate',
      (_event, rawTabId, rawProjectId, rawThreadId, rawUrl, rawBoxId) => {
        const tabId = validateTabId(rawTabId)
        const projectId = validateProjectId(rawProjectId)
        const threadId = validateThreadId(rawThreadId)
        const boxId = validateOptionalBoxId(rawBoxId)
        const url = this.host.validateTabNavigationUrl(projectId, boxId, rawUrl)
        // Main creates a tab on `browser:show`, so a tab the renderer already knows
        // can still be unknown here: a fresh tab whose page has not been shown yet
        // because an overlay (the address spotlight) covers its frame. Ensuring the
        // tab makes an address load regardless of whether its page is on screen.
        const tab = this.host.ensureTab(tabId, projectId, threadId, boxId)
        // The navigation below is this tab's first, so a later show must not load
        // the stale initial URL over it.
        tab.initialNavigationStarted = true
        this.host.load(tabId, url)
      }
    )
    // Back/Forward, Reload and Stop are issued from the tab the renderer held a
    // moment ago, so each acts only while that tab is still live (see `liveTab`).
    replaceHandler('browser:goBack', (_event, rawTabId) => {
      const current = this.host.liveTab(validateTabId(rawTabId))?.view.webContents.navigationHistory
      if (current?.canGoBack()) current.goBack()
    })
    replaceHandler('browser:goForward', (_event, rawTabId) => {
      const current = this.host.liveTab(validateTabId(rawTabId))?.view.webContents.navigationHistory
      if (current?.canGoForward()) current.goForward()
    })
    replaceHandler('browser:mouseHistoryNavigation', (_event, rawDirection) => {
      if (rawDirection !== 'back' && rawDirection !== 'forward') {
        throw new TypeError('Browser mouse history direction must be back or forward')
      }
      return this.host.navigateFocusedHistory(rawDirection)
    })
    replaceHandler('browser:pageState', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.host.liveTab(tabId)
      return tab ? this.host.stateFor(tabId, tab) : null
    })
    replaceHandler('browser:reload', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.host.liveTab(tabId)
      if (!tab) return
      // A composition resumes where it was instead of jumping back to its first
      // frame, which is what makes an editor-triggered refresh (a saved caption
      // style, a moved track) safe to do while the user is watching.
      void this.host.reloadKeepingPlayhead(tabId, tab).catch((error: unknown) => {
        Logger.error('A browser tab could not reload:', error)
      })
    })
    replaceHandler('browser:transport', async (_event, rawTabId, rawCommand, rawValue) => {
      const tabId = validateTabId(rawTabId)
      const command = validateTransportCommand(rawCommand)
      return this.host.transport(tabId, command, validateTransportValue(command, rawValue))
    })
    replaceHandler('browser:transportState', (_event, rawTabId) =>
      this.host.transportState(validateTabId(rawTabId))
    )
    replaceHandler('browser:captureCompositionFrame', (_event, rawTabId, rawSeconds) => {
      if (typeof rawSeconds !== 'number' || !Number.isFinite(rawSeconds)) {
        throw new TypeError('A composition frame needs a second to capture')
      }
      return this.host.captureCompositionFrame(validateTabId(rawTabId), rawSeconds)
    })
    replaceHandler('browser:reloadIgnoringCache', (_event, rawTabId) => {
      this.host.liveTab(validateTabId(rawTabId))?.view.webContents.reloadIgnoringCache()
    })
    replaceHandler('browser:stop', (_event, rawTabId) => {
      this.host.liveTab(validateTabId(rawTabId))?.view.webContents.stop()
    })
    replaceHandler('browser:findInPage', (_event, rawTabId, rawRequest) => {
      this.host.findInPage(validateTabId(rawTabId), validateBrowserFindRequest(rawRequest))
    })
    replaceHandler('browser:stopFindInPage', (_event, rawTabId, rawAction) => {
      this.host.stopFindInPage(validateTabId(rawTabId), validateBrowserFindStopAction(rawAction))
    })
    replaceHandler('browser:setMuted', (_event, rawTabId, rawMuted) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.host.requireTab(tabId)
      if (typeof rawMuted !== 'boolean') {
        throw new TypeError('Browser mute state must be a boolean')
      }
      tab.transportMuted = false
      tab.view.webContents.setAudioMuted(rawMuted)
      const directory = tab.composition?.directory
      if (directory) {
        if (rawMuted) this.host.mutedCompositions.add(directory)
        else this.host.mutedCompositions.delete(directory)
      }
      // Publish rather than trust the caller: `isAudioMuted` is the state the
      // renderer's indicator must show, including for a muted tab that the page
      // silently unmuted through its own audio controls.
      this.host.publishState(tabId)
    })
    replaceHandler('browser:setChromeFocus', (_event, rawTabId) => {
      // Kept as reported, including a tab this process has not created yet: the
      // claim is matched against the tab list when a key is consumed (see
      // `focusedChromeTabId`), because the surface reports it as it mounts, before
      // the show that creates the page.
      this.host.focusedChromeTabId = rawTabId === null ? null : validateTabId(rawTabId)
    })
    replaceHandler('browser:focusPage', (_event, rawTabId) => {
      this.host.focusPage(validateTabId(rawTabId))
    })
    replaceHandler('browser:setShortcutBindings', (_event, rawBindings) => {
      this.host.shortcutBindings = validateBrowserShortcutBindings(rawBindings)
    })
    replaceHandler('browser:setSwitcherBindings', (_event, rawBindings) => {
      this.host.switcherBindings = validateBrowserSwitcherBindings(rawBindings)
    })
    replaceHandler('browser:setAppShortcutChords', (_event, rawChords, rawCompositionChords) => {
      this.host.appShortcutChords = validateBrowserAppShortcutChords(rawChords)
      this.host.compositionShortcutChords = validateBrowserAppShortcutChords(
        rawCompositionChords ?? []
      )
    })
    replaceHandler('browser:setSiteKeymapOverride', (_event, rawAllows) => {
      if (typeof rawAllows !== 'boolean') {
        throw new TypeError('Browser site keymap override must be a boolean')
      }
      this.host.allowSiteKeymapOverride = rawAllows
    })
    replaceHandler('browser:setSearchEngine', (_event, rawEngine) => {
      this.host.contextMenuSearchEngine = validateBrowserSearchEngine(rawEngine)
    })
    replaceHandler('browser:setScrollbarTheme', (_event, rawTheme) => {
      this.host.setScrollbarTheme(validateScrollbarTheme(rawTheme))
    })
    replaceHandler('browser:toggleDevTools', (_event, rawTabId) =>
      this.host.toggleDevTools(this.host.requireTab(validateTabId(rawTabId)).view.webContents)
    )
    replaceHandler('browser:inspectSetArmed', (_event, rawTabId, rawArmed, rawTheme) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.host.requireTab(tabId)
      if (typeof rawArmed !== 'boolean') {
        throw new TypeError('Inspect mode must be a boolean')
      }
      if (!tab.design && rawArmed) {
        throw new TypeError('The element inspector is available on a design preview only')
      }
      this.host.inspector.setArmed(
        tabId,
        tab.view.webContents,
        rawArmed,
        rawTheme === undefined ? null : validateInspectorTheme(rawTheme)
      )
    })
    replaceHandler('browser:inspectTheme', (_event, rawTabId, rawTheme) => {
      const tabId = validateTabId(rawTabId)
      this.host.requireTab(tabId)
      this.host.inspector.syncTheme(tabId, validateInspectorTheme(rawTheme))
    })
    replaceHandler('browser:inspectFocus', (_event, rawTabId, rawReferenceId, rawScroll) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.host.requireTab(tabId)
      if (typeof rawScroll !== 'boolean') {
        throw new TypeError('Inspector focus scroll flag must be a boolean')
      }
      this.host.inspector.focus(
        tabId,
        tab.view.webContents,
        validateInspectorReferenceId(rawReferenceId),
        rawScroll
      )
    })
    replaceHandler('browser:inspectMarkers', (_event, rawTabId, rawMarkers) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.host.requireTab(tabId)
      this.host.inspector.syncMarkers(
        tabId,
        tab.view.webContents,
        validateInspectorMarkers(rawMarkers)
      )
    })
    replaceHandler('browser:clearData', async (_event, rawProjectId) => {
      await this.host.siteData.clearProjectData(validateProjectId(rawProjectId))
    })
    replaceHandler('browser:clearBoxData', async (_event, rawProjectId, rawBoxId) => {
      const projectId = validateProjectId(rawProjectId)
      const boxId = validateOptionalBoxId(rawBoxId)
      if (!boxId) throw new TypeError('Browser box ID is required')
      await this.host.extensions.whenReady()
      await this.host.clearBoxData(projectId, boxId)
    })
    /** A box was deleted, so everything about it goes, its extensions included. */
    replaceHandler('browser:forgetBox', async (_event, rawProjectId, rawBoxId) => {
      const projectId = validateProjectId(rawProjectId)
      const boxId = validateOptionalBoxId(rawBoxId)
      if (!boxId) throw new TypeError('Browser box ID is required')
      await this.host.extensions.whenReady()
      await this.host.forgetBox(projectId, boxId)
    })
    replaceHandler('browser:extensions', async () => {
      await this.host.extensions.whenReady()
      return this.host.extensions.list()
    })
    replaceHandler('browser:extensionInstall', async (_event, rawInput) => {
      await this.host.extensions.whenReady()
      return this.host.extensions.install(validateExtensionInstallInput(rawInput))
    })
    replaceHandler('browser:extensionUninstall', async (_event, rawExtensionId) => {
      await this.host.extensions.whenReady()
      await this.host.extensions.uninstall(validateExtensionId(rawExtensionId))
    })
    replaceHandler('browser:extensionReorder', async (_event, rawOrderedIds) => {
      if (!Array.isArray(rawOrderedIds) || !rawOrderedIds.every((id) => typeof id === 'string')) {
        throw new TypeError('Extension order is invalid')
      }
      await this.host.extensions.reorder(rawOrderedIds.map(validateExtensionId))
    })
    replaceHandler('browser:extensionUpdateFromWebStore', async (_event, rawExtensionId) => {
      await this.host.extensions.whenReady()
      return this.host.extensions.updateFromWebStore(validateExtensionId(rawExtensionId))
    })
    replaceHandler('browser:extensionUpdate', async (_event, rawExtensionId, rawPatch) => {
      await this.host.extensions.whenReady()
      return this.host.extensions.update(
        validateExtensionId(rawExtensionId),
        validateExtensionUpdatePatch(rawPatch)
      )
    })
    replaceHandler('browser:darkReaderTabState', async (_event, rawTabId) => {
      await this.host.extensions.whenReady()
      const tab = this.host.requireTab(validateTabId(rawTabId))
      return this.host.extensions.darkReaderTabState(
        tab.projectId,
        tab.boxId,
        tab.view.webContents.id
      )
    })
    replaceHandler('browser:darkReaderTabScope', async (_event, rawTabId, action) => {
      if (
        action !== 'only-tab' &&
        action !== 'disable-tab' &&
        action !== 'enable-tab' &&
        action !== 'reset-tabs'
      ) {
        throw new TypeError('Dark Reader tab action is invalid')
      }
      await this.host.extensions.whenReady()
      const tab = this.host.requireTab(validateTabId(rawTabId))
      return this.host.extensions.setDarkReaderTabScope(
        tab.projectId,
        tab.boxId,
        tab.view.webContents.id,
        action
      )
    })
    replaceHandler('browser:extensionPickFolder', async () => {
      await this.host.extensions.whenReady()
      return this.host.extensions.pickFolder()
    })
    replaceHandler('browser:clearSiteData', (_event, rawProjectId, rawScopes) => {
      const projectId = validateProjectId(rawProjectId)
      const scopes = validateSiteDataScopes(rawScopes)
      void this.host.siteData.clearSiteData(projectId, scopes).catch((error: unknown) => {
        Logger.error('Browser site data could not be cleared:', error)
      })
    })
    replaceHandler(
      'browser:siteMenu',
      (_event, rawProjectId, rawHost, rawOrigin, rawBoxId, rawBoxName, rawX, rawY) => {
        const projectId = validateProjectId(rawProjectId)
        const host = validateBoundedHost(rawHost)
        // The normalized origin the permission section acts on; null when the
        // address is not a site, in which case the menu still offers its
        // clearing actions without the permission section.
        const origin = validateSiteMenuOrigin(rawOrigin)
        // The padlock clears the jar it was opened from, so the jar comes with it.
        const boxId = validateOptionalBoxId(rawBoxId)
        // Only used to name the jar in the confirmation, so it is bounded here and
        // nothing else is claimed about it.
        const boxName = boundedBoxLabel(rawBoxName)
        const x = validateSiteMenuPoint(rawX, 'x coordinate')
        const y = validateSiteMenuPoint(rawY, 'y coordinate')
        // Native popup menus run a nested run loop; detach from the invoke reply
        // so the renderer's call resolves immediately.
        setImmediate(() =>
          this.host.siteData.showSiteMenu(projectId, host, origin, boxId, boxName, x, y)
        )
      }
    )
    replaceHandler('browser:pageMenu', (_event, rawTabId, rawX, rawY) => {
      const tabId = validateTabId(rawTabId)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      this.host.requireTab(tabId)
      setImmediate(() => this.host.showPageMenu(tabId, x, y))
    })
    replaceHandler('browser:downloadsMenu', (_event, rawProjectId, rawX, rawY) => {
      const projectId = validateProjectId(rawProjectId)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      setImmediate(() => this.host.downloads.showMenu(projectId, x, y))
    })
    replaceHandler('browser:newTabMenu', (_event, rawInput, rawX, rawY) =>
      showBrowserNewTabMenu(
        this.host.window,
        validateBrowserNewTabMenuInput(rawInput),
        validateSiteMenuPoint(rawX, 'x coordinate'),
        validateSiteMenuPoint(rawY, 'y coordinate')
      )
    )
    replaceHandler('browser:boxMenu', (_event, rawInput, rawX, rawY) => {
      const input = validateBrowserBoxMenuInput(rawInput)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      // Unlike the menus above, this one's answer is the invoke's reply: the
      // caller reopens the tab in the box it names, so the popup's promise is
      // what carries the choice back.
      return showBrowserBoxMenu(this.host.window, input, x, y)
    })
    replaceHandler('browser:tabSelectionMenu', (_event, rawInput, rawX, rawY) => {
      const input = validateBrowserTabSelectionMenuInput(rawInput)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      return showBrowserTabSelectionMenu(this.host.window, input, x, y)
    })
    replaceHandler('browser:tabContextMenu', (_event, rawInput, rawX, rawY) => {
      const input = validateBrowserTabContextMenuInput(rawInput)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      return showBrowserTabContextMenu(this.host.window, input, x, y)
    })
    replaceHandler('browser:agentTabMenu', (_event, rawInput, rawX, rawY) => {
      const input = validateBrowserAgentTabMenuInput(rawInput)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      return showBrowserAgentTabMenu(this.host.window, input, x, y)
    })
    replaceHandler('browser:extensionMenu', (_event, rawInput, rawX, rawY) => {
      const input = validateBrowserExtensionMenuInput(rawInput)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      return showBrowserExtensionMenu(this.host.window, input, x, y)
    })
    replaceHandler('browser:openExtensionPage', async (_event, rawExtensionId, rawBoxId) => {
      const extensionId = validateExtensionId(rawExtensionId)
      const boxId = validateOptionalBoxId(rawBoxId)
      await this.host.extensions.whenReady()
      await this.host.extensions.ensureExtensionPagesAvailable(extensionId)
      return this.host.extensions.optionsUrlFor(extensionId, GLOBAL_BROWSER_PROJECT_ID, boxId)
    })
    replaceHandler('browser:resolvePermission', (_event, rawRequestId, rawDecision) => {
      const requestId = validatePermissionRequestId(rawRequestId)
      const decision = validatePermissionDecision(rawDecision)
      this.host.resolvePermission(requestId, permissionResolutions[decision])
    })
    replaceHandler('browser:resolveScreenShare', (_event, rawRequestId, rawSourceId) => {
      const requestId = validatePermissionRequestId(rawRequestId)
      const sourceId = typeof rawSourceId === 'string' ? rawSourceId : null
      this.host.screenShare.resolveChoice(requestId, sourceId)
    })
    replaceHandler(
      'browser:setSitePermission',
      (_event, rawProjectId, rawBoxId, rawOrigin, rawPermissionId, rawAction) => {
        const projectId = validateProjectId(rawProjectId)
        const boxId = validateOptionalBoxId(rawBoxId)
        const origin = validateSiteMenuOrigin(rawOrigin)
        if (!origin) throw new Error('Site permissions require a site origin')
        const descriptor = sitePermissionDescriptor(validateSitePermissionId(rawPermissionId))
        if (!descriptor) throw new Error('Site permission is unknown')
        const action = validateSitePermissionState(rawAction)
        // The modal writes the same ledger keys the page-initiated prompt writes,
        // so a manual decision and a prompt decision are the same decision.
        const partition = browserPartitionFor(projectId, boxId)
        this.host.applySitePermission(
          partition,
          descriptor.keysFor(origin),
          action === 'ask' ? 'reset' : action
        )
        // A page that already read the old answer only re-queries on navigation,
        // so the origin's tabs are reloaded into the new one, exactly as the old
        // padlock submenus did.
        this.host.reloadOriginTabs(partition, origin)
      }
    )
    replaceHandler('browser:popupReady', () => {
      // Pull model: the popup document requests the prompt on display once its
      // listener is bound. Invoke replies bypass the push-side load-state
      // guards that repeatedly dropped the first prompt (blank first popup).
      return this.host.promptWindow.currentContext()
    })
    replaceHandler('browser:expandPeek', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      if (!this.host.peekTabs.has(tabId) || !this.host.tabs.has(tabId))
        throw new Error('Peek Window is no longer available')
      this.host.peekTabs.delete(tabId)
    })
    replaceHandler('browser:peekSnapshot', async (_event, rawTabId) => {
      // Taken while the peek is still on screen, because the surface animates the
      // page away with it: without a picture the last thing the user sees of the
      // page is the frame it was replaced by.
      const captured = await this.host.captureThumbnail(
        validateTabId(rawTabId),
        PEEK_SNAPSHOT_MAX_WIDTH
      )
      return captured?.dataUrl ?? null
    })
    replaceHandler('browser:destroy', (_event, rawTabId, rawReason) => {
      this.host.destroy(validateTabId(rawTabId), validateTabDestroyReason(rawReason))
    })
    replaceHandler('browser:bindAssistantPage', (_event, rawThreadId, rawTabId) => {
      // Binding is tolerant about the tab: a restored tab that is still
      // hibernated has no view in main yet, and the binding is only read when an
      // operation actually needs the page (see `attachedPageTab`).
      this.host.assistantPageTabIds.set(validateThreadId(rawThreadId), validateTabId(rawTabId))
    })
    replaceHandler('browser:unbindAssistantPage', (_event, rawThreadId) => {
      this.host.assistantPageTabIds.delete(validateThreadId(rawThreadId))
    })
    replaceHandler('browser:bindThreadBrowserPage', (_event, rawScopeId, rawPage) => {
      // Binding is tolerant about the page: a tab restored from a previous launch
      // has no view in this process until something shows it, and the binding is
      // only read when an operation actually needs that page (see
      // `conversationPageTab`).
      this.host.threadBrowserPages.set(
        validateConversationScopeId(rawScopeId),
        validateThreadBrowserPage(rawPage)
      )
    })
    replaceHandler('browser:unbindThreadBrowserPage', (_event, rawScopeId) => {
      this.host.threadBrowserPages.delete(validateConversationScopeId(rawScopeId))
    })
    replaceHandler('browser:destroyThread', (_event, rawProjectId, rawThreadId) => {
      const projectId = validateProjectId(rawProjectId)
      const threadId = validateThreadId(rawThreadId)
      for (const [tabId, tab] of this.host.tabs) {
        if (tab.projectId === projectId && tab.threadId === threadId)
          this.host.destroy(tabId, 'closed')
      }
      // A hibernated tab of that thread has no live tab for the loop above to
      // find, so its stored stack is swept by owner rather than by tab. This is
      // the thread browser going away: its history goes with it, session set and
      // all.
      const ownedByThread = (record: BrowserTabHistoryRecord): boolean =>
        record.projectId === projectId && record.threadId === threadId
      this.host.tabHistory.forgetScopes(ownedByThread)
      this.host.closedTabHistory.forgetScopes(ownedByThread)
    })
    replaceHandler('browser:destroyProject', (_event, rawProjectId) => {
      this.host.dropProjectTabs(validateProjectId(rawProjectId))
    })
    replaceHandler('browser:getDownloads', (_event, rawProjectId) => {
      const projectId = validateProjectId(rawProjectId)
      return this.host.downloads.list(projectId)
    })
    replaceHandler('browser:cancelDownload', (_event, rawDownloadId) => {
      this.host.downloads.cancel(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:pauseDownload', (_event, rawDownloadId) => {
      this.host.downloads.pause(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:resumeDownload', (_event, rawDownloadId) => {
      this.host.downloads.resume(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:retryDownload', (_event, rawDownloadId) => {
      this.host.downloads.retry(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:removeDownload', (_event, rawDownloadId) => {
      this.host.downloads.remove(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:openDownload', (_event, rawDownloadId) => {
      this.host.downloads.open(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:revealDownload', (_event, rawDownloadId) => {
      return this.host.downloads.reveal(validateDownloadId(rawDownloadId))
    })
  }
}
