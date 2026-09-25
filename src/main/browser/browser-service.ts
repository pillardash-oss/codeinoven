import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  MenuItem,
  session,
  webFrameMain,
  WebContentsView,
  type Session,
  type WebContents,
  type WebFrameMain
} from 'electron'
import type { Database } from '../database/database'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { Project, Thread } from '../../lib/types'
import { isPreviewOriginUrl, originOf } from '../../lib/local-development-url'
import { fitWithin, MAX_SCREENSHOT_DIMENSION } from '../../lib/image-payload'
import type {
  BrowserCompositionPlayback,
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserDesignTab,
  BrowserDevToolsState,
  BrowserPageState,
  BrowserPanelShortcutAction,
  BrowserPermissionRequest,
  BrowserShortcutAction,
  BrowserShortcutBindings,
  BrowserTransportCommand,
  BrowserViewBounds
} from '../../lib/ipc-contract'
import { isVideoCaptureUrl } from '../../lib/video/project'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'
import { fetchIconAsDataUrl } from '../editor/favicon-service'
import { PermissionPromptWindow, type PromptRequestContext } from './permission-prompt-window'
import { BrowserDownloadTracker } from './browser-service/browser-downloads'
import { BrowserCaptureObserver } from './browser-service/browser-capture'
import { BrowserInspector } from './browser-service/browser-inspector'
import { BrowserSiteDataService } from './browser-service/browser-site-data'
import { dialogContextScript } from './browser-service/browser-dialog-context'
import { matchBrowserShortcut } from './browser-service/browser-shortcuts'
import {
  permissionCheckKey,
  permissionGrantKeys,
  permissionOrigin,
  permissionResolutions,
  rememberedPermissionOutcome,
  type PermissionResolution
} from './browser-service/browser-permissions'
import {
  BrowserPermissionMemory,
  type PermissionMemoryPersistence
} from './browser-service/browser-permission-memory'
import type { BrowserTab, PendingBrowserPermission } from './browser-service/browser-types'
import { BrowserTabStage } from './browser-service/browser-stage'
import {
  AGENT_REVEAL_GRACE_MS,
  BROWSER_PARTITION_PREFIX,
  DEFAULT_PARKED_VIEWPORT,
  FRAME_RENDER_TIMEOUT_MS,
  MAX_ABANDONED_REVEALS,
  MAX_CONSOLE_ENTRIES,
  MAX_DIALOG_LABEL_LENGTH,
  MAX_PARKED_TABS,
  MAX_TRANSPORT_ERROR_LENGTH,
  MAX_ZOOM_LEVEL,
  PERMISSION_TIMEOUT_MS,
  RELAX_COOLDOWN_MS,
  SCREENSHOT_JPEG_QUALITY,
  SCREENSHOT_MAX_BYTES,
  ZOOM_STEP,
  browserContextKey,
  isSameBounds,
  safeBasename,
  validateAttention,
  validateBounds,
  validateBoundedHost,
  validateBrowserShortcutBindings,
  validateBrowserUrl,
  validateDownloadId,
  validateInspectorMarkers,
  validateOptionalBrowserUrl,
  validatePermissionDecision,
  validatePermissionRequestId,
  validateProjectId,
  validateSiteDataScopes,
  validateSiteMenuPoint,
  validateTabId,
  validateThreadId,
  validateTransportCommand,
  validateTransportValue,
  validateViewportRequest
} from './browser-service/browser-validation'
import type { BrowserViewport } from './browser-service/browser-types'

/**
 * Where a renderer-owned shortcut lands. The key is decided in this process,
 * which is the only one that sees it before the application menu, and the tab
 * strip stays the renderer's: it opens, closes and focuses its own tabs.
 */
const PANEL_SHORTCUT_TARGETS: Readonly<
  Record<'focusAddress' | 'closeTab' | 'newTab', BrowserPanelShortcutAction>
> = {
  focusAddress: 'focus-address',
  closeTab: 'close-tab',
  newTab: 'new-tab'
}

import {
  NO_TAB_MARK,
  isSameTabMark,
  tabMarkFor,
  type BrowserTabMark,
  type TabMarkRecogniser
} from './browser-service/browser-tab-mark'
import {
  COMPOSITION_TRANSPORT_GLOBAL,
  compositionTransportCommandScript,
  compositionTransportScript,
  compositionTransportStateScript
} from './browser-service/browser-transport-script'

/** Owns sandboxed page content while the renderer owns the browser chrome. */
export class BrowserService {
  private readonly tabs = new Map<string, BrowserTab>()
  private readonly agentTabIds = new Map<string, string>()
  private readonly configuredSessions = new Set<string>()
  private readonly permissionGrants = new Map<string, Set<string>>()
  private readonly permissionDenies = new Map<string, Set<string>>()
  private readonly pendingPermissions = new Map<string, PendingBrowserPermission>()
  private readonly downloadTracker: BrowserDownloadTracker
  private readonly capture: BrowserCaptureObserver
  /** Element inspector for design tabs. Injected page code reports picks and
   *  comments; the panel drives it through the browser IPC contract. */
  private readonly inspector: BrowserInspector
  private readonly siteData: BrowserSiteDataService
  private readonly permissionMemory: BrowserPermissionMemory
  private readonly promptWindow: PermissionPromptWindow
  private readonly projects: ProjectRepo
  private readonly threads: ThreadRepo
  /** Invisible windows that keep non-displayed tabs alive offscreen. */
  private readonly stage: BrowserTabStage
  /** Last capture per tab, so a page that has not changed is not sent to the
   *  model a second time. A design thread was measured taking seven byte-identical
   *  screenshots in one turn, which is what drove it to compact repeatedly. */
  private readonly lastScreenshot = new Map<
    string,
    { hash: string; width: number; height: number }
  >()
  /** How a tab is recognised as showing a design or a composition, supplied by
   *  the app at boot. */
  private tabMarkRecogniser: TabMarkRecogniser | null = null
  /**
   * Where each composition tab's playhead was, kept across a reload.
   *
   * A preview refreshes itself whenever the agent writes, which reloads the page
   * and would otherwise throw the playhead away: the user would be sent back to
   * the start of the video every time the composition changed, which is the whole
   * complaint the transport answers. The folder is recorded with the position so a
   * playhead is only ever restored into the composition it came from.
   */
  private readonly playheads = new Map<
    string,
    { directory: string; time: number; playing: boolean }
  >()
  private activeTabId: string | null = null
  /** Chords the browser claims, resolved from the keymap by the renderer. Empty
   *  until that report arrives, which leaves every key to the rest of the app. */
  private shortcutBindings: BrowserShortcutBindings = {}
  /**
   * The tab whose toolbar holds DOM focus (address bar, navigation buttons), or
   * null while none does.
   *
   * A key pressed inside the page arrives on the tab's own web contents; a key
   * pressed in the toolbar arrives on the window's, where the application menu
   * would otherwise act on it. This is the one fact main cannot read for itself,
   * so the panel reports it and the window-level interception routes to this tab.
   */
  private focusedChromeTabId: string | null = null
  /** Last known content bounds of the active tab's native view (window-content
   *  coordinates). The permission popup anchors itself to this area so it
   *  never collides with toasts at the window edge. */
  private activeTabBounds: BrowserViewBounds | null = null
  /** The view actually parented to the app window, and the frame it sits at, or
   *  null while the active tab's view is parked offscreen.
   *
   *  The renderer re-reports the same frame once per animation frame while it
   *  aligns the panel with an entry transform, so `showActiveView` needs to tell
   *  "attach this now" from "it is already there": re-adding a child view is a
   *  window-server commit, and doing that sixty times a second for a frame that
   *  never moved is the difference between an instant switch and a hitch. */
  private displayedTab: { tabId: string; bounds: BrowserViewBounds } | null = null
  /** The dialog-context label already installed in each tab's current document.
   *  The shim is idempotent per document, so a repeat is a script evaluation
   *  per frame for no change. Cleared when a new document commits. */
  private readonly injectedDialogLabels = new Map<string, string>()
  /** Parked tab ids in least-recently-used order, newest last. Drives the cap on
   *  how many tabs may render offscreen at once. */
  private readonly parkedOrder: string[] = []
  /** Tabs the agent just revealed to the user, so a tab the user immediately
   *  leaves can be counted as an ignored reveal. `shown` records that the reveal
   *  actually reached the screen, which is what makes leaving it meaningful. */
  private readonly agentReveals = new Map<
    string,
    { threadKey: string; at: number; shown: boolean }
  >()
  /** Consecutive ignored reveals per thread, with when the last one happened. */
  private readonly abandonedReveals = new Map<string, { count: number; at: number }>()
  /** Threads whose agent reveals were ignored, until this timestamp. */
  private readonly relaxedUntil = new Map<string, number>()
  /** True while a Sonner toast is visible in the renderer. A native
   *  WebContentsView floats above every DOM surface, so while this is set the
   *  active browser view stays detached and the DOM toast composites normally. */
  private toastVisible = false
  private consoleSequence = 0

  constructor(
    private readonly window: BrowserWindow,
    db: Database,
    permissionPersistence: PermissionMemoryPersistence
  ) {
    this.promptWindow = new PermissionPromptWindow(window)
    this.stage = new BrowserTabStage(window)
    this.permissionMemory = new BrowserPermissionMemory(permissionPersistence)
    this.projects = new ProjectRepo(db)
    this.threads = new ThreadRepo(db)
    this.downloadTracker = new BrowserDownloadTracker({
      window,
      findTabId: (projectId, contentsId) =>
        [...this.tabs.entries()].find(
          ([, tab]) => tab.projectId === projectId && tab.view.webContents.id === contentsId
        )?.[0]
    })
    this.siteData = new BrowserSiteDataService({
      window,
      sessionForProject: (projectId) => this.sessionForProject(projectId),
      forEachTab: (visit) => {
        for (const tab of this.tabs.values()) visit(tab)
      },
      dismissPermissions: (projectId) => this.dismissProjectPermissions(projectId),
      clearPermissionMemory: (projectId) => this.clearProjectPermissionMemory(projectId),
      cancelProjectDownloads: (projectId) => this.downloadTracker.cancelProject(projectId)
    })
    this.capture = new BrowserCaptureObserver({
      // A capture change is a tab-level fact the user must see, so it is
      // published on the same state event the tab strip already listens to.
      onChange: (tabId) => this.publishState(tabId)
    })
    this.inspector = new BrowserInspector({
      // Every pick, comment and removal is forwarded to the renderer, which owns
      // the reference list and turns it back into the page's marker set.
      onEvent: (tabId, event) => {
        sendToRenderer(this.window.webContents, 'browser:inspector', tabId, event)
      }
    })
  }

  /**
   * Merge the permission decisions the user already made into the live
   * ledgers. The bootstrap awaits this before the service accepts browser IPC,
   * so a site's permission request can never race the read and re-prompt for a
   * permission the user already granted.
   */
  async hydratePermissionMemory(): Promise<void> {
    try {
      await this.permissionMemory.load(this.permissionLedgers())
    } catch (error: unknown) {
      Logger.error('Browser permission memory could not be loaded:', error)
    }
  }

  register(): void {
    this.guardAgainstStrandedView()
    ipcMain.handle(
      'browser:show',
      (_event, rawTabId, rawProjectId, rawThreadId, rawInitialUrl, rawBounds) => {
        const tabId = validateTabId(rawTabId)
        const projectId = validateProjectId(rawProjectId)
        const threadId = validateThreadId(rawThreadId)
        const initialUrl = validateOptionalBrowserUrl(rawInitialUrl)
        const bounds = validateBounds(rawBounds)
        const tab = this.ensureTab(tabId, projectId, threadId)

        // Leaving a tab costs nothing now: the outgoing tab keeps running in an
        // invisible stage window instead of going dead behind the app window.
        if (this.activeTabId && this.activeTabId !== tabId) this.parkTab(this.activeTabId)
        this.activeTabId = tabId
        this.activeTabBounds = bounds
        this.markRevealShown(tabId)
        if (this.toastVisible) {
          // A native view floats above every DOM surface, so while a toast is on
          // screen the tab stays parked at its on-screen size: the page keeps
          // the exact viewport the user was looking at, and keeps running.
          this.parkTab(tabId, { width: bounds.width, height: bounds.height }, true)
        } else {
          this.showActiveView()
        }
        // Refresh the alert/confirm context label on every activation so a
        // renamed project or thread is reflected without waiting for a reload.
        this.injectDialogContext(tabId)
        if (!tab.initialNavigationStarted) {
          tab.initialNavigationStarted = true
          // A blank tab has no address yet: nothing to load, and the tab must
          // not spin. A later show still reports the live page state.
          if (initialUrl) this.load(tabId, initialUrl)
        }
        return this.stateFor(tabId, tab)
      }
    )

    ipcMain.handle('browser:hide', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      // Leaving a tab right after an agent revealed it is the signal that the
      // agent's reveal was not welcome; it stops being counted after a while.
      this.noteDepartedReveal(tabId)
      this.parkTab(tabId)
      // Missing tabs are silently ignored   the renderer may call hide
      // during teardown after the tab was already destroyed.
    })
    ipcMain.handle('browser:setToastVisible', (_event, rawVisible) => {
      this.setToastVisible(rawVisible === true)
    })
    ipcMain.handle('browser:navigate', (_event, rawTabId, rawUrl) => {
      this.load(validateTabId(rawTabId), validateBrowserUrl(rawUrl))
    })
    ipcMain.handle('browser:goBack', (_event, rawTabId) => {
      const tab = this.requireTab(validateTabId(rawTabId))
      if (tab.view.webContents.navigationHistory.canGoBack()) {
        tab.view.webContents.navigationHistory.goBack()
      }
    })
    ipcMain.handle('browser:goForward', (_event, rawTabId) => {
      const tab = this.requireTab(validateTabId(rawTabId))
      if (tab.view.webContents.navigationHistory.canGoForward()) {
        tab.view.webContents.navigationHistory.goForward()
      }
    })
    ipcMain.handle('browser:reload', (_event, rawTabId) => {
      this.requireTab(validateTabId(rawTabId)).view.webContents.reload()
    })
    ipcMain.handle('browser:transport', async (_event, rawTabId, rawCommand, rawValue) => {
      const tabId = validateTabId(rawTabId)
      const command = validateTransportCommand(rawCommand)
      return this.transport(tabId, command, validateTransportValue(command, rawValue))
    })
    ipcMain.handle('browser:transportState', (_event, rawTabId) =>
      this.transportState(validateTabId(rawTabId))
    )
    ipcMain.handle('browser:reloadIgnoringCache', (_event, rawTabId) => {
      this.requireTab(validateTabId(rawTabId)).view.webContents.reloadIgnoringCache()
    })
    ipcMain.handle('browser:stop', (_event, rawTabId) => {
      this.requireTab(validateTabId(rawTabId)).view.webContents.stop()
    })
    ipcMain.handle('browser:setMuted', (_event, rawTabId, rawMuted) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.requireTab(tabId)
      if (typeof rawMuted !== 'boolean') {
        throw new TypeError('Browser mute state must be a boolean')
      }
      tab.view.webContents.setAudioMuted(rawMuted)
      // Publish rather than trust the caller: `isAudioMuted` is the state the
      // renderer's indicator must show, including for a muted tab that the page
      // silently unmuted through its own audio controls.
      this.publishState(tabId)
    })
    ipcMain.handle('browser:setChromeFocus', (_event, rawTabId) => {
      // The panel may name a tab that was already destroyed (a close racing the
      // last focus report). Parking the answer as null is correct: no toolbar
      // holds the keyboard any more.
      if (rawTabId === null) {
        this.focusedChromeTabId = null
        return
      }
      const tabId = validateTabId(rawTabId)
      this.focusedChromeTabId = this.tabs.has(tabId) ? tabId : null
    })
    ipcMain.handle('browser:setShortcutBindings', (_event, rawBindings) => {
      this.shortcutBindings = validateBrowserShortcutBindings(rawBindings)
    })
    ipcMain.handle('browser:toggleDevTools', (_event, rawTabId) =>
      this.toggleTabDevTools(this.requireTab(validateTabId(rawTabId)))
    )
    ipcMain.handle('browser:inspectSetArmed', (_event, rawTabId, rawArmed) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.requireTab(tabId)
      if (typeof rawArmed !== 'boolean') {
        throw new TypeError('Inspect mode must be a boolean')
      }
      if (!tab.design && rawArmed) {
        throw new TypeError('The element inspector is available on a design preview only')
      }
      this.inspector.setArmed(tabId, tab.view.webContents, rawArmed)
    })
    ipcMain.handle('browser:inspectMarkers', (_event, rawTabId, rawMarkers) => {
      const tabId = validateTabId(rawTabId)
      this.requireTab(tabId)
      this.inspector.syncMarkers(tabId, validateInspectorMarkers(rawMarkers))
    })
    ipcMain.handle('browser:clearData', async (_event, rawProjectId) => {
      await this.siteData.clearProjectData(validateProjectId(rawProjectId))
    })
    ipcMain.handle('browser:clearSiteData', (_event, rawProjectId, rawScopes) => {
      const projectId = validateProjectId(rawProjectId)
      const scopes = validateSiteDataScopes(rawScopes)
      void this.siteData.clearSiteData(projectId, scopes).catch((error: unknown) => {
        Logger.error('Browser site data could not be cleared:', error)
      })
    })
    ipcMain.handle('browser:siteMenu', (_event, rawProjectId, rawHost, rawX, rawY) => {
      const projectId = validateProjectId(rawProjectId)
      const host = validateBoundedHost(rawHost)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      // Native popup menus run a nested run loop; detach from the invoke reply
      // so the renderer's call resolves immediately.
      setImmediate(() => this.siteData.showSiteMenu(projectId, host, x, y))
    })
    ipcMain.handle('browser:pageMenu', (_event, rawTabId, rawX, rawY) => {
      const tabId = validateTabId(rawTabId)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      this.requireTab(tabId)
      setImmediate(() => this.showPageMenu(tabId, x, y))
    })
    ipcMain.handle('browser:downloadsMenu', (_event, rawProjectId, rawX, rawY) => {
      const projectId = validateProjectId(rawProjectId)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      setImmediate(() => this.downloadTracker.showMenu(projectId, x, y))
    })
    ipcMain.handle('browser:resolvePermission', (_event, rawRequestId, rawDecision) => {
      const requestId = validatePermissionRequestId(rawRequestId)
      const decision = validatePermissionDecision(rawDecision)
      this.resolvePermission(requestId, permissionResolutions[decision])
    })
    ipcMain.handle('browser:popupReady', () => {
      // Pull model: the popup document requests the prompt on display once its
      // listener is bound. Invoke replies bypass the push-side load-state
      // guards that repeatedly dropped the first prompt (blank first popup).
      return this.promptWindow.currentContext()
    })
    ipcMain.handle('browser:destroy', (_event, rawTabId) => {
      this.destroy(validateTabId(rawTabId))
    })
    ipcMain.handle('browser:destroyThread', (_event, rawProjectId, rawThreadId) => {
      const projectId = validateProjectId(rawProjectId)
      const threadId = validateThreadId(rawThreadId)
      for (const [tabId, tab] of this.tabs) {
        if (tab.projectId === projectId && tab.threadId === threadId) this.destroy(tabId)
      }
    })
    ipcMain.handle('browser:destroyProject', (_event, rawProjectId) => {
      const projectId = validateProjectId(rawProjectId)
      for (const [tabId, tab] of this.tabs) {
        if (tab.projectId === projectId) this.destroy(tabId)
      }
    })
    ipcMain.handle('browser:getDownloads', (_event, rawProjectId) => {
      const projectId = validateProjectId(rawProjectId)
      return this.downloadTracker.list(projectId)
    })
    ipcMain.handle('browser:cancelDownload', (_event, rawDownloadId) => {
      this.downloadTracker.cancel(validateDownloadId(rawDownloadId))
    })
    ipcMain.handle('browser:pauseDownload', (_event, rawDownloadId) => {
      this.downloadTracker.pause(validateDownloadId(rawDownloadId))
    })
    ipcMain.handle('browser:resumeDownload', (_event, rawDownloadId) => {
      this.downloadTracker.resume(validateDownloadId(rawDownloadId))
    })
    ipcMain.handle('browser:openDownload', (_event, rawDownloadId) => {
      this.downloadTracker.open(validateDownloadId(rawDownloadId))
    })
    ipcMain.handle('browser:revealDownload', (_event, rawDownloadId) => {
      return this.downloadTracker.reveal(validateDownloadId(rawDownloadId))
    })
  }

  dispose(): void {
    this.activeTabId = null
    this.toastVisible = false
    this.activeTabBounds = null
    this.displayedTab = null
    this.injectedDialogLabels.clear()
    this.parkedOrder.length = 0
    this.agentReveals.clear()
    this.abandonedReveals.clear()
    this.relaxedUntil.clear()
    this.stage.dispose()
    this.promptWindow.dispose()
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.resolvePermission(requestId, permissionResolutions.dismiss)
    }
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    this.tabs.clear()
    this.agentTabIds.clear()
    this.configuredSessions.clear()
    this.permissionGrants.clear()
    this.permissionDenies.clear()
    this.playheads.clear()
    this.downloadTracker.dispose()
    this.capture.dispose()
    this.inspector.dispose()
  }

  /**
   * Record that a tab is rendering a design folder. Non-null `design` on the
   *  published state is what makes the panel offer the element inspector, so only
   *  the design capability calls this: it is the one caller that knows a served
   *  folder is a design rather than an arbitrary directory.
   *
   *  A composition is recognized rather than marked, because its mark carries the
   *  timeline its manifest declares and that has to be read.
   */
  markDesignTab(tabId: string, design: BrowserDesignTab): void {
    const tab = this.requireTab(tabId)
    tab.design = { directory: design.directory, origin: design.origin }
    this.publishState(tabId)
  }

  /**
   * Register how a tab is recognised from the page it is showing.
   *
   * Without this, a tab is a design only when a design capability marked it, which
   * is what left a tab the agent opened itself, and a tab the renderer restored after
   * a restart, showing a design as an ordinary page. The same recognition is what
   * arms a composition's transport, so both marks come from one rule.
   */
  setTabMarkRecogniser(recogniser: TabMarkRecogniser | null): void {
    this.tabMarkRecogniser = recogniser
  }

  /**
   * Decide, from the origin a tab is showing, what the app knows about its folder.
   *
   * Called on every committed navigation and nowhere else, because the origin is the
   * only thing that can change the answer: an in-page navigation cannot move a page
   * to another origin. A tab that navigated away from its folder therefore loses its
   * mark, and a tab that arrives on an authored-work folder gains one whether or not
   * a capability opened it.
   *
   * The answer is asynchronous because a composition's mark carries the timeline
   * its manifest declares, so the URL is read again when it lands: a mark for a
   * document the tab has already left would arm the transport with the wrong video.
   */
  private refreshTabMark(tabId: string, tab: BrowserTab): void {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    const url = contents.getURL()
    const recogniser = this.tabMarkRecogniser
    if (!recogniser) {
      this.applyTabMark(tabId, tab, url, NO_TAB_MARK)
      return
    }
    void recogniser(tab.projectId, tab.threadId, url)
      .then((recognised) => {
        if (contents.isDestroyed() || contents.getURL() !== url) return
        this.applyTabMark(tabId, tab, url, recognised)
      })
      .catch((error: unknown) => {
        Logger.error('Browser tab recognition failed:', error)
      })
  }

  /**
   * Land a recognised mark on a tab, and arm or disarm what it governs.
   *
   * Arming waits for the document to settle unless it already has: the transport is
   * installed into the page, and the load's own `did-finish-load` covers the case
   * where the mark was resolved while the document was still arriving.
   */
  private applyTabMark(
    tabId: string,
    tab: BrowserTab,
    url: string,
    recognised: BrowserTabMark
  ): void {
    const previous: BrowserTabMark = { design: tab.design, composition: tab.composition }
    const next = tabMarkFor(url, previous, recognised)
    if (isSameTabMark(next, previous)) return
    tab.design = next.design
    tab.composition = next.composition
    if (next.design === null) this.inspector.setArmed(tabId, tab.view.webContents, false)
    this.publishState(tabId)
    if (!next.composition) {
      // A tab that left the composition has no playhead to restore.
      this.playheads.delete(tabId)
      return
    }
    // Arming is idempotent per document and per timeline, so this needs no guard
    // against the load's own arm: whichever of the two arrives second does nothing.
    this.armCompositionQuietly(tabId, tab)
  }

  async executeUtility(
    operation: string,
    input: Record<string, unknown>,
    context: { projectId: string; threadId: string }
  ): Promise<unknown> {
    const projectId = validateProjectId(context.projectId)
    const threadId = validateThreadId(context.threadId)
    const contextKey = browserContextKey(projectId, threadId)
    if (operation === 'open') {
      const url = validateBrowserUrl(this.requiredInputString(input, 'url'))
      const attention = validateAttention(input['attention'])
      const tabId = `browser:agent:${crypto.randomUUID()}`
      const tab = this.ensureTab(tabId, projectId, threadId)
      tab.initialNavigationStarted = true
      // Mount the tab offscreen before anything else: the page must run whether
      // or not the user ends up looking at it.
      this.parkTab(tabId)
      this.load(tabId, url)
      this.agentTabIds.set(contextKey, tabId)
      // An opportunistic reveal is skipped once the user has shown twice that
      // they leave agent-opened tabs straight away.
      const relaxed = attention === 'focus' && this.isRelaxed(threadId)
      const reveal = attention === 'focus' && !relaxed
      if (reveal) this.rememberReveal(tabId, threadId)
      sendToRenderer(this.window.webContents, 'browser:openRequested', url, {
        projectId,
        threadId,
        requestedTabId: tabId,
        reveal
      })
      return {
        ...this.utilityTabContext(tabId, tab),
        viewport: tab.viewport,
        attention: reveal ? 'focus' : 'background',
        relaxed,
        page: this.stateFor(tabId, tab)
      }
    }

    const tabId = this.agentTabIds.get(contextKey)
    if (!tabId) throw new Error('Open a browser page before using this operation')
    const tab = this.requireTab(tabId)
    if (tab.projectId !== projectId || tab.threadId !== threadId) {
      throw new Error('The current browser tab belongs to a different project or thread')
    }
    // An operation is a use: it revives a tab that was evicted from the parked
    // set, and protects it from eviction while the agent keeps working on it.
    if (this.activeTabId !== tabId && !this.stage.isParked(tab.view)) this.parkTab(tabId)
    else this.touchParkedTab(tabId)
    const utilityContext = this.utilityTabContext(tabId, tab)
    if (operation === 'viewport') {
      const viewport = validateViewportRequest(input, tab.viewport)
      tab.viewport = viewport
      if (this.stage.isParked(tab.view)) {
        // Re-park rather than setBounds directly: the stage owns where each
        // parked view sits inside its window.
        this.stage.park(tab.view, viewport)
        return { ...utilityContext, viewport, applied: 'parked' }
      }
      return {
        ...utilityContext,
        viewport,
        applied: 'displayed',
        detail:
          'The user is viewing this tab, so it is laid out at the on-screen size right now. This viewport applies whenever the tab is parked offscreen.'
      }
    }
    if (operation === 'navigate') {
      const url = validateBrowserUrl(this.requiredInputString(input, 'url'))
      this.load(tabId, url)
      return { ...utilityContext, url }
    }
    if (operation === 'reload') {
      tab.view.webContents.reload()
      return { ...utilityContext, reloading: true }
    }
    if (operation === 'snapshot') {
      const snapshot: unknown = await tab.view.webContents.executeJavaScript(`(() => ({
        url: location.href,
        title: document.title,
        text: (document.body?.innerText ?? '').slice(0, 30000),
        elements: Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"], [contenteditable="true"]'))
          .slice(0, 250)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            id: element.id || undefined,
            name: element.getAttribute('name') || undefined,
            role: element.getAttribute('role') || undefined,
            type: element.getAttribute('type') || undefined,
            text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim().slice(0, 300)
          }))
      }))()`)
      return { ...utilityContext, snapshot }
    }
    if (operation === 'click') {
      const selector = this.requiredInputString(input, 'selector')
      const result: unknown = await tab.view.webContents.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return { clicked: false, reason: 'not found' };
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.click();
        return { clicked: true };
      })()`)
      return { ...utilityContext, result }
    }
    if (operation === 'type') {
      const selector = this.requiredInputString(input, 'selector')
      const text = this.requiredInputString(input, 'text', true)
      const result: unknown = await tab.view.webContents.executeJavaScript(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return { typed: false, reason: 'not found' };
        element.focus();
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = ${JSON.stringify(text)};
        } else if (element.isContentEditable) {
          element.textContent = ${JSON.stringify(text)};
        } else {
          return { typed: false, reason: 'element is not editable' };
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true };
      })()`)
      return { ...utilityContext, result }
    }
    if (operation === 'screenshot') {
      return { ...utilityContext, ...(await this.captureScreenshot(tabId, tab, input)) }
    }
    if (operation === 'console') {
      return { ...utilityContext, entries: [...tab.consoleEntries] }
    }
    throw new Error(`In-app browser does not expose the operation "${operation}"`)
  }

  /**
   * Capture a tab's page for an agent at a size the model can afford.
   *
   * `capturePage` returns device pixels, so a 4K panel yields a 3840x2160 picture
   * and a requested viewport may reach `MAX_VIEWPORT_SIDE`, doubled again by the
   * display scale factor. Base64 that travels inline in a tool result is billed as
   * text, at roughly one token per character, which measured ~40,788 tokens for one
   * such capture; the same picture sent as an image content part is billed on its
   * pixels instead, which is why the gateway converts it. The capture is therefore
   * capped to a legible size, bounded in bytes for a photo-heavy page, and skipped
   * entirely when the page has not changed, because a design thread was measured
   * taking seven byte-identical screenshots in a single turn.
   */
  private async captureScreenshot(
    tabId: string,
    tab: BrowserTab,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const captured = await tab.view.webContents.capturePage()
    const source = captured.getSize()
    const target = fitWithin(source.width, source.height, MAX_SCREENSHOT_DIMENSION)
    const capped = target.width !== source.width || target.height !== source.height
    const resized = capped
      ? captured.resize({ width: target.width, height: target.height })
      : captured
    const png = resized.toPNG()
    const lossless = png.byteLength <= SCREENSHOT_MAX_BYTES
    const encoded = lossless ? png : resized.toJPEG(SCREENSHOT_JPEG_QUALITY)
    const hash = createHash('sha256').update(encoded).digest('hex')
    if (input['force'] !== true && this.lastScreenshot.get(tabId)?.hash === hash) {
      return {
        unchanged: true,
        width: target.width,
        height: target.height,
        detail:
          'The page has not changed since the previous screenshot, so it was not captured again. Pass {"force":true} to capture it anyway.'
      }
    }
    this.lastScreenshot.set(tabId, { hash, width: target.width, height: target.height })
    return {
      dataUrl: `data:image/${lossless ? 'png' : 'jpeg'};base64,${encoded.toString('base64')}`,
      width: target.width,
      height: target.height,
      // Report the render size only when it was capped, so a model reading a
      // screenshot knows the page it is reviewing was laid out larger.
      ...(capped ? { sourceWidth: source.width, sourceHeight: source.height } : {})
    }
  }

  /**
   * Reload every live tab showing a page under one preview origin, and report how
   * many were reloaded.
   *
   * A preview server knows its own origin and nothing about browsers, so its tab
   * is found by the URL it is showing rather than by a registration. Matching on
   * the origin means a tab the user navigated somewhere else is left alone, and a
   * tab is never reloaded out from under a page that has nothing to do with the
   * folder that changed.
   */
  reloadPreviewOrigin(origin: string): number {
    let reloaded = 0
    for (const [tabId, tab] of this.tabs) {
      const contents = tab.view.webContents
      if (contents.isDestroyed()) continue
      if (!isPreviewOriginUrl(contents.getURL(), origin)) continue
      // Reloading is deferred until the tab's playhead has been read, so a
      // composition the agent just edited resumes where it was instead of being
      // thrown back to its first frame. A tab that is not a composition answers
      // without touching the page.
      void this.reloadKeepingPlayhead(tabId, tab).catch((error: unknown) => {
        Logger.error('A preview tab could not refresh itself:', error)
      })
      reloaded += 1
    }
    return reloaded
  }

  /**
   * Refresh one preview tab, keeping a composition's playhead across the reload.
   *
   * The document is about to be replaced, so where it was is read first and handed
   * to the next arming of the transport. The reload still happens when that read
   * fails: a preview that stops refreshing because playback could not be asked about
   * would be a worse trade than losing one second of position.
   */
  private async reloadKeepingPlayhead(tabId: string, tab: BrowserTab): Promise<void> {
    if (tab.composition) await this.rememberPlayhead(tabId, tab)
    const contents = tab.view.webContents
    if (!contents.isDestroyed()) contents.reload()
  }

  /** A composition tab's playhead as the page reports it, or null. */
  private async readPlayhead(tabId: string): Promise<{ time: number; playing: boolean } | null> {
    const playback = await this.transportState(tabId).catch(() => null)
    return playback ? { time: playback.time, playing: playback.playing } : null
  }

  /**
   * Remember where a composition's playhead is, for the next arming to restore.
   *
   * The folder is stored with the position, so a tab reused for another composition
   * can never restore this one's playhead. A page with no armed transport answers
   * nothing, and that answer deliberately does not overwrite a position already
   * remembered: a capture's frozen page is exactly that page, and the position worth
   * restoring is the one from before it was loaded.
   */
  private async rememberPlayhead(tabId: string, tab: BrowserTab): Promise<void> {
    const directory = tab.composition?.directory
    if (!directory) return
    const playback = await this.readPlayhead(tabId)
    // The tab can be closed while the page is being asked, and a position for a
    // tab that is gone would never be restored by anything.
    if (this.tabs.get(tabId) !== tab) return
    if (playback) this.playheads.set(tabId, { directory, ...playback })
  }

  /** Take the remembered playhead for one folder, when that is the folder it is for. */
  private takePlayhead(
    tabId: string,
    directory: string
  ): { time: number; playing: boolean } | null {
    const saved = this.playheads.get(tabId)
    if (!saved) return null
    this.playheads.delete(tabId)
    return saved.directory === directory ? { time: saved.time, playing: saved.playing } : null
  }

  /** The agent tab bound to a project and thread, or null when it has none.
   *  A preview uses this to decide between navigating the thread's existing tab
   *  and creating its first one, so the answer comes from the browser rather
   *  than from a memo a caller keeps on the side. */
  agentTabFor(projectId: string, threadId: string): string | null {
    return this.agentTabIds.get(browserContextKey(projectId, threadId)) ?? null
  }

  /**
   * The URL a tab is showing right now, or null when it is gone.
   *
   * A preview asks this before loading something, because a page the tab already
   * has open is a page the user is already looking at: reloading it would throw
   * away what they are watching, and a composition that is playing must not be
   * replaced by a still.
   */
  tabUrl(tabId: string): string | null {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return null
    return tab.view.webContents.getURL()
  }

  /**
   * Bring an existing tab to the user.
   *
   * Creating a tab reveals it as a side effect, but showing a page the thread
   * already has open makes no new tab, so nothing would move the sidebar. The
   * renderer already knows how to open or focus a tab from this event, so
   * revealing reuses it rather than adding a second reveal path.
   */
  revealTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.window.webContents.isDestroyed()) return
    sendToRenderer(
      this.window.webContents,
      'browser:openRequested',
      tab.view.webContents.getURL(),
      {
        projectId: tab.projectId,
        threadId: tab.threadId,
        requestedTabId: tabId,
        reveal: true
      }
    )
  }

  /**
   * Wait until a tab is no longer loading, bounded.
   *
   * A capture taken mid-navigation shows a half-painted page, and a page that
   * never finishes (a hung script, an unreachable host) must not hold the caller
   * forever, so the wait ends on stop, failure, or the deadline.
   */
  async waitForTabLoad(tabId: string, timeoutMs = 8_000): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const contents = tab.view.webContents
    if (contents.isDestroyed() || !contents.isLoading()) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        contents.removeListener('did-stop-loading', finish)
        contents.removeListener('did-fail-load', finish)
        resolve()
      }
      // Declared after `finish` closes over it: the deadline cannot fire before
      // this line runs, so the reference is always initialised.
      const timer = setTimeout(finish, timeoutMs)
      contents.once('did-stop-loading', finish)
      contents.once('did-fail-load', finish)
    })
  }

  /**
   * Capture a tab as a small PNG data URL, for a UI preview rather than a model.
   *
   * Distinct from the agent's `screenshot` operation: that one is capped for
   * tokens and skipped when the page has not changed, while a preview wants a
   * fresh picture at the size the panel can show.
   */
  async captureThumbnail(
    tabId: string,
    maxWidth: number
  ): Promise<{ dataUrl: string; width: number; height: number } | null> {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return null
    const captured = await tab.view.webContents.capturePage()
    const source = captured.getSize()
    if (source.width < 1 || source.height < 1) return null
    const target = fitWithin(source.width, source.height, maxWidth)
    const resized =
      target.width !== source.width || target.height !== source.height
        ? captured.resize({ width: target.width, height: target.height })
        : captured
    const size = resized.getSize()
    return {
      dataUrl: `data:image/png;base64,${resized.toPNG().toString('base64')}`,
      width: size.width,
      height: size.height
    }
  }

  /**
   * Draw one exact frame of a composition and settle the page before a capture.
   *
   * A composition owns how a frame is drawn   the render contract is a global
   * function the project defines   so the app calls it and waits rather than
   * reimplementing it. The page is asked to draw the frame itself, then two
   * animation frames are waited out, because a project that redraws from its own
   * loop during a settle would otherwise be captured mid-paint. A project that
   * defines no render function is reported rather than captured as a guess.
   */
  async renderTabFrame(
    tabId: string,
    seconds: number
  ): Promise<{ rendered: boolean; reason?: string }> {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) {
      return { rendered: false, reason: 'the tab is gone' }
    }
    const drawn: unknown = tab.view.webContents.executeJavaScript(`(async () => {
      const transport = globalThis.${COMPOSITION_TRANSPORT_GLOBAL};
      if (transport && typeof transport.freezeAt === 'function') {
        const state = transport.freezeAt(${JSON.stringify(seconds)});
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const failure = state && state.error;
        return failure ? { rendered: false, reason: String(failure) } : { rendered: true };
      }
      const draw = globalThis.cioRenderFrame;
      if (typeof draw !== 'function') {
        return { rendered: false, reason: 'the page defines no cioRenderFrame function' };
      }
      try {
        await draw(${JSON.stringify(seconds)});
      } catch (error) {
        return { rendered: false, reason: String(error) };
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { rendered: true };
    })()`)
    // Bounded, because a page that never settles, or one whose animation frames
    // are throttled because the tab is parked, would leave this outstanding and
    // hang the turn that asked for the frame.
    const expired: unique symbol = Symbol('frame-render-timeout')
    let timer: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<typeof expired>((resolve) => {
      timer = setTimeout(() => resolve(expired), FRAME_RENDER_TIMEOUT_MS)
    })
    let result: unknown
    try {
      result = await Promise.race([drawn, deadline])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
    if (result === expired) {
      return {
        rendered: false,
        reason: `the composition did not settle within ${FRAME_RENDER_TIMEOUT_MS / 1000} seconds`
      }
    }
    if (typeof result !== 'object' || result === null) return { rendered: false }
    const record = result as Record<string, unknown>
    const reason = typeof record['reason'] === 'string' ? record['reason'] : undefined
    return record['rendered'] === true
      ? { rendered: true }
      : { rendered: false, ...(reason ? { reason } : {}) }
  }

  /**
   * Install the playback transport in a composition tab.
   *
   * This is the handover that turns a composition from a page that plays itself
   * into a video: the runtime draws every frame and the panel drives the playhead,
   * so a piece of work can be paused, scrubbed and replayed instead of watched from
   * the start every time it is looked at.
   *
   * Three rules keep the playhead honest, and each of them exists because of a way
   * it was being lost:
   *
   * - A document is armed once, for the timeline it was armed with. Recognition
   *   resolves after the load, so a navigation can be armed from the mark the tab
   *   carried a moment ago and then asked to arm again for the folder it actually
   *   arrived on; without this, the second install restarts the video.
   * - A composition is restored from the playhead saved for *its* folder. A tab
   *   reused for a different composition must not inherit the previous one's
   *   position.
   * - A re-arm of a running document takes its position from the page rather than
   *   from the saved value, which belongs to the document that has already gone.
   *
   * A capture URL is armed frozen rather than played. The runtime still declines the
   * page's own draws, which is what makes the captured frame the frame that was
   * asked for, but it never starts moving and never restores a playhead: the picture
   * is the answer there, not playback.
   */
  private async armCompositionTransport(tabId: string, tab: BrowserTab): Promise<void> {
    const composition = tab.composition
    const contents = tab.view.webContents
    if (!composition || contents.isDestroyed()) return
    const url = contents.getURL()
    // Recognition resolves after the load, so the mark a tab is holding can name the
    // folder it just left. Every served folder keeps its own loopback origin, so the
    // origin is what tells the document in front of us from the one the mark
    // describes: arming on a stale mark would drive this page with another
    // composition's timeline.
    if (originOf(url) !== composition.origin) return
    const frozen = isVideoCaptureUrl(url)
    const generation = tab.navigationGeneration
    const armed = tab.transport
    if (
      armed !== null &&
      armed.generation === generation &&
      armed.url === url &&
      armed.duration === composition.duration &&
      armed.fps === composition.fps
    ) {
      // The same document, already driven by the same timeline.
      return
    }
    // A re-arm of the document that is on screen right now keeps where the user is
    // rather than the position saved for a document that has been replaced.
    const live = armed !== null && armed.url === url ? await this.readPlayhead(tabId) : null
    const result: unknown = await contents.executeJavaScript(
      compositionTransportScript({
        duration: composition.duration,
        fps: composition.fps,
        autoplay: !frozen
      })
    )
    const record =
      typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null
    if (record?.['installed'] !== true) {
      const reason = typeof record?.['reason'] === 'string' ? record['reason'] : 'unknown reason'
      // A folder listing, or a composition whose page has not defined the render
      // function yet, is an ordinary thing to be looking at rather than a fault.
      Logger.dev('Composition playback was not armed:', { tabId, reason })
      return
    }
    // A burst of agent writes reloads a preview more than once, so the document can
    // be replaced while the runtime is being installed. The position then belongs to
    // a document that has gone, and a record naming this one would make the next
    // load believe it was already armed, so neither is kept.
    if (contents.isDestroyed() || tab.navigationGeneration !== generation) return
    tab.transport = { generation, url, duration: composition.duration, fps: composition.fps }
    if (frozen) return
    const playhead = live ?? this.takePlayhead(tabId, composition.directory)
    if (!playhead) return
    await this.sendTransport(tabId, 'seek', playhead.time)
    if (playhead.playing) await this.sendTransport(tabId, 'play', 0)
  }

  /** Arm the transport without letting a playback problem fail a page load. */
  private armCompositionQuietly(tabId: string, tab: BrowserTab): void {
    void this.armCompositionTransport(tabId, tab).catch((error: unknown) => {
      Logger.error('A composition preview could not be armed for playback:', error)
    })
  }

  /**
   * Run one playback action on a composition tab and report the state it left.
   *
   * The page owns the frame, so the answer is read back rather than assumed: a play
   * that ended immediately, or a seek the composition clamped to its own length,
   * shows in the panel exactly as it happened.
   */
  async transport(
    tabId: string,
    command: BrowserTransportCommand,
    value: number | boolean
  ): Promise<BrowserCompositionPlayback | null> {
    const tab = this.requireTab(tabId)
    if (!tab.composition) {
      throw new TypeError('Playback is available on a composition preview only')
    }
    return this.sendTransport(tabId, command, value)
  }

  /**
   * A composition tab's playhead, or null when the tab is not playing one.
   *
   * Read without changing anything, because this is what the panel polls to move the
   * scrubber. A tab that is gone, or is not a composition, answers null rather than
   * throwing: the panel can outlive the tab it was reading.
   */
  async transportState(tabId: string): Promise<BrowserCompositionPlayback | null> {
    const tab = this.tabs.get(tabId)
    if (!tab || !tab.composition || tab.view.webContents.isDestroyed()) return null
    const result: unknown = await tab.view.webContents.executeJavaScript(
      compositionTransportStateScript()
    )
    return toCompositionPlayback(result)
  }

  private async sendTransport(
    tabId: string,
    command: BrowserTransportCommand,
    value: number | boolean
  ): Promise<BrowserCompositionPlayback | null> {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return null
    const result: unknown = await tab.view.webContents.executeJavaScript(
      compositionTransportCommandScript(command, value)
    )
    return toCompositionPlayback(result)
  }

  /**
   * Run one claimed browser action on a tab.
   *
   * The actions split by owner: what acts on the page happens here, and what
   * acts on the tab strip (focusing the address bar, closing or opening a tab)
   * is forwarded to the renderer, which is the only side that knows the strip.
   * Saving is asynchronous because the save dialog is, and it must never block
   * the key event that asked for it.
   */
  private runBrowserShortcut(tabId: string, action: BrowserShortcutAction): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return
    const contents = tab.view.webContents
    switch (action) {
      case 'reload':
        contents.reload()
        return
      case 'hardReload':
        contents.reloadIgnoringCache()
        return
      case 'back':
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
        return
      case 'forward':
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
        return
      case 'zoomIn':
        this.stepTabZoom(contents, ZOOM_STEP)
        return
      case 'zoomOut':
        this.stepTabZoom(contents, -ZOOM_STEP)
        return
      case 'zoomReset':
        contents.setZoomLevel(0)
        return
      case 'toggleDevTools':
        this.toggleTabDevTools(tab)
        return
      case 'savePage':
        void this.saveTabPage(tab)
        return
      case 'focusAddress':
      case 'closeTab':
      case 'newTab':
        this.requestPanelShortcut(tabId, PANEL_SHORTCUT_TARGETS[action])
        return
    }
  }

  /** Ask the renderer to act on the tab strip, which only the renderer owns. */
  private requestPanelShortcut(tabId: string, action: BrowserPanelShortcutAction): void {
    if (this.window.webContents.isDestroyed()) return
    sendToRenderer(this.window.webContents, 'browser:panelShortcut', tabId, action)
  }

  /**
   * Resolve a key pressed while the browser toolbar holds DOM focus.
   *
   * That key goes to the app renderer, so the window-level interception is the
   * only place it can be claimed before the application menu acts on it. Called
   * from `before-input-event` on the window's web contents; when it answers true
   * the caller prevents the event, which the renderer, the page and the menu all
   * then never see.
   */
  consumeChromeShortcut(event: Electron.Event, input: Electron.Input): boolean {
    const tabId = this.focusedChromeTabId
    if (!tabId) return false
    const action = matchBrowserShortcut(input, this.shortcutBindings)
    if (!action) return false
    event.preventDefault()
    this.runBrowserShortcut(tabId, action)
    return true
  }

  /** Toggle the web page's own DevTools. Returns whether it is now open. */
  private toggleTabDevTools(tab: BrowserTab): boolean {
    const contents = tab.view.webContents
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools()
      return false
    }
    // Plain native behavior: default dock inside the window, resizable
    // there, fully undockable from DevTools' own controls.
    contents.openDevTools()
    return true
  }

  /** Step one tab's zoom, clamped to Chromium's own range. */
  private stepTabZoom(contents: WebContents, step: number): void {
    const next = Math.min(MAX_ZOOM_LEVEL, Math.max(-MAX_ZOOM_LEVEL, contents.getZoomLevel() + step))
    contents.setZoomLevel(next)
  }

  /**
   * Save the page to a file the user picks.
   *
   * Chromium writes the page as it stands (markup plus its resources) rather
   * than the raw response, which is what Chrome's own "Web page, complete"
   * does and the only useful answer for a page a script rendered. A refusal or a
   * write failure has no UI of its own, so it is reported as an app toast
   * instead of leaving the user with a key that silently did nothing.
   */
  private async saveTabPage(tab: BrowserTab): Promise<void> {
    const contents = tab.view.webContents
    if (contents.isDestroyed() || this.window.isDestroyed()) return
    const title = contents.getTitle() || contents.getURL()
    const { canceled, filePath } = await dialog.showSaveDialog(this.window, {
      title: 'Save page',
      defaultPath: join(app.getPath('downloads'), `${safeBasename(title)}.html`),
      filters: [{ name: 'Web page, complete', extensions: ['html'] }]
    })
    if (canceled || !filePath) return
    if (contents.isDestroyed()) return
    try {
      await contents.savePage(filePath, 'HTMLComplete')
    } catch (error: unknown) {
      Logger.error('Browser page could not be saved:', error)
      if (this.window.webContents.isDestroyed()) return
      sendToRenderer(this.window.webContents, 'app:toast', {
        message: 'This page could not be saved to that file.',
        type: 'error'
      })
    }
  }

  private ensureTab(tabId: string, projectId: string, threadId: string): BrowserTab {
    const existing = this.tabs.get(tabId)
    if (existing) {
      if (existing.projectId !== projectId || existing.threadId !== threadId) {
        throw new Error('Browser tab belongs to a different project or thread')
      }
      return existing
    }

    const browserSession = this.sessionForProject(projectId)

    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: true
      }
    })
    view.setBackgroundColor('#00000000')
    const tab: BrowserTab = {
      view,
      projectId,
      threadId,
      initialNavigationStarted: false,
      consoleEntries: [],
      favicon: null,
      viewport: { ...DEFAULT_PARKED_VIEWPORT },
      design: null,
      composition: null,
      transport: null,
      navigationGeneration: 0
    }
    this.tabs.set(tabId, tab)

    const publish = (): void => this.publishState(tabId)
    // A key pressed in the page reaches this view's web contents and nothing
    // else in the app, so this is where the browser claims its own shortcuts.
    // Preventing the event also prevents the application menu from acting on
    // the key, which is what keeps Cmd/Ctrl+R from reloading the whole app (in
    // a development build the menu is Electron's default one) and Cmd/Ctrl+W
    // from closing its window.
    view.webContents.on('before-input-event', (event, input) => {
      const action = matchBrowserShortcut(input, this.shortcutBindings)
      if (!action) return
      event.preventDefault()
      this.runBrowserShortcut(tabId, action)
    })
    // Audio the page emits is a tab-level fact the strip renders, so the state
    // event follows it the same way it follows a title or favicon change.
    view.webContents.on('audio-state-changed', publish)
    // The document is parsed at dom-ready, which is the earliest point at which
    // the capture observer can be installed before the page's own scripts ask
    // for the microphone.
    view.webContents.on('dom-ready', () => {
      this.capture.reset(tabId)
      this.watchCaptureMainFrame(tabId, view.webContents)
      publish()
    })
    view.webContents.on('did-finish-load', () => {
      this.injectDialogContext(tabId)
      // The dom-ready install can race the document it runs in; watching again is
      // idempotent per frame and covers that case.
      this.watchCaptureMainFrame(tabId, view.webContents)
      // A composition is armed on the document that just arrived, which is what
      // covers a preview reloading itself: the folder is recognised on the
      // navigation, and the playback runtime is installed here.
      if (tab.composition) this.armCompositionQuietly(tabId, tab)
    })
    view.webContents.on(
      'did-frame-finish-load',
      (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame) return
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
        if (frame) {
          this.injectDialogContext(tabId, frame)
          // A recorder embedded in an iframe is a capture of this tab too.
          this.capture.watch(tabId, frame)
        }
      }
    )
    view.webContents.on('devtools-opened', publish)
    view.webContents.on('devtools-closed', publish)
    view.webContents.on('did-start-loading', publish)
    view.webContents.on('did-stop-loading', () => {
      publish()
      // The safety net for a mark that resolved while the document was still
      // arriving, which `did-finish-load` cannot see because recognition is
      // asynchronous. Arming is idempotent, so this costs nothing when the load's
      // own arm already happened.
      if (tab.composition) this.armCompositionQuietly(tabId, tab)
    })
    view.webContents.on('did-navigate', () => {
      // A new document starts without an icon; the old site's favicon must not linger.
      tab.favicon = null
      // Capture state belongs to the document that ended here, so the tab must
      // not keep claiming it is recording until the new page says otherwise.
      this.capture.reset(tabId)
      // The inspector lives in the document that ended here. Its desired mode is
      // kept (a live preview reloads itself mid-session), but the outstanding
      // event promise is void and the next arm installs into the new document.
      this.inspector.reset(tabId)
      // Recognition is decided from the page that just committed, not from a record
      // of who opened the tab last: that is what keeps a design a design across a
      // restart, and what covers a tab the agent opened itself.
      // Whatever runtime the document that just ended had went with it, and the
      // next document is a new one even when it is the same URL loaded again.
      tab.navigationGeneration += 1
      tab.transport = null
      this.refreshTabMark(tabId, tab)
      // The dialog shim lived in the document that just went away, so the next
      // report has to install it again rather than trust the old record.
      this.injectedDialogLabels.delete(tabId)
      publish()
    })
    view.webContents.on('did-navigate-in-page', publish)
    view.webContents.on('page-title-updated', publish)
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      const source = favicons.find((candidate) => candidate.length > 0) ?? null
      if (!source) return
      // Electron reports icon URLs, but remote images are blocked by the
      // renderer CSP   convert to a data URL so any consumer can render it.
      void fetchIconAsDataUrl(source).then((favicon) => {
        if (!favicon || tab.favicon === favicon) return
        tab.favicon = favicon
        publish()
      })
    })
    view.webContents.on('console-message', (details) => {
      this.appendConsoleEntry(tabId, {
        level: details.level,
        message: details.message,
        sourceId: details.sourceId,
        lineNumber: details.lineNumber
      })
    })
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return
        // The failed navigation can still commit an error document, which has no
        // shim of its own, so the record of what is installed must not survive it.
        this.injectedDialogLabels.delete(tabId)
        this.appendConsoleEntry(tabId, {
          level: 'error',
          message: `Navigation failed (${errorCode}): ${errorDescription}`,
          sourceId: validatedURL,
          lineNumber: 0
        })
      }
    )
    view.webContents.on('render-process-gone', (_event, details) => {
      // The recovered document is brand new and may not report a navigation
      // commit, so nothing about the dead document's injection may be trusted.
      this.injectedDialogLabels.delete(tabId)
      this.appendConsoleEntry(tabId, {
        level: 'error',
        message: `Browser renderer stopped: ${details.reason} (exit ${details.exitCode})`,
        sourceId: view.webContents.getURL(),
        lineNumber: 0
      })
    })
    view.webContents.on('will-navigate', (event, url) => {
      try {
        validateBrowserUrl(url)
      } catch {
        event.preventDefault()
      }
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const safeUrl = validateBrowserUrl(url)
        const popupTabId = `browser:${crypto.randomUUID()}`
        const popupTab = this.ensureTab(popupTabId, tab.projectId, tab.threadId)
        popupTab.initialNavigationStarted = true
        // Park it like every other tab: a popup the user never goes on to view
        // must still load and run.
        this.parkTab(popupTabId)
        this.load(popupTabId, safeUrl)
        sendToRenderer(this.window.webContents, 'browser:openRequested', safeUrl, {
          projectId: tab.projectId,
          threadId: tab.threadId,
          requestedTabId: popupTabId,
          reveal: true
        })
      } catch (error) {
        Logger.error('Browser popup rejected unsafe URL:', error)
      }
      return { action: 'deny' }
    })
    return tab
  }

  private requireTab(tabId: string): BrowserTab {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Browser tab does not exist')
    return tab
  }

  /** Install the capture observer into a tab's main frame. Called again after
   *  every navigation, because an observer lives in one document's world. */
  private watchCaptureMainFrame(tabId: string, contents: WebContents): void {
    if (contents.isDestroyed()) return
    this.capture.watch(tabId, contents.mainFrame)
  }

  private sessionForProject(projectId: string): Session {
    const partition = `${BROWSER_PARTITION_PREFIX}${projectId}`
    const browserSession = session.fromPartition(partition)
    if (this.configuredSessions.has(partition)) return browserSession
    const grants = new Set<string>()
    const denies = new Set<string>()
    this.permissionGrants.set(partition, grants)
    this.permissionDenies.set(partition, denies)
    browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      const origin = permissionOrigin(requestingOrigin)
      if (!origin) return false
      const key = permissionCheckKey(origin, permission, Reflect.get(details, 'mediaType'))
      // A remembered "Don't allow" wins over any cached grant for the same key.
      return !denies.has(key) && grants.has(key)
    })
    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const tabEntry = [...this.tabs.entries()].find(
        ([, tab]) => tab.projectId === projectId && tab.view.webContents.id === contents.id
      )
      const requestingUrl = Reflect.get(details, 'requestingUrl')
      const securityOrigin = Reflect.get(details, 'securityOrigin')
      const origin = permissionOrigin(
        typeof requestingUrl === 'string' && requestingUrl.length > 0
          ? requestingUrl
          : typeof securityOrigin === 'string' && securityOrigin.length > 0
            ? securityOrigin
            : contents.getURL()
      )
      if (!tabEntry || !origin || this.window.webContents.isDestroyed()) {
        callback(false)
        return
      }
      const [tabId] = tabEntry
      const tab = tabEntry[1]
      const id = crypto.randomUUID()
      const rawMediaTypes: unknown = Reflect.get(details, 'mediaTypes')
      const mediaTypes = Array.isArray(rawMediaTypes)
        ? rawMediaTypes.filter((value): value is string => typeof value === 'string')
        : []
      const request: BrowserPermissionRequest = {
        id,
        tabId,
        projectId,
        origin,
        permission,
        mediaTypes
      }
      // Electron calls this handler for every request even when the check
      // handler already answered, so the remembered decision is the gate here:
      // a remembered "Don't allow" refuses silently, and a decision that
      // already covers the request grants silently instead of prompting the
      // user for a permission they have given before.
      const partition = `${BROWSER_PARTITION_PREFIX}${projectId}`
      const outcome = rememberedPermissionOutcome(
        permissionGrantKeys(request),
        this.permissionGrants.get(partition),
        this.permissionDenies.get(partition)
      )
      if (outcome === 'deny') {
        callback(false)
        return
      }
      if (outcome === 'grant') {
        callback(true)
        return
      }
      const timer = setTimeout(
        () => this.resolvePermission(id, permissionResolutions.dismiss),
        PERMISSION_TIMEOUT_MS
      )
      this.pendingPermissions.set(id, { request, callback, timer })
      // Native OS popup composites above the WebContentsView: the page stays
      // live and interactive while the prompt is on screen.
      const context: PromptRequestContext = {
        request,
        queueSize: this.pendingPermissions.size,
        projectLabel: this.permissionLabel(tab)
      }
      this.promptWindow.show(context, this.promptAnchor())
    })
    browserSession.on('will-download', (event, item, contents) => {
      this.downloadTracker.handleDownload(projectId, item, contents.id)
    })
    this.configuredSessions.add(partition)
    return browserSession
  }

  /** The live grant/deny ledgers the permission handlers read and write. */
  private permissionLedgers(): {
    grants: Map<string, Set<string>>
    denies: Map<string, Set<string>>
  } {
    return { grants: this.permissionGrants, denies: this.permissionDenies }
  }

  /** Persist the ledgers after a decision. Writes are rare (one per user
   *  answer), so they go straight to disk and never block the handler. */
  private persistPermissionMemory(): void {
    void this.permissionMemory.save(this.permissionLedgers()).catch((error: unknown) => {
      Logger.error('Browser permission memory could not be saved:', error)
    })
  }

  /** Dismiss every pending permission prompt that belongs to a project. */
  private dismissProjectPermissions(projectId: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.request.projectId === projectId)
        this.resolvePermission(requestId, permissionResolutions.dismiss)
    }
  }

  /** Forget every remembered permission grant or denial for a project. */
  private clearProjectPermissionMemory(projectId: string): void {
    const partition = `${BROWSER_PARTITION_PREFIX}${projectId}`
    this.permissionGrants.get(partition)?.clear()
    this.permissionDenies.get(partition)?.clear()
    this.persistPermissionMemory()
  }

  private resolvePermission(requestId: string, resolution: PermissionResolution): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingPermissions.delete(requestId)
    if (resolution.rememberGrant || resolution.rememberDeny) {
      const partition = `${BROWSER_PARTITION_PREFIX}${pending.request.projectId}`
      const grants = this.permissionGrants.get(partition)
      const denies = this.permissionDenies.get(partition)
      for (const key of permissionGrantKeys(pending.request)) {
        if (resolution.rememberDeny) {
          grants?.delete(key)
          denies?.add(key)
        } else if (resolution.rememberGrant) {
          denies?.delete(key)
          grants?.add(key)
        }
      }
      this.persistPermissionMemory()
    }
    pending.callback(resolution.granted)
    // Show the next queued request, or drop the prompt when the queue is empty.
    const next = this.pendingPermissions.values().next()
    if (next.done) {
      this.promptWindow.hide()
      return
    }
    const nextTab = this.tabs.get(next.value.request.tabId)
    this.promptWindow.show(
      {
        request: next.value.request,
        queueSize: this.pendingPermissions.size,
        projectLabel: nextTab ? this.permissionLabel(nextTab) : null
      },
      this.promptAnchor()
    )
  }

  /** Content-anchored placement data for the permission popup: the active tab's
   *  last known view bounds, or nothing when no tab is on screen. */
  private promptAnchor(): { x: number; y: number; width: number } | null {
    const bounds = this.activeTabBounds
    return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width } : null
  }

  /** Resolve the "<project> - <thread>" context line for a tab's dialogs, or
   *  null when either record is missing (native dialog then stays untouched). */
  private dialogLabel(tab: BrowserTab): string | null {
    let project: Project | null
    let thread: Thread | null
    try {
      project = this.projects.get(tab.projectId)
      thread = this.threads.get(tab.threadId)
    } catch (error: unknown) {
      Logger.error('Browser dialog context lookup failed:', error)
      return null
    }
    if (!project || !thread) return null
    const name = project.name.trim()
    const title = thread.title.trim()
    if (!name || !title) return null
    const label = `${name} - ${title}`
    return label.length > MAX_DIALOG_LABEL_LENGTH
      ? `${label.slice(0, MAX_DIALOG_LABEL_LENGTH)}…`
      : label
  }

  /** Resolve the requester label for permission prompts: "<project> - <thread>"
   *  when both records exist, the project name alone when only the project
   *  does, and null when the request cannot be tied to a project (the popup
   *  then shows just the requesting website). */
  private permissionLabel(tab: BrowserTab): string | null {
    let project: Project | null
    let thread: Thread | null
    try {
      project = this.projects.get(tab.projectId)
      thread = this.threads.get(tab.threadId)
    } catch (error: unknown) {
      Logger.error('Browser permission label lookup failed:', error)
      return null
    }
    if (!project) return null
    const name = project.name.trim()
    const title = thread?.title.trim() ?? ''
    const label = title ? `${name} - ${title}` : name
    if (!label) return null
    return label.length > MAX_DIALOG_LABEL_LENGTH
      ? `${label.slice(0, MAX_DIALOG_LABEL_LENGTH)}…`
      : label
  }

  /** Install the labeled alert/confirm shim into a document's JS context.
   *  Chromium renders page dialogs as native windows parented to the app
   *  window and carries no context about which CodeInOven thread owns the
   *  page, so every loaded frame gets a wrapper that prefixes the dialog
   *  message with "<project> - <thread> <Alert|Confirm>" followed by the
   *  page's own text. Injection is idempotent per document: re-injection
   *  (after thread renames or replays) rewraps the same original callables
   *  instead of stacking prefixes. `prompt()` is left untouched because
   *  Electron never renders it. */
  private injectDialogContext(tabId: string, frame?: WebFrameMain): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const label = this.dialogLabel(tab)
    if (!label) return
    const script = dialogContextScript(label)
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    if (frame) {
      this.runDialogScript(frame, script)
      return
    }
    // The shim installs itself once per document and rewraps the same original
    // callables on repeat, so a document that already carries this label has
    // nothing to gain from another pass. Callers include the renderer's per-frame
    // alignment reporting, where a repeat is a script evaluation into every frame
    // of the page for no change. A new document clears the record (see the
    // `did-navigate` handler), and a renamed project or thread changes the label,
    // so both still re-install it.
    if (this.injectedDialogLabels.get(tabId) === label) return
    let frames: readonly WebFrameMain[]
    try {
      frames = contents.mainFrame.framesInSubtree
    } catch {
      // Between documents there is no frame tree to inject into.
      return
    }
    for (const candidate of frames) this.runDialogScript(candidate, script)
    this.injectedDialogLabels.set(tabId, label)
  }

  private runDialogScript(frame: WebFrameMain, script: string): void {
    if (frame.isDestroyed()) return
    void frame.executeJavaScript(script).catch(() => {
      // Frames can be replaced mid-navigation; the shim installs on the next
      // frame load, so a failed injection here is harmless.
    })
  }

  private load(tabId: string, url: string): void {
    const tab = this.requireTab(tabId)
    // Where a composition was is read before the document is replaced, so a capture
    // round trip does not send the user back to the first frame, and the ordering
    // cannot depend on which IPC the renderer happens to handle first.
    if (tab.composition && !tab.view.webContents.isDestroyed()) {
      void this.rememberPlayhead(tabId, tab).then(
        () => this.navigateTo(tabId, url),
        () => this.navigateTo(tabId, url)
      )
      return
    }
    this.navigateTo(tabId, url)
  }

  /** Start one navigation, reporting a failure rather than rejecting. */
  private navigateTo(tabId: string, url: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return
    void tab.view.webContents.loadURL(url).catch((error: unknown) => {
      Logger.dev('Browser navigation did not complete:', { tabId, url, error })
      this.publishState(tabId)
    })
  }

  /** Open the native page context menu. The OS popup composites above the
   *  WebContentsView, so the page never has to detach for the menu. */
  private showPageMenu(tabId: string, x: number, y: number): void {
    if (this.window.isDestroyed()) return
    const contents = this.requireTab(tabId).view.webContents
    const menu = new Menu()
    menu.append(
      new MenuItem({
        label: 'Reload (keeps cache)',
        click: () => {
          if (!contents.isDestroyed()) contents.reload()
        }
      })
    )
    menu.append(
      new MenuItem({
        label: 'Hard reload (ignores cache)',
        click: () => {
          if (!contents.isDestroyed()) contents.reloadIgnoringCache()
        }
      })
    )
    menu.popup({ window: this.window, x, y })
  }

  private stateFor(tabId: string, tab: BrowserTab): BrowserPageState {
    const contents = tab.view.webContents
    return {
      tabId,
      url: contents.getURL(),
      title: contents.getTitle(),
      favicon: tab.favicon,
      loading: contents.isLoading(),
      // Read from the view rather than cached: these drive the tab's speaker and
      // recording indicators, and a muted tab that the page itself unmuted must
      // report the mute state that is actually in force.
      audible: contents.isCurrentlyAudible(),
      muted: contents.isAudioMuted(),
      capturing: this.capture.isCapturing(tabId),
      design: tab.design,
      composition: tab.composition,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward()
    }
  }

  private utilityTabContext(
    tabId: string,
    tab: BrowserTab
  ): {
    tabId: string
    projectId: string
    threadId: string
  } {
    return { tabId, projectId: tab.projectId, threadId: tab.threadId }
  }

  private publishState(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.window.webContents.isDestroyed()) return
    sendToRenderer(this.window.webContents, 'browser:state', this.stateFor(tabId, tab))
    sendToRenderer(
      this.window.webContents,
      'browser:devToolsChanged',
      this.devToolsStateFor(tabId, tab)
    )
  }

  private devToolsStateFor(tabId: string, tab: BrowserTab): BrowserDevToolsState {
    return { tabId, open: tab.view.webContents.isDevToolsOpened() }
  }

  private appendConsoleEntry(
    tabId: string,
    input: {
      level: BrowserConsoleLevel
      message: string
      sourceId: string
      lineNumber: number
    }
  ): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const entry: BrowserConsoleEntry = {
      id: `${Date.now()}:${this.consoleSequence++}`,
      tabId,
      level: input.level,
      message: input.message.slice(0, 10_000),
      sourceId: input.sourceId.slice(0, 2_048),
      lineNumber: Math.max(0, input.lineNumber),
      timestamp: Date.now()
    }
    tab.consoleEntries = [...tab.consoleEntries, entry].slice(-MAX_CONSOLE_ENTRIES)
  }

  /**
   * Detach the native view when the app renderer goes away, so a reload can never
   * leave the browser floating over the app.
   *
   * The renderer is the only thing that knows which tab belongs on screen and at
   * which frame, and the compositor paints the view ABOVE every DOM surface. A
   * reload throws that knowledge away (the full screen browser is renderer state,
   * and the sidebar browser starts hidden), while the view stays parented to the
   * app window at the last frame it was given. Main only ever moves a view on the
   * next `browser:show`, so without this the frame the user was looking at keeps
   * covering the window and swallowing every click, with no DOM surface left that
   * would ever ask for a different frame.
   *
   * The tab itself is kept alive and parked offscreen, exactly as if the user had
   * left it, and the next renderer re-attaches it when it reports a frame. A
   * crashed renderer is handled the same way: nothing will report a frame again
   * until Electron reloads it, and an inert app must not sit under a live page.
   */
  private guardAgainstStrandedView(): void {
    const contents = this.window.webContents
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.detachDisplayedView()
    })
    contents.on('render-process-gone', () => this.detachDisplayedView())
  }

  /**
   * Take the view off the app window without touching a tab the stage already
   * released: reviving an inert tab would spend frames on a page nobody is
   * looking at, which is the state `enforceParkedCap` deliberately created. The
   * window's own child list is the authority on what is on screen, so this
   * cannot strand a view that no record happens to mention.
   */
  private detachDisplayedView(): void {
    // The toast hold is published by DOM that a reload or a crash has taken with
    // it, so keeping it would strand the browser offscreen for a toast that no
    // longer exists.
    this.toastVisible = false
    const parented = new Set(this.window.contentView.children)
    for (const [tabId, tab] of this.tabs) {
      if (parented.has(tab.view)) this.parkTab(tabId)
    }
  }

  /**
   * Park a tab in an invisible stage window, where it keeps a real viewport and
   * keeps producing frames no matter what the user is looking at. `size`
   * overrides the tab's parked viewport for callers that must preserve the exact
   * viewport the user was seeing (the toast case).
   */
  private parkTab(tabId: string, size?: BrowserViewport, keepActive = false): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return
    const viewport = size ?? tab.viewport
    this.window.contentView.removeChildView(tab.view)
    // The view is leaving the window, so whatever frame it was displayed at no
    // longer describes where it is.
    if (this.displayedTab?.tabId === tabId) this.displayedTab = null
    this.stage.park(tab.view, viewport)
    this.markParked(tabId)
    if (this.activeTabId === tabId && !keepActive) {
      this.activeTabId = null
      this.activeTabBounds = null
    }
    this.enforceParkedCap(tabId)
    // A stage window the window server stopped showing would silently freeze the
    // page (that is how a parked view dies), so confirm it once per park and hand
    // the tab a fresh window if it did not take. Fire and forget: parking must
    // not block the caller.
    void this.stage.verifyVisible(tab.view).then((visible) => {
      if (visible || !this.stage.isParked(tab.view)) return
      Logger.dev('Reparking a browser tab whose stage window stopped rendering', { tabId })
      this.stage.restart(tab.view, this.tabs.get(tabId)?.viewport ?? viewport)
    })
  }

  /** Mount the current active tab in the app window at its display bounds. */
  private showActiveView(): void {
    if (!this.activeTabId || this.toastVisible) return
    const tabId = this.activeTabId
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return
    const bounds = this.activeTabBounds
    const displayed = this.displayedTab
    // Both records must agree before a repeat can be skipped. The stage's parked
    // set is the authority on a view that is offscreen, and the stage re-parks
    // views on its own when it has to rebuild its stage window, which can land
    // between two of the renderer's per-frame reports. A view the stage holds has
    // to be re-parented, so this re-attaches rather than trusting `displayedTab`
    // alone; skipping here would leave it parked with nothing that ever recovers
    // it.
    if (displayed !== null && displayed.tabId === tabId && !this.stage.isParked(tab.view)) {
      // Already mounted: only a moved frame needs a native call, so the entry
      // loop's repeats cost one bounds comparison each instead of a re-parent.
      this.forgetParked(tabId)
      if (bounds !== null && !isSameBounds(displayed.bounds, bounds)) {
        this.displayedTab = { tabId, bounds }
        tab.view.setBounds(bounds)
      }
      return
    }
    this.stage.release(tab.view)
    this.forgetParked(tabId)
    this.window.contentView.addChildView(tab.view)
    if (bounds !== null) {
      this.displayedTab = { tabId, bounds }
      tab.view.setBounds(bounds)
    }
  }

  private markParked(tabId: string): void {
    this.forgetParked(tabId)
    this.parkedOrder.push(tabId)
  }

  private forgetParked(tabId: string): void {
    const index = this.parkedOrder.indexOf(tabId)
    if (index >= 0) this.parkedOrder.splice(index, 1)
  }

  /** Keep an agent's working tab from being evicted ahead of idle parked tabs. */
  private touchParkedTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab && this.stage.isParked(tab.view)) this.markParked(tabId)
  }

  /**
   * Cap how many tabs render offscreen at once. Every parked tab renders like a
   * displayed one, so an unbounded parked set would burn CPU and battery for
   * pages nobody is using. The oldest parked tab loses its stage window and goes
   * inert; the next operation on it parks it again.
   */
  private enforceParkedCap(keep: string): void {
    while (this.parkedOrder.length > MAX_PARKED_TABS) {
      const candidate = this.parkedOrder.find((id) => id !== keep && id !== this.activeTabId)
      if (candidate === undefined) return
      this.forgetParked(candidate)
      const tab = this.tabs.get(candidate)
      if (tab) this.stage.release(tab.view)
    }
  }

  /** Remember that the agent asked for this tab to be brought to the user. */
  private rememberReveal(tabId: string, threadId: string): void {
    const now = Date.now()
    for (const [id, reveal] of this.agentReveals) {
      if (now - reveal.at > AGENT_REVEAL_GRACE_MS) this.agentReveals.delete(id)
    }
    this.agentReveals.set(tabId, { threadKey: threadId, at: now, shown: false })
  }

  /** The revealed tab reached the user's screen, so leaving it now says
   *  something about the reveal. */
  private markRevealShown(tabId: string): void {
    const reveal = this.agentReveals.get(tabId)
    if (reveal) reveal.shown = true
  }

  /**
   * A reveal the user saw and then left within the grace window was not welcome.
   * Two of those in a row make the agent's next opens mount offscreen silently
   * for a cooldown, so an agent cannot keep pulling the user away from what they
   * were doing. Nothing is shown in the UI about it.
   */
  private noteDepartedReveal(tabId: string): void {
    const reveal = this.agentReveals.get(tabId)
    if (!reveal) return
    this.agentReveals.delete(tabId)
    const now = Date.now()
    if (now - reveal.at > AGENT_REVEAL_GRACE_MS) return
    // A reveal the user never saw was not refused: the renderer hides a tab for
    // reasons that have nothing to do with the user leaving it (a full-window
    // surface taking over, a stale-attach guard, the sidebar changing region).
    if (!reveal.shown) return
    const previous = this.abandonedReveals.get(reveal.threadKey)
    // Only consecutive ignores count, so an old one cannot combine with a new
    // one days later to mute a thread.
    const count = previous && now - previous.at <= RELAX_COOLDOWN_MS ? previous.count + 1 : 1
    if (count < MAX_ABANDONED_REVEALS) {
      this.abandonedReveals.set(reveal.threadKey, { count, at: now })
      return
    }
    this.abandonedReveals.delete(reveal.threadKey)
    this.relaxedUntil.set(reveal.threadKey, now + RELAX_COOLDOWN_MS)
  }

  private isRelaxed(threadId: string): boolean {
    const until = this.relaxedUntil.get(threadId)
    if (until === undefined) return false
    if (Date.now() >= until) {
      this.relaxedUntil.delete(threadId)
      return false
    }
    return true
  }

  /** Pull a tab out of the app window while a toast is on screen and put it back
   *  afterwards, so the DOM toast composites normally without the page losing
   *  its viewport. */
  private setToastVisible(visible: boolean): void {
    this.toastVisible = visible
    if (!this.activeTabId) return
    const tab = this.tabs.get(this.activeTabId)
    if (!tab) return
    if (visible) {
      this.parkTab(
        this.activeTabId,
        this.activeTabBounds ?? { width: tab.viewport.width, height: tab.viewport.height },
        true
      )
      return
    }
    this.showActiveView()
  }

  private destroy(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.request.tabId === tabId)
        this.resolvePermission(requestId, permissionResolutions.dismiss)
    }
    if (this.activeTabId === tabId) {
      this.activeTabId = null
      this.activeTabBounds = null
    }
    if (this.displayedTab?.tabId === tabId) this.displayedTab = null
    // A destroyed tab can no longer hold the keyboard, so its toolbar must not
    // stay the tab the window-level interception routes to.
    if (this.focusedChromeTabId === tabId) this.focusedChromeTabId = null
    this.injectedDialogLabels.delete(tabId)
    this.forgetParked(tabId)
    this.agentReveals.delete(tabId)
    this.lastScreenshot.delete(tabId)
    this.playheads.delete(tabId)
    this.capture.forget(tabId)
    this.inspector.forget(tabId)
    this.stage.release(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.tabs.delete(tabId)
    for (const [contextKey, agentTabId] of this.agentTabIds) {
      if (agentTabId === tabId) this.agentTabIds.delete(contextKey)
    }
  }

  private requiredInputString(
    input: Record<string, unknown>,
    field: string,
    allowEmpty = false
  ): string {
    const value = input[field]
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 8192) {
      throw new TypeError(`${field} must be a string${allowEmpty ? '' : ' with content'}`)
    }
    return value
  }
}

/**
 * Read a transport state out of what a composition page answered, or null when it
 * answered nothing usable.
 *
 * The page is a separate document whose shape the app does not control, so every
 * field is checked rather than trusted. A missing or malformed answer is the same
 * as no transport being armed, which is what a tab showing a normal site reports.
 */
function toCompositionPlayback(value: unknown): BrowserCompositionPlayback | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const time = record['time']
  const duration = record['duration']
  if (typeof time !== 'number' || !Number.isFinite(time)) return null
  if (typeof duration !== 'number' || !Number.isFinite(duration)) return null
  const error = record['error']
  return {
    time: Math.max(0, time),
    duration: Math.max(0, duration),
    playing: record['playing'] === true,
    loop: record['loop'] === true,
    error:
      typeof error === 'string' && error.length > 0
        ? error.slice(0, MAX_TRANSPORT_ERROR_LENGTH)
        : null
  }
}
