import {
  BrowserWindow,
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
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { Project, Thread } from '../../lib/types'
import { isPreviewOriginUrl } from '../../lib/local-development-url'
import type {
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserDevToolsState,
  BrowserPageState,
  BrowserPermissionRequest,
  BrowserViewBounds
} from '../../lib/ipc-contract'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'
import { fetchIconAsDataUrl } from '../editor/favicon-service'
import { PermissionPromptWindow, type PromptRequestContext } from './permission-prompt-window'
import { BrowserDownloadTracker } from './browser-service/browser-downloads'
import { BrowserCaptureObserver } from './browser-service/browser-capture'
import { BrowserSiteDataService } from './browser-service/browser-site-data'
import { dialogContextScript } from './browser-service/browser-dialog-context'
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
  MAX_ABANDONED_REVEALS,
  MAX_CONSOLE_ENTRIES,
  MAX_DIALOG_LABEL_LENGTH,
  MAX_PARKED_TABS,
  PERMISSION_TIMEOUT_MS,
  RELAX_COOLDOWN_MS,
  browserContextKey,
  isSameBounds,
  validateAttention,
  validateBounds,
  validateBoundedHost,
  validateBrowserUrl,
  validateDownloadId,
  validateOptionalBrowserUrl,
  validatePermissionDecision,
  validatePermissionRequestId,
  validateProjectId,
  validateSiteDataScopes,
  validateSiteMenuPoint,
  validateTabId,
  validateThreadId,
  validateViewportRequest
} from './browser-service/browser-validation'
import type { BrowserViewport } from './browser-service/browser-types'

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
  private readonly siteData: BrowserSiteDataService
  private readonly permissionMemory: BrowserPermissionMemory
  private readonly promptWindow: PermissionPromptWindow
  private readonly projects: ProjectRepo
  private readonly threads: ThreadRepo
  /** Invisible windows that keep non-displayed tabs alive offscreen. */
  private readonly stage: BrowserTabStage
  private activeTabId: string | null = null
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
    ipcMain.handle('browser:toggleDevTools', (_event, rawTabId) => {
      const tab = this.requireTab(validateTabId(rawTabId))
      const contents = tab.view.webContents
      if (contents.isDevToolsOpened()) {
        contents.closeDevTools()
        return false
      }
      // Plain native behavior: default dock inside the window, resizable
      // there, fully undockable from DevTools' own controls.
      contents.openDevTools()
      return true
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
    this.downloadTracker.dispose()
    this.capture.dispose()
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
      const image = await tab.view.webContents.capturePage()
      return {
        ...utilityContext,
        dataUrl: `data:image/png;base64,${image.toPNG().toString('base64')}`
      }
    }
    if (operation === 'console') {
      return { ...utilityContext, entries: [...tab.consoleEntries] }
    }
    throw new Error(`In-app browser does not expose the operation "${operation}"`)
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
    for (const tab of this.tabs.values()) {
      const contents = tab.view.webContents
      if (contents.isDestroyed()) continue
      if (!isPreviewOriginUrl(contents.getURL(), origin)) continue
      contents.reload()
      reloaded += 1
    }
    return reloaded
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
      viewport: { ...DEFAULT_PARKED_VIEWPORT }
    }
    this.tabs.set(tabId, tab)

    const publish = (): void => this.publishState(tabId)
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
    view.webContents.on('did-stop-loading', publish)
    view.webContents.on('did-navigate', () => {
      // A new document starts without an icon; the old site's favicon must not linger.
      tab.favicon = null
      // Capture state belongs to the document that ended here, so the tab must
      // not keep claiming it is recording until the new page says otherwise.
      this.capture.reset(tabId)
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
    this.injectedDialogLabels.delete(tabId)
    this.forgetParked(tabId)
    this.agentReveals.delete(tabId)
    this.capture.forget(tabId)
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
