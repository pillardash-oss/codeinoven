import {
  showBrowserNewTabMenu,
  validateBrowserNewTabMenuInput
} from './browser-service/browser-new-tab-menu'
import {
  restoreBrowserSessionCookies,
  waitBrowserSessionCookies,
  flushBrowserSessionCookiesFor
} from './browser-service/browser-session-cookies'
import {
  validateNativeDockAck,
  validateNativeDockId,
  validateNativeDockCommit,
  validateNativeDockInteraction,
  validateNativeDockRequest
} from '../../lib/native-dock'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain as electronIpcMain,
  Menu,
  screen,
  session,
  shell,
  systemPreferences,
  webContents,
  webFrameMain,
  WebContentsView,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
  type WebFrameMain
} from 'electron'
import type { Database } from '../database/database'
import { createHash } from 'node:crypto'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { PermissionLevel, Project, Thread } from '../../lib/types'
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
  BrowserFindRequest,
  BrowserFindStopAction,
  BrowserLoadError,
  BrowserPageState,
  BrowserPanelShortcutAction,
  BrowserPermissionRequest,
  BrowserShortcutAction,
  BrowserShortcutBindings,
  BrowserSwitcherBindings,
  BrowserTabDestroyReason,
  BrowserScrollbarTheme,
  BrowserTransportCommand,
  BrowserViewBounds
} from '../../lib/ipc-contract'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../lib/ipc-contract'
import {
  browserActionTargetScript,
  reviewBrowserAction,
  type BrowserActionTarget,
  type BrowserActionReview
} from './browser-service/browser-action-policy'
import { isVideoCaptureUrl } from '../../lib/video/project'
import {
  boundedBrowserTabHistory,
  type BrowserTabHistoryRecord
} from '../../lib/browser/browser-tab-history'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { getGlobalBrowserContextMenuBoxes } from '../ipc/global-browser-ipc'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'
import { getConfigRoot } from '../../lib/utils'
import type {
  BrowserExtensionActivityUpdate,
  BrowserExtensionMenuRecord,
  BrowserExtensionProgress
} from '../../lib/ipc/browser'
import {
  BrowserExtensionService,
  type BrowserExtensionActionPopupOpenRequest,
  type BrowserExtensionSidePanelOpenRequest,
  type BrowserExtensionTabEventName,
  type BrowserExtensionTabReplay,
  type BrowserExtensionWebNavigationEventName
} from './extensions/browser-extension-service'
import {
  validateExtensionId,
  validateExtensionInstallInput,
  validateExtensionUpdatePatch
} from './extensions/browser-extension-validation'
import { fetchIconAsDataUrl } from '../editor/favicon-service'
import { PermissionPromptWindow } from './permission-prompt-window'
import { BrowserOverlayWindow } from './browser-overlay-window'
import { browserStatusOverlayPlacement, type BrowserStatusOverlay } from '../../lib/browser-overlay'
import {
  BrowserDownloadManager,
  type BrowserDownloadOwner
} from './browser-service/browser-downloads'
import { showBrowserBoxMenu } from './browser-service/browser-box-menu'
import { showBrowserTabSelectionMenu } from './browser-service/browser-tab-selection-menu'
import { showBrowserTabContextMenu } from './browser-service/browser-tab-context-menu'
import { showBrowserAgentTabMenu } from './browser-service/browser-agent-tab-menu'
import {
  showBrowserExtensionMenu,
  validateBrowserExtensionMenuInput
} from './browser-service/browser-extension-menu'
import { BrowserTabHistoryStore } from './browser-tab-history-store'
import { BrowserClosedTabHistory } from './browser-closed-tab-history'
import { BrowserCaptureObserver } from './browser-service/browser-capture'
import { BrowserInspector } from './browser-service/browser-inspector'
import { BrowserSiteDataService } from './browser-service/browser-site-data'
import {
  BrowserPopupWindows,
  type BrowserPopupWindowHost,
  type BrowserPopupWindowRecord
} from './browser-service/browser-popup-windows'
import {
  BrowserExtensionSidePanels,
  type BrowserExtensionSidePanelHost
} from './browser-service/browser-extension-side-panels'
import { dialogContextScript } from './browser-service/browser-dialog-context'
import {
  buildBrowserContextMenuItems,
  buildBrowserPageMenuItems,
  buildExtensionMenuItems,
  extensionClickContexts,
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
  screenCaptureDeniedInLedger,
  sitePermissionDescriptor,
  sitePermissionState,
  type PermissionResolution
} from './browser-service/browser-permissions'
import {
  BrowserPermissionMemory,
  type PermissionMemoryPersistence
} from './browser-service/browser-permission-memory'
import {
  BrowserScreenShareService,
  type BrowserScreenShareOwner
} from './browser-service/browser-screen-share'
import {
  EXTERNAL_PROTOCOL_PERMISSION,
  externalProtocolTarget,
  type ExternalProtocolTarget
} from '../../lib/browser/external-protocol'
import {
  type BrowserPageOwner,
  type BrowserTab,
  type BrowserViewport,
  type ParkBrowserTabOptions,
  type PendingBrowserPermission
} from './browser-service/browser-types'
import {
  isAbortedNavigation,
  RESTORE_SETTLE_TIMEOUT_MS,
  restoreNeedsFallbackLoad
} from './browser-service/browser-navigation-outcome'
import {
  parsePeekProbeAnswer,
  peekPointInFrame,
  peekProbePoint,
  peekProbeScript,
  PEEK_ORIGIN_PROBE_TIMEOUT_MS,
  PEEK_SNAPSHOT_MAX_WIDTH,
  resolvePeekOrigin,
  type BrowserPeekPoint,
  type BrowserPeekRect
} from './browser-service/browser-peek'
import { BrowserTabStage } from './browser-service/browser-stage'
import {
  listBrowserProfilesForPartition,
  listProjectBrowserProfiles,
  removeBrowserProfiles
} from './browser-service/browser-profile-store'
import { applyBrowserPageBackground } from './browser-service/browser-page-background'
import { installBrowserHistorySwipe } from './browser-service/browser-history-swipe'
import {
  AGENT_REVEAL_GRACE_MS,
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
  boundedBoxLabel,
  browserContextKey,
  boxIdFromPartition,
  browserJarFor,
  browserPartitionFor,
  isAllowedPopupWindowUrl,
  isSameBounds,
  popupWindowViewport,
  safeBasename,
  validateAttention,
  validateBounds,
  validateBoundedHost,
  validateBrowserBoxMenuInput,
  validateBrowserSearchEngine,
  validateBrowserShortcutBindings,
  validateBrowserStripInteraction,
  validateBrowserStripOverlayRequest,
  validateBrowserSwitcherBindings,
  validateBrowserUrl,
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
  validateThreadId,
  validateToastOverlayAck,
  validateToastOverlayInteraction,
  validateToastOverlayRequest,
  validateTransportCommand,
  validateTransportValue,
  validateViewportRequest
} from './browser-service/browser-validation'
import { designScreenTabId } from './browser-service/design-screen-tab'

/**
 * Where a renderer-owned shortcut lands. The key is decided in this process,
 * which is the only one that sees it before the application menu, and the tab
 * strip stays the renderer's: it opens, closes and focuses its own tabs.
 */
const PANEL_SHORTCUT_TARGETS: Readonly<
  Record<
    | 'focusAddress'
    | 'closeTab'
    | 'newTab'
    | 'reopenTab'
    | 'toggleNotes'
    | 'find'
    | 'findNext'
    | 'findPrevious',
    BrowserPanelShortcutAction
  >
> = {
  focusAddress: 'focus-address',
  closeTab: 'close-tab',
  newTab: 'new-tab',
  reopenTab: 'reopen-tab',
  toggleNotes: 'toggle-notes',
  find: 'find',
  findNext: 'find-next',
  findPrevious: 'find-previous'
}

/**
 * Browser chords a popup window deliberately leaves unclaimed.
 *
 * Find is the chrome's own tool: its bar is a row of the surface that shows the
 * page, and a popup's page is shown by the rail, which carries no toolbar of its
 * own by design. Claiming the chord in a popup would swallow the key and open
 * nothing, so it is left to the page instead.
 */
const POPUP_UNCLAIMED_ACTIONS: ReadonlySet<BrowserShortcutAction> = new Set<BrowserShortcutAction>([
  'find',
  'findNext',
  'findPrevious'
])

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
  EXTENSION_PAGE_TABS_CHANNEL,
  EXTENSION_PAGE_TABS_PRELOAD_FILE,
  extensionPageTabsPreloadSource,
  extensionPageTabsScript,
  type BrowserExtensionPageTab
} from './extensions/browser-extension-page-tabs'
import { resolveBrowserExtensionStoreDir } from './extensions/browser-extension-registry'
import {
  BrowserFindSessions,
  browserFindResultFor,
  validateBrowserFindRequest,
  validateBrowserFindStopAction
} from './browser-service/browser-find'
import { BrowserLoadWaits } from './browser-service/browser-load-wait'
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
/**
 * One tab as `chrome.tabs` describes it, for the lifecycle events the app
 * synthesizes into a worker. Only the fields an extension reads in practice are
 * carried; `index` is always 0 because this browser has one strip and no
 * reorderable per-window indices of its own.
 */
interface BrowserExtensionTabInfo {
  id: number
  index: number
  windowId: number
  windowType: 'normal'
  active: boolean
  pinned: boolean
  incognito: boolean
  url: string
  title: string
  status: 'loading' | 'complete'
}

function menuPageFor(tabId: string, tab: BrowserTab): BrowserMenuPage {
  return {
    contents: tab.view.webContents,
    owner: { tabId, projectId: tab.projectId, threadId: tab.threadId, boxId: tab.boxId }
  }
}

/** The owner of a popup window's page: the tab whose page opened it. */
function popupPageOwner(record: BrowserPopupWindowRecord): BrowserPageOwner {
  return {
    tabId: record.tabId,
    projectId: record.projectId,
    threadId: record.threadId,
    boxId: record.boxId
  }
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
 * URL of the frame that logged a console message, or null when there is none to
 * name.
 *
 * Reading the URL of a frame that is already gone throws, and a document with no
 * address of its own reports an empty one, so both edges answer null rather than
 * costing the entry it belongs to.
 */
function consoleFrameUrl(frame: WebFrameMain | null | undefined): string | null {
  if (!frame) return null
  try {
    return frame.url.length > 0 ? frame.url : null
  } catch {
    return null
  }
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

/**
 * The browser operations a page belonging to the user answers.
 *
 * A browser tab's assistant conversation answers about the page on screen, so its
 * browser capability is attached to that tab. Reading operations observe it;
 * mutations pass through action-aware Auto Review. File upload uses a native
 * file chooser or exact-file confirmation, while Full Access may name files.
 */
const ATTACHED_PAGE_READ_OPERATIONS = new Set(['snapshot', 'screenshot', 'console'])
const ATTACHED_PAGE_MUTATION_OPERATIONS = new Set([
  'click',
  'type',
  'navigate',
  'reload',
  'viewport',
  'upload'
])

/** Approval request for an agent mutation on the page the user is viewing. */
export interface BrowserAgentActionApproval {
  projectId: string
  threadId: string
  sessionId?: string
  operation: string
  /** Human-readable description shown on the permission card. */
  action: string
  origin: string
  pageUrl: string
  review: BrowserActionReview
}

/** Outcome of a permission-card approval. An alternative carries the user's correction. */
export interface BrowserAgentActionDecision {
  approved: boolean
  alternative?: string
}

/** Resolves an attached-page mutation through the permission card. */
export type BrowserAgentActionApprover = (
  request: BrowserAgentActionApproval
) => Promise<BrowserAgentActionDecision | boolean>

/** Owns sandboxed page content while the renderer owns the browser chrome. */
export class BrowserService {
  private readonly tabs = new Map<string, BrowserTab>()
  private readonly agentTabIds = new Map<string, string>()
  /**
   * The browser tab each assistant conversation answers about, by thread id.
   *
   * A browser tab's assistant chat is a real thread of its own rather than a tab,
   * so it owns no page: this is what lets its browser capability read the page the
   * user is on. The renderer writes it when the rail resolves the conversation and
   * it is dropped with the tab that carried it.
   */
  private readonly assistantPageTabIds = new Map<string, string>()
  private readonly configuredSessions = new Set<string>()
  private readonly permissionGrants = new Map<string, Set<string>>()
  private readonly permissionDenies = new Map<string, Set<string>>()
  private readonly pendingPermissions = new Map<string, PendingBrowserPermission>()
  private readonly capture: BrowserCaptureObserver
  /** Element inspector for design tabs. Injected page code reports picks and
   *  comments; the panel drives it through the browser IPC contract. */
  private readonly inspector: BrowserInspector
  private readonly siteData: BrowserSiteDataService
  /** The screen-share source picker for platforms without a native one, and the
   *  ledger gate that refuses a share the user remembered blocking. */
  private readonly screenShare: BrowserScreenShareService
  private readonly permissionMemory: BrowserPermissionMemory
  private readonly promptWindow: PermissionPromptWindow
  /**
   * The window that draws the toast stack and the floating tab strip while a page
   * covers where they belong. It is created on the first surface that needs it
   * and kept while a page keeps needing it, so a browsing session that never
   * raises a toast and never hovers the strip never pays for a second renderer.
   */
  private readonly overlay: BrowserOverlayWindow
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
  /**
   * The link target the pointer on the active page rests on, and the tab's page
   * that reported it, or null while none is.
   *
   * Kept raw beside the bubble so a page that moves under a resting pointer can
   * be re-placed from the same target rather than waiting for another hover.
   */
  private targetUrl: string | null = null
  private targetUrlTabId: string | null = null
  /** The link preview currently drawn by the overlay window, or null while none
   *  is. Compared against the next placement so a repeat frame is not a repaint. */
  private statusOverlay: BrowserStatusOverlay | null = null
  /** Chords the browser claims, resolved from the keymap by the renderer. Empty
   *  until that report arrives, which leaves every key to the rest of the app. */
  private shortcutBindings: BrowserShortcutBindings = {}
  /** The Ctrl+Tab switcher chords, pushed by the renderer from its keymap. A key
   *  pressed in a page never reaches the renderer, so main claims these here. */
  private switcherBindings: BrowserSwitcherBindings = []
  /**
   * Which find request each tab's page is answering.
   *
   * Chromium's find hands back a request id and every report carries it, so this
   * is what lets a report for a query the user has already moved past be dropped
   * rather than briefly overwriting the count on screen.
   */
  private readonly findSessions = new BrowserFindSessions()
  /**
   * The page-load waits every capture path shares.
   *
   * Held by the service so one page's listeners are one pair no matter how many
   * callers are waiting on it; see `BrowserLoadWaits` for why that matters.
   */
  private readonly loadWaits = new BrowserLoadWaits()
  /** Navigation starts waiting for the extension jar before Chromium sees loadURL. */
  private readonly pendingNavigationStarts = new Map<string, Promise<void>>()
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
   *  coordinates). The permission popup centres itself over this area, so the
   *  prompt opens over the page it belongs to rather than over the app's chrome. */
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
   * Hides the renderer asked for, with the handle waiting out their grace window.
   *
   * A surface switch unmounts one panel and mounts the next for the same tab, and
   * the renderer's own visibility answer is recomputed every frame, so it flaps:
   * a hide and the show that follows it describe one continuous view that never
   * actually left. Parking in between is a window-server teardown and a re-parent
   * the page feels, and a re-attach a few milliseconds later is a flicker of a
   * page nothing asked to move. So a hide waits `RENDERER_PARK_GRACE_MS` for a
   * show to cancel it, and a hide nothing contradicts still parks, a few frames
   * after the decision that produced it.
   */
  private readonly pendingParks = new Map<string, ReturnType<typeof setTimeout>>()
  /** The dialog-context label already installed in each tab's current document.
   *  The shim is idempotent per document, so a repeat is a script evaluation
   *  per frame for no change. Cleared when a new document commits. */
  private readonly injectedDialogLabels = new Map<string, string>()
  /** The last address each tab's main frame committed or moved to inside the
   *  page, so a navigation event can be told from a reload and a fragment change
   *  from a history push. Chromium's own transition is not exposed. */
  private readonly extensionNavigationUrls = new Map<string, string>()
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
   *  the active view stays detached and the DOM toast composites normally. This
   *  is the safety net for the one case the toast overlay cannot serve (it could
   *  not be created at all), not the primary path: the renderer normally moves
   *  the stack into `browser-overlay-window.ts`, which draws it above the page. */
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
  /**
   * Every tab's Back/Forward stack, made durable.
   *
   * The stack lives in the live `WebContentsView` and goes with it, and this
   * process is the only one that can read it off a view or that sees all three
   * moments it has to be written down: parking a view, destroying a tab, and
   * quitting. See `browser-tab-history-store.ts`.
   */
  private readonly tabHistory = new BrowserTabHistoryStore()
  /** Stacks of tabs closed this session, held only until the tab is reopened. */
  private readonly closedTabHistory = new BrowserClosedTabHistory()
  private peekTabs = new Map<string, string>()
  private consoleSequence = 0
  /**
   * The popup windows pages have opened, hosted by the app rather than by the
   * system. Created with the rest of the view plumbing below, because its host
   * is this service's own window handling.
   */
  private readonly popupWindows: BrowserPopupWindows
  /** One in-flight extension popup creation per project, box, and extension. */
  private readonly extensionPopupOpenings = new Map<string, Promise<string>>()
  /**
   * The extension side panels the rail hosts, over the frame it measures. A panel
   * is the extension's own document, loaded in the jar the extension runs in,
   * exactly as its action popup is, and `chrome.sidePanel` is compiled out of the
   * runtime so this is the only host one can have.
   */
  private readonly sidePanels: BrowserExtensionSidePanels
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
  /** The side-panel views currently mounted in the app window, tracked for the
   *  same reason the popup views are. */
  private readonly mountedSidePanelViews = new Set<WebContentsView>()
  /** The frame each mounted side-panel view was last placed at. */
  private readonly sidePanelViewFrames = new Map<WebContentsView, BrowserViewBounds>()
  /**
   * Installed extensions, and which jars load them.
   *
   * Built with the service because reading the registry is one small file, and
   * nothing actually loads an extension until a jar asks for a page: the cost of
   * the feature is per live jar, not per app launch.
   */
  private readonly extensions: BrowserExtensionService
  /**
   * Permission-card approver for attached-page mutations, supplied by the app
   * at boot. When present, Auto Review routes through the thread's permission
   * card instead of the native dialog, so the request sets `awaiting_approval`,
   * notifies attention, and stays covered by policy automation.
   */
  private agentActionApprover: BrowserAgentActionApprover | null = null

  constructor(
    private readonly window: BrowserWindow,
    db: Database,
    permissionPersistence: PermissionMemoryPersistence,
    private readonly downloads: BrowserDownloadManager
  ) {
    this.promptWindow = new PermissionPromptWindow(window)
    this.overlay = new BrowserOverlayWindow(window)
    // Chromium drops its own status bubble when the window loses the pointer's
    // context; so does this.
    window.on('blur', () => this.dismissStatusOverlay())
    this.stage = new BrowserTabStage(window)
    this.permissionMemory = new BrowserPermissionMemory(permissionPersistence)
    this.projects = new ProjectRepo(db)
    this.threads = new ThreadRepo(db)
    this.popupWindows = new BrowserPopupWindows(this.popupWindowHost())
    this.sidePanels = new BrowserExtensionSidePanels(this.sidePanelHost())
    // A download started by a popup window is the tab's download: the row the
    // user sees must name the tab they were reading, not a page with no strip.
    this.downloads.setTabResolver((projectId, contentsId) =>
      this.tabIdForContents(projectId, contentsId)
    )
    this.downloads.setOwnerResolver((contentsId) => this.ownerTabForContents(contentsId))
    this.siteData = new BrowserSiteDataService({
      window,
      sessionForJar: (projectId, boxId) => this.sessionForProject(projectId, boxId),
      projectJars: (projectId) => this.projectJars(projectId),
      forEachTab: (visit) => {
        for (const tab of this.tabs.values()) visit(tab)
      },
      dismissPermissions: (projectId) => this.dismissProjectPermissions(projectId),
      clearPermissionMemory: (projectId) => this.clearProjectPermissionMemory(projectId),
      cancelProjectDownloads: (projectId) => this.downloads.cancelProject(projectId),
      partitionFor: (projectId, boxId) => browserPartitionFor(projectId, boxId),
      sitePermissionState: (partition, keys) =>
        sitePermissionState(
          keys,
          this.permissionGrants.get(partition),
          this.permissionDenies.get(partition)
        ),
      reloadOriginTabs: (partition, origin) => this.reloadOriginTabs(partition, origin)
    })
    this.screenShare = new BrowserScreenShareService({
      window,
      resolveFrameOwner: (frame) => this.resolveScreenShareOwner(frame),
      isScreenShareDenied: (partition, origin) =>
        screenCaptureDeniedInLedger(this.permissionDenies.get(partition), origin)
    })
    this.extensions = new BrowserExtensionService(getConfigRoot(), permissionPersistence, {
      window: () => (this.window.isDestroyed() ? null : this.window),
      sessionFor: (projectId, boxId) => this.sessionForProject(projectId, boxId),
      liveJars: () => this.liveJars(),
      reportProgress: (progress) => this.publishExtensionProgress(progress),
      // Resolved by the page itself rather than by the jar's first owner: a box's
      // session serves every context that picked it, so a tab fact about a page in
      // it has to name that page's own tab.
      resolveTabId: (_projectId, contentsId) => this.tabForContents(contentsId)?.id ?? null,
      tabReplay: (projectId, boxId) => this.extensionTabReplay(projectId, boxId),
      publishActivity: (update) => this.publishExtensionActivity(update),
      publish: () => this.publishExtensions(),
      releaseViews: (extensionId, projectId, boxId) => {
        const partition = browserPartitionFor(projectId, boxId)
        const matches = (record: {
          extensionId: string | null
          projectId: string
          boxId: string | null
        }): boolean =>
          record.extensionId === extensionId &&
          browserPartitionFor(record.projectId, record.boxId) === partition
        this.popupWindows.closeWhere(matches, 'its extension was unloaded')
        this.sidePanels.closeWhere(matches, 'its extension was unloaded')
      },
      openSidePanel: (request) => {
        void this.openExtensionSidePanel(request).catch((error: unknown) => {
          Logger.error('An extension side panel could not be opened:', error)
        })
      },
      closeSidePanel: (extensionId, extensionTabId) =>
        this.sidePanels.closeForExtension(extensionId, extensionTabId, 'the extension closed it'),
      openPopup: (request) => this.openExtensionPopupFromWorker(request)
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

  /**
   * Read every stored Back/Forward stack.
   *
   * Awaited by the bootstrap before the service accepts browser IPC, for the same
   * reason the permission ledgers are: a tab can be shown on the very first frame
   * the renderer is allowed to ask, and a stack that had not been read yet would
   * be a tab restored with no history and no second chance to get one.
   */
  async hydrateTabHistory(): Promise<void> {
    try {
      await this.tabHistory.load()
    } catch (error: unknown) {
      Logger.error('Browser tab history could not be loaded:', error)
    }
  }

  /**
   * Read one tab's Back/Forward stack off its live view, or null when the view is
   * gone or has nothing loadable to restore.
   */
  private readTabHistory(tabId: string, tab: BrowserTab): BrowserTabHistoryRecord | null {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return null
    const history = contents.navigationHistory
    const bounded = boundedBrowserTabHistory(
      history.getAllEntries().map((entry) => {
        const captured: { url: string; title: string; pageState?: string } = {
          url: entry.url,
          title: entry.title
        }
        if (entry.pageState) captured.pageState = entry.pageState
        return captured
      }),
      history.getActiveIndex()
    )
    // Nothing loadable means nothing to restore, so there is no record: an empty
    // stack is the same as no stack, and one fewer row to keep.
    if (!bounded) return null
    return {
      projectId: tab.projectId,
      threadId: tab.threadId,
      entries: bounded.entries,
      index: bounded.index,
      updatedAt: Date.now()
    }
  }

  /**
   * Read one tab's Back/Forward stack off its live view and remember it durably.
   *
   * Called at the moments the view is about to lose the stack: parking it off
   * screen, hibernating it, and quitting. Nothing is captured on a navigation,
   * because the view is where the stack belongs while the tab is alive. The tab
   * is live again, so any copy kept for a reopen is dropped here rather than left
   * to be restored twice.
   */
  private captureTabHistory(tabId: string, tab: BrowserTab): void {
    if (this.peekTabs.has(tabId)) return
    const record = this.readTabHistory(tabId, tab)
    if (!record) return
    this.closedTabHistory.forget(tabId)
    this.tabHistory.store(tabId, record)
  }

  /**
   * Keep a closing tab's stack for a reopen instead of discarding it.
   *
   * A live tab's stack is read off its view before the view closes; a tab that
   * was already hibernated has no view left, so its durable stack is the one that
   * goes into the session set. Either way the durable copy is removed by the
   * caller, because a closed tab's stack lives only until it is reopened or the
   * session ends.
   */
  private stashClosedTabHistory(tabId: string, tab: BrowserTab | undefined): void {
    const record =
      tab && !tab.view.webContents.isDestroyed()
        ? this.readTabHistory(tabId, tab)
        : this.tabHistory.recordFor(tabId)
    if (record) this.closedTabHistory.stash(tabId, record)
  }

  /**
   * Put a tab's stored stack back into a view that has just been created.
   *
   * Answers whether a restore was started, which is what tells the caller not to
   * load the tab's single stored address over it: `restore()` puts the view on the
   * entry the tab was on, which is that address, with everything behind it alive.
   *
   * A record is only ever restored into the tab that wrote it. A tab id is unique,
   * but the project and thread are checked as well, so a thread browser's stack can
   * never be served to a global tab even if a file is edited to claim it. A tab
   * that was closed and is being reopened reads its stack from the session set,
   * which is the one place a closed tab's history is still alive.
   */
  private restoreTabHistory(tabId: string, tab: BrowserTab, fallbackUrl: string): boolean {
    const record = this.tabHistory.recordFor(tabId) ?? this.closedTabHistory.peek(tabId)
    if (!record) return false
    if (record.projectId !== tab.projectId || record.threadId !== tab.threadId) return false
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return false
    void contents.navigationHistory
      .restore({ entries: record.entries.map((entry) => ({ ...entry })), index: record.index })
      .catch(
        (error: unknown) => void this.recoverFromFailedRestore(tabId, contents, fallbackUrl, error)
      )
    return true
  }

  /**
   * What a tab does when its stored stack did not come back.
   *
   * The rejection arrives while the page is still settling   Chromium reports a
   * failure before it commits the document the failure ends on   so the page is
   * given its moment first (bounded; see `RESTORE_SETTLE_TIMEOUT_MS`). Judging it
   * earlier reads a load that is dying as a page that is arriving, and the
   * recovery then does nothing; loading over a page that really is arriving is
   * the other half of the same mistake, a second navigation racing the first.
   *
   * Once the page has settled, `restoreNeedsFallbackLoad` decides: a page that is
   * still loading or that is already on the tab's address is left alone, and
   * anything else gets that address, which is the whole of what is left to try.
   */
  private async recoverFromFailedRestore(
    tabId: string,
    contents: WebContents,
    fallbackUrl: string,
    error: unknown
  ): Promise<void> {
    if (contents.isDestroyed()) return
    await this.loadWaits.wait(contents, RESTORE_SETTLE_TIMEOUT_MS)
    if (contents.isDestroyed()) return
    const page = { loading: contents.isLoading(), url: contents.getURL() }
    if (!restoreNeedsFallbackLoad(page, fallbackUrl)) {
      Logger.dev('Browser tab history restore left the page where the stack put it:', {
        tabId,
        error,
        page
      })
      return
    }
    Logger.dev('Browser tab history could not be restored:', { tabId, error, page })
    if (fallbackUrl) this.load(tabId, fallbackUrl)
  }

  /**
   * Write every open tab's stack, and wait for the file.
   *
   * The commit point for quitting, and the one place the write is awaited rather
   * than coalesced: the views are closed right after it, so a write that had only
   * been started would lose exactly what it was meant to save.
   */
  async flushTabHistory(): Promise<void> {
    for (const [tabId, tab] of this.tabs) this.captureTabHistory(tabId, tab)
    await this.tabHistory.flush()
  }

  register(): void {
    this.guardAgainstStrandedView()
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
          ? this.extensionPageTabForContents(event.sender.id)
          : null
    })
    // Started here so the file exists long before the first extension popup or
    // panel is created; every path that can wait for it does.
    void this.ensureExtensionPageTabsPreload()
    replaceHandler(
      'browser:show',
      async (_event, rawTabId, rawProjectId, rawThreadId, rawInitialUrl, rawBounds, rawBoxId) => {
        const tabId = validateTabId(rawTabId)
        const projectId = validateProjectId(rawProjectId)
        const threadId = validateThreadId(rawThreadId)
        const boxId = validateOptionalBoxId(rawBoxId)
        const initialUrl =
          rawInitialUrl === undefined || rawInitialUrl === null || rawInitialUrl === ''
            ? ''
            : this.validateTabNavigationUrl(projectId, boxId, rawInitialUrl)
        const bounds = validateBounds(rawBounds)
        // The first document must not outrun extensions in its jar. If a page
        // navigates before Chromium has loaded an extension, its manifest content
        // scripts never get a receiver in that document, and later calls such as
        // Bitwarden's tabs.sendMessage fail until the page is reloaded. ensureTab
        // remains synchronous; this IPC path waits for the same single-flight load
        // before it creates and navigates a page.
        await this.extensions.ensureJarLoaded(projectId, boxId)
        const tab = this.ensureTab(tabId, projectId, threadId, boxId)

        // A show that lands inside the grace window of a hide is a surface switch
        // or a visibility answer that flapped, not a departure: dropping the
        // deferred park keeps the page where it is instead of parking it and
        // re-parenting it straight back, which is the flicker the user sees.
        this.dropPendingPark(tabId)
        // Leaving a tab costs nothing now: the outgoing tab keeps running in an
        // invisible stage window instead of going dead behind the app window.
        const previousActiveTabId = this.activeTabId
        if (this.activeTabId && this.activeTabId !== tabId) {
          this.parkTab(this.activeTabId)
        }
        this.activeTabId = tabId
        this.activeTabBounds = bounds
        // A page that moved under a resting pointer keeps its preview where it is
        // relative to the page; a switch to another tab drops the one the old
        // page was showing, because the pointer is no longer over it.
        if (this.targetUrl !== null) this.refreshStatusOverlay()
        if (previousActiveTabId !== tabId) this.notifyExtensionActivated(tabId)
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
              keepActive: true
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
          // A tab restored after a restart or a hibernation gets its whole stack
          // back, and the restore already puts it on the address it was left on.
          // Only a tab with no stored stack loads that address as a single page.
          if (!this.restoreTabHistory(tabId, tab, initialUrl)) {
            // A blank tab has no address yet: nothing to load, and the tab must
            // not spin. A later show still reports the live page state.
            if (initialUrl) this.load(tabId, initialUrl)
          }
        }
        return this.stateFor(tabId, tab)
      }
    )

    replaceHandler('browser:hide', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      // Leaving a tab right after an agent revealed it is the signal that the
      // agent's reveal was not welcome; it stops being counted after a while.
      this.noteDepartedReveal(tabId)
      // A peek is the one tab whose hide is never a hand-off between two surfaces:
      // it is being destroyed or promoted into a tab of its own, and either way its
      // page has to be off screen before the flight that carries it away starts,
      // because a native view is painted over the DOM that flight happens in. The
      // grace period below would leave the page sitting over that flight for its
      // length.
      if (this.peekTabs.has(tabId)) this.parkTab(tabId)
      // Deferred by one tick, so a panel that unmounts because the same tab is
      // moving to another surface (the sidebar handing the tab to the full screen
      // browser) does not park a view that is about to be shown again.
      else this.schedulePark(tabId)
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
    replaceHandler('browser:dismissPopupWindow', (_event, rawPopupId) => {
      this.popupWindows.dismiss(validatePopupWindowId(rawPopupId))
    })
    replaceHandler('browser:closePopupWindow', (_event, rawPopupId) => {
      this.popupWindows.close(validatePopupWindowId(rawPopupId), 'the user closed its window')
    })
    replaceHandler('browser:getPopupWindows', (_event, rawProjectId) =>
      this.popupWindows.list(validateProjectId(rawProjectId))
    )
    /**
     * Extension side panels: the rail measures a frame and these place the
     * extension's own document in it, exactly as the popup channels do.
     */
    replaceHandler('browser:showExtensionSidePanel', (_event, rawExtensionId, rawBounds) => {
      this.sidePanels.show(validateExtensionId(rawExtensionId), validateBounds(rawBounds))
    })
    replaceHandler('browser:hideExtensionSidePanel', (_event, rawExtensionId) => {
      this.sidePanels.hide(validateExtensionId(rawExtensionId))
    })
    replaceHandler('browser:focusExtensionSidePanel', (_event, rawExtensionId) => {
      this.sidePanels.focus(validateExtensionId(rawExtensionId))
    })
    replaceHandler('browser:closeExtensionSidePanel', (_event, rawExtensionId) => {
      this.sidePanels.close(validateExtensionId(rawExtensionId), 'the user closed it')
    })
    replaceHandler('browser:getExtensionSidePanels', (_event, rawProjectId) =>
      this.sidePanels.list(validateProjectId(rawProjectId))
    )
    /**
     * Open an extension's own action popup, which the app hosts because Electron
     * draws no toolbar and no action popup for one to hang from.
     */
    replaceHandler(
      'browser:openExtensionPopup',
      (_event, rawProjectId, rawTabId, rawThreadId, rawBoxId, rawExtensionId) =>
        this.openExtensionPopup(
          validateProjectId(rawProjectId),
          validateTabId(rawTabId),
          validateThreadId(rawThreadId),
          validateOptionalBoxId(rawBoxId),
          validateExtensionId(rawExtensionId)
        )
    )
    replaceHandler('browser:setToastVisible', (_event, rawVisible) => {
      this.setToastVisible(rawVisible === true)
    })
    replaceHandler('browser:setToastOverlay', (_event, rawRequest) => {
      const request = validateToastOverlayRequest(rawRequest)
      // Null is the renderer saying no page covers the toaster's corner any
      // more, so the stack belongs back in the app's own DOM. The window itself
      // only goes when nothing else is drawing in it.
      if (request === null) {
        this.overlay.releaseStack()
        return true
      }
      return this.overlay.applyStack(request)
    })
    replaceHandler('browser:setStripOverlay', (_event, rawRequest) =>
      this.overlay.applyStrip(validateBrowserStripOverlayRequest(rawRequest))
    )
    replaceHandler('browser:setDockOverlay', (_event, rawId, rawRequest) => {
      const id = validateNativeDockId(rawId)
      const request = rawRequest === null ? null : validateNativeDockRequest(rawRequest)
      if (request && request.id !== id) throw new TypeError('Native dock identities differ')
      return this.overlay.applyDock(id, request)
    })
    replaceHandler('browser:overlayDockInteract', (_event, rawReport) => {
      sendToRenderer(
        this.window.webContents,
        'browser:overlay:dockEvent',
        validateNativeDockInteraction(rawReport)
      )
    })
    replaceHandler('browser:overlayDockDrawn', (_event, rawAck) => {
      sendToRenderer(
        this.window.webContents,
        'browser:overlay:dockDrawn',
        validateNativeDockAck(rawAck)
      )
    })
    replaceHandler('browser:commitDockOverlay', (_event, rawRequest) =>
      this.overlay.commitDock(validateNativeDockCommit(rawRequest))
    )
    replaceHandler('browser:focusDockOverlay', (_event, rawId) =>
      this.overlay.focusDock(validateNativeDockId(rawId))
    )
    replaceHandler('browser:overlayReady', () => this.overlay.currentState())
    replaceHandler('browser:overlayInteract', (_event, rawReport) => {
      // The overlay carries no handlers, so an interaction is only a fact about
      // what the user did: the app renderer owns the toast and runs its handler.
      const report = validateToastOverlayInteraction(rawReport)
      sendToRenderer(this.window.webContents, 'browser:overlay:event', report)
    })
    replaceHandler('browser:overlayStripInteract', (_event, rawReport) => {
      // The same contract one surface over: the overlay reports what the user did
      // to the strip, and the app renderer owns what it means.
      const report = validateBrowserStripInteraction(rawReport)
      sendToRenderer(this.window.webContents, 'browser:overlay:stripEvent', report)
    })
    replaceHandler('browser:overlayDrawn', (_event, rawAck) => {
      // The content the overlay drew carries handlers that live in the app
      // renderer, so this is the overlay proving it can still reach them. It is
      // relayed rather than answered here: only the renderer that published a
      // revision knows which one it is waiting for.
      const ack = validateToastOverlayAck(rawAck)
      sendToRenderer(this.window.webContents, 'browser:overlay:drawn', ack)
    })
    replaceHandler('browser:overlayPointer', (_event, rawOverContent) => {
      this.overlay.setPointerOverContent(rawOverContent === true)
    })
    replaceHandler('browser:overlayCursor', () => this.overlay.pointerInClientSpace())
    replaceHandler(
      'browser:navigate',
      (_event, rawTabId, rawProjectId, rawThreadId, rawUrl, rawBoxId) => {
        const tabId = validateTabId(rawTabId)
        const projectId = validateProjectId(rawProjectId)
        const threadId = validateThreadId(rawThreadId)
        const boxId = validateOptionalBoxId(rawBoxId)
        const url = this.validateTabNavigationUrl(projectId, boxId, rawUrl)
        // Main creates a tab on `browser:show`, so a tab the renderer already knows
        // can still be unknown here: a fresh tab whose page has not been shown yet
        // because an overlay (the address spotlight) covers its frame. Ensuring the
        // tab makes an address load regardless of whether its page is on screen.
        const tab = this.ensureTab(tabId, projectId, threadId, boxId)
        // The navigation below is this tab's first, so a later show must not load
        // the stale initial URL over it.
        tab.initialNavigationStarted = true
        this.load(tabId, url)
      }
    )
    // Back/Forward, Reload and Stop are issued from the tab the renderer held a
    // moment ago, so each acts only while that tab is still live (see `liveTab`).
    replaceHandler('browser:goBack', (_event, rawTabId) => {
      const current = this.liveTab(validateTabId(rawTabId))?.view.webContents.navigationHistory
      if (current?.canGoBack()) current.goBack()
    })
    replaceHandler('browser:goForward', (_event, rawTabId) => {
      const current = this.liveTab(validateTabId(rawTabId))?.view.webContents.navigationHistory
      if (current?.canGoForward()) current.goForward()
    })
    replaceHandler('browser:mouseHistoryNavigation', (_event, rawDirection) => {
      if (rawDirection !== 'back' && rawDirection !== 'forward') {
        throw new TypeError('Browser mouse history direction must be back or forward')
      }
      return this.navigateFocusedHistory(rawDirection)
    })
    replaceHandler('browser:pageState', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      const tab = this.liveTab(tabId)
      return tab ? this.stateFor(tabId, tab) : null
    })
    replaceHandler('browser:reload', (_event, rawTabId) => {
      this.liveTab(validateTabId(rawTabId))?.view.webContents.reload()
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
      this.liveTab(validateTabId(rawTabId))?.view.webContents.reloadIgnoringCache()
    })
    replaceHandler('browser:stop', (_event, rawTabId) => {
      this.liveTab(validateTabId(rawTabId))?.view.webContents.stop()
    })
    replaceHandler('browser:findInPage', (_event, rawTabId, rawRequest) => {
      this.findInPage(validateTabId(rawTabId), validateBrowserFindRequest(rawRequest))
    })
    replaceHandler('browser:stopFindInPage', (_event, rawTabId, rawAction) => {
      this.stopFindInPage(validateTabId(rawTabId), validateBrowserFindStopAction(rawAction))
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
    replaceHandler('browser:clearBoxData', async (_event, rawProjectId, rawBoxId) => {
      const projectId = validateProjectId(rawProjectId)
      const boxId = validateOptionalBoxId(rawBoxId)
      if (!boxId) throw new TypeError('Browser box ID is required')
      await this.extensions.whenReady()
      await this.clearBoxData(projectId, boxId)
    })
    /** A box was deleted, so everything about it goes, its extensions included. */
    replaceHandler('browser:forgetBox', async (_event, rawProjectId, rawBoxId) => {
      const projectId = validateProjectId(rawProjectId)
      const boxId = validateOptionalBoxId(rawBoxId)
      if (!boxId) throw new TypeError('Browser box ID is required')
      await this.extensions.whenReady()
      await this.forgetBox(projectId, boxId)
    })
    replaceHandler('browser:extensions', async () => {
      await this.extensions.whenReady()
      return this.extensions.list()
    })
    replaceHandler('browser:extensionInstall', async (_event, rawInput) => {
      await this.extensions.whenReady()
      return this.extensions.install(validateExtensionInstallInput(rawInput))
    })
    replaceHandler('browser:extensionUninstall', async (_event, rawExtensionId) => {
      await this.extensions.whenReady()
      await this.extensions.uninstall(validateExtensionId(rawExtensionId))
    })
    replaceHandler('browser:extensionReorder', async (_event, rawOrderedIds) => {
      if (!Array.isArray(rawOrderedIds) || !rawOrderedIds.every((id) => typeof id === 'string')) {
        throw new TypeError('Extension order is invalid')
      }
      await this.extensions.reorder(rawOrderedIds.map(validateExtensionId))
    })
    replaceHandler('browser:extensionUpdateFromWebStore', async (_event, rawExtensionId) => {
      await this.extensions.whenReady()
      return this.extensions.updateFromWebStore(validateExtensionId(rawExtensionId))
    })
    replaceHandler('browser:extensionUpdate', async (_event, rawExtensionId, rawPatch) => {
      await this.extensions.whenReady()
      return this.extensions.update(
        validateExtensionId(rawExtensionId),
        validateExtensionUpdatePatch(rawPatch)
      )
    })
    replaceHandler('browser:darkReaderTabState', async (_event, rawTabId) => {
      await this.extensions.whenReady()
      const tab = this.requireTab(validateTabId(rawTabId))
      return this.extensions.darkReaderTabState(tab.projectId, tab.boxId, tab.view.webContents.id)
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
      await this.extensions.whenReady()
      const tab = this.requireTab(validateTabId(rawTabId))
      return this.extensions.setDarkReaderTabScope(
        tab.projectId,
        tab.boxId,
        tab.view.webContents.id,
        action
      )
    })
    replaceHandler('browser:extensionPickFolder', async () => {
      await this.extensions.whenReady()
      return this.extensions.pickFolder()
    })
    replaceHandler('browser:clearSiteData', (_event, rawProjectId, rawScopes) => {
      const projectId = validateProjectId(rawProjectId)
      const scopes = validateSiteDataScopes(rawScopes)
      void this.siteData.clearSiteData(projectId, scopes).catch((error: unknown) => {
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
          this.siteData.showSiteMenu(projectId, host, origin, boxId, boxName, x, y)
        )
      }
    )
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
      setImmediate(() => this.downloads.showMenu(projectId, x, y))
    })
    replaceHandler('browser:newTabMenu', (_event, rawInput, rawX, rawY) =>
      showBrowserNewTabMenu(
        this.window,
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
      return showBrowserBoxMenu(this.window, input, x, y)
    })
    replaceHandler('browser:tabSelectionMenu', (_event, rawInput, rawX, rawY) => {
      const input = validateBrowserTabSelectionMenuInput(rawInput)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      return showBrowserTabSelectionMenu(this.window, input, x, y)
    })
    replaceHandler('browser:tabContextMenu', (_event, rawInput, rawX, rawY) => {
      const input = validateBrowserTabContextMenuInput(rawInput)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      return showBrowserTabContextMenu(this.window, input, x, y)
    })
    replaceHandler('browser:agentTabMenu', (_event, rawInput, rawX, rawY) => {
      const input = validateBrowserAgentTabMenuInput(rawInput)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      return showBrowserAgentTabMenu(this.window, input, x, y)
    })
    replaceHandler('browser:extensionMenu', (_event, rawInput, rawX, rawY) => {
      const input = validateBrowserExtensionMenuInput(rawInput)
      const x = validateSiteMenuPoint(rawX, 'x coordinate')
      const y = validateSiteMenuPoint(rawY, 'y coordinate')
      return showBrowserExtensionMenu(this.window, input, x, y)
    })
    replaceHandler('browser:openExtensionPage', async (_event, rawExtensionId, rawBoxId) => {
      const extensionId = validateExtensionId(rawExtensionId)
      const boxId = validateOptionalBoxId(rawBoxId)
      await this.extensions.whenReady()
      await this.extensions.ensureExtensionPagesAvailable(extensionId)
      return this.extensions.optionsUrlFor(extensionId, GLOBAL_BROWSER_PROJECT_ID, boxId)
    })
    replaceHandler('browser:resolvePermission', (_event, rawRequestId, rawDecision) => {
      const requestId = validatePermissionRequestId(rawRequestId)
      const decision = validatePermissionDecision(rawDecision)
      this.resolvePermission(requestId, permissionResolutions[decision])
    })
    replaceHandler('browser:resolveScreenShare', (_event, rawRequestId, rawSourceId) => {
      const requestId = validatePermissionRequestId(rawRequestId)
      const sourceId = typeof rawSourceId === 'string' ? rawSourceId : null
      this.screenShare.resolveChoice(requestId, sourceId)
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
        this.applySitePermission(
          partition,
          descriptor.keysFor(origin),
          action === 'ask' ? 'reset' : action
        )
        // A page that already read the old answer only re-queries on navigation,
        // so the origin's tabs are reloaded into the new one, exactly as the old
        // padlock submenus did.
        this.reloadOriginTabs(partition, origin)
      }
    )
    replaceHandler('browser:popupReady', () => {
      // Pull model: the popup document requests the prompt on display once its
      // listener is bound. Invoke replies bypass the push-side load-state
      // guards that repeatedly dropped the first prompt (blank first popup).
      return this.promptWindow.currentContext()
    })
    replaceHandler('browser:expandPeek', (_event, rawTabId) => {
      const tabId = validateTabId(rawTabId)
      if (!this.peekTabs.has(tabId) || !this.tabs.has(tabId))
        throw new Error('Peek Window is no longer available')
      this.peekTabs.delete(tabId)
    })
    replaceHandler('browser:peekSnapshot', async (_event, rawTabId) => {
      // Taken while the peek is still on screen, because the surface animates the
      // page away with it: without a picture the last thing the user sees of the
      // page is the frame it was replaced by.
      const captured = await this.captureThumbnail(validateTabId(rawTabId), PEEK_SNAPSHOT_MAX_WIDTH)
      return captured?.dataUrl ?? null
    })
    replaceHandler('browser:destroy', (_event, rawTabId, rawReason) => {
      this.destroy(validateTabId(rawTabId), validateTabDestroyReason(rawReason))
    })
    replaceHandler('browser:bindAssistantPage', (_event, rawThreadId, rawTabId) => {
      // Binding is tolerant about the tab: a restored tab that is still
      // hibernated has no view in main yet, and the binding is only read when an
      // operation actually needs the page (see `attachedPageTab`).
      this.assistantPageTabIds.set(validateThreadId(rawThreadId), validateTabId(rawTabId))
    })
    replaceHandler('browser:unbindAssistantPage', (_event, rawThreadId) => {
      this.assistantPageTabIds.delete(validateThreadId(rawThreadId))
    })
    replaceHandler('browser:destroyThread', (_event, rawProjectId, rawThreadId) => {
      const projectId = validateProjectId(rawProjectId)
      const threadId = validateThreadId(rawThreadId)
      for (const [tabId, tab] of this.tabs) {
        if (tab.projectId === projectId && tab.threadId === threadId) this.destroy(tabId, 'closed')
      }
      // A hibernated tab of that thread has no live tab for the loop above to
      // find, so its stored stack is swept by owner rather than by tab. This is
      // the thread browser going away: its history goes with it, session set and
      // all.
      const ownedByThread = (record: BrowserTabHistoryRecord): boolean =>
        record.projectId === projectId && record.threadId === threadId
      this.tabHistory.forgetScopes(ownedByThread)
      this.closedTabHistory.forgetScopes(ownedByThread)
    })
    replaceHandler('browser:destroyProject', (_event, rawProjectId) => {
      this.dropProjectTabs(validateProjectId(rawProjectId))
    })
    replaceHandler('browser:getDownloads', (_event, rawProjectId) => {
      const projectId = validateProjectId(rawProjectId)
      return this.downloads.list(projectId)
    })
    replaceHandler('browser:cancelDownload', (_event, rawDownloadId) => {
      this.downloads.cancel(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:pauseDownload', (_event, rawDownloadId) => {
      this.downloads.pause(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:resumeDownload', (_event, rawDownloadId) => {
      this.downloads.resume(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:retryDownload', (_event, rawDownloadId) => {
      this.downloads.retry(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:removeDownload', (_event, rawDownloadId) => {
      this.downloads.remove(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:openDownload', (_event, rawDownloadId) => {
      this.downloads.open(validateDownloadId(rawDownloadId))
    })
    replaceHandler('browser:revealDownload', (_event, rawDownloadId) => {
      return this.downloads.reveal(validateDownloadId(rawDownloadId))
    })
  }

  dispose(): void {
    this.popupWindows.closeAll('the browser was torn down')
    this.mountedPopupViews.clear()
    this.popupViewFrames.clear()
    this.sidePanels.closeAll('the browser was torn down')
    this.mountedSidePanelViews.clear()
    this.sidePanelViewFrames.clear()
    this.activeTabId = null
    this.toastVisible = false
    this.activeTabBounds = null
    this.displayedTab = null
    for (const handle of this.pendingParks.values()) clearTimeout(handle)
    this.pendingParks.clear()
    this.injectedDialogLabels.clear()
    this.parkedOrder.length = 0
    this.agentReveals.clear()
    this.abandonedReveals.clear()
    this.relaxedUntil.clear()
    this.stage.dispose()
    this.promptWindow.dispose()
    this.overlay.dispose()
    this.screenShare.dispose()
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.resolvePermission(requestId, permissionResolutions.dismiss)
    }
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    this.tabs.clear()
    this.agentTabIds.clear()
    // Downloads belong to the session, not to this window: a download keeps
    // running while the window is parked, so teardown only stops this window's
    // tab lookup from being consulted. The manager survives and keeps the
    // records, the live items and the bytes.
    this.downloads.setTabResolver(null)
    this.configuredSessions.clear()
    // Extensions are unloaded from every jar before the sessions go: a loaded
    // extension holds a renderer and an open file inside a partition this service
    // is about to stop tracking.
    void this.extensions.dispose()
    this.permissionGrants.clear()
    this.permissionDenies.clear()
    this.playheads.clear()
    this.capture.dispose()
    this.inspector.dispose()
    // The views are closed two lines above, taking every stack with them. The last
    // commit is normally `flushTabHistory()`, awaited by whoever is tearing this
    // service down before it calls in here; this is the safety net for a teardown
    // that did not. It is not merely a no-op in that case: a flush that finds a
    // write still running waits for it and retries if it failed, which is the one
    // window a fire-and-forget teardown would otherwise close on a lost stack.
    void this.tabHistory.flush()
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

  /** Register the permission-card approver for attached-page mutations. */
  setAgentActionApprover(approver: BrowserAgentActionApprover | null): void {
    this.agentActionApprover = approver
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
    context: {
      projectId: string
      threadId: string
      // Only the upload path consults this. Callers that can never upload (the
      // design and video preview sessions) omit it, and the upload fallback then
      // treats the missing level as review-required rather than full access.
      permissionLevel?: PermissionLevel
      sessionId?: string
    }
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
        reveal,
        boxId: tab.boxId
      })
      return {
        ...this.utilityTabContext(tabId, tab),
        viewport: this.parkedViewportFor(tab),
        attention: reveal ? 'focus' : 'background',
        relaxed,
        page: this.stateFor(tabId, tab)
      }
    }

    const target = this.utilityTarget(contextKey, threadId)
    if (!target) {
      // A browser assistant conversation that has a page bound but whose page is
      // not in memory right now (a hibernated tab) is told exactly that, instead
      // of being told to open a page it already has.
      throw new Error(
        this.assistantPageTabIds.has(threadId)
          ? 'The page the user is on is not loaded right now, so it cannot be read. Open a page of your own with "open" if you need one.'
          : 'Open a browser page before using this operation'
      )
    }
    const { tabId, tab, attached } = target
    if (!attached && (tab.projectId !== projectId || tab.threadId !== threadId)) {
      throw new Error('The current browser tab belongs to a different project or thread')
    }
    // Review effects, rather than prompting for every click on an attached page.
    // Agent-owned pages use the same gate; uploads keep their exact-file review.
    let reviewedTarget: BrowserActionTarget | null = null
    if (attached && !ATTACHED_PAGE_READ_OPERATIONS.has(operation)) {
      if (!ATTACHED_PAGE_MUTATION_OPERATIONS.has(operation)) {
        throw new Error(
          `The page the user is on is attached for reading (${[...ATTACHED_PAGE_READ_OPERATIONS].join(', ')}), so "${operation}" is unavailable.`
        )
      }
    }
    if (
      context.permissionLevel !== 'full_access' &&
      ATTACHED_PAGE_MUTATION_OPERATIONS.has(operation) &&
      operation !== 'upload'
    ) {
      const reviewed = await this.approveAttachedPageOperation(operation, input, tab, {
        projectId,
        threadId,
        sessionId: context.sessionId
      })
      if (!reviewed.approved) {
        return {
          ...this.utilityTabContext(tabId, tab),
          page: attached ? 'user' : 'agent',
          cancelled: true
        }
      }
      reviewedTarget = reviewed.target
    }
    // An operation is a use: it revives a tab the agent owns that was evicted
    // from the parked set, and protects it from eviction while the agent keeps
    // working on it. A page belonging to the user is never parked, claimed or
    // touched by that bookkeeping.
    if (!attached) {
      if (this.activeTabId !== tabId && !this.stage.isParked(tab.view)) {
        this.parkTab(tabId)
      } else {
        this.touchParkedTab(tabId)
      }
    }
    const utilityContext = {
      ...this.utilityTabContext(tabId, tab),
      // Which page the answer came from, so the agent can tell a page it opened
      // apart from the page the user is reading.
      page: attached ? ('user' as const) : ('agent' as const)
    }
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
        ${reviewedTarget ? `if (JSON.stringify(${browserActionTargetScript(selector)}) !== ${JSON.stringify(JSON.stringify(reviewedTarget))}) return { clicked: false, reason: 'target changed; inspect the page and retry' };` : ''}
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
        ${reviewedTarget ? `if (JSON.stringify(${browserActionTargetScript(selector)}) !== ${JSON.stringify(JSON.stringify(reviewedTarget))}) return { typed: false, reason: 'target changed; inspect the page and retry' };` : ''}
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
    if (operation === 'upload') {
      const result = await this.uploadFiles(tabId, tab, input, context.permissionLevel)
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

  /** Route a browser action through the ledger and confirm consequential effects. */
  private async approveAttachedPageOperation(
    operation: string,
    input: Record<string, unknown>,
    tab: BrowserTab,
    context: { projectId: string; threadId: string; sessionId?: string }
  ): Promise<{ approved: boolean; target: BrowserActionTarget | null }> {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) throw new Error('The browser page is no longer available')
    const pageUrl = contents.getURL()
    const pageGeneration = tab.navigationGeneration
    const target: BrowserActionTarget | null =
      operation === 'click' || operation === 'type'
        ? await contents.executeJavaScript(
            browserActionTargetScript(this.requiredInputString(input, 'selector'))
          )
        : null
    const review = reviewBrowserAction(operation, input, target)
    let action: string
    if (operation === 'click') {
      action = `Click the first element matching this selector:\n${this.requiredInputString(input, 'selector')}`
    } else if (operation === 'type') {
      action = `Replace the value of this element:\n${this.requiredInputString(input, 'selector')}\n\nWith this text:\n${this.requiredInputString(input, 'text', true)}`
    } else if (operation === 'navigate') {
      action = `Navigate the current tab to:\n${validateBrowserUrl(this.requiredInputString(input, 'url'))}`
    } else if (operation === 'reload') {
      action = 'Reload the current page.'
    } else if (operation === 'viewport') {
      action = `Change the page viewport to:\n${JSON.stringify(input)}`
    } else {
      throw new Error(`Auto Review does not support the browser action "${operation}"`)
    }

    const approver = this.agentActionApprover
    if (!approver) throw new Error('Browser conversation approval is unavailable')
    const decision = await approver({
      ...context,
      operation,
      action,
      origin: safeOrigin(pageUrl),
      pageUrl,
      review
    })
    const approved = typeof decision === 'boolean' ? decision : decision.approved
    if (typeof decision !== 'boolean' && decision.alternative) {
      throw new Error(`Browser action rejected. User instruction: ${decision.alternative}`)
    }
    if (!approved) return { approved: false, target }
    if (
      contents.isDestroyed() ||
      tab.navigationGeneration !== pageGeneration ||
      contents.getURL() !== pageUrl
    ) {
      throw new Error(
        'The page changed while the browser action was being approved; retry on the current page'
      )
    }
    return { approved: true, target }
  }

  /**
   * Fill a page's file input through a narrow main-process action. Auto Review
   * always asks the user to choose files in a native dialog; Full Access can use
   * paths directly. The site never receives a file until this operation is
   * called, and this operation never submits the surrounding form.
   */
  private async uploadFiles(
    tabId: string,
    tab: BrowserTab,
    input: Record<string, unknown>,
    permissionLevel: PermissionLevel | undefined
  ): Promise<Record<string, unknown>> {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) throw new Error('The browser page is no longer available')

    const rawSelector = input['selector']
    if (
      rawSelector !== undefined &&
      (typeof rawSelector !== 'string' || rawSelector.length === 0 || rawSelector.length > 1024)
    ) {
      throw new TypeError('selector must be a non-empty CSS selector under 1024 characters')
    }
    const selector = typeof rawSelector === 'string' ? rawSelector : 'input[type="file"]'
    const beforeUrl = contents.getURL()
    const beforeGeneration = tab.navigationGeneration
    const inputState: unknown = await contents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
        return { available: false };
      }
      return {
        available: true,
        multiple: element.multiple,
        accept: element.accept,
        disabled: element.disabled
      };
    })()`)
    if (typeof inputState !== 'object' || inputState === null) {
      throw new Error('The selected browser element is not a file input')
    }
    const inputRecord = inputState as Record<string, unknown>
    if (inputRecord['available'] !== true || inputRecord['disabled'] === true) {
      throw new Error('The selected browser element is not an enabled file input')
    }
    const multiple = inputRecord['multiple'] === true
    const accept = typeof inputRecord['accept'] === 'string' ? inputRecord['accept'] : ''
    const requestedPaths = this.uploadPathInputs(input)
    const suppliedPaths = permissionLevel === 'full_access' ? requestedPaths : []
    let paths: string[]
    if (suppliedPaths.length > 0) {
      paths = await Promise.all(suppliedPaths.map((path) => this.resolveUploadPath(path)))
      if (!multiple && paths.length > 1) {
        throw new Error('This file input accepts one file at a time')
      }
    } else {
      const filters = fileChooserFilters(accept)
      const choice = await dialog.showOpenDialog(this.window, {
        title: `Choose files for upload to ${safeOrigin(beforeUrl)}`,
        buttonLabel: 'Upload',
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        ...(filters.length > 0 ? { filters } : {})
      })
      if (choice.canceled || choice.filePaths.length === 0) {
        return { uploaded: false, cancelled: true }
      }
      paths = await Promise.all(choice.filePaths.map((path) => this.resolveUploadPath(path)))
    }
    if (paths.length > 10) throw new Error('A browser upload can include at most 10 files')

    if (
      contents.isDestroyed() ||
      tab.navigationGeneration !== beforeGeneration ||
      contents.getURL() !== beforeUrl
    ) {
      throw new Error(
        'The page changed while the file upload was being approved; retry on the current page'
      )
    }

    const debuggerSession = contents.debugger
    const attachedHere = !debuggerSession.isAttached()
    try {
      if (attachedHere) debuggerSession.attach('1.3')
      const documentResult: unknown = await debuggerSession.sendCommand('DOM.getDocument', {
        depth: 1,
        pierce: true
      })
      const documentRecord = asObject(documentResult)
      const root = asObject(documentRecord?.['root'])
      const rootNodeId = root?.['nodeId']
      if (typeof rootNodeId !== 'number') throw new Error('The page document is unavailable')
      const queryResult: unknown = await debuggerSession.sendCommand('DOM.querySelector', {
        nodeId: rootNodeId,
        selector
      })
      const nodeId = asObject(queryResult)?.['nodeId']
      if (typeof nodeId !== 'number' || nodeId === 0) {
        throw new Error('The file input is no longer present on the page')
      }
      await debuggerSession.sendCommand('DOM.setFileInputFiles', { nodeId, files: paths })
      return { uploaded: true, files: paths.map((path) => basename(path)), submitted: false }
    } finally {
      if (attachedHere && debuggerSession.isAttached()) debuggerSession.detach()
    }
  }

  private uploadPathInputs(input: Record<string, unknown>): string[] {
    const value = input['paths']
    if (value === undefined) return []
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 10 ||
      value.some((path) => typeof path !== 'string' || path.length === 0 || path.length > 8192)
    ) {
      throw new TypeError('paths must contain between 1 and 10 absolute file paths')
    }
    return value as string[]
  }

  private async resolveUploadPath(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new TypeError('Every upload path must be absolute')
    const resolved = await realpath(path)
    const details = await stat(resolved)
    if (!details.isFile()) throw new TypeError(`Upload path is not a file: ${basename(path)}`)
    return resolved
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
   * Open or re-show one design screen in a tab of its own.
   *
   * A canvas click is the user choosing a page, and two canvases are two pages:
   * a tab per screen is what keeps clicking one from replacing another's. The
   * tab id is derived from the screen's identity rather than minted (see
   * {@link designScreenTabId}), so the same canvas addresses the same tab every
   * time: clicked twice it replaces its own page and leaves every other tab
   * alone, and a tab the user left open across a restart is found again rather
   * than copied where a freshly minted id would not be.
   *
   * The tab is parked offscreen before it loads, exactly as an agent-opened tab
   * is, so the page runs whether or not it ends up on screen.
   */
  async openDesignScreen(input: {
    projectId: string
    threadId: string
    /** Project-relative folder of the design, part of the screen's identity. */
    directory: string
    /** Entry file of the screen, normalized, or null for the folder listing. */
    entry: string | null
    url: string
    /** Bring the tab to the user once it is loaded, or leave it in the sidebar. */
    reveal: boolean
  }): Promise<{ tabId: string; tab: 'reused' | 'opened' }> {
    const tabId = designScreenTabId(input)
    const reused = this.tabs.has(tabId)
    const tab = this.ensureTab(tabId, input.projectId, input.threadId)
    if (!reused) {
      tab.initialNavigationStarted = true
      // Mount the tab offscreen before anything else: the page must run whether or
      // not the user ends up looking at it.
      this.parkTab(tabId)
    } else if (this.activeTabId !== tabId && !this.stage.isParked(tab.view)) {
      // A tab the parked cap evicted has no stage window left, so it is mounted
      // again before it navigates, exactly as an agent's operation revives one.
      this.parkTab(tabId)
    }
    this.load(tabId, input.url)
    // The event carries the URL that was asked for rather than whatever the page
    // holds a moment after a load started, so the sidebar row is named from the
    // screen the user clicked even before the page commits. It is sent for a
    // reused tab too, because that is also the only thing that moves the user to
    // a page the thread already has open. A screen tab is the user's, not the
    // agent's: nothing here claims the thread's agent tab, so no later preview
    // replaces this page under them.
    sendToRenderer(this.window.webContents, 'browser:openRequested', input.url, {
      projectId: input.projectId,
      threadId: input.threadId,
      requestedTabId: tabId,
      reveal: input.reveal,
      boxId: tab.boxId
    })
    return { tabId, tab: reused ? 'reused' : 'opened' }
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
        reveal: true,
        boxId: tab.boxId
      }
    )
  }

  /**
   * Wait until a tab is no longer loading, bounded.
   *
   * A capture taken mid-navigation shows a half-painted page, and a page that
   * never finishes (a hung script, an unreachable host) must not hold the caller
   * forever, so the wait ends on stop, failure, or the deadline. The wait itself
   * belongs to the page rather than to this call: a board sweep, a frame capture
   * and a refresh of the same tab are three callers on one `WebContents`, and
   * `BrowserLoadWaits` holds one listener pair for all of them (see that module
   * for why a pair per caller is worse than it looks).
   */
  async waitForTabLoad(tabId: string, timeoutMs = 8_000): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const contents: WebContents | undefined = tab.view.webContents
    if (!contents) return
    const startedAt = Date.now()
    const pendingStart = this.pendingNavigationStarts.get(tabId)
    if (pendingStart) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        pendingStart.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs))
        })
      ])
      if (timer !== undefined) clearTimeout(timer)
    }
    const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt))
    await this.loadWaits.wait(contents, remaining)
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

  /** Deliver view navigation to the existing shell handlers, with renderer focus. */
  private forwardNavigationShortcut(action: BrowserShortcutAction): boolean {
    if (!action.startsWith('nav-')) return false
    const chord = this.shortcutBindings[action]?.[0]
    if (chord && !this.window.webContents.isDestroyed()) {
      this.window.webContents.focus()
      sendToRenderer(this.window.webContents, 'browser:navigationKey', chord)
    }
    return true
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
    if (this.forwardNavigationShortcut(action)) return
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
      case 'reopenTab':
      case 'toggleNotes':
      case 'find':
      case 'findNext':
      case 'findPrevious':
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
   * the window's web contents the focus first: `focus-address`, `new-tab` and
   * `find` all open a field the renderer immediately focuses. The tab-strip
   * actions that do not involve a field (`close-tab`, `toggle-notes`, and a find
   * step) deliberately do not, because the page must keep the keyboard after
   * them.
   */
  private requestPanelShortcut(tabId: string, action: BrowserPanelShortcutAction): void {
    if (this.window.webContents.isDestroyed()) return
    if (action === 'focus-address' || action === 'new-tab' || action === 'find') {
      this.window.webContents.focus()
    }
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
   * Search a tab's page, or end its search.
   *
   * The search itself is Chromium's: the page is a native view, so its text is
   * only reachable through `findInPage`, and the engine that owns the document is
   * the one that highlights the matches and scrolls to the active one. An empty
   * text is not a search of nothing   it is the field being cleared, which means
   * the highlight on the page goes away, so it ends the session instead of asking
   * Chromium for a match on "".
   *
   * The request id is recorded before the call resolves so that the report of a
   * superseded query can never be taken for the current one; the report arrives
   * on the page's own `found-in-page` event, which is wired when the tab is
   * created.
   */
  private findInPage(tabId: string, request: BrowserFindRequest): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return
    const contents = tab.view.webContents
    if (request.text.length === 0) {
      this.stopFindInPage(tabId, 'clearSelection')
      return
    }
    const requestId = contents.findInPage(request.text, {
      forward: request.forward,
      findNext: request.findNext,
      matchCase: request.matchCase
    })
    this.findSessions.begin(tabId, requestId, request.text)
  }

  /** End a tab's find session, which is what closing the bar does. */
  private stopFindInPage(tabId: string, action: BrowserFindStopAction): void {
    const tab = this.tabs.get(tabId)
    this.findSessions.take(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return
    tab.view.webContents.stopFindInPage(action)
  }

  /**
   * Forward one report from a page's own find to the bar that draws it.
   *
   * A report for a request that has been superseded, for a tab with no session at
   * all (the bar was closed, or the page navigated), or one that repeats what the
   * bar was already told is dropped: the bar is only ever told about the search it
   * is currently showing, and only when there is something new to show.
   */
  private publishFindResult(
    tabId: string,
    requestId: number,
    report: { matches: number; activeMatchOrdinal: number }
  ): void {
    const session = this.findSessions.acceptReport(tabId, requestId, report)
    if (!session) return
    if (this.window.isDestroyed()) return
    sendToRenderer(
      this.window.webContents,
      'browser:findResult',
      browserFindResultFor(tabId, session.text, report)
    )
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

  private ensureTab(
    tabId: string,
    projectId: string,
    threadId: string,
    boxId: string | null = null
  ): BrowserTab {
    const existing = this.tabs.get(tabId)
    if (existing) {
      if (existing.projectId !== projectId || existing.threadId !== threadId) {
        throw new Error('Browser tab belongs to a different project or thread')
      }
      if (existing.boxId !== boxId) {
        // Cookies cannot move between jars, so a tab cannot either. Re-parenting
        // one would leave the page reading a store its session does not have.
        throw new Error('Browser tab belongs to a different box')
      }
      return existing
    }

    const browserSession = this.sessionForProject(projectId, boxId)

    // Extension loading is deliberately off the tab-creation path: `ensureTab` is
    // synchronous and creating a page must not wait on disk. The extension service
    // is single-flight per jar, so a burst of shows loads each extension once.
    void this.extensions.ensureJarLoaded(projectId, boxId)

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
      boxId,
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
    this.notifyExtensionTab(tabId, projectId, boxId, 'onCreated', [
      this.extensionTabInfo(tabId, tab)
    ])

    const publish = (): void => this.publishState(tabId)
    // A key pressed in the page reaches this view's web contents and nothing
    // else in the app, so this is where the browser claims its own shortcuts.
    // Preventing the event also prevents the application menu from acting on
    // the key, which is what keeps Cmd/Ctrl+R from reloading the whole app (in
    // a development build the menu is Electron's default one) and Cmd/Ctrl+W
    // from closing its window.
    view.webContents.on('before-input-event', (event, input) => {
      if (this.peekTabs.has(tabId) && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        this.requestPanelShortcut(tabId, 'close-tab')
        return
      }
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
    // Chromium reports the resolved address under the pointer here, and an empty
    // string once it leaves the link. That is the whole source of the bottom-left
    // status bubble: an embedded page has no browser chrome to draw one itself.
    view.webContents.on('update-target-url', (_event, url) => {
      this.onTargetUrlReport(tabId, url)
    })
    // The document is parsed at dom-ready, which is the earliest point at which
    // the capture observer can be installed before the page's own scripts ask
    // for the microphone.
    view.webContents.on('dom-ready', () => {
      installBrowserHistorySwipe(view.webContents)
      this.capture.reset(tabId)
      this.watchCaptureMainFrame(tabId, view.webContents)
      // The document that just arrived drops the last one's stylesheet, so the
      // app's scrollbar colours are installed again here.
      this.applyScrollbarTheme(tabId, view.webContents)
      publish()
      this.notifyExtensionWebNavigation(
        tab.projectId,
        tab.boxId,
        'onDOMContentLoaded',
        this.extensionWebNavigationDetails(tab, view.webContents.getURL())
      )
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
      this.notifyExtensionWebNavigation(
        tab.projectId,
        tab.boxId,
        'onCompleted',
        this.extensionWebNavigationDetails(tab, view.webContents.getURL())
      )
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
    view.webContents.on('did-start-loading', () => {
      publish()
      this.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onUpdated', [
        tab.view.webContents.id,
        { status: 'loading' },
        this.extensionTabInfo(tabId, tab)
      ])
    })
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
      this.notifyExtensionWebNavigation(
        tab.projectId,
        tab.boxId,
        'onBeforeNavigate',
        // The generation this navigation will land on, so the attempt and the
        // commit it leads to carry the same document id.
        this.extensionWebNavigationDetails(tab, details.url, {
          documentGeneration: tab.navigationGeneration + 1
        })
      )
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
      this.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onUpdated', [
        tab.view.webContents.id,
        { status: 'complete', url },
        this.extensionTabInfo(tabId, tab)
      ])
      // Chromium's page transition is not exposed, so a commit to the address the
      // tab was already showing is the one case the app can tell apart: a reload.
      const committedFrom = this.extensionNavigationUrls.get(tabId) ?? null
      this.notifyExtensionWebNavigation(
        tab.projectId,
        tab.boxId,
        'onCommitted',
        this.extensionWebNavigationDetails(tab, url, {
          transitionType: committedFrom === url ? 'reload' : 'link'
        })
      )
      this.extensionNavigationUrls.set(tabId, url)
      // Chromium's find does not survive a document, so a session that was live
      // across this navigation is over: the page has no matches to report and the
      // bar must not keep showing the count of the document that just went away.
      // The report is sent rather than left to the engine, which says nothing at
      // all for a search that no longer exists, and it names the text that was
      // being searched so the bar it belongs to is the one that answers it.
      const findSession = this.findSessions.take(tabId)
      if (findSession && !this.window.isDestroyed()) {
        sendToRenderer(
          this.window.webContents,
          'browser:findResult',
          browserFindResultFor(tabId, findSession.text, { matches: 0, activeMatchOrdinal: 0 })
        )
      }
    })
    // Every report from this page's own find: the session decides which of them
    // the bar is waiting for, and which of those say anything new (see
    // `BrowserFindSessions`).
    view.webContents.on('found-in-page', (_event, result) => {
      this.publishFindResult(tabId, result.requestId, result)
    })
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      publish()
      this.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onUpdated', [
        tab.view.webContents.id,
        { url },
        this.extensionTabInfo(tabId, tab)
      ])
      const navigatedFrom = this.extensionNavigationUrls.get(tabId) ?? ''
      const previousHash = navigatedFrom.indexOf('#')
      const nextHash = url.indexOf('#')
      // Two addresses that agree through their first '#' moved inside the same
      // document, which the runtime reports as a fragment change rather than a
      // history push.
      const fragmentOnly =
        previousHash !== -1 &&
        nextHash !== -1 &&
        navigatedFrom.slice(0, previousHash + 1) === url.slice(0, nextHash + 1)
      this.notifyExtensionWebNavigation(
        tab.projectId,
        tab.boxId,
        fragmentOnly ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated',
        this.extensionWebNavigationDetails(tab, url, {
          transitionType: navigatedFrom === url ? 'reload' : 'link'
        })
      )
      this.extensionNavigationUrls.set(tabId, url)
    })
    view.webContents.on('page-title-updated', (_event, title) => {
      publish()
      this.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onUpdated', [
        tab.view.webContents.id,
        { title },
        this.extensionTabInfo(tabId, tab)
      ])
    })
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
        this.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onUpdated', [
          tab.view.webContents.id,
          { favIconUrl: source },
          this.extensionTabInfo(tabId, tab)
        ])
      })
    })
    view.webContents.on('console-message', (details) => {
      this.appendConsoleEntry(tabId, {
        level: details.level,
        message: details.message,
        sourceId: details.sourceId,
        lineNumber: details.lineNumber,
        frameUrl: consoleFrameUrl(details.frame)
      })
    })
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // An aborted load is a navigation that was superseded (a redirect, or a
        // load the app replaced), never a page worth an error card: the policy and
        // the restore recovery share `isAbortedNavigation` so they cannot disagree.
        if (!isMainFrame || isAbortedNavigation(errorCode)) return
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
          lineNumber: 0,
          // The navigation that failed never committed a document, so there is no
          // frame behind this entry: the address is the one in the message.
          frameUrl: null
        })
        this.notifyExtensionWebNavigation(
          tab.projectId,
          tab.boxId,
          'onErrorOccurred',
          this.extensionWebNavigationDetails(tab, validatedURL, {
            error: errorDescription
          })
        )
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
        lineNumber: 0,
        // The frame that would have named itself is the one that died.
        frameUrl: null
      })
    })
    const owner: BrowserPageOwner = { tabId, projectId, threadId, boxId: tab.boxId }
    view.webContents.on('will-navigate', (event, url) => {
      // An external address (the App Store, mail, a native app) is offered to
      // the OS behind a confirmation; the page itself never navigates to it.
      if (this.offerExternalNavigation(owner, url)) {
        event.preventDefault()
        return
      }
      if (!this.isAllowedTabNavigation(projectId, tab.boxId, url)) event.preventDefault()
    })
    view.webContents.on('will-redirect', (event, url) => {
      if (this.offerExternalNavigation(owner, url)) event.preventDefault()
    })
    // `will-navigate` is the main frame only. A companion-app button often
    // lives in a page's own embedded frame (an embedded widget, a booking
    // panel), whose navigation fires this event and nothing else, so it is
    // handled here rather than left to be dropped in silence.
    view.webContents.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) return
      if (this.offerExternalNavigation(owner, details.url, details.frame?.url)) {
        details.preventDefault()
      }
    })
    this.installWindowOpenPolicy(view, owner)
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
    // A `window.open` aimed at an external scheme is the same handoff a link
    // click is, and never becomes a tab: the address is not a page.
    if (this.offerExternalNavigation(owner, details.url)) return { action: 'deny' }
    if (
      details.disposition === 'new-window' &&
      !details.features &&
      !details.postBody &&
      owner.projectId === GLOBAL_BROWSER_PROJECT_ID
    ) {
      try {
        this.openPeekFromWindowRequest(
          owner,
          this.validateTabNavigationUrl(owner.projectId, owner.boxId, details.url)
        )
      } catch (error: unknown) {
        Logger.error('Browser Peek rejected unsafe URL:', error)
      }
      return { action: 'deny' }
    }
    if (details.disposition === 'new-window' && owner.projectId === GLOBAL_BROWSER_PROJECT_ID) {
      const popup = this.openPopupWindowFor(owner, details)
      if (popup) return popup
    }
    try {
      this.openNewTabFor(
        owner,
        this.validateTabNavigationUrl(owner.projectId, owner.boxId, details.url)
      )
    } catch (error: unknown) {
      Logger.error('Browser popup rejected unsafe URL:', error)
    }
    return { action: 'deny' }
  }

  /** Accept only a popout page belonging to the requesting extension. */
  private ownedExtensionPageUrl(extensionId: string, rawUrl: string | undefined): string | null {
    if (!rawUrl) return null
    try {
      const url = new URL(rawUrl)
      if (
        url.protocol !== 'chrome-extension:' ||
        url.host !== extensionId ||
        url.username !== '' ||
        url.password !== '' ||
        url.searchParams.get('uilocation') !== 'popout'
      ) {
        return null
      }
      return url.toString()
    } catch {
      return null
    }
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

  /** Resolve a worker popup request and route its extension page to the rail. */
  private openExtensionPopupFromWorker(request: BrowserExtensionActionPopupOpenRequest): void {
    const owner = this.tabForContents(request.extensionTabId)
    if (!owner) return
    const tab = owner.tab
    if (tab.projectId !== request.projectId || tab.boxId !== request.boxId) return

    if (request.kind === 'focus-browser') {
      if (!this.window.isDestroyed()) {
        this.window.focus()
        if (this.activeTabId === owner.id && !tab.view.webContents.isDestroyed()) {
          tab.view.webContents.focus()
        }
      }
      return
    }

    if (request.kind === 'hide-window') {
      const cached = this.popupWindows.extensionPopupForJar(
        request.extensionId,
        request.projectId,
        request.boxId
      )
      if (cached) this.popupWindows.dismiss(cached)
      return
    }

    const requestedUrl =
      request.kind === 'open-window' || request.kind === 'focus-window'
        ? (this.ownedExtensionPageUrl(request.extensionId, request.url) ?? undefined)
        : undefined
    if ((request.kind === 'open-window' || request.kind === 'focus-window') && !requestedUrl) {
      Logger.dev('An extension popup request used an invalid extension URL:', {
        extensionId: request.extensionId
      })
      return
    }
    void this.openExtensionPopup(
      request.projectId,
      owner.id,
      tab.threadId,
      tab.boxId,
      request.extensionId,
      requestedUrl
    ).catch((error: unknown) => {
      Logger.dev('An extension action popup could not be opened:', {
        extensionId: request.extensionId,
        error
      })
    })
  }

  /**
   * Open an extension's own popup in the rail. Its page runs in the extension's
   * jar, remains live when hidden, and is retargeted when the extension is used in
   * another tab in the same jar.
   */
  private async openExtensionPopup(
    projectId: string,
    tabId: string,
    threadId: string,
    boxId: string | null,
    extensionId: string,
    requestedUrl?: string
  ): Promise<string | null> {
    const tab = this.ensureTab(tabId, projectId, threadId, boxId)
    // An extension can ask for its panel to open when its action is clicked, and
    // Chromium opens the panel rather than the action popup when it does. The
    // panel is a surface of the rail, so there is no popup id to answer with.
    const actionPanel = requestedUrl
      ? null
      : this.extensions.sidePanelForActionClick(
          projectId,
          tab.boxId,
          extensionId,
          tab.view.webContents.id
        )
    if (actionPanel) {
      await this.openExtensionSidePanel({
        projectId,
        boxId: tab.boxId,
        extensionId,
        extensionName: actionPanel.extensionName,
        extensionTabId: tab.view.webContents.id,
        path: actionPanel.path,
        url: actionPanel.url
      })
      return null
    }
    // One live popup page per extension jar: moving to another tab retargets this
    // view instead of creating another extension document and worker connection.
    const cached = this.popupWindows.extensionPopupForJar(extensionId, projectId, tab.boxId)
    const activateCached = async (popupId: string): Promise<boolean> => {
      if (
        !this.popupWindows.retargetExtensionPopup(
          popupId,
          { tabId, projectId, threadId: tab.threadId, boxId: tab.boxId },
          requestedUrl ??
            this.extensions.popupUrlFor(extensionId, projectId, tab.boxId) ??
            undefined
        )
      )
        return false
      if (requestedUrl) {
        try {
          if (!(await this.popupWindows.navigateExtensionPopup(popupId, requestedUrl))) return false
        } catch (error: unknown) {
          Logger.dev('A retained extension page could not navigate to its requested popup:', {
            extensionId,
            error
          })
          return true
        }
      }
      this.reportExtensionPageTabs(tabId)
      return true
    }
    if (cached && (await activateCached(cached))) {
      return cached
    }
    const popupKey = JSON.stringify([projectId, tab.boxId, extensionId])
    let opening = this.extensionPopupOpenings.get(popupKey)
    while (opening) {
      try {
        await opening
      } catch {
        // A later action can retry after a failed load; the failed page cleans
        // itself up before the next creation starts.
      }
      opening = this.extensionPopupOpenings.get(popupKey)
    }
    const openedWhileWaiting = this.popupWindows.extensionPopupForJar(
      extensionId,
      projectId,
      tab.boxId
    )
    if (openedWhileWaiting && (await activateCached(openedWhileWaiting))) {
      return openedWhileWaiting
    }
    const creation = this.createExtensionPopup(
      projectId,
      tabId,
      tab.threadId,
      tab.boxId,
      extensionId,
      requestedUrl
    )
    this.extensionPopupOpenings.set(popupKey, creation)
    try {
      return await creation
    } finally {
      if (this.extensionPopupOpenings.get(popupKey) === creation) {
        this.extensionPopupOpenings.delete(popupKey)
      }
    }
  }

  /** Create the one cached action popup page after jar-level access is ready. */
  private async createExtensionPopup(
    projectId: string,
    tabId: string,
    threadId: string,
    boxId: string | null,
    extensionId: string,
    requestedUrl?: string
  ): Promise<string> {
    if (this.popupWindows.countForTab(tabId) >= MAX_POPUP_WINDOWS_PER_TAB) {
      throw new Error('This tab already holds the popups it may host')
    }
    await this.extensions.ensureExtensionPagesAvailable(extensionId)
    const url = requestedUrl ?? this.extensions.popupUrlFor(extensionId, projectId, boxId)
    if (!url) throw new Error('That extension offers no popup in this box')
    // The extension has to be loaded in the jar before its own page can resolve: a
    // jar is loaded on demand and does not wait for a popup.
    await this.extensions.ensureJarLoaded(projectId, boxId)
    // The wrappers that answer this page's `chrome.tabs.query` must be in the
    // document before the extension's own bundle reads them: a popup decides which
    // site it is on as it starts, so a push that arrives after `did-finish-load`
    // lands once the decision was already made from focus. See
    // `browser-extension-page-tabs.ts`.
    const preload = await this.ensureExtensionPageTabsPreload()
    const view = new WebContentsView({
      webPreferences: {
        session: this.sessionForProject(projectId, boxId),
        preload: preload ?? undefined,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: true
      }
    })
    const popupId = this.popupWindows.hostExtension({
      owner: { tabId, projectId, threadId, boxId },
      extensionId,
      url,
      view,
      viewport: null
    })
    // The wrappers that answer this page's `chrome.tabs.query` live in its
    // document, so every document it arrives with is told which tab it acts on.
    // The preload above already answered the first document; this is what keeps the
    // answer current as the page navigates and as the tab behind it changes.
    view.webContents.on('did-finish-load', () => {
      const currentTabId = this.popupWindows.tabIdForContents(view.webContents.id)
      if (currentTabId) this.reportExtensionPageTabs(currentTabId)
    })
    try {
      await view.webContents.loadURL(url)
    } catch (error: unknown) {
      // A page that could not load is not a popup: without this the rail would keep
      // a tab that can never show anything.
      this.popupWindows.close(popupId, 'its page could not be loaded')
      throw error
    }
    return popupId
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
          this.popupViewFrames.set(view, bounds)
          if (this.mountedPopupViews.has(view)) {
            // Already on screen: re-asserting the frame is a native call, which is
            // still cheaper than the re-parent a repeat would otherwise cost.
            view.setBounds(bounds)
            return
          }
          this.stage.release(view)
          this.window.contentView.addChildView(view)
          this.mountedPopupViews.add(view)
          view.setBounds(bounds)
        } catch (error: unknown) {
          Logger.error('Browser popup window could not be placed:', error)
        }
      },
      unmount: (view, viewport) => {
        this.detachPopupView(view)
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
   * The view plumbing extension side panels run on.
   *
   * The registry owns panel lifetimes; every native call a view needs stays here,
   * beside the tab and popup ones, so a panel is placed, parked and dropped the
   * same way and there is one place to look when a document is not where it should
   * be.
   */
  private sidePanelHost(): BrowserExtensionSidePanelHost {
    return {
      mount: (view, bounds) => {
        if (this.window.isDestroyed()) return
        try {
          this.sidePanelViewFrames.set(view, bounds)
          if (this.mountedSidePanelViews.has(view)) {
            // Already on screen: re-asserting the frame is cheaper than the
            // re-parent a repeat would otherwise cost.
            view.setBounds(bounds)
            return
          }
          this.stage.release(view)
          this.window.contentView.addChildView(view)
          this.mountedSidePanelViews.add(view)
          view.setBounds(bounds)
        } catch (error: unknown) {
          Logger.error('Browser extension side panel could not be placed:', error)
        }
      },
      unmount: (view, viewport) => {
        this.detachSidePanelView(view)
        this.stage.park(view, viewport)
      },
      discard: (view) => {
        this.detachSidePanelView(view)
        this.stage.release(view)
      },
      changed: () => this.publishExtensionSidePanels(),
      notify: (record, opened) => {
        // A panel opening and closing are the two facts the worker's own
        // `chrome.sidePanel.onOpened` / `onClosed` are made of, and the tab id is
        // the one the extension already knows this panel by.
        if (opened) {
          this.extensions.reportSidePanelOpened(
            record.projectId,
            record.boxId,
            record.extensionId,
            record.extensionTabId
          )
          return
        }
        this.extensions.reportSidePanelClosed(
          record.projectId,
          record.boxId,
          record.extensionId,
          record.extensionTabId
        )
      }
    }
  }

  /**
   * Take a side panel's view out of the app window, answering whether it was in
   * it. A view whose document destroyed itself cannot be handed to the window at
   * all, so every native call is defended.
   */
  private detachSidePanelView(view: WebContentsView): boolean {
    this.sidePanelViewFrames.delete(view)
    if (!this.mountedSidePanelViews.has(view)) return false
    this.mountedSidePanelViews.delete(view)
    if (this.window.isDestroyed()) return false
    try {
      this.window.contentView.removeChildView(view)
    } catch (error: unknown) {
      Logger.error('Browser extension side panel could not be detached:', error)
      return false
    }
    return true
  }

  /**
   * Raise one extension's side panel over the rail.
   *
   * The worker names the extension's own tab id; a request may name none, in which
   * case Chromium's answer is the active tab of that project's browser. The panel's
   * document is loaded in the jar the extension runs in, which is the only session
   * its own files resolve in.
   */
  private async openExtensionSidePanel(
    request: BrowserExtensionSidePanelOpenRequest
  ): Promise<void> {
    const appTabId =
      request.extensionTabId === null
        ? this.activeTabIdInProject(request.projectId)
        : (this.tabIdForContents(request.projectId, request.extensionTabId) ?? null)
    if (!appTabId) {
      Logger.dev('An extension side panel had no tab to open on:', {
        extensionId: request.extensionId,
        extensionTabId: request.extensionTabId
      })
      return
    }
    const tab = this.tabs.get(appTabId)
    if (!tab) return
    this.sidePanels.open({
      session: this.sessionForProject(request.projectId, request.boxId),
      extensionId: request.extensionId,
      extensionName: request.extensionName,
      projectId: request.projectId,
      boxId: request.boxId,
      appTabId,
      extensionTabId: request.extensionTabId ?? tab.view.webContents.id,
      // Awaited, not read as a field: the panel's document is the extension's own,
      // so it decides which site it is on as its bundle starts, exactly like an
      // action popup. Reading the field would hand the first panel of a session a
      // null preload and leave it with the late push, which is the defect the
      // preload exists to remove. Null only when the write itself failed, and the
      // panel then still opens on the push rather than not opening at all.
      preload: await this.ensureExtensionPageTabsPreload(),
      path: request.path,
      url: request.url
    })
  }

  /** The active tab of one project's browser, or null when it has none. */
  private activeTabIdInProject(projectId: string): string | null {
    const tabId = this.activeTabId
    if (!tabId) return null
    const tab = this.tabs.get(tabId)
    return tab && tab.projectId === projectId ? tabId : null
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
    // A popup's page is a page in the app's browser, so what it logs belongs to
    // the tab that owns it rather than being dropped: a page that opens a popup
    // for a sign-in flow reports its own troubles there, and without this the
    // ownership of that page is the only record that the trouble happened.
    contents.on('console-message', (details) => {
      this.appendConsoleEntry(record.tabId, {
        level: details.level,
        message: details.message,
        sourceId: details.sourceId,
        lineNumber: details.lineNumber,
        frameUrl: consoleFrameUrl(details.frame)
      })
    })
    // A popup's keys reach its own page and then the application menu, where
    // Cmd/Ctrl+W would close the app window rather than this popup.
    contents.on('before-input-event', (event, input) => {
      if (this.consumeSwitcherKey(input)) {
        event.preventDefault()
        return
      }
      const action = matchBrowserShortcut(input, this.shortcutBindings)
      // A popup answers the browser's chords except the ones that need chrome it
      // does not have (see `POPUP_UNCLAIMED_ACTIONS`): those are left to the page
      // rather than prevented into a no-op.
      if (!action || POPUP_UNCLAIMED_ACTIONS.has(action)) return
      event.preventDefault()
      this.runPopupWindowShortcut(record, action)
    })
    contents.on('context-menu', (_event, params) => {
      this.showPopupWindowContextMenu(record, params)
    })
    contents.on('will-navigate', (event, url) => {
      if (this.offerExternalNavigation(popupPageOwner(record), url)) {
        event.preventDefault()
        return
      }
      if (!this.isAllowedPopupNavigation(record, url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (this.offerExternalNavigation(popupPageOwner(record), url)) event.preventDefault()
    })
    contents.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) return
      if (this.offerExternalNavigation(popupPageOwner(record), details.url, details.frame?.url)) {
        details.preventDefault()
      }
    })
    contents.setWindowOpenHandler((details) =>
      this.windowOpenResponse(popupPageOwner(record), details)
    )
    this.installDevToolsOpenPolicy(contents, () => popupPageOwner(record))
  }

  /**
   * Whether a popup's page may navigate itself to an address.
   *
   * A page's popup is held to what every page is held to: http or https, plus the
   * blank document it legitimately starts at. An extension's own popup is a
   * `chrome-extension:` document, so the extension's own files are allowed on top
   * of that; a navigation anywhere else would be the popup leaving the extension
   * that owns it.
   */
  private isAllowedPopupNavigation(record: BrowserPopupWindowRecord, url: string): boolean {
    if (isAllowedPopupWindowUrl(url)) return true
    if (record.extensionId === null) return false
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'chrome-extension:' && parsed.host === record.extensionId
    } catch {
      return false
    }
  }

  /** Install the landing policy for the windows a page opens. */
  private installWindowOpenPolicy(view: WebContentsView, owner: BrowserPageOwner): void {
    view.webContents.setWindowOpenHandler((details) => this.windowOpenResponse(owner, details))
    this.installDevToolsOpenPolicy(view.webContents, () => owner)
  }

  /** DevTools link commands use their own event, independent of window.open. */
  private installDevToolsOpenPolicy(contents: WebContents, owner: () => BrowserPageOwner): void {
    contents.on('devtools-open-url', (_event, url) => {
      if (contents.isDestroyed() || this.window.isDestroyed()) return
      const source = owner()
      if (!this.tabs.has(source.tabId)) return
      try {
        this.openNewTabFor(source, validateBrowserUrl(url))
      } catch (error: unknown) {
        Logger.error('Browser DevTools rejected a link:', error)
      }
    })
  }

  /**
   * Run one browser chord pressed inside a popup window.
   *
   * Cmd/Ctrl+W dismisses the popup surface. A page-created window ends; an
   * extension action popup is parked for reuse. The chords that belong to the
   * app's own chrome (the address bar, a new tab, the note) are forwarded to the
   * renderer under the owning tab, which is the tab the app would act on.
   */
  private runPopupWindowShortcut(
    record: BrowserPopupWindowRecord,
    action: BrowserShortcutAction
  ): void {
    if (this.forwardNavigationShortcut(action)) return
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

  /** Publish the extension side panels the browser holds, whole, after any change. */
  private publishExtensionSidePanels(): void {
    if (this.window.webContents.isDestroyed()) return
    sendToRenderer(this.window.webContents, 'browser:extensionSidePanels', this.sidePanels.list())
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
    const owner = this.tabForContents(contentsId)
    return owner && owner.tab.projectId === projectId ? owner.id : undefined
  }

  /**
   * The tab a page belongs to, whichever project owns it.
   *
   * A box's jar is shared, so the context that configured a session is not
   * necessarily the context a page in it belongs to: anything that has to name the
   * tab behind a page (a permission prompt, a download row) resolves it here and
   * reads the tab's own project.
   */
  private tabForContents(contentsId: number): { id: string; tab: BrowserTab } | null {
    for (const [id, tab] of this.tabs) {
      if (tab.view.webContents.id === contentsId) return { id, tab }
    }
    const ownerTabId = this.popupWindows.tabIdForContents(contentsId)
    if (!ownerTabId) return null
    const tab = this.tabs.get(ownerTabId)
    return tab ? { id: ownerTabId, tab } : null
  }

  /**
   * The tab behind a page, as the download manager reads it: which project owns
   *  the tab, and which box its jar belongs to.
   *
   * A boxed tab runs in a jar the profile owns, but the page is still a
   * conversation's tab, so a download reported against it belongs to the project
   * the user was browsing rather than to whichever context opened the jar first,
   * and a resume has to be issued through that same jar.
   */
  private ownerTabForContents(contentsId: number): BrowserDownloadOwner | null {
    const owner = this.tabForContents(contentsId)
    return owner ? { projectId: owner.tab.projectId, boxId: owner.tab.boxId } : null
  }

  private requireTab(tabId: string): BrowserTab {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Browser tab does not exist')
    return tab
  }

  /**
   * The tab a best-effort page control works on, or `undefined` once it is gone.
   *
   * The renderer issues Back/Forward, Reload and Stop from the tab state it held
   * a moment ago, so the tab can be gone before the command lands: the user closed
   * it, or its page is a tab this process has never shown and therefore never
   * created. A control with no page to act on is nothing to do rather than a
   * failure, exactly as the page context menu already treats a gone tab
   * (`live()?.reload()`), so the close race never surfaces as a main-process
   * "Browser tab does not exist" error. Operations that mutate the tab's durable
   * state still use `requireTab`, because a missing tab there is a real defect.
   */
  private liveTab(tabId: string): BrowserTab | undefined {
    return this.tabs.get(tabId)
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

  /**
   * Erase one box's cookies, site data and cache, and forget the permission
   * decisions it remembered.
   *
   * This is the destructive half of deleting a box. The partition *is* the box,
   * so clearing it is what "delete and erase" means, and the ledgers go with it:
   * leaving them behind would let a recreated box inherit decisions for a site
   * the user removed. The session object itself is kept, because a box the user
   * recreates will resolve to this same partition string, and a session already
   * configured is cheaper than one rebuilt on the next tab.
   */
  async clearBoxData(projectId: string, boxId: string): Promise<void> {
    const partition = browserPartitionFor(projectId, boxId)
    // Unload first, then reload: an extension holds open files and a running
    // service worker inside the storage being erased, and reloading the jar's tabs
    // then runs it again against the clean store.
    await this.extensions.onJarEmptied(projectId, boxId, true)
    await this.clearJarStorage(partition)
    await this.extensions.ensureJarLoaded(projectId, boxId)
  }

  /**
   * A box was deleted. Everything about it goes: its extensions are released and
   * dropped from every extension's jar list, its storage and its remembered
   * permissions are erased, and the Chromium profile directory behind the
   * partition is removed.
   *
   * A box's id is minted per creation, so a box made again after this is a new jar
   * with no relationship to the one that was removed, which is why nothing is kept.
   * The directory has to go explicitly: clearing a session empties a profile
   * without removing the directory that holds it, so a deleted box would otherwise
   * keep its cache on disk forever.
   */
  async forgetBox(projectId: string, boxId: string): Promise<void> {
    const partition = browserPartitionFor(projectId, boxId)
    await this.extensions.forgetBox(projectId, boxId)
    await this.clearJarStorage(partition)
    this.configuredSessions.delete(partition)
    await removeBrowserProfiles(await listBrowserProfilesForPartition(partition))
  }

  /**
   * A project was deleted, so its browser goes with it.
   *
   * This is the one path that removes a project's whole browser: its tabs are
   * destroyed, every jar it had open settles its connections and empties its
   * storage, the remembered decisions and stored Back/Forward stacks go, and the
   * Chromium profile directories are then removed from disk. None of it can be
   * reached again, because a project id is minted per project.
   *
   * Erasing a context that still exists is a different action: that one keeps its
   * session and clears only what the user asked to clear, so the profile comes back
   * empty rather than gone.
   */
  async forgetProject(projectId: string): Promise<string[]> {
    await this.extensions.whenReady()
    this.dropProjectTabs(projectId)
    // Settle the jars that have a live session *before* their directories go: an
    // open database or a connection still in flight would otherwise keep writing
    // into a profile that is being removed underneath it.
    for (const partition of this.projectPartitions(projectId)) {
      await this.settleJar(partition)
      this.configuredSessions.delete(partition)
    }
    const profiles = await listProjectBrowserProfiles(projectId)
    // The persisted decision ledger is keyed by partition, so every profile that is
    // about to go is forgotten by name, not only the jars with a live session.
    this.clearProjectPermissionMemory(
      projectId,
      profiles.map((profile) => profile.partition)
    )
    const removed = await removeBrowserProfiles(profiles)
    if (removed.length > 0) {
      Logger.info('Removed the browser profiles of a deleted project', { projectId, removed })
    }
    return removed
  }

  /**
   * Tear down everything one project's browser holds in this window: its tabs, the
   * stored stacks they own, and the download records named after it.
   *
   * Shared by the renderer's `browser:destroyProject` (a workspace closed) and by
   * `forgetProject` (the project itself is gone), so a closed workspace and a
   * deleted project can never leave different remnants behind.
   */
  private dropProjectTabs(projectId: string): void {
    for (const [tabId, tab] of [...this.tabs]) {
      if (tab.projectId === projectId) this.destroy(tabId, 'closed')
    }
    this.tabHistory.forgetScopes((record) => record.projectId === projectId)
    this.closedTabHistory.forgetScopes((record) => record.projectId === projectId)
    this.downloads.forgetProject(projectId)
  }

  /** Every jar of one project that this window currently holds a session for.
   *  Only the project's own jar: a box's jar is the profile's, shared by every
   *  context that picked that box, so a project's removal never touches one. */
  private projectPartitions(projectId: string): string[] {
    const own = browserPartitionFor(projectId)
    return [...this.configuredSessions].filter((partition) => partition === own)
  }

  /**
   * Close a jar's connections and empty its storage and cache, so removing the
   * directory behind it does not race a write already in flight. A jar that cannot
   * be settled is reported and still removed: its profile is unreachable either way,
   * and a failure here must not strand gigabytes.
   */
  private async settleJar(partition: string): Promise<void> {
    try {
      const browserSession = session.fromPartition(partition)
      await waitBrowserSessionCookies(browserSession)
      await browserSession.closeAllConnections()
      await browserSession.clearStorageData()
      await browserSession.clearCache()
    } catch (error: unknown) {
      Logger.error(`Browser profile "${partition}" could not be emptied before removal:`, error)
    }
  }

  /** Erase one jar's storage, cache and remembered permission decisions. */
  private async clearJarStorage(partition: string): Promise<void> {
    const browserSession = session.fromPartition(partition)
    await waitBrowserSessionCookies(browserSession)
    await browserSession.clearStorageData()
    await flushBrowserSessionCookiesFor(browserSession)
    await browserSession.clearCache()
    await browserSession.closeAllConnections()
    await this.permissionMemory.forget(partition, this.permissionLedgers())
    // The jar's own tabs reload so the cleared state takes effect now rather than
    // at the next navigation: an in-memory session would otherwise keep answering
    // as the account whose cookies were just erased.
    for (const tab of this.tabs.values()) {
      if (browserPartitionFor(tab.projectId, tab.boxId) !== partition) continue
      if (!tab.initialNavigationStarted || tab.view.webContents.isDestroyed()) continue
      tab.view.webContents.reload()
    }
  }

  /**
   * Every jar that currently has a live page, so the extension service can aim a
   * load at the jars that exist rather than at every jar the user ever made.
   *
   *  Listed by jar, not by tab owner: a box's session is one jar however many
   *  contexts have a tab in it, so the global browser and a project browsing the
   *  same box contribute one entry. The profile's default box is that same rule
   *  taken to its end: a tab in it is a tab in the global browser's own jar, so it
   *  is reported as the global browser rather than as the context that opened it.
   */
  private liveJars(): { projectId: string; boxId: string | null }[] {
    const jars: { projectId: string; boxId: string | null }[] = []
    const partitions = new Set<string>()
    for (const tab of this.tabs.values()) {
      if (tab.view.webContents.isDestroyed()) continue
      const jar = browserJarFor(tab.projectId, tab.boxId)
      const partition = browserPartitionFor(jar.projectId, jar.boxId)
      if (partitions.has(partition)) continue
      partitions.add(partition)
      jars.push(jar)
    }
    for (const owner of [...this.popupWindows.liveJars(), ...this.sidePanels.liveJars()]) {
      const jar = browserJarFor(owner.projectId, owner.boxId)
      const partition = browserPartitionFor(jar.projectId, jar.boxId)
      if (partitions.has(partition)) continue
      partitions.add(partition)
      jars.push(jar)
    }
    return jars
  }

  /** Retained extension documents keep their jar alive after site tabs close. */
  private jarHasLivePage(projectId: string, boxId: string | null): boolean {
    // Asked about the jar rather than about its owner: a box's jar is shared, so
    // the global browser reading a page in it is enough to keep its extensions
    // loaded even as a project's tab in the same box closes.
    const partition = browserPartitionFor(projectId, boxId)
    return this.liveJars().some(
      (jar) => browserPartitionFor(jar.projectId, jar.boxId) === partition
    )
  }

  /** Every jar one context holds a session for, the context's own jar first.
   *
   *  The own jar is always listed even before a session exists for it, because a
   *  context-wide clear has always meant "this browser" and must keep meaning it.
   *  The global browser's boxes are listed too: that is where boxes are made and
   *  where they are managed, so clearing the personal browser still takes its own
   *  boxes with it. A project's clear lists only its own jar, because a box is
   *  shared by every context that picked it and one project must not wipe an
   *  identity the personal browser and other projects are signed into. */
  private projectJars(projectId: string): (string | null)[] {
    const jars: (string | null)[] = [null]
    if (projectId !== GLOBAL_BROWSER_PROJECT_ID) return jars
    for (const partition of this.configuredSessions) {
      const boxId = boxIdFromPartition(partition)
      if (!boxId || jars.includes(boxId)) continue
      jars.push(boxId)
    }
    return jars
  }

  private publishExtensions(): void {
    this.reconcileExtensionPopups()
    this.reconcileExtensionSidePanels()
    if (this.window.webContents.isDestroyed()) return
    sendToRenderer(this.window.webContents, 'browser:extensions', this.extensions.list())
  }

  /** One extension's action state, published the moment its worker reports it. */
  private publishExtensionActivity(update: BrowserExtensionActivityUpdate): void {
    if (this.window.webContents.isDestroyed()) return
    sendToRenderer(this.window.webContents, 'browser:extensionActivity', update)
  }

  // ─── Extensions beside a page ──────────────────────────────────────────────

  /**
   * One tab fact, aimed at the extensions loaded in that tab's jar.
   *
   * The runtime delivers no tab lifecycle events of its own, so these are what
   * an extension's state machine is driven by: a created, updated, activated or
   * removed tab, in the shapes `chrome.tabs` documents, so a listener written
   * against the real API runs unmodified.
   *
   * One fact reaches two kinds of listener, which is why the tab is named rather
   * than left to the arguments: the worker's state machine, through those argument
   * shapes, and the extension's own pages, because a popup the app hosts for an
   * extension is a document that asks the same question the worker is being told
   * the answer to (see `reportExtensionPageTabs`).
   */
  private notifyExtensionTab(
    tabId: string,
    projectId: string,
    boxId: string | null,
    name: BrowserExtensionTabEventName,
    args: unknown[]
  ): void {
    this.extensions.onTabEvent(projectId, boxId, name, args)
    // The two facts an extension's own page acts on are the address and title of
    // the page it is acting on and whether that page is the one on screen. The rest
    // of the lifecycle either concerns the tab's jar or belongs to a tab that is
    // going away, and a tab that goes away takes its own popups with it.
    if (name === 'onUpdated' || name === 'onActivated') this.reportExtensionPageTabs(tabId)
  }

  /**
   * Tell every extension page one tab owns which tab it is acting on.
   *
   * An extension's action popup is hosted by the app in a rail popup, and it is a
   * `WebContents` among the pages, so the runtime answers its `chrome.tabs.query`
   * from focus   and the popup is the focused view by design. A query for "the tab I
   * am acting on" therefore came back as the popup's own document, which Bitwarden
   * reads as the site the user is on ("Site doesn't match", `CURRENT WEBSITE
   * nngceckbapebfimnlniiiahkandclblb`), so the app pushes the tab it knows instead.
   * See `browser-extension-page-tabs.ts`.
   */
  private reportExtensionPageTabs(tabId: string): void {
    for (const contents of this.popupWindows.extensionPagesForTab(tabId)) {
      this.pushExtensionPageTab(tabId, contents)
    }
  }

  /**
   * The tab one extension page acts on, for the preload that asks before the
   * page's own scripts exist.
   *
   * Only a `WebContents` this app hosts for an extension can be answered at all:
   * the two registries below are the app's own record of which tab each extension
   * surface belongs to, so a document the app is not hosting gets nothing rather
   * than a guess.
   */
  private extensionPageTabForContents(contentsId: number): BrowserExtensionPageTab | null {
    const tabId =
      this.popupWindows.tabIdForContents(contentsId) ?? this.sidePanels.tabIdForContents(contentsId)
    if (!tabId) return null
    return this.extensionPageTabSnapshot(tabId)
  }

  /**
   * The page behind an extension surface, as the extension should see it.
   *
   * One builder, because two callers need the same answer at different moments:
   * the preload asks for it before the popup's first script runs, and a push sends
   * it again whenever the page it describes changes or moves.
   */
  private extensionPageTabSnapshot(tabId: string): BrowserExtensionPageTab | null {
    const tab = this.tabs.get(tabId)
    if (!tab) return null
    const page: WebContents | undefined = tab.view.webContents
    if (!page || page.isDestroyed()) return null
    return {
      id: page.id,
      url: page.getURL(),
      title: page.getTitle(),
      active: this.activeTabId === tabId,
      loading: page.isLoading(),
      audible: page.isCurrentlyAudible(),
      muted: page.isAudioMuted()
    }
  }

  /**
   * One extension page, told the tab it is acting on.
   *
   * The tab is reported with the page's own `WebContents` id and address, which is
   * what makes an autofill flow correct rather than merely quiet: the extension
   * messages that id, and the message lands in the page's content script.
   */
  private pushExtensionPageTab(tabId: string, contents: WebContents): void {
    if (contents.isDestroyed()) return
    const snapshot = this.extensionPageTabSnapshot(tabId)
    if (!snapshot) return
    void contents
      .executeJavaScript(extensionPageTabsScript(snapshot), true)
      .catch((error: unknown) => {
        Logger.dev('An extension page could not be told which tab it acts on', {
          tabId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  // ─── The preload that lands in time ────────────────────────────────────────

  /** Where the page-tabs preload was written, or null before it has been, or if
   *  it could not be written at all. */
  private extensionPageTabsPreload: string | null = null

  /** The one write, shared by every caller that needs the preload. */
  private extensionPageTabsPreloadWrite: Promise<string | null> | null = null

  /**
   * Write the preload an extension page is created with, once per run.
   *
   * It has to exist on disk before the first extension surface is created, because
   * `webPreferences.preload` is a path and a view cannot be built without one, so
   * the write is started when the service registers and every caller that can wait
   * does. The content is generated from the same wrapper source main pushes, so the
   * preload and the push can never describe the page differently.
   */
  private ensureExtensionPageTabsPreload(): Promise<string | null> {
    this.extensionPageTabsPreloadWrite ??= this.writeExtensionPageTabsPreload()
    return this.extensionPageTabsPreloadWrite
  }

  private async writeExtensionPageTabsPreload(): Promise<string | null> {
    const file = join(
      getConfigRoot(),
      resolveBrowserExtensionStoreDir(),
      EXTENSION_PAGE_TABS_PRELOAD_FILE
    )
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, extensionPageTabsPreloadSource(), 'utf8')
      this.extensionPageTabsPreload = file
      return file
    } catch (error: unknown) {
      Logger.error('The extension page-tabs preload could not be written:', error)
      return null
    }
  }

  /**
   * One navigation fact for a tab's main frame, aimed at the extensions loaded
   * in that tab's jar.
   *
   * `chrome.webNavigation` is compiled out of the runtime, so nothing drives an
   * extension's navigation listeners on its own. The app watches the tab's own
   * main frame and hands each step over in the details shape the API documents,
   * so a listener written against the real API runs unmodified.
   */
  private notifyExtensionWebNavigation(
    projectId: string,
    boxId: string | null,
    name: BrowserExtensionWebNavigationEventName,
    details: Record<string, unknown>
  ): void {
    this.extensions.onWebNavigationEvent(projectId, boxId, name, details)
  }

  /**
   * One `chrome.webNavigation` details record for a main-frame event.
   *
   * Chromium exposes neither a document id nor a page transition, so the document
   * id is the page's own web contents id and a navigation generation, and the
   * transition is approximated by the caller.
   *
   * The generation is the tab's committed-navigation counter, which is why
   * `onBeforeNavigate` passes `documentGeneration + 1`: that counter increments when
   * the navigation commits, so the attempt and the commit that follows it only share
   * a document id if the attempt names the document it is about to create. An
   * extension correlating the two events by `documentId` is the reason.
   */
  private extensionWebNavigationDetails(
    tab: BrowserTab,
    url: string,
    options?: { transitionType?: 'link' | 'reload'; error?: string; documentGeneration?: number }
  ): Record<string, unknown> {
    const contents: WebContents | undefined = tab.view.webContents
    const webContentsId = contents && !contents.isDestroyed() ? contents.id : -1
    const generation = options?.documentGeneration ?? tab.navigationGeneration
    const details: Record<string, unknown> = {
      tabId: webContentsId,
      frameId: 0,
      parentFrameId: -1,
      url,
      timeStamp: Date.now(),
      documentId: `${webContentsId}-${generation}`,
      documentLifecycle: 'active',
      transitionQualifiers: []
    }
    if (options?.transitionType) details['transitionType'] = options.transitionType
    if (options?.error) details['error'] = options.error
    return details
  }

  /** A tab became the one on screen: the extension-visible activation event. */
  private notifyExtensionActivated(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const contents: WebContents | undefined = tab.view.webContents
    if (!contents || contents.isDestroyed()) return
    this.popupWindows.followActiveTab(
      { tabId, projectId: tab.projectId, threadId: tab.threadId, boxId: tab.boxId },
      (extensionId) => this.extensions.popupUrlFor(extensionId, tab.projectId, tab.boxId)
    )
    this.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onActivated', [
      { tabId: contents.id, windowId: 0 }
    ])
  }

  /**
   * Every tab event a jar's worker needs to know what is already open.
   *
   * A worker starts long after the tabs it runs beside, and the runtime gives it
   * no usable way to discover them: `chrome.tabs.query` answers from the
   * runtime's own focus state, so a query for the active tab comes back empty
   * whenever the app is not the focused one, and a browser view is not a tab in
   * a window the runtime tracks. Both a fresh worker and a restarted one are
   * therefore handed this replay, built from the app's own tab registry.
   *
   * Order matters and is the only contract here: every tab is announced, then
   * each tab's address and title, then the tab that is on screen. An extension
   * that scopes its state per tab ends up with the right state on the right tab,
   * which is what a badge count or a locked padlock on the current tab is.
   *
   * A hibernated tab has no page and is left out: announcing a page the runtime
   * cannot resolve would be a lie the extension then acts on.
   */
  private extensionTabReplay(projectId: string, boxId: string | null): BrowserExtensionTabReplay[] {
    // By jar, not by owner: a box's session is one jar however many contexts have
    // a tab in it, and an extension loaded there must be told about every page it
    // can see, including ones a conversation opened rather than the global browser.
    const partition = browserPartitionFor(projectId, boxId)
    const live: { tabId: string; tab: BrowserTab; contents: WebContents }[] = []
    for (const [tabId, tab] of this.tabs) {
      if (browserPartitionFor(tab.projectId, tab.boxId) !== partition) continue
      const contents: WebContents | undefined = tab.view.webContents
      if (!contents || contents.isDestroyed()) continue
      live.push({ tabId, tab, contents })
    }
    const events: BrowserExtensionTabReplay[] = []
    for (const entry of live) {
      events.push({ name: 'onCreated', args: [this.extensionTabInfo(entry.tabId, entry.tab)] })
    }
    for (const entry of live) {
      const info = this.extensionTabInfo(entry.tabId, entry.tab)
      // `changeInfo.url` is not decoration: an extension that tracks what a tab
      // is showing filters its `onUpdated` listener on it, so an update that
      // omits the address is an update it never sees.
      events.push({
        name: 'onUpdated',
        args: [entry.contents.id, { status: info.status, url: info.url }, info]
      })
    }
    const active = live.find((entry) => entry.tabId === this.activeTabId)
    if (active) {
      events.push({
        name: 'onActivated',
        args: [{ tabId: active.contents.id, windowId: 0 }]
      })
    }
    return events
  }

  /** One tab as `chrome.tabs` describes it, for a synthesized event. */
  private extensionTabInfo(tabId: string, tab: BrowserTab): BrowserExtensionTabInfo {
    const contents: WebContents | undefined = tab.view.webContents
    const active = this.activeTabId === tabId
    if (!contents || contents.isDestroyed()) {
      return {
        id: -1,
        index: 0,
        windowId: 0,
        windowType: 'normal',
        active,
        pinned: false,
        incognito: false,
        url: '',
        title: '',
        status: 'complete'
      }
    }
    return {
      id: contents.id,
      index: 0,
      windowId: 0,
      windowType: 'normal',
      active,
      pinned: false,
      incognito: false,
      url: contents.getURL(),
      title: contents.getTitle(),
      status: contents.isLoading() ? 'loading' : 'complete'
    }
  }

  /**
   * The right-click items every extension in the page's jar contributed.
   *
   * Recorded trees are read at click time rather than kept warm, and a chosen
   * item travels back through its extension's bridge as `contextMenus.onClicked`.
   */
  private extensionMenuItems(
    page: BrowserMenuPage,
    params: Electron.ContextMenuParams
  ): MenuItemConstructorOptions[] {
    const sections = this.extensions.menuRecordsFor(page.owner.projectId, page.owner.boxId)
    if (sections.length === 0) return []
    return buildExtensionMenuItems(sections, extensionClickContexts(params), (section, item) => {
      this.dispatchExtensionMenuClick(page, params, section.extensionId, item)
    })
  }

  /** Hand one chosen extension item back to the worker that recorded it. */
  private dispatchExtensionMenuClick(
    page: BrowserMenuPage,
    params: Electron.ContextMenuParams,
    extensionId: string,
    item: BrowserExtensionMenuRecord
  ): void {
    const contents = page.contents
    if (contents.isDestroyed()) return
    const info: Record<string, unknown> = {
      menuItemId: item.rawId,
      editable: params.isEditable,
      pageUrl: contents.getURL(),
      frameId: 0
    }
    if (item.parentId) info['parentMenuItemId'] = item.parentId
    if (params.linkURL) info['linkUrl'] = params.linkURL
    if (params.srcURL) info['srcUrl'] = params.srcURL
    if (params.selectionText.trim()) info['selectionText'] = params.selectionText
    if (params.mediaType !== 'none') info['mediaType'] = params.mediaType
    if (item.type === 'checkbox' || item.type === 'radio') {
      info['wasChecked'] = item.checked
      info['checked'] = !item.checked
    }
    this.extensions.dispatchMenuClick(page.owner.projectId, page.owner.boxId, extensionId, info, {
      id: contents.id,
      url: contents.getURL(),
      title: contents.getTitle(),
      active: this.activeTabId === page.owner.tabId,
      windowId: 0,
      index: 0
    })
  }

  /**
   * Close extension popups whose extension is no longer there to answer.
   *
   * An extension's popup hosts the extension's own page in the jar that runs it, so
   * an extension that was uninstalled, disabled, or taken out of that box leaves a
   * page behind that nothing can talk to. The installed list is published on every
   * change to it, which makes that the one place that sees all of them.
   */
  private reconcileExtensionPopups(): void {
    const jarsByExtension = new Map<string, Set<string>>()
    for (const extension of this.extensions.list()) {
      if (!extension.enabled) continue
      jarsByExtension.set(extension.id, new Set(extension.boxes))
    }
    this.popupWindows.closeWhere((record) => {
      if (record.extensionId === null) return false
      const jars = jarsByExtension.get(record.extensionId)
      if (!jars) return true
      return !jars.has(record.boxId ?? '')
    }, 'its extension was unloaded')
  }

  /**
   * Close side panels whose extension is no longer there to answer.
   *
   * A panel hosts the extension's own document in the jar that runs it, so an
   * extension that was uninstalled, disabled, or taken out of that box leaves a
   * document behind that nothing can talk to. The installed list is published on
   * every change to it, which makes that the one place that sees all of them.
   */
  private reconcileExtensionSidePanels(): void {
    const jarsByExtension = new Map<string, Set<string>>()
    for (const extension of this.extensions.list()) {
      if (!extension.enabled) continue
      jarsByExtension.set(extension.id, new Set(extension.boxes))
    }
    this.sidePanels.closeWhere((record) => {
      const jars = jarsByExtension.get(record.extensionId)
      if (!jars) return true
      return !jars.has(record.boxId ?? '')
    }, 'its extension was unloaded')
  }

  private publishExtensionProgress(progress: BrowserExtensionProgress): void {
    if (this.window.webContents.isDestroyed()) return
    sendToRenderer(this.window.webContents, 'browser:extensionProgress', progress)
  }

  private sessionForProject(projectId: string, boxId: string | null = null): Session {
    const partition = browserPartitionFor(projectId, boxId)
    const browserSession = session.fromPartition(partition)
    // Every browser context keeps its own login state across app restarts,
    // including thread browsers that use their project's private cookie jar.
    void restoreBrowserSessionCookies(browserSession)
    // Downloads are tracked for the session, not for the window: the window can be
    // parked and rebuilt while a download keeps running, so the manager that owns
    // them registers here once and keeps them across that rebuild. The partition
    // is what the registration is keyed by, because a box's session is shared by
    // every context that picked that box.
    this.downloads.watchSession(projectId, browserSession, partition)
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
      // prompt is labelled with and what a grant is remembered against. It is
      // found by its page rather than by this session's context: a box's jar is
      // configured by whichever context reached it first and then serves every
      // other one, so the tab's own project is what names the request.
      const owner = this.tabForContents(contents.id)
      if (!owner || !origin || this.window.webContents.isDestroyed()) {
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
        tabId: owner.id,
        projectId: owner.tab.projectId,
        origin,
        permission,
        mediaTypes
      }
      // Electron calls this handler for every request even when the check
      // handler already answered, so the remembered decision is the gate here:
      // a remembered "Don't allow" refuses silently, and a decision that
      // already covers the request grants silently instead of prompting the
      // user for a permission they have given before. The partition is this
      // closure's, so a box answers from its own jar's decisions.
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
      this.pendingPermissions.set(id, {
        request,
        callback,
        timer,
        partition,
        systemAccessDenied: false
      })
      // Nothing in this instance's ledgers covers the request, but the durable
      // memory is shared with every other running instance: re-read it before
      // asking, and answer from it when the decision is already there. The
      // pending entry (and its timeout) is live while that read is in flight, so
      // a slow or failed read still ends in the prompt on screen instead of a
      // stranded request.
      void this.promptFromDurableMemory(id)
    })
    // Screen sharing needs its own handler on Electron: `getDisplayMedia`
    // rejects with `NotSupportedError` when a session never answers it. The
    // native system picker is preferred where the platform has one, and the
    // permission request handler above has already gated the call, so a
    // remembered refusal refuses the share before any picker can appear.
    browserSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        void this.screenShare.handle(request, callback)
      },
      { useSystemPicker: true }
    )
    this.configuredSessions.add(partition)
    return browserSession
  }

  /** The tab and jar a display-media request's frame belongs to, or null when
   *  the frame is gone or belongs to no tab of this browser. */
  private resolveScreenShareOwner(frame: WebFrameMain | null): BrowserScreenShareOwner | null {
    const contents = frame ? webContents.fromFrame(frame) : undefined
    if (!contents || contents.isDestroyed()) return null
    const owner = this.tabForContents(contents.id)
    if (!owner) return null
    return {
      tabId: owner.id,
      projectId: owner.tab.projectId,
      partition: browserPartitionFor(owner.tab.projectId, owner.tab.boxId)
    }
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
    const outcome = rememberedPermissionOutcome(
      permissionGrantKeys(remaining.request),
      this.permissionGrants.get(remaining.partition),
      this.permissionDenies.get(remaining.partition)
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
    this.showPendingPermission(remaining)
  }

  /** Put one pending request on the prompt card, labelled with its tab. Every
   *  path that raises a prompt shares this, so a permission request and an
   *  external-address handoff draw the same card and cannot drift apart. */
  private showPendingPermission(pending: PendingBrowserPermission): void {
    const tab = this.tabs.get(pending.request.tabId)
    this.promptWindow.show(
      {
        request: pending.request,
        queueSize: this.pendingPermissions.size,
        projectLabel: tab ? this.permissionLabel(tab) : null,
        systemAccessDenied: pending.systemAccessDenied
      },
      this.promptAnchor()
    )
  }

  /**
   * Offer a page's external address to the operating system, and answer whether
   * it was one.
   *
   * The address is not opened here: a page must not be able to launch an app on
   * the machine just by pointing a link at it. It goes on the same prompt card a
   * permission request uses, and the OS open happens only after the user
   * confirms it ({@link openExternalUrl}). A caller that gets true must refuse
   * the in-app navigation, because the destination is not a page.
   */
  private offerExternalNavigation(
    owner: BrowserPageOwner,
    url: string,
    requestingFrameUrl?: string | null
  ): boolean {
    const target = externalProtocolTarget(url)
    if (!target) return false
    const tab = this.tabs.get(owner.tabId)
    if (!tab || this.window.webContents.isDestroyed()) return false
    // An embedded frame that asked for the handoff names itself on the card; a
    // main-frame navigation names the page it is on. Only an http(s) requester
    // can ask at all: a page with no origin of its own (a blank document, a
    // dead renderer) has no site to name.
    const origin =
      permissionOrigin(requestingFrameUrl ?? '') ?? permissionOrigin(tab.view.webContents.getURL())
    if (!origin) return false
    const id = crypto.randomUUID()
    const request: BrowserPermissionRequest = {
      id,
      tabId: owner.tabId,
      projectId: owner.projectId,
      origin,
      permission: EXTERNAL_PROTOCOL_PERMISSION,
      mediaTypes: [],
      externalUrl: target.url
    }
    const timer = setTimeout(
      () => this.resolvePermission(id, permissionResolutions.dismiss),
      PERMISSION_TIMEOUT_MS
    )
    const pending: PendingBrowserPermission = {
      request,
      // An external address has no Chromium callback waiting on it: the page's
      // navigation was already refused, and the OS open is the whole outcome.
      callback: () => {},
      timer,
      systemAccessDenied: false,
      partition: browserPartitionFor(owner.projectId, owner.boxId)
    }
    this.pendingPermissions.set(id, pending)
    this.showPendingPermission(pending)
    return true
  }

  /** Hand a confirmed external address to the operating system. Only an address
   *  that passed {@link externalProtocolTarget} reaches here, and only after the
   *  user asked for it, so the value handed out is validated twice. */
  private openExternalUrl(url: string): void {
    const target: ExternalProtocolTarget | null = externalProtocolTarget(url)
    if (!target) return
    void shell.openExternal(target.url).catch((error: unknown) => {
      Logger.error('Browser external address could not be opened:', error)
    })
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

  /** Forget every remembered permission grant or denial for one context: its own
   *  jar, plus any partition the caller is about to remove.
   *
   *  A box's ledger is deliberately not reached from here. A box is one jar for the
   *  whole profile, so clearing one project's decisions must not forget the answers
   *  the personal browser and other projects rely on; a box's own clear action
   *  forgets its ledger when it empties that jar. */
  private clearProjectPermissionMemory(
    projectId: string,
    extraPartitions: readonly string[] = []
  ): void {
    const partitions = new Set<string>([browserPartitionFor(projectId), ...extraPartitions])
    // The store owns the clear so a permission read already in flight cannot
    // merge the forgotten keys back after the user asked for them to be gone.
    void Promise.all(
      [...partitions].map((partition) =>
        this.permissionMemory.forget(partition, this.permissionLedgers())
      )
    ).catch((error: unknown) => {
      Logger.error('Browser permission memory could not be saved:', error)
    })
  }

  /** Apply a manual site-permission decision from the padlock menu. Writes the
   *  same ledger keys the prompt path reads, so the next request from the page
   *  is answered silently: a manual Allow behaves exactly like answering Allow
   *  on the prompt, a Block like Don't allow, and Ask every time forgets only
   *  this origin's keys instead of the whole jar. */
  private applySitePermission(
    partition: string,
    keys: readonly string[],
    action: 'allow' | 'block' | 'reset'
  ): void {
    const grants = permissionLedgerForPartition(this.permissionGrants, partition)
    const denies = permissionLedgerForPartition(this.permissionDenies, partition)
    for (const key of new Set(keys)) {
      if (action === 'allow') {
        denies.delete(key)
        grants.add(key)
      } else if (action === 'block') {
        grants.delete(key)
        denies.add(key)
      } else {
        grants.delete(key)
        denies.delete(key)
      }
    }
    this.persistPermissionMemory()
  }

  /** Reload the tabs in one jar currently showing one origin. A page that
   *  already decided the camera is blocked (Meet's "camera off" state) only
   *  re-queries on navigation, so a manual decision reloads it into the new
   *  answer instead of leaving the stale one on screen. */
  private reloadOriginTabs(partition: string, origin: string): void {
    for (const tab of this.tabs.values()) {
      if (browserPartitionFor(tab.projectId, tab.boxId) !== partition) continue
      if (!tab.initialNavigationStarted) continue
      const contents = tab.view.webContents
      if (contents.isDestroyed()) continue
      if (permissionOrigin(contents.getURL()) !== origin) continue
      contents.reload()
    }
  }

  private resolvePermission(requestId: string, resolution: PermissionResolution): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingPermissions.delete(requestId)
    if (resolution.rememberDeny) {
      const grants = this.permissionGrants.get(pending.partition)
      const denies = this.permissionDenies.get(pending.partition)
      for (const key of permissionGrantKeys(pending.request)) {
        grants?.delete(key)
        denies?.add(key)
      }
      this.persistPermissionMemory()
    }
    if (resolution.granted) {
      if (pending.request.externalUrl) {
        this.openExternalUrl(pending.request.externalUrl)
      } else {
        void this.grantBrowserPermission(pending, resolution.rememberGrant)
      }
    } else {
      pending.callback(false)
    }
    this.showNextPermissionPrompt()
  }

  /** Show the next queued request, or drop the prompt when the queue is empty. */
  private showNextPermissionPrompt(): void {
    const next = this.pendingPermissions.values().next()
    if (next.done) {
      this.promptWindow.hide()
      return
    }
    this.showPendingPermission(next.value)
  }

  /** Ask macOS for capture access only after the user allows the site. The
   * browser's callback stays pending while the OS prompt is open, which lets
   * Chromium resume `getUserMedia` only after both decisions have succeeded. */
  private async grantBrowserPermission(
    pending: PendingBrowserPermission,
    rememberGrant: boolean
  ): Promise<void> {
    const mediaTypes = pending.request.permission === 'media' ? pending.request.mediaTypes : []
    if (process.platform === 'darwin') {
      try {
        for (const mediaType of new Set(mediaTypes)) {
          const accessType =
            mediaType === 'audio' ? 'microphone' : mediaType === 'video' ? 'camera' : null
          if (accessType && !(await systemPreferences.askForMediaAccess(accessType))) {
            pending.systemAccessDenied = true
            pending.callback(false)
            this.promptSystemAccessDenied(pending)
            return
          }
        }
      } catch (error: unknown) {
        Logger.error('macOS browser media access request failed:', error)
        pending.callback(false)
        return
      }
    }
    if (rememberGrant) {
      const grants = this.permissionGrants.get(pending.partition)
      const denies = this.permissionDenies.get(pending.partition)
      for (const key of permissionGrantKeys(pending.request)) {
        denies?.delete(key)
        grants?.add(key)
      }
      this.persistPermissionMemory()
    }
    pending.callback(true)
  }

  /** Keep the denied request visible until the user dismisses it or retries. */
  private promptSystemAccessDenied(pending: PendingBrowserPermission): void {
    this.showPendingPermission(pending)
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
      const navigationStart = this.rememberPlayhead(tabId, tab).then(
        () => this.navigateTo(tabId, url),
        () => this.navigateTo(tabId, url)
      )
      this.pendingNavigationStarts.set(tabId, navigationStart)
      void navigationStart.then(
        () => {
          if (this.pendingNavigationStarts.get(tabId) === navigationStart) {
            this.pendingNavigationStarts.delete(tabId)
          }
        },
        () => {
          if (this.pendingNavigationStarts.get(tabId) === navigationStart) {
            this.pendingNavigationStarts.delete(tabId)
          }
        }
      )
      return
    }
    this.navigateTo(tabId, url)
  }

  /** Start one navigation, reporting a failure rather than rejecting. */
  private navigateTo(tabId: string, url: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return Promise.resolve()
    const contents = tab.view.webContents
    const navigationStart = this.extensions
      .ensureJarLoaded(tab.projectId, tab.boxId)
      .catch((error: unknown) => {
        // An extension load failure must not prevent the page itself from opening.
        Logger.dev('Browser extensions could not be prepared before navigation:', {
          tabId,
          error
        })
      })
      .then(() => waitBrowserSessionCookies(contents.session))
      .then(() => {
        if (this.tabs.get(tabId) !== tab || contents.isDestroyed()) return
        return contents.loadURL(url).catch((error: unknown) => {
          Logger.dev('Browser navigation did not complete:', { tabId, url, error })
          const reason = error instanceof Error && error.message ? error.message : String(error)
          this.setTabLoadError(tabId, {
            kind: 'network',
            code: 0,
            description: reason || 'The page could not be opened'
          })
          this.publishState(tabId)
        })
      })
      .finally(() => {
        if (this.pendingNavigationStarts.get(tabId) === navigationStart) {
          this.pendingNavigationStarts.delete(tabId)
        }
      })
    this.pendingNavigationStarts.set(tabId, navigationStart)
    return navigationStart
  }

  /**
   * Whether a tab may navigate to an address. HTTP and HTTPS always may. A
   * `chrome-extension://` address may only when it names an enabled extension
   * that runs in that tab's own jar, so one box can never open another jar's
   * extension files.
   */
  private isAllowedTabNavigation(projectId: string, boxId: string | null, url: string): boolean {
    try {
      validateBrowserUrl(url)
      return true
    } catch {
      // Not http(s). Only an installed extension page in this jar passes.
    }
    try {
      return this.extensions.isExtensionPageAllowed(url, projectId, boxId)
    } catch {
      return false
    }
  }

  /**
   * Validate an address a tab is about to load. Accepts http(s) plus an
   * extension page allowed in that jar. Throws when neither passes, so callers
   * keep the same refusal shape as before.
   */
  private validateTabNavigationUrl(
    projectId: string,
    boxId: string | null,
    value: unknown
  ): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('Browser URL must be a string of at most 8192 characters')
    }
    const candidate = value
    try {
      return validateBrowserUrl(candidate)
    } catch {
      // Fall through to the extension-page check below.
    }
    if (this.extensions.isExtensionPageAllowed(candidate, projectId, boxId)) return candidate
    throw new TypeError('Browser URL must use http or https')
  }

  /** Open the page-level context menu anchored at a point (the toolbar's page
   *  menu and the host's fallback for a click the native view did not take). The
   *  right-click menu is this same page section plus the point-specific ones. */
  private showPageMenu(tabId: string, x: number, y: number): void {
    if (this.window.isDestroyed()) return
    const tab = this.requireTab(tabId)
    const page = menuPageFor(tabId, tab)
    const frame = this.frameForTab(tabId)
    const menu = Menu.buildFromTemplate(
      buildBrowserPageMenuItems(
        this.contextMenuContext(page.contents),
        this.contextMenuActions(page, frame, this.pagePointOf(x, y, frame))
      )
    )
    menu.popup({ window: this.window, x, y })
  }

  /**
   * A page-menu point, translated from the window's space into the page's own.
   *
   * The channel behind the page menu is shared: the host's fallback for a click
   * the native view did not take passes the click itself, and the reload button
   * passes its own position under it. Only a point that lands inside the page
   * says anything about where on the page the user is, so one that does not is
   * reported as no point at all.
   */
  private pagePointOf(
    x: number,
    y: number,
    frame: BrowserViewBounds | null
  ): BrowserPeekPoint | null {
    if (frame === null) return null
    return peekPointInFrame({ x: Math.round(x - frame.x), y: Math.round(y - frame.y) }, frame)
  }

  /** The rectangle a tab's page is on screen at, or null while it is parked or
   *  displayed off the app window. */
  private frameForTab(tabId: string): BrowserViewBounds | null {
    return this.activeTabId === tabId ? this.activeTabBounds : null
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
    const frame = this.frameForTab(tabId)
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
        this.contextMenuActions(page, frame, { x: params.x, y: params.y }),
        this.extensionMenuItems(page, params)
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
      searchEngineName: this.contextMenuSearchEngine.name,
      boxes: getGlobalBrowserContextMenuBoxes()
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
  /**
   * The menu's actions for one page.
   *
   * `frame` and `point` are where the click that opened the menu landed, which
   * only the page's own right-click and the host's fallback can supply: they are
   * what a Peek opened from this menu grows out of.
   */
  private contextMenuActions(
    page: BrowserMenuPage,
    frame: BrowserViewBounds | null,
    point: BrowserPeekPoint | null
  ): BrowserContextMenuActions {
    const contents = page.contents
    const owner = page.owner
    const live = (): WebContents | null =>
      contents.isDestroyed() || this.window.isDestroyed() ? null : contents
    const openInNewTab = (url: string): void => {
      try {
        this.openNewTabFor(owner, validateBrowserUrl(url))
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
      openLinkInBox: (url, rawBoxId) => {
        const boxId = validateOptionalBoxId(rawBoxId)
        if (!boxId || !getGlobalBrowserContextMenuBoxes().some((box) => box.id === boxId)) return
        try {
          this.openNewTabFor({ ...owner, boxId }, validateBrowserUrl(url))
        } catch (error: unknown) {
          Logger.error('Browser context menu refused a link in a box:', error)
        }
      },
      ...(owner.projectId === GLOBAL_BROWSER_PROJECT_ID
        ? {
            openPeekWindow: (url: string): void => {
              const current = live()
              if (!current) return
              let target: string
              try {
                target = validateBrowserUrl(url)
              } catch (error: unknown) {
                Logger.error('Browser Peek refused a link:', error)
                return
              }
              this.openPeekFrom(owner, current, target, frame, point)
            }
          }
        : {}),
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
  private openNewTabFor(
    owner: BrowserPageOwner,
    url: string,
    peek = false,
    origin: BrowserViewBounds | null = null
  ): void {
    const sourceTabId = this.peekTabs.get(owner.tabId) ?? owner.tabId
    if (peek) {
      for (const [peekId, sourceId] of this.peekTabs) {
        if (sourceId === sourceTabId) this.destroy(peekId, 'closed')
      }
    }
    const tabId = `browser:${crypto.randomUUID()}`
    if (peek) this.peekTabs.set(tabId, sourceTabId)
    // A new sibling inherits the box it was opened from: a popup or a link
    // belongs beside the page that produced it, in the same jar.
    const tab = this.ensureTab(tabId, owner.projectId, owner.threadId, owner.boxId)
    tab.initialNavigationStarted = true
    this.parkTab(tabId)
    this.load(tabId, url)
    sendToRenderer(this.window.webContents, 'browser:openRequested', url, {
      projectId: owner.projectId,
      threadId: owner.threadId,
      requestedTabId: tabId,
      sourceTabId,
      peek,
      reveal: true,
      boxId: owner.boxId,
      origin
    })
  }

  /**
   * Open an ephemeral peek page, growing out of the link it was asked for.
   *
   * The probe is what makes the opening flight start on the link rather than at a
   * corner of the window, and it is bounded: the page is asked once, within
   * `PEEK_ORIGIN_PROBE_TIMEOUT_MS`, and the tab is created afterwards with whatever
   * answer came back. In practice that is a few milliseconds, because the question
   * is a containment test in a frame that is already running; the budget is what a
   * page that is busy, mid-navigation or without a document can cost, and it is
   * spent before the surface exists rather than while it is on screen.
   */
  private openPeekFrom(
    owner: BrowserPageOwner,
    contents: WebContents,
    url: string,
    frame: BrowserViewBounds | null,
    point: BrowserPeekPoint | null
  ): void {
    void this.peekOriginFor(contents, frame, point).then((origin) => {
      try {
        this.openNewTabFor(owner, url, true, origin)
      } catch (error: unknown) {
        Logger.error('Browser Peek refused a link:', error)
      }
    })
  }

  /**
   * Open a peek for a page that asked for a window of its own.
   *
   * Chromium reports no point for this gesture, but the pointer is the click: a
   * shift-click on a link is exactly this request, and the pointer is still on
   * the link when it arrives.
   */
  private openPeekFromWindowRequest(owner: BrowserPageOwner, url: string): void {
    const frame = this.frameForTab(owner.tabId)
    const source = this.tabs.get(owner.tabId)
    if (!frame || !source || source.view.webContents.isDestroyed()) {
      this.openNewTabFor(owner, url, true)
      return
    }
    const point = peekPointInFrame(this.pointerViewPoint(frame), frame)
    this.openPeekFrom(owner, source.view.webContents, url, frame, point)
  }

  /** Where the pointer is, in a page view's own pixels. */
  private pointerViewPoint(frame: BrowserViewBounds): BrowserPeekPoint {
    const cursor = screen.getCursorScreenPoint()
    const content = this.window.getContentBounds()
    return {
      x: Math.round(cursor.x - content.x - frame.x),
      y: Math.round(cursor.y - content.y - frame.y)
    }
  }

  /**
   * The rectangle a peek's flight starts from: the link under `point`, or null
   * when there is no point to speak of, because the page is not on screen, the
   * click never landed on it, or the page answered nothing in time.
   *
   * `point` arrives in the page view's own pixels, which is what Electron reports
   * for a right-click and what the pointer is read as, and the answer has to be in
   * the window's, because that is where the renderer's panel and ghost are laid
   * out. The frame is what converts one into the other.
   */
  private async peekOriginFor(
    contents: WebContents,
    frame: BrowserViewBounds | null,
    point: BrowserPeekPoint | null
  ): Promise<BrowserViewBounds | null> {
    if (frame === null || point === null) return null
    const link = await this.probeLinkRect(contents, point)
    return resolvePeekOrigin({
      link,
      point: { x: frame.x + point.x, y: frame.y + point.y },
      frame,
      zoomFactor: contents.isDestroyed() ? 1 : contents.getZoomFactor()
    })
  }

  /** Ask the page which link is under a point, bounded. */
  private async probeLinkRect(
    contents: WebContents,
    point: BrowserPeekPoint
  ): Promise<BrowserPeekRect | null> {
    if (contents.isDestroyed()) return null
    const script = peekProbeScript(peekProbePoint(point, contents.getZoomFactor()))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const answer = await Promise.race([
        contents.executeJavaScript(script) as Promise<unknown>,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PEEK_ORIGIN_PROBE_TIMEOUT_MS)
        })
      ])
      return parsePeekProbeAnswer(answer)
    } catch {
      // A page mid-navigation answers with an error rather than a rectangle.
      return null
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
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
    const sourceTab = this.ensureTab(
      tabId,
      page.owner.projectId,
      page.owner.threadId,
      page.owner.boxId
    )
    sourceTab.initialNavigationStarted = true
    this.parkTab(tabId)
    this.navigateTo(tabId, target)
    sendToRenderer(this.window.webContents, 'browser:openRequested', target, {
      projectId: page.owner.projectId,
      threadId: page.owner.threadId,
      requestedTabId: tabId,
      reveal: true,
      boxId: page.owner.boxId
    })
  }

  /** Run the context-menu web search in a new tab, using the reported engine. */
  private searchSelectionInNewTab(owner: BrowserPageOwner, query: string): void {
    const url = buildBrowserSearchUrl(this.contextMenuSearchEngine, query)
    if (!url) return
    try {
      this.openNewTabFor(owner, validateBrowserUrl(url))
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
      // The surface the tab belongs to. A store that keeps something per browser
      // (the browsing history does) reads the ownership here rather than looking
      // the tab up in a list the other surface's tabs are not in.
      projectId: tab.projectId,
      threadId: tab.threadId,
      boxId: tab.boxId,
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
      frameUrl: string | null
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
      timestamp: Date.now(),
      frameUrl: input.frameUrl === null ? null : input.frameUrl.slice(0, 2_048)
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
        this.parkTab(tabId)
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
  private schedulePark(tabId: string): void {
    if (this.pendingParks.has(tabId)) return
    const handle = setTimeout(() => {
      this.pendingParks.delete(tabId)
      this.parkTab(tabId)
    }, RENDERER_PARK_GRACE_MS)
    this.pendingParks.set(tabId, handle)
  }

  /**
   * Forget a deferred hide, because the tab is being shown again after all, or
   * because its park is settled some other way: the park itself, and the tab
   * being destroyed.
   */
  private dropPendingPark(tabId: string): void {
    const handle = this.pendingParks.get(tabId)
    if (handle === undefined) return
    clearTimeout(handle)
    this.pendingParks.delete(tabId)
  }

  /**
   * Park a tab in an invisible stage window, where it keeps a real viewport and
   * keeps producing frames no matter what the user is looking at.
   *
   * The page is laid out at `options.size` when a caller has one to insist on
   * (the toast case, which must preserve the frame the user is looking at), and at
   * the tab's own parked viewport otherwise.
   */
  private parkTab(tabId: string, options: ParkBrowserTabOptions = {}): void {
    // The park this timer was going to do is happening now, so it is spent.
    this.dropPendingPark(tabId)
    const tab = this.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return
    // A deferred hide can land after the app window is gone (the app is quitting),
    // and there is no child list left to take the view out of.
    if (this.window.isDestroyed()) return
    // Leaving a tab is one of the two moments its stack has to be written down:
    // the view keeps running offscreen, but the app must not depend on that. The
    // write is coalesced, so a run of parks as the user moves around is one write.
    this.captureTabHistory(tabId, tab)
    // A switch waiting for this tab is spent only when the park is a real
    // departure. A keep-active park (a toast holding the view off) leaves the tab
    // as the one on screen, so the switch has to survive until the page comes back
    // and `showActiveView` can honour it.
    if (!options.keepActive && this.pendingPageFocusTabId === tabId) {
      this.pendingPageFocusTabId = null
    }
    const viewport = options.size ?? this.parkedViewportFor(tab)
    this.window.contentView.removeChildView(tab.view)
    // The view is leaving the window, so whatever frame it was displayed at no
    // longer describes where it is.
    if (this.displayedTab?.tabId === tabId) this.displayedTab = null
    this.stage.park(tab.view, viewport)
    this.markParked(tabId)
    if (this.targetUrlTabId === tabId) this.dismissStatusOverlay()
    if (this.activeTabId === tabId && !options.keepActive) {
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
      }
      // The page is already on screen, which is the one moment a held switch can
      // be honoured without waiting for another show.
      this.takePendingPageFocus(tabId)
      return
    }
    // A view the stage was holding is off the window, so the page has already been
    // told the pointer left it and needs the pointer position again once it is
    // back.
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
    // The DOM toast replaces the overlay window's own content, so the preview
    // steps aside with it rather than drawing over the toast.
    if (visible) this.dismissStatusOverlay()
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
        keepActive: true
      })
      return
    }
    this.showActiveView()
  }

  /**
   * Show or drop the link preview for a report from a page's pointer.
   *
   * `update-target-url` carries the resolved address under the pointer and an
   * empty string once it leaves the link, which is the one signal that takes the
   * bubble down. Only the page actually on screen can be hovered, so a report
   * from a parked or background tab is dropped rather than drawn over another.
   */
  private onTargetUrlReport(tabId: string, url: string): void {
    const target = statusTextForTarget(url)
    if (target === null) {
      if (this.targetUrlTabId === tabId) this.dismissStatusOverlay()
      return
    }
    if (this.window.isDestroyed()) return
    if (this.activeTabId !== tabId || this.toastVisible) return
    this.targetUrl = target
    this.targetUrlTabId = tabId
    this.refreshStatusOverlay()
  }

  /**
   * Re-place the preview from the tab and frame that are current, or take it down
   * when there is nothing it can be drawn against.
   *
   * Called on a hover, a tab switch, a frame change, and the page leaving the
   * screen, so a bubble only ever belongs to the page the pointer is over and
   * never lingers after it. A frame that produces the same placement is not a
   * repaint, which matters because a surface animation re-reports its frame every
   * frame it runs.
   */
  private refreshStatusOverlay(): void {
    if (this.window.isDestroyed()) return
    const bounds = this.activeTabBounds
    const target = this.targetUrl
    if (
      target === null ||
      this.targetUrlTabId !== this.activeTabId ||
      this.toastVisible ||
      bounds === null
    ) {
      this.setStatusOverlay(null)
      return
    }
    const placement = browserStatusOverlayPlacement(bounds, this.window.getContentBounds().height)
    const current = this.statusOverlay
    if (
      current !== null &&
      current.url === target &&
      current.left === placement.left &&
      current.bottom === placement.bottom
    ) {
      return
    }
    this.setStatusOverlay({ url: target, left: placement.left, bottom: placement.bottom })
  }

  /** Send the preview to the overlay window, tracking what is on display. */
  private setStatusOverlay(request: BrowserStatusOverlay | null): void {
    this.statusOverlay = request
    this.overlay.applyStatus(request)
  }

  /** Drop the preview, for the page that owns it leaving the screen. */
  private dismissStatusOverlay(): void {
    if (this.targetUrl === null && this.targetUrlTabId === null) return
    this.targetUrl = null
    this.targetUrlTabId = null
    this.refreshStatusOverlay()
  }

  private destroy(tabId: string, reason: BrowserTabDestroyReason): void {
    // A hide that is still inside its grace window must not park a tab that is
    // about to be gone: the view would be handed to the stage window only to be
    // destroyed.
    this.dropPendingPark(tabId)
    if (reason === 'closed') {
      for (const [peekId, sourceId] of this.peekTabs) {
        if (sourceId === tabId) this.destroy(peekId, 'closed')
      }
    }
    const tab = this.tabs.get(tabId)
    // The stack dies with the view, so a tab that is only being hibernated hands
    // its stack over before it goes. A tab that is being closed hands it to the
    // session's reopen set instead: the stack outlives the tab just long enough
    // for Cmd/Ctrl+Shift+T to bring it back, and a restart empties that set. Both
    // halves run before the early return, because a destroy for a tab this process
    // no longer holds still has a record to settle.
    if (reason === 'hibernated') {
      if (tab) this.captureTabHistory(tabId, tab)
    } else {
      if (!this.peekTabs.has(tabId)) this.stashClosedTabHistory(tabId, tab)
      else this.peekTabs.delete(tabId)
      this.tabHistory.forget(tabId)
    }
    if (!tab) return
    // The extension-visible removal goes out before the page closes, because the
    // id it carries is the page's own.
    const removedContents: WebContents | undefined = tab.view.webContents
    if (removedContents && !removedContents.isDestroyed()) {
      this.notifyExtensionTab(tabId, tab.projectId, tab.boxId, 'onRemoved', [
        removedContents.id,
        { windowId: 0, isWindowClosing: false }
      ])
    }
    // A popup window is the tab's own window as far as the user is concerned, so
    // closing the tab closes what its page opened rather than leaving a sign-in
    // stranded behind a tab that no longer exists.
    this.popupWindows.closeForTab(tabId, 'its tab closed')
    this.sidePanels.closeForTab(tabId, 'its tab closed')
    for (const [requestId, pending] of this.pendingPermissions) {
      if (pending.request.tabId === tabId)
        this.resolvePermission(requestId, permissionResolutions.dismiss)
    }
    if (this.activeTabId === tabId) {
      this.activeTabId = null
      this.activeTabBounds = null
    }
    if (this.displayedTab?.tabId === tabId) this.displayedTab = null
    if (this.targetUrlTabId === tabId) this.dismissStatusOverlay()
    // A destroyed tab can no longer hold the keyboard, so its toolbar must not
    // stay the tab the window-level interception routes to.
    if (this.focusedChromeTabId === tabId) this.focusedChromeTabId = null
    this.injectedDialogLabels.delete(tabId)
    this.extensionNavigationUrls.delete(tabId)
    this.forgetParked(tabId)
    this.agentReveals.delete(tabId)
    this.lastScreenshot.delete(tabId)
    this.playheads.delete(tabId)
    this.scrollbarStyles.delete(tabId)
    this.capture.forget(tabId)
    this.inspector.forget(tabId)
    this.findSessions.take(tabId)
    this.stage.release(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.tabs.delete(tabId)
    // A cached popup is still a live extension document. Unloading its extension
    // would invalidate that document even though it remains available for reuse.
    if (!this.jarHasLivePage(tab.projectId, tab.boxId)) {
      void this.extensions.onJarEmptied(tab.projectId, tab.boxId)
    }
    for (const [contextKey, agentTabId] of this.agentTabIds) {
      if (agentTabId === tabId) this.agentTabIds.delete(contextKey)
    }
    for (const [threadId, pageTabId] of this.assistantPageTabIds) {
      if (pageTabId === tabId) this.assistantPageTabIds.delete(threadId)
    }
  }

  /**
   * The page tab a browser assistant conversation answers about, when the tab is
   * live.
   *
   * A binding whose tab is gone (closed or never created in this process) reads
   * as no binding rather than as an error, so an operation reports that it has no
   * page to read instead of failing a turn over a tab the user closed.
   */
  private attachedPageTab(threadId: string): BrowserTab | null {
    const tabId = this.assistantPageTabIds.get(threadId)
    if (!tabId) return null
    return this.tabs.get(tabId) ?? null
  }

  /**
   * The tab one browser utility call works on.
   *
   * An ordinary agent tab is one the agent opened and owns (`open`), addressed by
   * the conversation that asked for it. A browser tab's assistant conversation
   * owns no page, so it falls back to the page bound to it: the tab the user is
   * on. `attached` is what tells the caller the difference, because the two are
   * not interchangeable (see {@link ATTACHED_PAGE_OPERATIONS}).
   */
  private utilityTarget(
    contextKey: string,
    threadId: string
  ): { tabId: string; tab: BrowserTab; attached: boolean } | null {
    const ownedTabId = this.agentTabIds.get(contextKey)
    if (ownedTabId) {
      const owned = this.tabs.get(ownedTabId)
      if (owned) return { tabId: ownedTabId, tab: owned, attached: false }
    }
    const pageTabId = this.assistantPageTabIds.get(threadId)
    if (!pageTabId) return null
    const page = this.tabs.get(pageTabId)
    return page ? { tabId: pageTabId, tab: page, attached: true } : null
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

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'the current page'
  }
}

/**
 * What the link preview should show for a target the page reported, or null when
 * there is nothing useful to say.
 *
 * A `javascript:` link navigates nowhere, so Chromium leaves its own status
 * bubble empty for one and this does the same. An address that will not parse is
 * dropped for the same reason: it is not a place the user is about to visit.
 */
function statusTextForTarget(url: string): string | null {
  if (url.length === 0) return null
  try {
    return new URL(url).protocol === 'javascript:' ? null : url
  } catch {
    return null
  }
}

function fileChooserFilters(accept: string): Array<{ name: string; extensions: string[] }> {
  const extensions = [
    ...new Set(
      accept
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.startsWith('.') && !item.includes('*'))
        .map((item) => item.slice(1).toLowerCase())
        .filter((item) => /^[a-z0-9.+_-]+$/u.test(item))
    )
  ]
  return extensions.length > 0 ? [{ name: 'Accepted file types', extensions }] : []
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
