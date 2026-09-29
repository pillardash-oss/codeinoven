import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  screen,
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
import {
  BUILT_IN_BROWSER_SEARCH_ENGINES,
  buildBrowserSearchUrl,
  type BrowserSearchEngine
} from '../../lib/browser-search-engines'
import { fitWithin, MAX_SCREENSHOT_DIMENSION } from '../../lib/image-payload'
import type {
  BrowserCompositionPlayback,
  BrowserConsoleEntry,
  BrowserConsoleLevel,
  BrowserDesignTab,
  BrowserDevToolsState,
  BrowserLoadError,
  BrowserPageState,
  BrowserPanelShortcutAction,
  BrowserPermissionRequest,
  BrowserShortcutAction,
  BrowserShortcutBindings,
  BrowserSwitcherBindings,
  BrowserScrollbarTheme,
  BrowserTransportCommand,
  BrowserViewBounds
} from '../../lib/ipc-contract'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../lib/ipc-contract'
import { isVideoCaptureUrl } from '../../lib/video/project'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'
import { fetchIconAsDataUrl } from '../editor/favicon-service'
import { PermissionPromptWindow } from './permission-prompt-window'
import { BrowserDownloadTracker } from './browser-service/browser-downloads'
import { BrowserCaptureObserver } from './browser-service/browser-capture'
import { BrowserInspector } from './browser-service/browser-inspector'
import { BrowserSiteDataService } from './browser-service/browser-site-data'
import {
  BrowserPopupWindows,
  type BrowserPopupWindowHost,
  type BrowserPopupWindowRecord
} from './browser-service/browser-popup-windows'
import { dialogContextScript } from './browser-service/browser-dialog-context'
import {
  buildBrowserContextMenuItems,
  buildBrowserPageMenuItems,
  type BrowserContextMenuActions,
  type BrowserContextMenuContext
} from './browser-service/browser-context-menu'
import {
  matchBrowserShortcut,
  matchesBrowserChord,
  type ShortcutKeyInput
} from './browser-service/browser-shortcuts'
import {
  permissionCheckKey,
  permissionGrantKeys,
  permissionLedgerForPartition,
  permissionOrigin,
  permissionResolutions,
  permissionSilentGrant,
  rememberedPermissionOutcome,
  type PermissionResolution
} from './browser-service/browser-permissions'
import {
  BrowserPermissionMemory,
  type PermissionMemoryPersistence
} from './browser-service/browser-permission-memory'
import type {
  BrowserPageOwner,
  BrowserTab,
  BrowserViewport,
  ParkBrowserTabOptions,
  PendingBrowserPermission
} from './browser-service/browser-types'
import { BrowserTabStage } from './browser-service/browser-stage'
import { applyBrowserPageBackground } from './browser-service/browser-page-background'
import {
  AGENT_REVEAL_GRACE_MS,
  BROWSER_PARTITION_PREFIX,
  DEFAULT_PARKED_VIEWPORT,
  FRAME_RENDER_TIMEOUT_MS,
  MAX_ABANDONED_REVEALS,
  MAX_CONSOLE_ENTRIES,
  MAX_DIALOG_LABEL_LENGTH,
  MAX_PARKED_TABS,
  MAX_POPUP_WINDOWS_PER_TAB,
  MAX_TRANSPORT_ERROR_LENGTH,
  MAX_ZOOM_LEVEL,
  PERMISSION_TIMEOUT_MS,
  RELAX_COOLDOWN_MS,
  RENDERER_PARK_GRACE_MS,
  SCREENSHOT_JPEG_QUALITY,
  SCREENSHOT_MAX_BYTES,
  ZOOM_STEP,
  browserContextKey,
  isAllowedPopupWindowUrl,
  isSameBounds,
  isSameViewport,
  popupWindowViewport,
  safeBasename,
  validateAttention,
  validateBounds,
  validateBoundedHost,
  validateBrowserSearchEngine,
  validateBrowserShortcutBindings,
  validateBrowserSwitcherBindings,
  validateBrowserUrl,
  validateDownloadId,
  validateInspectorMarkers,
  validateInspectorReferenceId,
  validateInspectorTheme,
  validateOptionalBrowserUrl,
  validatePermissionDecision,
  validatePermissionRequestId,
  validatePopupWindowId,
  validateProjectId,
  validateScrollbarTheme,
  validateSiteDataScopes,
  validateSiteMenuPoint,
  validateTabId,
  validateThreadId,
  validateTransportCommand,
  validateTransportValue,
  validateViewportRequest
} from './browser-service/browser-validation'

/**
 * Where a renderer-owned shortcut lands. The key is decided in this process,
 * which is the only one that sees it before the application menu, and the tab
 * strip stays the renderer's: it opens, closes and focuses its own tabs.
 */
const PANEL_SHORTCUT_TARGETS: Readonly<
  Record<'focusAddress' | 'closeTab' | 'newTab' | 'toggleNotes', BrowserPanelShortcutAction>
> = {
  focusAddress: 'focus-address',
  closeTab: 'close-tab',
  newTab: 'new-tab',
  toggleNotes: 'toggle-notes'
}

import {
  faviconForCommittedUrl,
  faviconOriginOf,
  rememberFavicon
} from './browser-service/browser-favicon-memory'
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

/**
 * The page a native context menu was opened over.
 *
 * One shape covers both kinds of page the browser hosts   a tab's own page and a
 * popup window's   so one menu builder and one action set serve both: what
 * differs between them is only which page the actions act on and which tab a page
 * they open belongs to.
 */
interface BrowserMenuPage {
  contents: WebContents
  owner: BrowserPageOwner
}

/** The menu's view of one browser tab's own page. */
function menuPageFor(tabId: string, tab: BrowserTab): BrowserMenuPage {
  return {
    contents: tab.view.webContents,
    owner: { tabId, projectId: tab.projectId, threadId: tab.threadId }
  }
}

/** The owner of a popup window's page: the tab whose page opened it. */
function popupPageOwner(record: BrowserPopupWindowRecord): BrowserPageOwner {
  return { tabId: record.tabId, projectId: record.projectId, threadId: record.threadId }
}

/**
 * The `WebContents` Chromium created for a popup window, read off the options it
 * hands the `createWindow` hook.
 *
 * The hook is called instead of Electron creating a window, and the popup's own
 * `WebContents` travels on an options field the constructor type does not declare.
 * It is therefore read from the object itself and checked before use, because the
 * hook must answer with that exact object: any other one is reported as
 * unconnected and the popup never opens.
 */
function popupWindowContents(
  options: Electron.BrowserWindowConstructorOptions
): WebContents | null {
  const candidate: unknown = Reflect.get(options, 'webContents')
  return isWebContents(candidate) ? candidate : null
}

/**
 * Whether a value is a live `WebContents`, checked by the methods the app uses
 * on it rather than by `instanceof`: the popup's own contents arrives on an
 * options field with no declared type, so the check has to be structural.
 */
function isWebContents(value: unknown): value is WebContents {
  if (typeof value !== 'object' || value === null) return false
  return (
    typeof Reflect.get(value, 'getURL') === 'function' &&
    typeof Reflect.get(value, 'isDestroyed') === 'function' &&
    typeof Reflect.get(value, 'loadURL') === 'function'
  )
}

/**
 * Rebind a browser IPC channel.
 *
 * Reopening a window after a close-to-background rebuilds the browser service,
 * but the IPC handlers survive the old service's disposal, and Electron throws
 * when a channel is handled twice. Removing before registering makes the attach
 * safe to run once per window instead of once per process.
 */
function replaceHandler(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, listener)
}

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
  /** The Ctrl+Tab switcher chords, pushed by the renderer from its keymap. A key
   *  pressed in a page never reaches the renderer, so main claims these here. */
  private switcherBindings: BrowserSwitcherBindings = []
  /**
   * The tab whose surface holds the keyboard, or null while none does.
   *
   * A key pressed inside the page arrives on the tab's own web contents; a key
   * pressed in the toolbar, or anywhere in the Browser view's own DOM, arrives on
   * the window's, where the application menu would otherwise act on it. This is
   * the one fact main cannot read for itself, so the surface that holds the
   * keyboard reports it and the window-level interception routes to this tab.
   *
   * The report is kept exactly as it arrived and matched against the tab list when
   * a key is consumed, rather than parked as null when the tab is not known yet: a
   * view claims the keyboard as it mounts, which is a moment *before* the
   * `browser:show` that creates the page it is about to display, and by the time a
   * key arrives the tab is the one the renderer named. A destroyed tab is cleared
   * here as well (`destroyTab`), so the match is what keeps a stale id from routing
   * a key.
   */
  private focusedChromeTabId: string | null = null
  /**
   * The tab whose page should take the keyboard the moment it is on screen.
   *
   * A page can only be handed the keyboard while it is actually displayed, but a
   * user switch asks the instant the user picks the tab, which can be before the
   * show carrying that page lands. Holding the intent here is what keeps the
   * switch focused instead of losing the race to the page's own mount.
   */
  private pendingPageFocusTabId: string | null = null
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
  /**
   * Hides the renderer asked for, with the handle waiting out their grace window
   * and the moment each one arrived.
   *
   * A surface switch unmounts one panel and mounts the next for the same tab, and
   * the renderer's own visibility answer is recomputed every frame, so it flaps:
   * a hide and the show that follows it describe one continuous view that never
   * actually left. Parking in between is a window-server teardown and a re-parent
   * the page feels, and a re-attach a few milliseconds later is a flicker of a
   * page nothing asked to move. So a hide waits `RENDERER_PARK_GRACE_MS` for a
   * show to cancel it, and a hide nothing contradicts still parks, a few frames
   * after the decision that produced it. The arrival time is kept so a cancelled
   * park can report how long the answer it acted on lasted.
   */
  private readonly pendingParks = new Map<
    string,
    { handle: ReturnType<typeof setTimeout>; at: number }
  >()
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
  /** True while the renderer asked for the active browser view to be parked
   *  because a toast could not be placed anywhere a page does not cover.
   *
   *  A native WebContentsView floats above every DOM surface, so while this is set
   *  the active view stays detached and the DOM toast composites normally. The
   *  renderer no longer asks for this on every toast: it moves the toaster to a
   *  lane no on-screen page occupies (renderer `stores/toast-lane.ts`) and asks
   *  only when the measured toast still lands under one, which the header band as
   *  the last lane should make impossible. This path is the safety net, not the
   *  primary one. */
  private toastVisible = false
  /**
   * The address bar's active search engine, reported by the renderer (which
   * owns the config) so the native context menu can label and run its
   * "Search <engine> for ..." item. Defaults to the shipped engine until the
   * first report lands.
   */
  private contextMenuSearchEngine: BrowserSearchEngine = BUILT_IN_BROWSER_SEARCH_ENGINES[0]
  /** The app's default-scrollbar colours, applied to every tab's page. Null
   *  until the renderer pushes them once at boot. */
  private scrollbarTheme: BrowserScrollbarTheme | null = null
  /** The user-origin stylesheet inserted per tab, so a theme swap can replace
   *  the previous one instead of stacking. */
  private scrollbarStyles = new Map<string, string>()
  private consoleSequence = 0
  /**
   * The popup windows pages have opened, hosted by the app rather than by the
   * system. Created with the rest of the view plumbing below, because its host
   * is this service's own window handling.
   */
  private readonly popupWindows: BrowserPopupWindows
  /**
   * The popup views currently mounted in the app window.
   *
   * Tracked rather than read back from `contentView.children`: a popup's page can
   * destroy itself at any moment (that is how a finished sign-in ends), and once
   * its view no longer carries web contents the window's own child list throws
   * when it is read. The app therefore has to know what it mounted itself.
   */
  private readonly mountedPopupViews = new Set<WebContentsView>()
  /** The frame each mounted popup view was last placed at, so a move is reported
   *  as a move rather than as another placement. */
  private readonly popupViewFrames = new Map<WebContentsView, BrowserViewBounds>()

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
    this.popupWindows = new BrowserPopupWindows(this.popupWindowHost())
    this.downloadTracker = new BrowserDownloadTracker({
      window,
      // A download started by a popup window is the tab's download: the row the
      // user sees must name the tab they were reading, not a page with no strip.
      findTabId: (projectId, contentsId) => this.tabIdForContents(projectId, contentsId)
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
    replaceHandler(
      'browser:show',
      (_event, rawTabId, rawProjectId, rawThreadId, rawInitialUrl, rawBounds) => {
        const tabId = validateTabId(rawTabId)
        const projectId = validateProjectId(rawProjectId)
        const threadId = validateThreadId(rawThreadId)
        const initialUrl = validateOptionalBrowserUrl(rawInitialUrl)
        const bounds = validateBounds(rawBounds)
        const tab = this.ensureTab(tabId, projectId, threadId)

        // A show that lands inside the grace window of a hide is a surface switch
        // or a visibility answer that flapped, not a departure: dropping the
        // deferred park keeps the page where it is instead of parking it and
        // re-parenting it straight back, which is the flicker the user sees.
        this.cancelPendingPark(tabId)
        // Leaving a tab costs nothing now: the outgoing tab keeps running in an
        // invisible stage window instead of going dead behind the app window.
        if (this.activeTabId && this.activeTabId !== tabId) {
          this.parkTab(this.activeTabId, { reason: 'another tab took the view' })
        }
        this.activeTabId = tabId
        this.activeTabBounds = bounds
        // Remember the frame the page is on screen at. Parking lays the page out at
        // this size from now on, so leaving a tab never resizes the page away from
        // the size the user was reading it at.
        tab.displayedViewport = {
          viewport: { width: bounds.width, height: bounds.height },
          at: Date.now()
        }
        this.markRevealShown(tabId)
        if (this.toastVisible) {
          // A native view floats above every DOM surface, so while a toast is on
          // screen the tab stays parked at its on-screen size: the page keeps
          // the exact viewport the user was looking at, and keeps running. The
          // panel re-reports the same frame while the toast is up and the view is
          // already where it belongs, so only the first report parks it.
          if (!this.stage.isParked(tab.view)) {
            this.parkTab(tabId, {
              size: { width: bounds.width, height: bounds.height },
              keepActive: true,
              reason: 'toast on screen'
            })
          }
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

    replaceHandler('browser:hide', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      // Leaving a tab right after an agent revealed it is the signal that the
      // agent's reveal was not welcome; it stops being counted after a while.
      this.noteDepartedReveal(tabId)
      // Deferred by one tick, so a panel that unmounts because the same tab is
      // moving to another surface (the sidebar handing the tab to the full screen
      // browser) does not park a view that is about to be shown again.
      this.schedulePark(tabId, 'the renderer left this surface')
      // Missing tabs are silently ignored   the renderer may call hide
      // during teardown after the tab was already destroyed.
    })
    replaceHandler('browser:showPopupWindow', (_event, rawPopupId, rawBounds) => {
      this.popupWindows.show(validatePopupWindowId(rawPopupId), validateBounds(rawBounds))
    })
    replaceHandler('browser:hidePopupWindow', (_event, rawPopupId) => {
      this.popupWindows.hide(validatePopupWindowId(rawPopupId))
    })
    replaceHandler('browser:focusPopupWindow', (_event, rawPopupId) => {
      this.popupWindows.focus(validatePopupWindowId(rawPopupId))
    })
    replaceHandler('browser:closePopupWindow', (_event, rawPopupId) => {
      this.popupWindows.close(validatePopupWindowId(rawPopupId), 'the user closed it')
    })
    replaceHandler('browser:getPopupWindows', (_event, rawProjectId) =>
      this.popupWindows.list(validateProjectId(rawProjectId))
    )
    replaceHandler('browser:setToastVisible', (_event, rawVisible) => {
      this.setToastVisible(rawVisible === true)
    })
    replaceHandler('browser:navigate', (_event, rawTabId, rawProjectId, rawThreadId, rawUrl) => {
      const tabId = validateTabId(rawTabId)
      const projectId = validateProjectId(rawProjectId)
      const threadId = validateThreadId(rawThreadId)
      const url = validateBrowserUrl(rawUrl)
      // Main creates a tab on `browser:show`, so a tab the renderer already knows
      // can still be unknown here: a fresh tab whose page has not been shown yet
      // because an overlay (the address spotlight) covers its frame. Ensuring the
      // tab makes an address load regardless of whether its page is on screen.
      const tab = this.ensureTab(tabId, projectId, threadId)
      // The navigation below is this tab's first, so a later show must not load
      // the stale initial URL over it.
      tab.initialNavigationStarted = true
      this.load(tabId, url)
    })
    replaceHandler('browser:goBack', (_event, rawTabId) => {
      const tab = this.requireTab(validateTabId(rawTabId))
      if (tab.view.webContents.navigationHistory.canGoBack()) {
        tab.view.webContents.navigationHistory.goBack()
      }
    })
    replaceHandler('browser:goForward', (_event, rawTabId) => {
      const tab = this.requireTab(validateTabId(rawTabId))
      if (tab.view.webContents.navigationHistory.canGoForward()) {
        tab.view.webContents.navigationHistory.goForward()
      }
    })
    replaceHandler('browser:mouseHistoryNavigation', (_event, rawDirection) => {
      if (rawDirection !== 'back' && rawDirection !== 'forward') {
        throw new TypeError('Browser mouse history direction must be back or forward')
      }
      return this.navigateFocusedHistory(rawDirection)
    })
    replaceHandler('browser:reload', (_event, rawTabId) => {
      this.requireTab(validateTabId(rawTabId)).view.webContents.reload()
    })
    replaceHandler('browser:transport', async (_event, rawTabId, rawCommand, rawValue) => {
      const tabId = validateTabId(rawTabId)
      const command = validateTransportCommand(rawCommand)
      return this.transport(tabId, command, validateTransportValue(command, rawValue))
    })
    replaceHandler('browser:transportState', (_event, rawTabId) =>
      this.transportState(validateTabId(rawTabId))
    )
    replaceHandler('browser:reloadIgnoringCache', (_event, rawTabId) => {
      this.requireTab(validateTabId(rawTabId)).view.webContents.reloadIgnoringCache()
    })
    replaceHandler('browser:stop', (_event, rawTabId) => {
      this.requireTab(validateTabId(rawTabId)).view.webContents.stop()
    })
    replaceHandler('browser:setMuted', (_event, rawTabId, rawMuted) => {
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
    replaceHandler('browser:setChromeFocus', (_event, rawTabId) => {
      // Kept as reported, including a tab this process has not created yet: the
      // claim is matched against the tab list when a key is consumed (see
      // `focusedChromeTabId`), because the surface reports it as it mounts, before
      // the show that creates the page.
      this.focusedChromeTabId = rawTabId === null ? null : validateTabId(rawTabId)
    })
    replaceHandler('browser:focusPage', (_event, rawTabId) => {
      this.focusPage(validateTabId(rawTabId))
    })
    replaceHandler('browser:setShortcutBindings', (_event, rawBindings) => {
      this.shortcutBindings = validateBrowserShortcutBindings(rawBindings)
    })
    replaceHandler('browser:setSwitcherBindings', (_event, rawBindings) => {
      this.switcherBindings = validateBrowserSwitcherBindings(rawBindings)
    })
    replaceHandler('browser:setSearchEngine', (_event, rawEngine) => {
      this.contextMenuSearchEngine = validateBrowserSearchEngine(rawEngine)
    })
    replaceHandler('browser:setScrollbarTheme', (_event, rawTheme) => {
      this.setScrollbarTheme(validateScrollbarTheme(rawTheme))
    })
    replaceHandler('browser:toggleDevTools', (_event, rawTabId) =>
      this.toggleDevTools(this.requireTab(validateTabId(rawTabId)).view.webContents)
    )
    replaceHandler('browser:inspectSetArmed', (_event, rawTabId, rawArmed, rawTheme) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.requireTab(tabId)
      if (typeof rawArmed !== 'boolean') {
        throw new TypeError('Inspect mode must be a boolean')
      }
      if (!tab.design && rawArmed) {
        throw new TypeError('The element inspector is available on a design preview only')
      }
      this.inspector.setArmed(
        tabId,
        tab.view.webContents,
        rawArmed,
        rawTheme === undefined ? null : validateInspectorTheme(rawTheme)
      )
    })
    replaceHandler('browser:inspectTheme', (_event, rawTabId, rawTheme) => {
      const tabId = validateTabId(rawTabId)
      this.requireTab(tabId)
      this.inspector.syncTheme(tabId, validateInspectorTheme(rawTheme))
    })
    replaceHandler('browser:inspectFocus', (_event, rawTabId, rawReferenceId, rawScroll) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.requireTab(tabId)
      if (typeof rawScroll !== 'boolean') {
        throw new TypeError('Inspector focus scroll flag must be a boolean')
      }
      this.inspector.focus(
        tabId,
        tab.view.webContents,
        validateInspectorReferenceId(rawReferenceId),
        rawScroll
      )
    })
    replaceHandler('browser:inspectMarkers', (_event, rawTabId, rawMarkers) => {
      const tabId = validateTabId(rawTabId)
      this.requireTab(tabId)
      this.inspector.syncMarkers(tabId, validateInspectorMarkers(rawMarkers))
    })
    replaceHandler('browser:clearData', async (_event, rawProjectId) => {
      await this.siteData.clearProjectData(validateProjectId(rawProjectId))
    })
    replaceHandler('browser:clearSiteData', (_event, rawProjectId, rawScopes) => {
      const projectId = validateProjectId(rawProjectId)
      const scopes = validateSiteDataScopes(rawScopes)
      void this.siteData.clearSiteData(projectId, scopes).catch((error: unknown) => {
        Logger.error('Browser site data could not be cleared:', error)
      })
    })
    replaceHandler('browser:siteMenu', (_event, rawProjectId, rawHost, rawX, rawY) => {
      const projectId = validateProjectId(rawProjectId)
      const host = validateBoundedHost(rawHost)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      // Native popup menus run a nested run loop; detach from the invoke reply
      // so the renderer's call resolves immediately.
      setImmediate(() => this.siteData.showSiteMenu(projectId, host, x, y))
    })
    replaceHandler('browser:pageMenu', (_event, rawTabId, rawX, rawY) => {
      const tabId = validateTabId(rawTabId)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      this.requireTab(tabId)
      setImmediate(() => this.showPageMenu(tabId, x, y))
    })
    replaceHandler('browser:downloadsMenu', (_event, rawProjectId, rawX, rawY) => {
      const projectId = validateProjectId(rawProjectId)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      setImmediate(() => this.downloadTracker.showMenu(projectId, x, y))
    })
    replaceHandler('browser:resolvePermission', (_event, rawRequestId, rawDecision) => {
      const requestId = validatePermissionRequestId(rawRequestId)
      const decision = validatePermissionDecision(rawDecision)
      this.resolvePermission(requestId, permissionResolutions[decision])
    })
    replaceHandler('browser:popupReady', () => {
      // Pull model: the popup document requests the prompt on display once its
      // listener is bound. Invoke replies bypass the push-side load-state
      // guards that repeatedly dropped the first prompt (blank first popup).
      return this.promptWindow.currentContext()
    })
    replaceHandler('browser:destroy', (_event, rawTabId) => {
      this.destroy(validateTabId(rawTabId))
    })
    replaceHandler('browser:destroyThread', (_event, rawProjectId, rawThreadId) => {
      const projectId = validateProjectId(rawProjectId)
      const threadId = validateThreadId(rawThreadId)
      for (const [tabId, tab] of this.tabs) {
        if (tab.projectId === projectId && tab.threadId === threadId) this.destroy(tabId)
      }
    })
    replaceHandler('browser:destroyProject', (_event, rawProjectId) => {
      const projectId = validateProjectId(rawProjectId)
      for (const [tabId, tab] of this.tabs) {
        if (tab.projectId === projectId) this.destroy(tabId)
      }
    })
    replaceHandler('browser:getDownloads', (_event, rawProjectId) => {
      const projectId = validateProjectId(rawProjectId)
      return this.downloadTracker.list(projectId)
    })
    replaceHandler('browser:cancelDownload', (_event, rawDownloadId) => {
      this.downloadTracker.cancel(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:pauseDownload', (_event, rawDownloadId) => {
      this.downloadTracker.pause(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:resumeDownload', (_event, rawDownloadId) => {
      this.downloadTracker.resume(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:openDownload', (_event, rawDownloadId) => {
      this.downloadTracker.open(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:revealDownload', (_event, rawDownloadId) => {
      return this.downloadTracker.reveal(validateDownloadId(rawDownloadId))
    })
  }

  dispose(): void {
    this.popupWindows.closeAll('the browser was torn down')
    this.mountedPopupViews.clear()
    this.popupViewFrames.clear()
    this.activeTabId = null
    this.toastVisible = false
    this.activeTabBounds = null
    this.displayedTab = null
    for (const pending of this.pendingParks.values()) clearTimeout(pending.handle)
    this.pendingParks.clear()
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
   * Set the search engine the context menu's web search uses.
   *
   * Called once with the boot config and again whenever the renderer reports a
   * config change, because the browser's native context menu is built here and
   * this process holds the config rather than the service.
   */
  setSearchEngine(engine: BrowserSearchEngine): void {
    this.contextMenuSearchEngine = engine
  }

  /**
   * Set the app's scrollbar colours and apply them to every open tab.
   *
   * Called once with the renderer's first push and again whenever the app theme
   * changes, so a default page scrollbar stays on brand without the renderer
   * having to know which tabs exist. A user-origin stylesheet is what keeps a
   * site's own scrollbar styling in charge where it exists.
   */
  setScrollbarTheme(theme: BrowserScrollbarTheme): void {
    this.scrollbarTheme = theme
    for (const [tabId, tab] of this.tabs) this.applyScrollbarTheme(tabId, tab.view.webContents)
  }

  /** Build the user-origin stylesheet a page's default scrollbar is drawn with. */
  private scrollbarThemeCss(theme: BrowserScrollbarTheme): string {
    return (
      '::-webkit-scrollbar{width:6px;height:6px}' +
      '::-webkit-scrollbar-track{background:transparent}' +
      `::-webkit-scrollbar-thumb{background:${theme.thumb};border-radius:3px}` +
      `::-webkit-scrollbar-thumb:hover{background:${theme.thumbHover}}`
    )
  }

  /**
   * Install the current colours into one tab's document. Re-run on every
   * `dom-ready`, because a navigation replaces the stylesheet with the document.
   * The insert is user-origin on purpose: author styles win the cascade, so a
   * site that styles its own scrollbar keeps it.
   */
  private applyScrollbarTheme(tabId: string, contents: WebContents): void {
    const theme = this.scrollbarTheme
    if (!theme || contents.isDestroyed()) return
    const previous = this.scrollbarStyles.get(tabId)
    this.scrollbarStyles.delete(tabId)
    contents
      .insertCSS(this.scrollbarThemeCss(theme), { cssOrigin: 'user' })
      .then((key) => {
        if (contents.isDestroyed()) return
        this.scrollbarStyles.set(tabId, key)
        if (previous) void contents.removeInsertedCSS(previous).catch(() => {})
      })
      .catch(() => {})
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
    if (next.design === null) this.inspector.setArmed(tabId, tab.view.webContents, false, null)
    this.publishState(tabId)
    if (!next.composition) {
      // A tab that left the composition has no playhead to restore, and the mute
      // the player took from it belongs to the tab rather than to the composition.
      this.playheads.delete(tabId)
      this.releaseTransportAudio(tabId, tab)
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
      this.parkTab(tabId, { reason: 'agent opened a tab in the background' })
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
        viewport: this.parkedViewportFor(tab),
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
    if (this.activeTabId !== tabId && !this.stage.isParked(tab.view)) {
      this.parkTab(tabId, { reason: 'agent operation on a tab that was not on screen' })
    } else {
      this.touchParkedTab(tabId)
    }
    const utilityContext = this.utilityTabContext(tabId, tab)
    if (operation === 'viewport') {
      const viewport = validateViewportRequest(
        input,
        tab.requestedViewport?.viewport ?? DEFAULT_PARKED_VIEWPORT
      )
      tab.requestedViewport = { viewport, at: Date.now() }
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
          'The user is viewing this tab, so it is laid out at the on-screen size right now. This viewport applies the next time the tab is parked, unless the user displays it at a size of their own after this request.'
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
      // A preview the runtime could not drive is still a preview the app put on
      // screen, and one that cannot be stopped must not be audible.
      this.applyTransportAudio(tabId, tab, false)
      return
    }
    // A burst of agent writes reloads a preview more than once, so the document can
    // be replaced while the runtime is being installed. The position then belongs to
    // a document that has gone, and a record naming this one would make the next
    // load believe it was already armed, so neither is kept.
    if (contents.isDestroyed() || tab.navigationGeneration !== generation) return
    tab.transport = { generation, url, duration: composition.duration, fps: composition.fps }
    // A capture URL is silent by definition and a viewing starts playing, so the
    // tab's audio follows what the runtime actually did rather than what was asked
    // of it: a first frame that threw leaves the transport paused and the tab quiet.
    const playback = await this.transportState(tabId)
    this.applyTransportAudio(tabId, tab, playback?.playing === true)
    if (frozen) return
    const playhead = live ?? this.takePlayhead(tabId, composition.directory)
    if (!playhead) return
    await this.sendTransport(tabId, 'seek', playhead.time)
    // A reload arms playing, so a composition the user had paused must be paused
    // again: without this, an agent write while the user was stopped would start
    // the video over their still frame.
    await this.sendTransport(tabId, playhead.playing ? 'play' : 'pause', 0)
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
    const playback = toCompositionPlayback(result)
    // The runtime declines the page's draws, parks its loop and pauses the media it
    // knows about, but a page can always start sound none of that reaches. The tab
    // is muted for exactly as long as the transport is not playing, which is the
    // one lever no composition can work around. A command that never reached the
    // page reports nothing, and an unreachable composition is quiet by default.
    if (tab.composition) this.applyTransportAudio(tabId, tab, playback?.playing === true)
    return playback
  }

  /**
   * Mute a composition tab for as long as its transport is not playing.
   *
   * The page-side runtime pauses the media it can reach; this is the part it cannot.
   * Muting the view silences a detached element the runtime never saw, a synthesized
   * track, and a frame the page starts behind the player's back. The app only lifts a
   * mute it made itself, so a tab the user muted stays muted through a play.
   */
  private applyTransportAudio(tabId: string, tab: BrowserTab, playing: boolean): void {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    if (playing) {
      if (tab.transportMuted && contents.isAudioMuted()) {
        contents.setAudioMuted(false)
        this.publishState(tabId)
      }
      tab.transportMuted = false
      return
    }
    if (contents.isAudioMuted()) return
    contents.setAudioMuted(true)
    tab.transportMuted = true
    this.publishState(tabId)
  }

  /** Give a tab back the mute the player took from it. */
  private releaseTransportAudio(tabId: string, tab: BrowserTab): void {
    if (!tab.transportMuted) return
    tab.transportMuted = false
    const contents = tab.view.webContents
    if (contents.isDestroyed() || !contents.isAudioMuted()) return
    contents.setAudioMuted(false)
    this.publishState(tabId)
  }

  /**
   * Run one claimed browser action on a tab.
   *
   * The actions split by owner: what acts on the page happens here, and what
   * acts on the tab strip (focusing the address bar, closing or opening a tab,
   * showing the tab's notes) is forwarded to the renderer, which is the only side
   * that knows the strip. Saving is asynchronous because the save dialog is, and
   * it must never block the key event that asked for it.
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
        this.toggleDevTools(contents)
        return
      case 'savePage':
        void this.savePage(contents)
        return
      case 'focusAddress':
      case 'closeTab':
      case 'newTab':
      case 'toggleNotes':
        this.requestPanelShortcut(tabId, PANEL_SHORTCUT_TARGETS[action])
        return
    }
  }

  /**
   * Claim the Ctrl+Tab switcher gesture pressed in a page.
   *
   * The switcher is a renderer DOM surface, but a key pressed in the page never
   * reaches it. So the app claims the chord here (the app always wins; a site
   * cannot override Ctrl+Tab), hands the renderer the keyboard and forwards the
   * gesture. Once the renderer owns the keyboard the real Control release reaches
   * the DOM and commits the highlight, so only the first press is forwarded.
   *
   * Returns whether the key was claimed, so the caller prevents it. Preventing it
   * is what stops the page and the application menu from also acting on it.
   */
  private consumeSwitcherKey(input: ShortcutKeyInput): boolean {
    if (!matchesBrowserChord(input, this.switcherBindings)) return false
    if (!this.window.webContents.isDestroyed()) {
      this.window.webContents.focus()
      sendToRenderer(this.window.webContents, 'browser:switcherKey', { backward: input.shift })
    }
    return true
  }

  /**
   * Ask the renderer to act on the tab strip, which only the renderer owns.
   *
   * When the key came from the page, this process still holds the OS keyboard
   * through the page's own `WebContentsView`, so the renderer can move its
   * `document.activeElement` into the address field but not take the user's
   * typing with it. A shortcut whose whole point is a DOM field therefore hands
   * the window's web contents the focus first: `focus-address` and `new-tab`
   * both open a field the renderer immediately focuses. The tab-strip actions
   * that do not involve a field (`close-tab`, `toggle-notes`) deliberately do
   * not, because the page must keep the keyboard after them.
   */
  private requestPanelShortcut(tabId: string, action: BrowserPanelShortcutAction): void {
    if (this.window.webContents.isDestroyed()) return
    if (action === 'focus-address' || action === 'new-tab') this.window.webContents.focus()
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
    // The claim can name a tab this process has not created yet (a view claims the
    // keyboard as it mounts, before the show that creates its page), and a tab it
    // no longer has is one whose keys belong to the app again, so the match is what
    // decides.
    if (!tabId || !this.tabs.has(tabId)) return false
    const action = matchBrowserShortcut(input, this.shortcutBindings)
    if (!action) return false
    event.preventDefault()
    this.runBrowserShortcut(tabId, action)
    return true
  }

  /** Route a mouse history button to the browser only when its active page or
   *  toolbar owns focus. The caller falls back to app navigation when this
   *  returns false. A focused browser consumes the input even at a history end. */
  private navigateFocusedHistory(direction: 'back' | 'forward'): boolean {
    const tabId = this.activeTabId
    if (!tabId) return false
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return false

    const isFocusedToolbar = tabId === this.focusedChromeTabId
    const isFocusedPage = tab.view.webContents.isFocused()
    if (!isFocusedToolbar && !isFocusedPage) return false

    const history = tab.view.webContents.navigationHistory
    if (direction === 'back' && history.canGoBack()) history.goBack()
    if (direction === 'forward' && history.canGoForward()) history.goForward()
    return true
  }

  /** Toggle the web page's own DevTools. Returns whether it is now open. */
  private toggleDevTools(contents: WebContents): boolean {
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
   * Save a page to a file the user picks.
   *
   * Chromium writes the page as it stands (markup plus its resources) rather
   * than the raw response, which is what Chrome's own "Web page, complete"
   * does and the only useful answer for a page a script rendered. A refusal or a
   * write failure has no UI of its own, so it is reported as an app toast
   * instead of leaving the user with a key that silently did nothing.
   *
   * The page is a `WebContents` rather than a tab, because a popup window's page
   * is saved exactly the way a tab's is.
   */
  private async savePage(contents: WebContents): Promise<void> {
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
    // The tab carries no document yet, so nothing of the page's own surface is
    // painted over the app until one commits.
    applyBrowserPageBackground(view)
    const tab: BrowserTab = {
      view,
      projectId,
      threadId,
      initialNavigationStarted: false,
      consoleEntries: [],
      favicon: null,
      faviconByOrigin: new Map(),
      requestedViewport: null,
      displayedViewport: null,
      design: null,
      composition: null,
      transport: null,
      transportMuted: false,
      navigationGeneration: 0,
      loadError: null,
      navigationFailure: null
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
      // The switcher is claimed first: it is an app-level gesture that must work
      // from inside a page, and it must never be shadowed by a browser binding.
      if (this.consumeSwitcherKey(input)) {
        event.preventDefault()
        return
      }
      const action = matchBrowserShortcut(input, this.shortcutBindings)
      if (!action) return
      event.preventDefault()
      this.runBrowserShortcut(tabId, action)
    })
    // The page itself never sees the application's DOM menus, so this is where
    // the browser's own right-click menu is produced: link, image, media,
    // selection, editing and page actions, decided from the point clicked.
    view.webContents.on('context-menu', (_event, params) => {
      this.showTabContextMenu(tabId, params)
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
      // The document that just arrived drops the last one's stylesheet, so the
      // app's scrollbar colours are installed again here.
      this.applyScrollbarTheme(tabId, view.webContents)
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
      // The document that arrived is the answer to whether the navigation failed,
      // so this is where the error card is confirmed or lifted.
      this.resolveLoadOutcome(tabId)
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
    // A main-frame navigation is a fresh attempt, so the provisional failure of
    // the last one is dropped here. The published `loadError` is deliberately left
    // in place until this navigation resolves, so the card cannot flicker away for
    // the empty frame a load starts with.
    view.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      tab.navigationFailure = null
    })
    view.webContents.on('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
      // An HTTP error status is provisional: it becomes the tab's error only if
      // the document the server sent turns out to be empty, which is read when
      // the load finishes. A network failure already recorded for this navigation
      // outranks it, because the error document the failure commits reports no
      // status of its own.
      if (tab.navigationFailure?.kind !== 'network') {
        tab.navigationFailure =
          httpResponseCode >= 400
            ? {
                kind: 'http',
                code: httpResponseCode,
                description: httpStatusText || `HTTP ${httpResponseCode}`
              }
            : null
      }
      // A committed document comes back with the icon its own origin is known by.
      // Chromium announces an icon only when it changes, so clearing the tab here
      // and waiting for the announcement left a reload, a client-side redirect, or
      // a link inside one site iconless, and the strip fell back to the globe. An
      // origin the tab has never shown still starts out without an icon.
      tab.favicon = faviconForCommittedUrl(tab.faviconByOrigin, url)
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
      // The document that just committed is also what decides the surface it is
      // drawn over, which is white for a loaded page and the app's own surface
      // for an empty one.
      applyBrowserPageBackground(tab.view)
      publish()
    })
    view.webContents.on('did-navigate-in-page', publish)
    view.webContents.on('page-title-updated', publish)
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      const source = favicons.find((candidate) => candidate.length > 0) ?? null
      if (!source) return
      // Read now, not when the fetch resolves: the document that declared this
      // icon is the one that owns it, whatever the tab moves on to while the icon
      // is in flight.
      const declaredBy = faviconOriginOf(view.webContents.getURL())
      // Electron reports icon URLs, but remote images are blocked by the
      // renderer CSP   convert to a data URL so any consumer can render it.
      void fetchIconAsDataUrl(source).then((favicon) => {
        if (!favicon) return
        if (declaredBy !== null) rememberFavicon(tab.faviconByOrigin, declaredBy, favicon)
        // An answer for a document the tab has already left is remembered for that
        // document's origin and goes no further, so the icon on screen always
        // belongs to the origin on screen.
        if (view.webContents.isDestroyed()) return
        if (declaredBy !== faviconOriginOf(view.webContents.getURL())) return
        if (tab.favicon === favicon) return
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
        // -3 is ERR_ABORTED, which a redirect or a cancelled load produces and is
        // not a failure worth a page of its own.
        if (!isMainFrame || errorCode === -3) return
        // The failed navigation can still commit an error document, which has no
        // shim of its own, so the record of what is installed must not survive it.
        this.injectedDialogLabels.delete(tabId)
        const failure: BrowserLoadError = {
          kind: 'network',
          code: errorCode,
          description: errorDescription
        }
        tab.navigationFailure = failure
        // A network failure is final the moment it is reported, so the card goes
        // up without waiting for the error document that may or may not commit.
        this.setTabLoadError(tabId, failure)
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
      // A renderer that exited on its own (window teardown, a reload of the app)
      // is not a page error; every other reason leaves the tab with nothing.
      if (details.reason !== 'clean-exit') {
        this.setTabLoadError(tabId, {
          kind: 'crashed',
          code: details.exitCode,
          description: details.reason
        })
      }
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
    this.installWindowOpenPolicy(view, { tabId, projectId, threadId })
    return tab
  }
  /**
   * Decide where a page's `window.open` lands.
   *
   * Two answers, by what the page asked for:
   *
   * - a popup window   Chromium reports `new-window`, which is what a `features`
   *   string produces   is hosted by the app, so a sign-in or a checkout happens
   *   inside the browser instead of in an operating-system window of its own;
   * - anything else, such as a link that asks for its own tab, keeps the app's
   *   tabs: a safe https address becomes a background tab.
   *
   * A popup window is only hosted for the global browser, which is the one with a
   * rail to show it in. A project's browser   and every page an agent drives   keeps
   * the tab behaviour it had, where an opened window is a tab with an address the
   * user can see and steer.
   *
   * Shared by tabs and popup windows, because a popup may open a popup (a
   * sign-in that takes a second step) and both must land the same way.
   */
  private windowOpenResponse(
    owner: BrowserPageOwner,
    details: Electron.HandlerDetails
  ): Electron.WindowOpenHandlerResponse {
    if (details.disposition === 'new-window' && owner.projectId === GLOBAL_BROWSER_PROJECT_ID) {
      const popup = this.openPopupWindowFor(owner, details)
      if (popup) return popup
    }
    try {
      this.openNewTabFor(owner, validateBrowserUrl(details.url), 'a popup opened in the background')
    } catch (error: unknown) {
      Logger.error('Browser popup rejected unsafe URL:', error)
    }
    return { action: 'deny' }
  }

  /**
   * Host the popup window a page asked for, or answer null to let the caller
   * fall back to opening it as a tab.
   *
   * A popup that cannot be hosted   an address the browser will not navigate to,
   * or a tab that already holds as many popups as it may   still gets its window,
   * it just gets it as a tab, which is what the page's own code can survive.
   */
  private openPopupWindowFor(
    owner: BrowserPageOwner,
    details: Electron.HandlerDetails
  ): Electron.WindowOpenHandlerResponse | null {
    const url = details.url === '' ? 'about:blank' : details.url
    if (!isAllowedPopupWindowUrl(url)) {
      Logger.error('Browser popup window refused an address it may not navigate to:', url)
      return null
    }
    if (this.popupWindows.countForTab(owner.tabId) >= MAX_POPUP_WINDOWS_PER_TAB) {
      Logger.dev('Browser popup window refused: the tab already holds the maximum', {
        tabId: owner.tabId
      })
      return null
    }
    const viewport = popupWindowViewport(details.features)
    return {
      action: 'allow',
      // `createWindow` runs instead of Electron creating a window, and is handed
      // the popup's own `WebContents`. Presenting that one is what keeps the popup
      // a real popup: it keeps its opener, its opener's session and the ability to
      // close itself, none of which survive a page the app loads on its own.
      createWindow: (options) => {
        const contents = popupWindowContents(options)
        if (!contents) {
          Logger.error('Browser popup window was offered no web contents to host')
          throw new Error('Browser popup window was offered no web contents to host')
        }
        return this.popupWindows.host(contents, { owner, url, viewport })
      }
    }
  }

  /**
   * The view plumbing popup windows run on.
   *
   * The registry owns popup lifetimes; every native call a view needs stays here,
   * beside the tab ones, so a popup and a tab are placed, parked and dropped the
   * same way and there is one place to look when a page is not where it should be.
   */
  private popupWindowHost(): BrowserPopupWindowHost {
    return {
      mount: (view, bounds) => {
        if (this.window.isDestroyed()) return
        try {
          const previous = this.popupViewFrames.get(view)
          this.popupViewFrames.set(view, bounds)
          if (this.mountedPopupViews.has(view)) {
            // Already on screen: only a moved frame needs a native call, so the
            // rail's own resize reports cost one comparison each.
            view.setBounds(bounds)
            if (previous && !isSameBounds(previous, bounds)) {
              Logger.dev('Browser popup window moved', { from: previous, to: bounds })
            }
            return
          }
          this.stage.release(view)
          this.window.contentView.addChildView(view)
          this.mountedPopupViews.add(view)
          view.setBounds(bounds)
          Logger.dev('Browser popup window placed', { bounds })
        } catch (error: unknown) {
          Logger.error('Browser popup window could not be placed:', error)
        }
      },
      unmount: (view, viewport) => {
        if (this.detachPopupView(view)) {
          Logger.dev('Browser popup window parked', { viewport })
        }
        this.stage.park(view, viewport)
      },
      discard: (view) => {
        this.detachPopupView(view)
        this.stage.release(view)
      },
      wire: (record) => this.wirePopupWindow(record),
      changed: () => this.publishPopupWindows()
    }
  }

  /**
   * Take a popup's view out of the app window, answering whether it was in it.
   *
   * A view whose page destroyed itself cannot be handed to the window at all, so
   * every native call is defended: the popup is gone and the app must not follow
   * it.
   */
  private detachPopupView(view: WebContentsView): boolean {
    this.popupViewFrames.delete(view)
    if (!this.mountedPopupViews.has(view)) return false
    this.mountedPopupViews.delete(view)
    if (this.window.isDestroyed()) return false
    try {
      this.window.contentView.removeChildView(view)
    } catch (error: unknown) {
      Logger.error('Browser popup window could not be detached:', error)
      return false
    }
    return true
  }

  /**
   * Give a popup window's page its own browser behaviour.
   *
   * It is a page in the app's browser, so it gets what a tab's page gets: the
   * browser's own keyboard chords rather than the application menu's, the browser's
   * right-click menu over its content, the browser's navigation policy, and a
   * landing place for a window it opens itself.
   */
  private wirePopupWindow(record: BrowserPopupWindowRecord): void {
    const contents = record.view.webContents
    // A popup's keys reach its own page and then the application menu, where
    // Cmd/Ctrl+W would close the app window rather than this popup.
    contents.on('before-input-event', (event, input) => {
      if (this.consumeSwitcherKey(input)) {
        event.preventDefault()
        return
      }
      const action = matchBrowserShortcut(input, this.shortcutBindings)
      if (!action) return
      event.preventDefault()
      this.runPopupWindowShortcut(record, action)
    })
    contents.on('context-menu', (_event, params) => {
      this.showPopupWindowContextMenu(record, params)
    })
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedPopupWindowUrl(url)) event.preventDefault()
    })
    this.installWindowOpenPolicy(record.view, popupPageOwner(record))
  }

  /** Install the landing policy for the windows a page opens. */
  private installWindowOpenPolicy(view: WebContentsView, owner: BrowserPageOwner): void {
    view.webContents.setWindowOpenHandler((details) => this.windowOpenResponse(owner, details))
  }

  /**
   * Run one browser chord pressed inside a popup window.
   *
   * Closing a popup closes the popup and not the browser: to the user a popup is
   * its own window, so Cmd/Ctrl+W must end it. The chords that belong to the app's
   * own chrome (the address bar, a new tab, the note) are forwarded to the
   * renderer under the owning tab, which is the tab the app would act on.
   */
  private runPopupWindowShortcut(
    record: BrowserPopupWindowRecord,
    action: BrowserShortcutAction
  ): void {
    const contents = record.view.webContents
    if (contents.isDestroyed()) return
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
        this.toggleDevTools(contents)
        return
      case 'savePage':
        void this.savePage(contents)
        return
      case 'closeTab':
        this.popupWindows.close(record.id, 'the user closed its window')
        return
      case 'focusAddress':
      case 'newTab':
      case 'toggleNotes':
        this.requestPanelShortcut(record.tabId, PANEL_SHORTCUT_TARGETS[action])
        return
    }
  }

  /** Publish the popup windows the browser holds, whole, after any change. */
  private publishPopupWindows(): void {
    if (this.window.webContents.isDestroyed()) return
    sendToRenderer(this.window.webContents, 'browser:popupWindows', this.popupWindows.list())
  }

  /**
   * The tab that owns a page inside one project's browser session.
   *
   * A page is either a tab's own or a popup window's, and the reports that arrive
   * with a `WebContents`   a permission a page asks for, a file it downloads   name
   * the tab the user was reading, so the prompt and the download row belong to
   * something on screen.
   */
  private tabIdForContents(projectId: string, contentsId: number): string | undefined {
    for (const [tabId, tab] of this.tabs) {
      if (tab.projectId === projectId && tab.view.webContents.id === contentsId) return tabId
    }
    const ownerTabId = this.popupWindows.tabIdForContents(contentsId)
    if (!ownerTabId) return undefined
    const owner = this.tabs.get(ownerTabId)
    return owner && owner.projectId === projectId ? ownerTabId : undefined
  }

  private requireTab(tabId: string): BrowserTab {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Browser tab does not exist')
    return tab
  }

  /**
   * Whether a tab is showing a `view-source:` document.
   *
   * Chromium renders one as static text and never runs page scripts in it, and
   * `executeJavaScript` against such a document never settles. The document
   * shims that would otherwise be injected into it are therefore skipped, which
   * keeps every injection point from parking on a promise that cannot resolve.
   */
  private isViewSourceDocument(contents: WebContents): boolean {
    return contents.isDestroyed() || contents.getURL().startsWith('view-source:')
  }

  /** Install the capture observer into a tab's main frame. Called again after
   *  every navigation, because an observer lives in one document's world. */
  private watchCaptureMainFrame(tabId: string, contents: WebContents): void {
    if (this.isViewSourceDocument(contents)) return
    this.capture.watch(tabId, contents.mainFrame)
  }

  private sessionForProject(projectId: string): Session {
    const partition = `${BROWSER_PARTITION_PREFIX}${projectId}`
    const browserSession = session.fromPartition(partition)
    if (this.configuredSessions.has(partition)) return browserSession
    // Reuse the ledgers the durable memory loaded: a fresh set here would throw
    // away every decision the user already made, so a site the user allowed in
    // an earlier run would be prompted again the first time it asked.
    const grants = permissionLedgerForPartition(this.permissionGrants, partition)
    const denies = permissionLedgerForPartition(this.permissionDenies, partition)
    browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      const origin = permissionOrigin(requestingOrigin)
      if (!origin) return false
      const key = permissionCheckKey(origin, permission, Reflect.get(details, 'mediaType'))
      // A remembered "Don't allow" wins over any cached grant for the same key.
      return !denies.has(key) && grants.has(key)
    })
    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const requestingUrl = Reflect.get(details, 'requestingUrl')
      const securityOrigin = Reflect.get(details, 'securityOrigin')
      const origin = permissionOrigin(
        typeof requestingUrl === 'string' && requestingUrl.length > 0
          ? requestingUrl
          : typeof securityOrigin === 'string' && securityOrigin.length > 0
            ? securityOrigin
            : contents.getURL()
      )
      // A popup window's page asks for its own permissions   a camera prompt in a
      // popup is the same decision as one in a tab. The owner tab is what the
      // prompt is labelled with and what a grant is remembered against.
      const tabId = this.tabIdForContents(projectId, contents.id)
      if (!tabId || !origin || this.window.webContents.isDestroyed()) {
        callback(false)
        return
      }
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
      // Nothing in this instance's ledgers covers the request, but the durable
      // memory is shared with every other running instance: re-read it before
      // asking, and answer from it when the decision is already there. The
      // pending entry (and its timeout) is live while that read is in flight, so
      // a slow or failed read still ends in the prompt on screen instead of a
      // stranded request.
      void this.promptFromDurableMemory(id)
    })
    browserSession.on('will-download', (event, item, contents) => {
      this.downloadTracker.handleDownload(projectId, item, contents.id)
    })
    this.configuredSessions.add(partition)
    return browserSession
  }

  /**
   * Answer a pending request from the durable memory when it already holds the
   * decision, otherwise put the prompt on screen.
   *
   * The prompt is shown after the read, so a permission the user already granted
   * (in this run of another instance, or before a restart) is never asked for
   * again just because this instance's ledgers had not caught up yet.
   */
  private async promptFromDurableMemory(id: string): Promise<void> {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return
    try {
      await this.permissionMemory.refresh(this.permissionLedgers())
    } catch (error: unknown) {
      Logger.error('Browser permission memory could not be refreshed:', error)
    }
    // The user may have answered, or the request may have timed out, while the
    // read was in flight.
    const remaining = this.pendingPermissions.get(id)
    if (!remaining) return
    const partition = `${BROWSER_PARTITION_PREFIX}${remaining.request.projectId}`
    const outcome = rememberedPermissionOutcome(
      permissionGrantKeys(remaining.request),
      this.permissionGrants.get(partition),
      this.permissionDenies.get(partition)
    )
    if (outcome === 'grant') {
      this.resolvePermission(id, permissionSilentGrant)
      return
    }
    if (outcome === 'deny') {
      this.resolvePermission(id, permissionResolutions.dismiss)
      return
    }
    // Native OS popup composites above the WebContentsView: the page stays
    // live and interactive while the prompt is on screen.
    const tab = this.tabs.get(remaining.request.tabId)
    this.promptWindow.show(
      {
        request: remaining.request,
        queueSize: this.pendingPermissions.size,
        projectLabel: tab ? this.permissionLabel(tab) : null
      },
      this.promptAnchor()
    )
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
    // The store owns the clear so a permission read already in flight cannot
    // merge the forgotten keys back after the user asked for them to be gone.
    void this.permissionMemory
      .forget(partition, this.permissionLedgers())
      .catch((error: unknown) => {
        Logger.error('Browser permission memory could not be saved:', error)
      })
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
    if (this.isViewSourceDocument(contents)) return
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

  /** Open the page-level context menu anchored at a point (the toolbar's page
   *  menu and the host's fallback for a click the native view did not take). The
   *  right-click menu is this same page section plus the point-specific ones. */
  private showPageMenu(tabId: string, x: number, y: number): void {
    if (this.window.isDestroyed()) return
    const tab = this.requireTab(tabId)
    const page = menuPageFor(tabId, tab)
    const menu = Menu.buildFromTemplate(
      buildBrowserPageMenuItems(
        this.contextMenuContext(page.contents),
        this.contextMenuActions(page)
      )
    )
    menu.popup({ window: this.window, x, y })
  }

  /**
   * Open the full right-click menu for one point in a tab's page.
   *
   * The OS popup composites above the native view, so the page never detaches
   * for the menu. The reported point is in the view's own coordinates, so it is
   * translated into the window's content space the popup expects; when the
   * tab's on-screen frame is not known the popup falls back to the pointer.
   */
  private showTabContextMenu(tabId: string, params: Electron.ContextMenuParams): void {
    const tab = this.tabs.get(tabId)
    if (!tab || this.window.isDestroyed() || tab.view.webContents.isDestroyed()) return
    const frame = this.activeTabId === tabId ? this.activeTabBounds : null
    this.showPageContextMenu(menuPageFor(tabId, tab), params, frame)
  }

  /**
   * Open the full right-click menu for one point in a popup window's page.
   *
   * It is the same menu a tab's page gets, over the popup's own page and anchored
   * at the frame the rail has it on screen at.
   */
  private showPopupWindowContextMenu(
    record: BrowserPopupWindowRecord,
    params: Electron.ContextMenuParams
  ): void {
    const contents = record.view.webContents
    if (contents.isDestroyed() || this.window.isDestroyed()) return
    this.showPageContextMenu(
      { contents, owner: popupPageOwner(record) },
      params,
      record.displayedBounds
    )
  }

  /** Build and pop the point-specific context menu for one page. */
  private showPageContextMenu(
    page: BrowserMenuPage,
    params: Electron.ContextMenuParams,
    frame: BrowserViewBounds | null
  ): void {
    const menu = Menu.buildFromTemplate(
      buildBrowserContextMenuItems(
        params,
        this.contextMenuContext(page.contents),
        this.contextMenuActions(page)
      )
    )
    // The point Electron reports is in the page's own coordinates, and a native
    // menu wants the window's, so the frame the page is displayed at is added.
    if (frame) menu.popup({ window: this.window, x: frame.x + params.x, y: frame.y + params.y })
    else menu.popup({ window: this.window })
  }

  /** Live facts the context menu needs about a page. */
  private contextMenuContext(contents: WebContents): BrowserContextMenuContext {
    return {
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      searchEngineName: this.contextMenuSearchEngine.name
    }
  }

  /**
   * The actions a page's context menu can run.
   *
   * Every action re-checks that its page is alive when it fires, because the menu
   * can outlive the page it was opened over. A link or media URL the browser's
   * navigation policy refuses is dropped with a log rather than opened.
   *
   * One set serves a tab's page and a popup window's, because the menu offers the
   * same actions over both: what differs is only which page they act on and which
   * tab a page they open belongs to.
   */
  private contextMenuActions(page: BrowserMenuPage): BrowserContextMenuActions {
    const contents = page.contents
    const owner = page.owner
    const live = (): WebContents | null =>
      contents.isDestroyed() || this.window.isDestroyed() ? null : contents
    const openInNewTab = (url: string): void => {
      try {
        this.openNewTabFor(owner, validateBrowserUrl(url), 'a context-menu link')
      } catch (error: unknown) {
        Logger.error('Browser context menu refused a link:', error)
      }
    }
    const saveAs = (url: string): void => {
      try {
        live()?.downloadURL(validateBrowserUrl(url))
      } catch (error: unknown) {
        Logger.error('Browser context menu refused a download:', error)
      }
    }
    return {
      goBack: () => {
        const current = live()
        if (current?.navigationHistory.canGoBack()) current.navigationHistory.goBack()
      },
      goForward: () => {
        const current = live()
        if (current?.navigationHistory.canGoForward()) current.navigationHistory.goForward()
      },
      reload: () => live()?.reload(),
      hardReload: () => live()?.reloadIgnoringCache(),
      savePage: () => void this.savePage(contents),
      print: () => live()?.print({}),
      viewSource: () => this.openViewSourceInNewTab(page),
      copyPageAddress: () => {
        const current = live()
        if (current) clipboard.writeText(current.getURL())
      },
      inspectElement: (x, y) => live()?.inspectElement(x, y),
      selectAll: () => live()?.selectAll(),
      openLinkInNewTab: openInNewTab,
      saveLinkAs: saveAs,
      openMediaInNewTab: openInNewTab,
      saveMediaAs: saveAs,
      copyImage: (x, y) => live()?.copyImageAt(x, y),
      copyAddress: (url) => clipboard.writeText(url),
      copyText: (text) => clipboard.writeText(text),
      searchFor: (text) => this.searchSelectionInNewTab(owner, text),
      undo: () => live()?.undo(),
      redo: () => live()?.redo(),
      cut: () => live()?.cut(),
      copy: () => live()?.copy(),
      paste: () => live()?.paste(),
      pasteAndMatchStyle: () => live()?.pasteAndMatchStyle(),
      deleteSelection: () => live()?.delete(),
      replaceMisspelling: (word) => live()?.replaceMisspelling(word)
    }
  }

  /**
   * Create a tab in the same project and thread as `source`, load it, and ask
   * the renderer to show it.
   *
   * Shared by the links and popups a page opens and by the context-menu actions
   * that open an address in a new tab, so every new tab is parked, loaded and
   * announced the same way.
   */
  private openNewTabFor(owner: BrowserPageOwner, url: string, reason: string): void {
    const tabId = `browser:${crypto.randomUUID()}`
    const tab = this.ensureTab(tabId, owner.projectId, owner.threadId)
    tab.initialNavigationStarted = true
    this.parkTab(tabId, { reason })
    this.load(tabId, url)
    sendToRenderer(this.window.webContents, 'browser:openRequested', url, {
      projectId: owner.projectId,
      threadId: owner.threadId,
      requestedTabId: tabId,
      reveal: true
    })
  }

  /**
   * Open the current document's source in a new tab.
   *
   * Chromium renders `view-source:` itself, but the browser's navigation
   * validation accepts http and https only, so this is a main-initiated load the
   * page's own navigation rules never see. The displayed address keeps the
   * `view-source:` prefix, exactly as a normal browser shows it.
   */
  private openViewSourceInNewTab(page: BrowserMenuPage): void {
    const contents = page.contents
    if (contents.isDestroyed()) return
    const current = contents.getURL()
    const inner = current.startsWith('view-source:')
      ? current.slice('view-source:'.length)
      : current
    let target: string
    try {
      target = `view-source:${validateBrowserUrl(inner)}`
    } catch {
      return
    }
    const tabId = `browser:${crypto.randomUUID()}`
    const sourceTab = this.ensureTab(tabId, page.owner.projectId, page.owner.threadId)
    sourceTab.initialNavigationStarted = true
    this.parkTab(tabId, { reason: 'the user opened a page source' })
    this.navigateTo(tabId, target)
    sendToRenderer(this.window.webContents, 'browser:openRequested', target, {
      projectId: page.owner.projectId,
      threadId: page.owner.threadId,
      requestedTabId: tabId,
      reveal: true
    })
  }

  /** Run the context-menu web search in a new tab, using the reported engine. */
  private searchSelectionInNewTab(owner: BrowserPageOwner, query: string): void {
    const url = buildBrowserSearchUrl(this.contextMenuSearchEngine, query)
    if (!url) return
    try {
      this.openNewTabFor(owner, validateBrowserUrl(url), 'a context-menu web search')
    } catch (error: unknown) {
      Logger.error('Browser context menu could not run a search:', error)
    }
  }

  /**
   * Settle the error state of the tab once a navigation has finished.
   *
   * A network failure and a crash are already final; an HTTP error status is
   * only this app's error to show when the page it served has nothing visible in
   * it, so that one case is read from the page before it is published. Identity is
   * re-checked after the read, because the user can navigate again while it is in
   * flight.
   */
  private resolveLoadOutcome(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const failure = tab.navigationFailure
    if (!failure || failure.kind !== 'http') {
      this.setTabLoadError(tabId, failure)
      return
    }
    void this.documentHasNothingToShow(tab.view.webContents).then((nothingVisible) => {
      const current = this.tabs.get(tabId)
      if (!current || current.navigationFailure !== failure) return
      this.setTabLoadError(tabId, nothingVisible ? failure : null)
    })
  }

  /** Publish a tab's load error only when it actually changed. */
  private setTabLoadError(tabId: string, error: BrowserLoadError | null): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const previous = tab.loadError
    if (previous === error) return
    if (
      previous !== null &&
      error !== null &&
      previous.kind === error.kind &&
      previous.code === error.code &&
      previous.description === error.description
    ) {
      return
    }
    tab.loadError = error
    this.publishState(tabId)
  }

  /**
   * Whether the loaded document shows the user anything at all.
   *
   * The catch-all rule for an HTTP error status: the app stands in only when the
   * server's own answer has nothing to look at, and never covers a page that did
   * render. Empty is judged by what is on screen, not by markup: an error body
   * with a container but no text, image, control or drawn media is still a blank
   * frame to the user, while any visible text or rendered element is the site's
   * own page and is left alone.
   *
   * Read in the page's own world: the main process cannot see page markup, and
   * `innerText` already excludes hidden text. Any failure to answer is read as
   * "has content", so a real page is never masked by a probe that could not run.
   */
  private async documentHasNothingToShow(contents: WebContents): Promise<boolean> {
    // A `view-source:` document never runs scripts, so the probe could not
    // settle on it; it is treated as having content, which it plainly does.
    if (this.isViewSourceDocument(contents)) return false
    try {
      const result: unknown = await contents.executeJavaScript(
        '(function () {' +
          ' var body = document.body; if (!body) return true;' +
          ' if ((body.innerText || "").trim().length > 0) return false;' +
          ' var nodes = body.querySelectorAll("img, svg, canvas, video, audio, iframe, embed, object, input, button, select, textarea, [style*=background], [style*=Background]");' +
          ' for (var i = 0; i < nodes.length; i++) {' +
          '  var rect = nodes[i].getBoundingClientRect();' +
          '  if (rect.width > 1 && rect.height > 1) return false;' +
          ' }' +
          ' return true;' +
          '})()'
      )
      return result === true
    } catch {
      return false
    }
  }

  private stateFor(tabId: string, tab: BrowserTab): BrowserPageState {
    const contents = tab.view.webContents
    return {
      tabId,
      url: contents.getURL(),
      title: contents.getTitle(),
      favicon: tab.favicon,
      loading: contents.isLoading(),
      loadError: tab.loadError,
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
      if (parented.has(tab.view)) {
        this.parkTab(tabId, { reason: 'the renderer reloaded or crashed' })
      }
    }
  }

  /**
   * The viewport a tab is laid out at while it is parked offscreen.
   *
   * The newest of the two records wins, because the newest one is the size
   * something actually asked the page to be: an agent's explicit request, or the
   * frame the user was reading the tab at. A tab that was never displayed and
   * never asked for a viewport is mounted at `DEFAULT_PARKED_VIEWPORT`.
   */
  private parkedViewportFor(tab: BrowserTab): BrowserViewport {
    const requested = tab.requestedViewport
    const displayed = tab.displayedViewport
    if (displayed && (!requested || requested.at <= displayed.at)) return displayed.viewport
    return requested?.viewport ?? DEFAULT_PARKED_VIEWPORT
  }

  /**
   * Carry out a hide the renderer asked for after a short grace window, so a show
   * that lands inside it cancels the park instead of being served a view that was
   * pulled out from under it for a frame.
   *
   * See `RENDERER_PARK_GRACE_MS`: the renderer's answer to "is this surface still
   * showing the page" is recomputed every frame and flaps, and a park that a
   * re-attach follows a few milliseconds later is a visible flicker of a page
   * nothing asked to move. A hide no show ever contradicts still parks, a few
   * frames after the decision that produced it.
   */
  private schedulePark(tabId: string, reason: string): void {
    if (this.pendingParks.has(tabId)) return
    const handle = setTimeout(() => {
      this.pendingParks.delete(tabId)
      this.parkTab(tabId, { reason })
    }, RENDERER_PARK_GRACE_MS)
    this.pendingParks.set(tabId, { handle, at: Date.now() })
  }

  /** Drop a deferred hide, because the tab is being shown again after all. */
  private cancelPendingPark(tabId: string): void {
    const pending = this.dropPendingPark(tabId)
    if (pending === null) return
    // Dev-only, and deliberately one line per cancelled hide: it is the record
    // that the page never left the screen, and that the hide which would have
    // taken it off was the renderer's own answer flapping rather than a surface
    // change the user made.
    Logger.dev('Browser view park cancelled', {
      tabId,
      afterMs: Date.now() - pending.at
    })
  }

  /**
   * Forget a deferred hide silently, for the two callers whose park is settled
   * some other way: the park itself, and the tab being destroyed. Their cancelled
   * timer is bookkeeping, and logging it as a cancelled park would read as a page
   * that stayed on screen when it is about to leave.
   */
  private dropPendingPark(tabId: string): { at: number } | null {
    const pending = this.pendingParks.get(tabId)
    if (pending === undefined) return null
    clearTimeout(pending.handle)
    this.pendingParks.delete(tabId)
    return pending
  }

  /**
   * Park a tab in an invisible stage window, where it keeps a real viewport and
   * keeps producing frames no matter what the user is looking at.
   *
   * The page is laid out at `options.size` when a caller has one to insist on
   * (the toast case, which must preserve the frame the user is looking at), and at
   * the tab's own parked viewport otherwise. Every park carries a reason and is
   * logged at dev level: a recorded frame of the browser surface can then be
   * matched to the moment that produced it.
   */
  private parkTab(tabId: string, options: ParkBrowserTabOptions): void {
    // The park this timer was going to do is happening now, so it is spent.
    this.dropPendingPark(tabId)
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return
    // A deferred hide can land after the app window is gone (the app is quitting),
    // and there is no child list left to take the view out of.
    if (this.window.isDestroyed()) return
    // A switch waiting for this tab is spent only when the park is a real
    // departure. A keep-active park (a toast holding the view off) leaves the tab
    // as the one on screen, so the switch has to survive until the page comes back
    // and `showActiveView` can honour it.
    if (!options.keepActive && this.pendingPageFocusTabId === tabId) {
      this.pendingPageFocusTabId = null
    }
    const viewport = options.size ?? this.parkedViewportFor(tab)
    // Whether this view is the one the app window is showing: a park only re-lays
    // the page out when it takes a view off the screen and gives it another size.
    const wasOnScreen = this.displayedTab?.tabId === tabId
    this.window.contentView.removeChildView(tab.view)
    // The view is leaving the window, so whatever frame it was displayed at no
    // longer describes where it is.
    if (this.displayedTab?.tabId === tabId) this.displayedTab = null
    this.stage.park(tab.view, viewport)
    this.markParked(tabId)
    if (this.activeTabId === tabId && !options.keepActive) {
      this.activeTabId = null
      this.activeTabBounds = null
    }
    this.enforceParkedCap(tabId)
    // Dev-only, and deliberately one line per park: a recorded frame of the
    // browser surface can then be matched against the park, the size it laid the
    // page out at, and whether that size was a change the page had to reflow for.
    Logger.dev('Browser view parked', {
      tabId,
      reason: options.reason,
      viewport,
      relayout: wasOnScreen && !isSameViewport(tab.displayedViewport?.viewport, viewport)
    })
    // A stage window the window server stopped showing would silently freeze the
    // page (that is how a parked view dies), so confirm it once per park and hand
    // the tab a fresh window if it did not take. Fire and forget: parking must
    // not block the caller.
    void this.stage.verifyVisible(tab.view).then((visible) => {
      if (visible || !this.stage.isParked(tab.view)) return
      Logger.dev('Reparking a browser tab whose stage window stopped rendering', { tabId })
      const current = this.tabs.get(tabId)
      this.stage.restart(tab.view, current ? this.parkedViewportFor(current) : viewport)
    })
  }

  /**
   * Deliver the current pointer position to a page that has just come back on
   * screen.
   *
   * While a tab is parked its view sits in the stage window, so the pointer is not
   * over the page any more and the page is told the pointer left. Chromium
   * rebuilds hover state and the cursor shape only from an input event, so without
   * this the page keeps what it decided back then: `cursor: pointer` never comes
   * back, hover menus stay shut, and drag affordances stay inert until the user
   * physically moves the mouse. One real mouse move, at the position the pointer
   * is actually at, restores the state the user can already see they are in.
   */
  private primePagePointer(tab: BrowserTab, bounds: BrowserViewBounds | null): void {
    if (bounds === null || this.window.isDestroyed()) return
    if (tab.view.webContents.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const content = this.window.getContentBounds()
    const x = Math.round(cursor.x - content.x - bounds.x)
    const y = Math.round(cursor.y - content.y - bounds.y)
    // A pointer that is not over the page must not be reported as if it were: the
    // page would gain a hover the user is not pointing at.
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return
    tab.view.webContents.sendInputEvent({ type: 'mouseMove', x, y })
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
        // A size change re-lays the page out and hands it a new surface, which is
        // worth seeing in the dev log next to a parked or re-attached view: the
        // three together are what a recorded frame of this surface can be matched
        // against. A position-only move re-lays nothing out.
        if (bounds.width !== displayed.bounds.width || bounds.height !== displayed.bounds.height) {
          Logger.dev('Browser view resized', { tabId, from: displayed.bounds, to: bounds })
        }
      }
      // The page is already on screen, which is the one moment a held switch can
      // be honoured without waiting for another show.
      this.takePendingPageFocus(tabId)
      return
    }
    // A view the stage was holding is off the window, so the page has already been
    // told the pointer left it and needs the pointer position again once it is
    // back. Recorded before the release, which is what clears the parked state.
    const wasParked = this.stage.isParked(tab.view)
    this.stage.release(tab.view)
    this.forgetParked(tabId)
    this.window.contentView.addChildView(tab.view)
    if (bounds !== null) {
      this.displayedTab = { tabId, bounds }
      tab.view.setBounds(bounds)
    }
    // A page that has just landed needs the pointer delivered again. Chromium
    // rebuilds hover and the cursor shape only from an input event, and the page
    // may have been told the pointer left while it was off screen: that is true
    // of a park, and equally of a view the parked cap evicted or one being
    // attached for the first time under a resting pointer. So this runs on every
    // attach, not only a stage re-attach, or `cursor: pointer` never comes back
    // until the user physically moves the mouse.
    this.primePagePointer(tab, bounds)
    if (wasParked) {
      Logger.dev('Browser view re-attached', { tabId, bounds })
    }
    // A page that just landed is on screen now, so a switch that was waiting for
    // it takes the keyboard here.
    this.takePendingPageFocus(tabId)
  }

  /**
   * Give a tab's page the keyboard, or remember that it wants it.
   *
   * The page is a native view above the DOM, so DOM focus in the app chrome never
   * lands on it and a tab switch has to hand it over deliberately. A page that is
   * not the one on screen yet   a show still in flight, a toast holding the view
   * off, a tab main has not even heard of   keeps the intent until it is shown.
   */
  private focusPage(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab && !tab.view.webContents.isDestroyed() && this.isPageOnScreen(tabId)) {
      this.pendingPageFocusTabId = null
      this.focusPageView(tabId, tab)
      return
    }
    this.pendingPageFocusTabId = tabId
  }

  /**
   * Hand a page the keyboard and re-deliver the pointer to it.
   *
   * Focus alone is not enough: moving focus away from the page and back leaves
   * the cursor whatever the app chrome set, and Chromium rebuilds hover and the
   * cursor shape only from an input event. So a focus handover is followed by the
   * same prime a re-attach uses, which is what makes `cursor: pointer` come back
   * the moment a switch lands on the tab rather than at the next mouse move.
   */
  private focusPageView(tabId: string, tab: BrowserTab): void {
    tab.view.webContents.focus()
    this.primePagePointer(tab, this.activeTabId === tabId ? this.activeTabBounds : null)
  }

  /** Whether a tab's page is the native view the window is currently showing. */
  private isPageOnScreen(tabId: string): boolean {
    if (this.toastVisible || this.activeTabId !== tabId) return false
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return false
    return this.displayedTab?.tabId === tabId && !this.stage.isParked(tab.view)
  }

  /** Focus the page a switch asked for, now that it is the one on screen. The
   *  intent is spent either way it resolves, so a stale one cannot fire later. */
  private takePendingPageFocus(tabId: string): void {
    if (this.pendingPageFocusTabId !== tabId) return
    this.pendingPageFocusTabId = null
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return
    this.focusPageView(tabId, tab)
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

  /** Pull a tab out of the app window when a toast has nowhere else to go, and
   *  put it back afterwards, so the DOM toast composites normally without the page
   *  losing its viewport. */
  private setToastVisible(visible: boolean): void {
    this.toastVisible = visible
    // A popup window's page is a native view too, so a DOM toast under it would be
    // invisible. It steps aside with the tab's page and comes back at the same
    // frame, which is what keeps a momentary toast from resizing a page.
    this.popupWindows.setSuspended(visible)
    if (!this.activeTabId) return
    const tab = this.tabs.get(this.activeTabId)
    if (!tab) return
    if (visible) {
      // The on-screen frame is the whole point of this park: the toast is on screen
      // for a moment and the page must come back at the size the user left it at.
      this.parkTab(this.activeTabId, {
        size: this.activeTabBounds ?? this.parkedViewportFor(tab),
        keepActive: true,
        reason: 'toast on screen'
      })
      return
    }
    this.showActiveView()
  }

  private destroy(tabId: string): void {
    // A hide that is still inside its grace window must not park a tab that is
    // about to be gone: the view would be handed to the stage window only to be
    // destroyed.
    this.dropPendingPark(tabId)
    const tab = this.tabs.get(tabId)
    if (!tab) return
    // A popup window is the tab's own window as far as the user is concerned, so
    // closing the tab closes what its page opened rather than leaving a sign-in
    // stranded behind a tab that no longer exists.
    this.popupWindows.closeForTab(tabId, 'its tab closed')
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
    this.scrollbarStyles.delete(tabId)
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
