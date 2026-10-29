import type { AuthoredMotion } from '../../lib/design/motion-policy'
import {
  BrowserWindow,
  WebContentsView,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
  type WebFrameMain
} from 'electron'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { PermissionLevel } from '../../lib/types'
import {
  BUILT_IN_BROWSER_SEARCH_ENGINES,
  type BrowserSearchEngine
} from '../../lib/browser-search-engines'
import type {
  BrowserCompositionPlayback,
  CompositionFrameSnapshot,
  BrowserConsoleLevel,
  BrowserDesignTab,
  BrowserFindRequest,
  BrowserFindStopAction,
  BrowserLoadError,
  BrowserPageState,
  BrowserPanelShortcutAction,
  BrowserPageKey,
  BrowserShortcutAction,
  BrowserShortcutBindings,
  BrowserShortcutChord,
  BrowserSwitcherBindings,
  BrowserTabDestroyReason,
  BrowserThreadBrowserPage,
  BrowserScrollbarTheme,
  BrowserTransportCommand,
  BrowserViewBounds
} from '../../lib/ipc-contract'
import { type BrowserActionTarget } from './browser-service/browser-action-policy'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from '../system/logger'
import { getConfigRoot } from '../../lib/utils'
import type {
  BrowserExtensionActivityUpdate,
  BrowserExtensionProgress,
  BrowserInspectorEvent
} from '../../lib/ipc/browser'
import type { ReportedInspectorEvent } from './browser-service/browser-inspector'
import {
  BrowserExtensionService,
  type BrowserExtensionActionPopupOpenRequest,
  type BrowserExtensionSidePanelOpenRequest,
  type BrowserExtensionTabEventName,
  type BrowserExtensionTabReplay,
  type BrowserExtensionWebNavigationEventName
} from './extensions/browser-extension-service'
import { PermissionPromptWindow } from './permission-prompt-window'
import { BrowserOverlayWindow } from './browser-overlay-window'
import { NativeToastView } from './native-toast-view'
import { NativeStripView } from './native-strip-view'
import { type BrowserStatusOverlay } from '../../lib/browser-overlay'
import {
  BrowserDownloadManager,
  type BrowserDownloadOwner
} from './browser-service/browser-downloads'
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
import { type ShortcutKeyInput } from './browser-service/browser-shortcuts'
import {
  screenCaptureDeniedInLedger,
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
  type BrowserPageOwner,
  type BrowserTab,
  type BrowserViewport,
  type ParkBrowserTabOptions,
  type PendingBrowserPermission
} from './browser-service/browser-types'
import { type BrowserPeekMediaTarget, type BrowserPeekPoint } from './browser-service/browser-peek'
import { BrowserTabStage } from './browser-service/browser-stage'
import { BrowserPageKeys } from './browser-service/browser-page-keys'
import { BrowserLinkPeek } from './browser-service/browser-link-peek'
import { browserPartitionFor, type BrowserUtilityPage } from './browser-service/browser-validation'
import { type TabMarkRecogniser } from './browser-service/browser-tab-mark'
import { type BrowserExtensionPageTab } from './extensions/browser-extension-page-tabs'
import { BrowserFindSessions } from './browser-service/browser-find'
import { BrowserLoadWaits } from './browser-service/browser-load-wait'
import type { BrowserMenuPage } from './browser-service/browser-service-common'
import type { BrowserAgentActionApprover } from './browser-service/browser-service-agent-approval'
import type { BrowserExtensionTabInfo } from './browser-service/browser-service-extension-runtime'
import { BrowserServiceTabHistory } from './browser-service/browser-service-tab-history'
import { BrowserServiceLifecycle } from './browser-service/browser-service-lifecycle'
import { BrowserServiceConfiguration } from './browser-service/browser-service-configuration'
import { BrowserServiceIpcSurface } from './browser-service/browser-service-ipc-surface'
import { BrowserServiceAgentUtility } from './browser-service/browser-service-agent-utility'
import { BrowserServiceAgentFiles } from './browser-service/browser-service-agent-files'
import { BrowserServiceAgentScript } from './browser-service/browser-service-agent-script'
import { BrowserServiceSurfaces } from './browser-service/browser-service-surfaces'
import { BrowserServiceCompositionFrames } from './browser-service/browser-service-composition-frames'
import { BrowserServiceTransport } from './browser-service/browser-service-transport'
import { BrowserServiceKeyboard } from './browser-service/browser-service-keyboard'
import { BrowserServiceFindBar } from './browser-service/browser-service-find-bar'
import { BrowserServiceTabs } from './browser-service/browser-service-tabs'
import { BrowserServicePopups } from './browser-service/browser-service-popups'
import { BrowserServiceExtensionPages } from './browser-service/browser-service-extension-pages'
import { BrowserServiceExtensionRuntime } from './browser-service/browser-service-extension-runtime'
import { BrowserServiceSessions } from './browser-service/browser-service-sessions'
import { BrowserServicePermissions } from './browser-service/browser-service-permissions'
import { BrowserServiceNavigation } from './browser-service/browser-service-navigation'
import { BrowserServiceMenus } from './browser-service/browser-service-menus'
import { BrowserServiceNewTabs } from './browser-service/browser-service-new-tabs'
import { BrowserServicePageState } from './browser-service/browser-service-page-state'
import { BrowserServiceViewLifecycle } from './browser-service/browser-service-view-lifecycle'
import { BrowserServiceStatusOverlay } from './browser-service/browser-service-status-overlay'
import { BrowserServiceJars } from './browser-service/browser-service-jars'
import { BrowserServiceConversationPages } from './browser-service/browser-service-conversation-pages'

export type {
  BrowserAgentActionApproval,
  BrowserAgentActionDecision,
  BrowserAgentActionApprover
} from './browser-service/browser-service-agent-approval'

/** Owns sandboxed page content while the renderer owns the browser chrome. */
export class BrowserService {
  public readonly tabs = new Map<string, BrowserTab>()
  /** Native child tabs and the page that opened them. */
  public readonly childTabOpeners = new Map<string, string>()
  public readonly compositionArming = new WeakMap<
    BrowserTab,
    { generation: number; promise: Promise<void> }
  >()
  public readonly agentTabIds = new Map<string, string>()
  /**
   * The browser tab each assistant conversation answers about, by thread id.
   *
   * A browser tab's assistant chat is a real thread of its own rather than a tab,
   * so it owns no page: this is what lets its browser capability read the page the
   * user is on. The renderer writes it when the rail resolves the conversation and
   * it is dropped with the tab that carried it.
   */
  public readonly assistantPageTabIds = new Map<string, string>()
  /**
   * The page each conversation's thread browser is in use on, by conversation
   * scope.
   *
   * The thread browser is the browser a conversation shares with its agent, so
   * this is what lets the agent's browser capability reach the page the user is
   * reading: without it an agent could only ever answer about a page it opened
   * itself. Keyed by scope because that is what the strip groups its tabs by (a
   * project's threads share one browser, an inbox chat and an assistant own
   * theirs), and it holds the whole reference so a page this process has no view
   * for yet can be mounted. The app reports it; nothing an agent calls moves the
   * thread browser to another tab or another box.
   */
  public readonly threadBrowserPages = new Map<string, BrowserThreadBrowserPage>()
  public readonly configuredSessions = new Set<string>()
  /** Where the browser page's identity preload was written, or null if it could not be. */
  public browserIdentityPreloadPath: string | null = null
  public readonly permissionGrants = new Map<string, Set<string>>()
  public readonly permissionDenies = new Map<string, Set<string>>()
  public readonly pendingPermissions = new Map<string, PendingBrowserPermission>()
  public readonly capture: BrowserCaptureObserver
  /** Element inspector for design tabs. Injected page code reports picks and
   *  comments; the panel drives it through the browser IPC contract. */
  public readonly inspector: BrowserInspector
  public readonly siteData: BrowserSiteDataService
  /** The screen-share source picker for platforms without a native one, and the
   *  ledger gate that refuses a share the user remembered blocking. */
  public readonly screenShare: BrowserScreenShareService
  public readonly permissionMemory: BrowserPermissionMemory
  public readonly promptWindow: PermissionPromptWindow
  /**
   * The window that draws the toast stack and the floating tab strip while a page
   * covers where they belong. It is created on the first surface that needs it
   * and kept while a page keeps needing it, so a browsing session that never
   * raises a toast and never hovers the strip never pays for a second renderer.
   */
  public readonly overlay: BrowserOverlayWindow
  public readonly nativeToasts: NativeToastView
  public readonly nativeStrip: NativeStripView
  public readonly projects: ProjectRepo
  public readonly threads: ThreadRepo
  /** Invisible windows that keep non-displayed tabs alive offscreen. */
  public readonly stage: BrowserTabStage
  /** Last capture per tab, so a page that has not changed is not sent to the
   *  model a second time. A design thread was measured taking seven byte-identical
   *  screenshots in one turn, which is what drove it to compact repeatedly. */
  public readonly lastScreenshot = new Map<
    string,
    { hash: string; width: number; height: number }
  >()
  /** How a tab is recognised as showing a design or a composition, supplied by
   *  the app at boot. */
  public tabMarkRecogniser: TabMarkRecogniser | null = null
  /**
   * Where each composition tab's playhead was, kept across a reload.
   *
   * A preview refreshes itself whenever the agent writes, which reloads the page
   * and would otherwise throw the playhead away: the user would be sent back to
   * the start of the video every time the composition changed, which is the whole
   * complaint the transport answers. The folder is recorded with the position so a
   * playhead is only ever restored into the composition it came from.
   */
  public readonly playheads = new Map<
    string,
    { directory: string; time: number; playing: boolean }
  >()
  /**
   * Compositions the user muted, by folder.
   *
   * A mute is a decision about the film, not about the view showing it, so it is
   * held by folder and re-applied whenever that composition is armed or restored.
   * Keying it by tab made it vanish with the tab: every reload or re-open brought
   * the sound back, and the user had to mute the same video again.
   */
  public readonly mutedCompositions = new Set<string>()
  public activeTabId: string | null = null
  /**
   * The link target the pointer on the active page rests on, and the tab's page
   * that reported it, or null while none is.
   *
   * Kept raw beside the bubble so a page that moves under a resting pointer can
   * be re-placed from the same target rather than waiting for another hover.
   */
  public targetUrl: string | null = null
  public targetUrlTabId: string | null = null
  /**
   * Whether the pointer has rested on `targetUrl` long enough to paint it.
   *
   * A new target starts false and flips true when the resting delay elapses; a
   * target the bubble is already showing stays true so moving between links
   * updates it live. It gates the placement, so a pointer sweeping across a page
   * shows no bubble at all.
   */
  public statusDelayElapsed = false
  /** The pending resting-delay timer, or null while none is armed. */
  public statusShowTimer: ReturnType<typeof setTimeout> | null = null
  /** The link preview currently drawn by the overlay window, or null while none
   *  is. Compared against the next placement so a repeat frame is not a repaint. */
  public statusOverlay: BrowserStatusOverlay | null = null
  /** Chords the browser claims, resolved from the keymap by the renderer. Empty
   *  until that report arrives, which leaves every key to the rest of the app. */
  public shortcutBindings: BrowserShortcutBindings = {}
  /** The Ctrl+Tab switcher chords, pushed by the renderer from its keymap. A key
   *  pressed in a page never reaches the renderer, so main claims these here. */
  public switcherBindings: BrowserSwitcherBindings = []
  /**
   * Every app-global chord the keymap answers, pushed by the renderer.
   *
   * Main claims none of these itself. It matches a chord a page reported as
   * unhandled against them and replays the chord so the app's own handler runs,
   * which is the half of the browser's keyboard behaviour that has to happen after
   * the page has had its turn.
   */
  public appShortcutChords: BrowserShortcutChord[] = []
  public compositionShortcutChords: BrowserShortcutChord[] = []
  /**
   * Whether a page may keep a chord the app also binds.
   *
   * On, the shipped default: an overridable chord is offered to the page first and
   * only runs the browser's or the app's action when the page leaves it unhandled.
   * Off, the app claims every app chord in the page, so it wins whether the page is
   * focused or not.
   */
  public allowSiteKeymapOverride = true
  /** The page-side observer that reports a chord a page did not handle. */
  public readonly pageKeys = new BrowserPageKeys({
    onKey: (contents, key) => this.handlePageKey(contents, key)
  })
  /**
   * The page-side observer that reports an Option-click on a link.
   *
   * A click inside a native page view never reaches the app, so "take a peek"
   * cannot be a normal event handler here. The page names the link and the point
   * it was pressed at, and the peek grows out of that page's own frame.
   */
  public readonly linkPeek = new BrowserLinkPeek({
    onPeek: (contents, request) => this.newTabsUnit.openPeekFromPage(contents, request)
  })
  /**
   * Which find request each tab's page is answering.
   *
   * Chromium's find hands back a request id and every report carries it, so this
   * is what lets a report for a query the user has already moved past be dropped
   * rather than briefly overwriting the count on screen.
   */
  public readonly findSessions = new BrowserFindSessions()
  /**
   * The page-load waits every capture path shares.
   *
   * Held by the service so one page's listeners are one pair no matter how many
   * callers are waiting on it; see `BrowserLoadWaits` for why that matters.
   */
  public readonly loadWaits = new BrowserLoadWaits()
  /** Navigation starts waiting for the extension jar before Chromium sees loadURL. */
  public readonly pendingNavigationStarts = new Map<string, Promise<void>>()
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
  public focusedChromeTabId: string | null = null
  /**
   * The tab whose page should take the keyboard the moment it is on screen.
   *
   * A page can only be handed the keyboard while it is actually displayed, but a
   * user switch asks the instant the user picks the tab, which can be before the
   * show carrying that page lands. Holding the intent here is what keeps the
   * switch focused instead of losing the race to the page's own mount.
   */
  public pendingPageFocusTabId: string | null = null
  /**
   * The tab whose page last gained the keyboard, or null while the window's own
   * renderer did.
   *
   * Claimed by page clicks and explicit keyboard handovers, and released when
   * the app renderer gains focus. It is read on the window's `blur`, because
   * nothing inside the app gains focus while the whole window is losing it, so
   * at that moment it still names the page the user was typing in.
   */
  public keyboardOwnerTabId: string | null = null
  /**
   * The tab whose page should get the keyboard back when the app window is
   * reactivated, captured from {@link keyboardOwnerTabId} at the window's
   * `blur`.
   *
   * Reactivating a window hands the keyboard to the window's own web contents,
   * not to the `WebContentsView` that had it (the same handoff
   * `browser-history-swipe.ts` corrects for history traversal), so a page the
   * user was typing in comes back unfocused unless it is deliberately refocused.
   */
  public restorePageFocusTabId: string | null = null
  /** Last known content bounds of the active tab's native view (window-content
   *  coordinates). The permission popup centres itself over this area, so the
   *  prompt opens over the page it belongs to rather than over the app's chrome. */
  public activeTabBounds: BrowserViewBounds | null = null
  /** The view actually parented to the app window, and the frame it sits at, or
   *  null while the active tab's view is parked offscreen.
   *
   *  The renderer re-reports the same frame once per animation frame while it
   *  aligns the panel with an entry transform, so `showActiveView` needs to tell
   *  "attach this now" from "it is already there": re-adding a child view is a
   *  window-server commit, and doing that sixty times a second for a frame that
   *  never moved is the difference between an instant switch and a hitch. */
  public displayedTab: { tabId: string; bounds: BrowserViewBounds } | null = null
  /** Only the latest show may attach after asynchronous extension preparation. */
  public pendingShow: { tabId: string } | null = null
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
  public readonly pendingParks = new Map<string, ReturnType<typeof setTimeout>>()
  /** The dialog-context label already installed in each tab's current document.
   *  The shim is idempotent per document, so a repeat is a script evaluation
   *  per frame for no change. Cleared when a new document commits. */
  public readonly injectedDialogLabels = new Map<string, string>()
  /** The last address each tab's main frame committed or moved to inside the
   *  page, so a navigation event can be told from a reload and a fragment change
   *  from a history push. Chromium's own transition is not exposed. */
  public readonly extensionNavigationUrls = new Map<string, string>()
  /** Parked tab ids in least-recently-used order, newest last. Drives the cap on
   *  how many tabs may render offscreen at once. */
  public readonly parkedOrder: string[] = []
  /** Tabs the agent just revealed to the user, so a tab the user immediately
   *  leaves can be counted as an ignored reveal. `shown` records that the reveal
   *  actually reached the screen, which is what makes leaving it meaningful. */
  public readonly agentReveals = new Map<
    string,
    { threadKey: string; at: number; shown: boolean }
  >()
  /** Consecutive ignored reveals per thread, with when the last one happened. */
  public readonly abandonedReveals = new Map<string, { count: number; at: number }>()
  /** Threads whose agent reveals were ignored, until this timestamp. */
  public readonly relaxedUntil = new Map<string, number>()
  /** True while the renderer asked for the active browser view to be parked
   *  because a toast could not be placed anywhere a page does not cover.
   *
   *  A native WebContentsView floats above every DOM surface, so while this is set
   *  the active view stays detached and the DOM toast composites normally. This
   *  is the safety net for the one case the toast overlay cannot serve (it could
   *  not be created at all), not the primary path: the renderer normally moves
   *  the stack into `browser-overlay-window.ts`, which draws it above the page. */
  public toastVisible = false
  /**
   * The address bar's active search engine, reported by the renderer (which
   * owns the config) so the native context menu can label and run its
   * "Search <engine> for ..." item. Defaults to the shipped engine until the
   * first report lands.
   */
  public contextMenuSearchEngine: BrowserSearchEngine = BUILT_IN_BROWSER_SEARCH_ENGINES[0]
  /** The app's default-scrollbar colours, applied to every tab's page. Null
   *  until the renderer pushes them once at boot. */
  public scrollbarTheme: BrowserScrollbarTheme | null = null
  /** The user-origin stylesheet inserted per tab, so a theme swap can replace
   *  the previous one instead of stacking. */
  public scrollbarStyles = new Map<string, string>()
  /**
   * Every tab's Back/Forward stack, made durable.
   *
   * The stack lives in the live `WebContentsView` and goes with it, and this
   * process is the only one that can read it off a view or that sees all three
   * moments it has to be written down: parking a view, destroying a tab, and
   * quitting. See `browser-tab-history-store.ts`.
   */
  public readonly tabHistory = new BrowserTabHistoryStore()
  /** Stacks of tabs closed this session, held only until the tab is reopened. */
  public readonly closedTabHistory = new BrowserClosedTabHistory()
  public peekTabs = new Map<string, string>()
  public consoleSequence = 0
  /**
   * The popup windows pages have opened, hosted by the app rather than by the
   * system. Created with the rest of the view plumbing below, because its host
   * is this service's own window handling.
   */
  public readonly popupWindows: BrowserPopupWindows
  /** One in-flight extension popup creation per project, box, and extension. */
  public readonly extensionPopupOpenings = new Map<string, Promise<string>>()
  /**
   * The extension side panels the rail hosts, over the frame it measures. A panel
   * is the extension's own document, loaded in the jar the extension runs in,
   * exactly as its action popup is, and `chrome.sidePanel` is compiled out of the
   * runtime so this is the only host one can have.
   */
  public readonly sidePanels: BrowserExtensionSidePanels
  /**
   * The popup views currently mounted in the app window.
   *
   * Tracked rather than read back from `contentView.children`: a popup's page can
   * destroy itself at any moment (that is how a finished sign-in ends), and once
   * its view no longer carries web contents the window's own child list throws
   * when it is read. The app therefore has to know what it mounted itself.
   */
  public readonly mountedPopupViews = new Set<WebContentsView>()
  /** The frame each mounted popup view was last placed at, so a move is reported
   *  as a move rather than as another placement. */
  public readonly popupViewFrames = new Map<WebContentsView, BrowserViewBounds>()
  /** The side-panel views currently mounted in the app window, tracked for the
   *  same reason the popup views are. */
  public readonly mountedSidePanelViews = new Set<WebContentsView>()
  /** The frame each mounted side-panel view was last placed at. */
  public readonly sidePanelViewFrames = new Map<WebContentsView, BrowserViewBounds>()
  /**
   * Installed extensions, and which jars load them.
   *
   * Built with the service because reading the registry is one small file, and
   * nothing actually loads an extension until a jar asks for a page: the cost of
   * the feature is per live jar, not per app launch.
   */
  public readonly extensions: BrowserExtensionService
  /**
   * Permission-card approver for attached-page mutations, supplied by the app
   * at boot. When present, Auto Review routes through the thread's permission
   * card instead of the native dialog, so the request sets `awaiting_approval`,
   * notifies attention, and stays covered by policy automation.
   */
  public agentActionApprover: BrowserAgentActionApprover | null = null
  // ─── The preload that lands in time ────────────────────────────────────────

  /** Where the page-tabs preload was written, or null before it has been, or if
   *  it could not be written at all. */
  public extensionPageTabsPreload: string | null = null
  /** The one write, shared by every caller that needs the preload. */
  public extensionPageTabsPreloadWrite: Promise<string | null> | null = null
  // ---------------------------------------------------------------------------
  // The concern units. Each owns one job from `browser-service/`; the service
  // keeps the state they share and hands each call to the unit that owns it, so
  // the rest of main still talks to one object.
  // ---------------------------------------------------------------------------
  private readonly tabHistoryUnit: BrowserServiceTabHistory
  private readonly lifecycleUnit: BrowserServiceLifecycle
  private readonly configurationUnit: BrowserServiceConfiguration
  private readonly ipcSurfaceUnit: BrowserServiceIpcSurface
  private readonly agentUtilityUnit: BrowserServiceAgentUtility
  private readonly agentFilesUnit: BrowserServiceAgentFiles
  private readonly agentScriptUnit: BrowserServiceAgentScript
  private readonly surfacesUnit: BrowserServiceSurfaces
  private readonly compositionFramesUnit: BrowserServiceCompositionFrames
  private readonly transportUnit: BrowserServiceTransport
  private readonly keyboardUnit: BrowserServiceKeyboard
  private readonly findBarUnit: BrowserServiceFindBar
  private readonly tabsUnit: BrowserServiceTabs
  private readonly popupsUnit: BrowserServicePopups
  private readonly extensionPagesUnit: BrowserServiceExtensionPages
  private readonly extensionRuntimeUnit: BrowserServiceExtensionRuntime
  private readonly sessionsUnit: BrowserServiceSessions
  private readonly permissionsUnit: BrowserServicePermissions
  private readonly navigationUnit: BrowserServiceNavigation
  private readonly menusUnit: BrowserServiceMenus
  private readonly newTabsUnit: BrowserServiceNewTabs
  private readonly pageStateUnit: BrowserServicePageState
  private readonly viewLifecycleUnit: BrowserServiceViewLifecycle
  private readonly statusOverlayUnit: BrowserServiceStatusOverlay
  private readonly jarsUnit: BrowserServiceJars
  private readonly conversationPagesUnit: BrowserServiceConversationPages

  constructor(
    public readonly window: BrowserWindow,
    public readonly db: Database,
    permissionPersistence: PermissionMemoryPersistence,
    public readonly downloads: BrowserDownloadManager
  ) {
    this.tabHistoryUnit = new BrowserServiceTabHistory(this)
    this.lifecycleUnit = new BrowserServiceLifecycle(this)
    this.configurationUnit = new BrowserServiceConfiguration(this)
    this.ipcSurfaceUnit = new BrowserServiceIpcSurface(this)
    this.agentUtilityUnit = new BrowserServiceAgentUtility(this)
    this.agentFilesUnit = new BrowserServiceAgentFiles(this)
    this.agentScriptUnit = new BrowserServiceAgentScript()
    this.surfacesUnit = new BrowserServiceSurfaces(this)
    this.compositionFramesUnit = new BrowserServiceCompositionFrames(this)
    this.transportUnit = new BrowserServiceTransport(this)
    this.keyboardUnit = new BrowserServiceKeyboard(this)
    this.findBarUnit = new BrowserServiceFindBar(this)
    this.tabsUnit = new BrowserServiceTabs(this)
    this.popupsUnit = new BrowserServicePopups(this)
    this.extensionPagesUnit = new BrowserServiceExtensionPages(this)
    this.extensionRuntimeUnit = new BrowserServiceExtensionRuntime(this)
    this.sessionsUnit = new BrowserServiceSessions(this)
    this.permissionsUnit = new BrowserServicePermissions(this)
    this.navigationUnit = new BrowserServiceNavigation(this)
    this.menusUnit = new BrowserServiceMenus(this)
    this.newTabsUnit = new BrowserServiceNewTabs(this)
    this.pageStateUnit = new BrowserServicePageState(this)
    this.viewLifecycleUnit = new BrowserServiceViewLifecycle(this)
    this.statusOverlayUnit = new BrowserServiceStatusOverlay(this)
    this.jarsUnit = new BrowserServiceJars(this)
    this.conversationPagesUnit = new BrowserServiceConversationPages(this)
    this.promptWindow = new PermissionPromptWindow(window)
    this.nativeToasts = new NativeToastView(window)
    this.nativeStrip = new NativeStripView(window)
    this.overlay = new BrowserOverlayWindow(window, undefined, (host) =>
      this.nativeToasts.setHost(host ?? window)
    )
    // Chromium drops its own status bubble when the window loses the pointer's
    // context; so does this. The same moment captures which surface held the
    // keyboard, so reactivating the window can hand the page its keyboard back;
    // see `restorePageFocusTabId`.
    window.on('blur', () => {
      this.restorePageFocusTabId = this.keyboardOwnerTabId
      this.dismissStatusOverlay()
    })
    window.on('focus', () => this.restorePageFocus())
    // The renderer owns the keyboard whenever the user works in the app chrome
    // rather than the page, so this is what keeps a page from being refocused on
    // return when the user had actually been in the toolbar.
    window.webContents.on('focus', () => {
      this.keyboardOwnerTabId = null
      this.pendingPageFocusTabId = null
    })
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
      openPopup: (request) => this.openExtensionWindowFromWorker(request),
      // A capture extension stops the browser's own transfer to fetch the file
      // with its own manager, and the app's download manager is the only thing
      // that can stop it.
      downloadCommand: (command) => this.downloads.applyExtensionCommand(command),
      // `chrome.runtime.openOptionsPage()` from a worker has no window of its own,
      // so the page it asks for opens as a tab in the jar the extension runs in.
      openExtensionPage: (projectId, boxId, extensionId, page) =>
        this.openExtensionPageFromWorker({ projectId, boxId, extensionId, page })
    })
    // Every download this browser starts is also reported to the extensions that
    // declared the `downloads` permission, which is what a download manager
    // extension captures. Nothing crosses into a worker when no extension asked.
    this.downloads.setExtensionObserver((event) => {
      const args: unknown[] = event.item ? [event.item] : [event.id]
      this.extensions.onDownloadEvent(event.projectId, event.boxId, event.name, args)
    })
    // An extension that watches downloads captures them by cancelling, so a new
    // download in that jar starts without a save dialog: it would be a dialog for
    // a file the extension is about to discard.
    this.downloads.setDownloadWatcher((projectId, boxId) =>
      this.extensions.watchesDownloadsInJar(projectId, boxId)
    )
    this.capture = new BrowserCaptureObserver({
      // A capture change is a tab-level fact the user must see, so it is
      // published on the same state event the tab strip already listens to.
      onChange: (tabId) => this.publishState(tabId)
    })
    this.inspector = new BrowserInspector({
      // Every pick, comment and removal is forwarded to the renderer, which owns
      // the reference list and turns it back into the page's marker set.
      onEvent: (tabId, event) => {
        sendToRenderer(
          this.window.webContents,
          'browser:inspector',
          tabId,
          this.anchorInspectorEvent(tabId, event)
        )
      }
    })
  }

  // ---------------------------------------------------------------------------
  // browser-service-tab-history.ts
  // ---------------------------------------------------------------------------

  async hydrateTabHistory(): Promise<void> {
    return this.tabHistoryUnit.hydrateTabHistory()
  }

  captureTabHistory(tabId: string, tab: BrowserTab): void {
    this.tabHistoryUnit.captureTabHistory(tabId, tab)
  }

  stashClosedTabHistory(tabId: string, tab: BrowserTab | undefined): void {
    this.tabHistoryUnit.stashClosedTabHistory(tabId, tab)
  }

  restoreTabHistory(tabId: string, tab: BrowserTab, fallbackUrl: string): boolean {
    return this.tabHistoryUnit.restoreTabHistory(tabId, tab, fallbackUrl)
  }

  async flushTabHistory(): Promise<void> {
    return this.tabHistoryUnit.flushTabHistory()
  }

  // ---------------------------------------------------------------------------
  // browser-service-lifecycle.ts
  // ---------------------------------------------------------------------------

  private anchorInspectorEvent(
    tabId: string,
    event: ReportedInspectorEvent
  ): BrowserInspectorEvent {
    return this.lifecycleUnit.anchorInspectorEvent(tabId, event)
  }

  async hydratePermissionMemory(): Promise<void> {
    return this.lifecycleUnit.hydratePermissionMemory()
  }

  dispose(): void {
    this.lifecycleUnit.dispose()
  }

  relocateWorkFolder(
    projectId: string,
    from: string,
    to: string,
    assistantId?: string | null
  ): void {
    this.lifecycleUnit.relocateWorkFolder(projectId, from, to, assistantId)
  }

  // ---------------------------------------------------------------------------
  // browser-service-configuration.ts
  // ---------------------------------------------------------------------------

  markDesignTab(tabId: string, design: BrowserDesignTab): void {
    this.configurationUnit.markDesignTab(tabId, design)
  }

  setTabMarkRecogniser(recogniser: TabMarkRecogniser | null): void {
    this.configurationUnit.setTabMarkRecogniser(recogniser)
  }

  setAgentActionApprover(approver: BrowserAgentActionApprover | null): void {
    this.configurationUnit.setAgentActionApprover(approver)
  }

  setSearchEngine(engine: BrowserSearchEngine): void {
    this.configurationUnit.setSearchEngine(engine)
  }

  setScrollbarTheme(theme: BrowserScrollbarTheme): void {
    this.configurationUnit.setScrollbarTheme(theme)
  }

  applyScrollbarTheme(tabId: string, contents: WebContents): void {
    this.configurationUnit.applyScrollbarTheme(tabId, contents)
  }

  refreshTabMark(tabId: string, tab: BrowserTab): void {
    this.configurationUnit.refreshTabMark(tabId, tab)
  }

  // ---------------------------------------------------------------------------
  // browser-service-ipc-surface.ts
  // ---------------------------------------------------------------------------

  register(): void {
    this.ipcSurfaceUnit.register()
  }

  // ---------------------------------------------------------------------------
  // browser-service-agent-utility.ts
  // ---------------------------------------------------------------------------

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
    return this.agentUtilityUnit.executeUtility(operation, input, context)
  }

  // ---------------------------------------------------------------------------
  // browser-service-agent-files.ts
  // ---------------------------------------------------------------------------

  async uploadFiles(
    tabId: string,
    tab: BrowserTab,
    input: Record<string, unknown>,
    permissionLevel: PermissionLevel | undefined
  ): Promise<Record<string, unknown>> {
    return this.agentFilesUnit.uploadFiles(tabId, tab, input, permissionLevel)
  }

  async captureScreenshot(
    tabId: string,
    tab: BrowserTab,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.agentFilesUnit.captureScreenshot(tabId, tab, input)
  }

  // ---------------------------------------------------------------------------
  // browser-service-agent-script.ts
  // ---------------------------------------------------------------------------

  async runAgentScript(contents: WebContents, script: string): Promise<unknown> {
    return this.agentScriptUnit.runAgentScript(contents, script)
  }

  agentSelector(input: Record<string, unknown>): string {
    return this.agentScriptUnit.agentSelector(input)
  }

  optionalAgentSelector(input: Record<string, unknown>): string | undefined {
    return this.agentScriptUnit.optionalAgentSelector(input)
  }

  agentBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    return this.agentScriptUnit.agentBoundedNumber(value, fallback, min, max)
  }

  agentSignedNumber(value: unknown, fallback: number): number {
    return this.agentScriptUnit.agentSignedNumber(value, fallback)
  }

  async agentPointFrom(
    input: Record<string, unknown>,
    tab: BrowserTab,
    label: 'point' | 'from' | 'to'
  ): Promise<{ x: number; y: number }> {
    return this.agentScriptUnit.agentPointFrom(input, tab, label)
  }

  async agentTargetChanged(
    contents: WebContents,
    selector: string,
    reviewedTarget: BrowserActionTarget | null
  ): Promise<boolean> {
    return this.agentScriptUnit.agentTargetChanged(contents, selector, reviewedTarget)
  }

  async clickAgentTarget(
    tab: BrowserTab,
    selector: string,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.agentScriptUnit.clickAgentTarget(tab, selector, input)
  }

  async paintAgentCursor(
    tab: BrowserTab,
    point: { x: number; y: number },
    press: boolean
  ): Promise<void> {
    return this.agentScriptUnit.paintAgentCursor(tab, point, press)
  }

  async paintAgentCursorAtElement(
    tab: BrowserTab,
    selector: string,
    press: boolean
  ): Promise<void> {
    return this.agentScriptUnit.paintAgentCursorAtElement(tab, selector, press)
  }

  requiredInputString(input: Record<string, unknown>, field: string, allowEmpty = false): string {
    return this.agentScriptUnit.requiredInputString(input, field, allowEmpty)
  }

  // ---------------------------------------------------------------------------
  // browser-service-surfaces.ts
  // ---------------------------------------------------------------------------

  reloadPreviewOrigin(origin: string): number {
    return this.surfacesUnit.reloadPreviewOrigin(origin)
  }

  async reloadKeepingPlayhead(tabId: string, tab: BrowserTab): Promise<void> {
    return this.surfacesUnit.reloadKeepingPlayhead(tabId, tab)
  }

  async readPlayhead(tabId: string): Promise<{ time: number; playing: boolean } | null> {
    return this.surfacesUnit.readPlayhead(tabId)
  }

  async rememberPlayhead(tabId: string, tab: BrowserTab): Promise<void> {
    return this.surfacesUnit.rememberPlayhead(tabId, tab)
  }

  takePlayhead(tabId: string, directory: string): { time: number; playing: boolean } | null {
    return this.surfacesUnit.takePlayhead(tabId, directory)
  }

  agentTabFor(projectId: string, threadId: string): string | null {
    return this.surfacesUnit.agentTabFor(projectId, threadId)
  }

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
    return this.surfacesUnit.openDesignScreen(input)
  }

  async showThreadWorkTab(input: {
    projectId: string
    threadId: string
    url: string
    attention: 'focus' | 'background'
    reveal: boolean
  }): Promise<{ tabId: string; tab: 'reused' | 'opened' }> {
    return this.surfacesUnit.showThreadWorkTab(input)
  }

  async showCompositionBoardTab(input: {
    projectId: string
    threadId: string
    /** Project-relative folder of the composition, with forward slashes. */
    directory: string
    url: string
  }): Promise<{ tabId: string; tab: 'reused' | 'opened' }> {
    return this.surfacesUnit.showCompositionBoardTab(input)
  }

  tabUrl(tabId: string): string | null {
    return this.surfacesUnit.tabUrl(tabId)
  }

  revealTab(tabId: string): void {
    this.surfacesUnit.revealTab(tabId)
  }

  async waitForTabLoad(tabId: string, timeoutMs = 8_000): Promise<void> {
    return this.surfacesUnit.waitForTabLoad(tabId, timeoutMs)
  }

  async captureThumbnail(
    tabId: string,
    maxWidth: number
  ): Promise<{ dataUrl: string; width: number; height: number } | null> {
    return this.surfacesUnit.captureThumbnail(tabId, maxWidth)
  }

  designMotionTab(projectId: string, threadId: string, expectedUrl: string): string | null {
    return this.surfacesUnit.designMotionTab(projectId, threadId, expectedUrl)
  }

  async inspectDesignMotion(
    tabId: string,
    expectedUrl: string,
    input: { targetId?: string; motion?: AuthoredMotion; sampleMs?: number }
  ): Promise<unknown> {
    return this.surfacesUnit.inspectDesignMotion(tabId, expectedUrl, input)
  }

  // ---------------------------------------------------------------------------
  // browser-service-composition-frames.ts
  // ---------------------------------------------------------------------------

  async renderTabFrame(
    tabId: string,
    seconds: number
  ): Promise<{ rendered: boolean; reason?: string }> {
    return this.compositionFramesUnit.renderTabFrame(tabId, seconds)
  }

  async captureCompositionFrame(
    tabId: string,
    seconds: number
  ): Promise<CompositionFrameSnapshot | null> {
    return this.compositionFramesUnit.captureCompositionFrame(tabId, seconds)
  }

  // ---------------------------------------------------------------------------
  // browser-service-transport.ts
  // ---------------------------------------------------------------------------

  async armCompositionTransport(tabId: string, tab: BrowserTab): Promise<void> {
    return this.transportUnit.armCompositionTransport(tabId, tab)
  }

  armCompositionQuietly(tabId: string, tab: BrowserTab): void {
    this.transportUnit.armCompositionQuietly(tabId, tab)
  }

  async transport(
    tabId: string,
    command: BrowserTransportCommand,
    value: number | boolean
  ): Promise<BrowserCompositionPlayback | null> {
    return this.transportUnit.transport(tabId, command, value)
  }

  async transportState(tabId: string): Promise<BrowserCompositionPlayback | null> {
    return this.transportUnit.transportState(tabId)
  }

  async sendTransport(
    tabId: string,
    command: BrowserTransportCommand,
    value: number | boolean
  ): Promise<BrowserCompositionPlayback | null> {
    return this.transportUnit.sendTransport(tabId, command, value)
  }

  releaseTransportAudio(tabId: string, tab: BrowserTab): void {
    this.transportUnit.releaseTransportAudio(tabId, tab)
  }

  // ---------------------------------------------------------------------------
  // browser-service-keyboard.ts
  // ---------------------------------------------------------------------------

  runBrowserShortcut(tabId: string, action: BrowserShortcutAction): void {
    this.keyboardUnit.runBrowserShortcut(tabId, action)
  }

  canUseScreenHistory(tabId: string): boolean {
    return this.keyboardUnit.canUseScreenHistory(tabId)
  }

  consumeSwitcherKey(input: ShortcutKeyInput): boolean {
    return this.keyboardUnit.consumeSwitcherKey(input)
  }

  requestPanelShortcut(tabId: string, action: BrowserPanelShortcutAction): void {
    this.keyboardUnit.requestPanelShortcut(tabId, action)
  }

  private handlePageKey(contents: WebContents, key: BrowserPageKey): void {
    this.keyboardUnit.handlePageKey(contents, key)
  }

  dispatchPageKey(key: BrowserPageKey): void {
    this.keyboardUnit.dispatchPageKey(key)
  }

  consumeChromeShortcut(event: Electron.Event, input: Electron.Input): boolean {
    return this.keyboardUnit.consumeChromeShortcut(event, input)
  }

  navigateFocusedHistory(direction: 'back' | 'forward'): boolean {
    return this.keyboardUnit.navigateFocusedHistory(direction)
  }

  toggleDevTools(contents: WebContents): boolean {
    return this.keyboardUnit.toggleDevTools(contents)
  }

  stepTabZoom(contents: WebContents, step: number): void {
    this.keyboardUnit.stepTabZoom(contents, step)
  }

  // ---------------------------------------------------------------------------
  // browser-service-find-bar.ts
  // ---------------------------------------------------------------------------

  findInPage(tabId: string, request: BrowserFindRequest): void {
    this.findBarUnit.findInPage(tabId, request)
  }

  stopFindInPage(tabId: string, action: BrowserFindStopAction): void {
    this.findBarUnit.stopFindInPage(tabId, action)
  }

  publishFindResult(
    tabId: string,
    requestId: number,
    report: { matches: number; activeMatchOrdinal: number }
  ): void {
    this.findBarUnit.publishFindResult(tabId, requestId, report)
  }

  // ---------------------------------------------------------------------------
  // browser-service-tabs.ts
  // ---------------------------------------------------------------------------

  boxOfExistingTab(tabId: string): string | null {
    return this.tabsUnit.boxOfExistingTab(tabId)
  }

  ensureTab(
    tabId: string,
    projectId: string,
    threadId: string,
    boxId: string | null = null,
    childContents?: WebContents
  ): BrowserTab {
    return this.tabsUnit.ensureTab(tabId, projectId, threadId, boxId, childContents)
  }

  tabIdForContents(projectId: string, contentsId: number): string | undefined {
    return this.tabsUnit.tabIdForContents(projectId, contentsId)
  }

  tabForContents(contentsId: number): { id: string; tab: BrowserTab } | null {
    return this.tabsUnit.tabForContents(contentsId)
  }

  private ownerTabForContents(contentsId: number): BrowserDownloadOwner | null {
    return this.tabsUnit.ownerTabForContents(contentsId)
  }

  requireTab(tabId: string): BrowserTab {
    return this.tabsUnit.requireTab(tabId)
  }

  liveTab(tabId: string): BrowserTab | undefined {
    return this.tabsUnit.liveTab(tabId)
  }

  isViewSourceDocument(contents: WebContents): boolean {
    return this.tabsUnit.isViewSourceDocument(contents)
  }

  destroy(tabId: string, reason: BrowserTabDestroyReason): void {
    this.tabsUnit.destroy(tabId, reason)
  }

  // ---------------------------------------------------------------------------
  // browser-service-popups.ts
  // ---------------------------------------------------------------------------

  raisePageChrome(): void {
    this.popupsUnit.raisePageChrome()
  }

  private popupWindowHost(): BrowserPopupWindowHost {
    return this.popupsUnit.popupWindowHost()
  }

  installWindowOpenPolicy(view: WebContentsView, owner: BrowserPageOwner): void {
    this.popupsUnit.installWindowOpenPolicy(view, owner)
  }

  runPopupWindowShortcut(record: BrowserPopupWindowRecord, action: BrowserShortcutAction): void {
    this.popupsUnit.runPopupWindowShortcut(record, action)
  }

  popupWindowMenuItems(record: BrowserPopupWindowRecord): MenuItemConstructorOptions[] {
    return this.popupsUnit.popupWindowMenuItems(record)
  }

  // ---------------------------------------------------------------------------
  // browser-service-extension-pages.ts
  // ---------------------------------------------------------------------------

  private openExtensionPageFromWorker(request: {
    projectId: string
    boxId: string | null
    extensionId: string
    page: 'options'
  }): void {
    this.extensionPagesUnit.openExtensionPageFromWorker(request)
  }

  openOptionsPageFromPage(contentsId: number): void {
    this.extensionPagesUnit.openOptionsPageFromPage(contentsId)
  }

  private openExtensionWindowFromWorker(request: BrowserExtensionActionPopupOpenRequest): void {
    this.extensionPagesUnit.openExtensionWindowFromWorker(request)
  }

  async openExtensionPopup(
    projectId: string,
    tabId: string,
    threadId: string,
    boxId: string | null,
    extensionId: string,
    requestedUrl?: string
  ): Promise<string | null> {
    return this.extensionPagesUnit.openExtensionPopup(
      projectId,
      tabId,
      threadId,
      boxId,
      extensionId,
      requestedUrl
    )
  }

  // ---------------------------------------------------------------------------
  // browser-service-extension-runtime.ts
  // ---------------------------------------------------------------------------

  private sidePanelHost(): BrowserExtensionSidePanelHost {
    return this.extensionRuntimeUnit.sidePanelHost()
  }

  async openExtensionSidePanel(request: BrowserExtensionSidePanelOpenRequest): Promise<void> {
    return this.extensionRuntimeUnit.openExtensionSidePanel(request)
  }

  private publishExtensions(): void {
    this.extensionRuntimeUnit.publishExtensions()
  }

  private publishExtensionActivity(update: BrowserExtensionActivityUpdate): void {
    this.extensionRuntimeUnit.publishExtensionActivity(update)
  }

  notifyExtensionTab(
    tabId: string,
    projectId: string,
    boxId: string | null,
    name: BrowserExtensionTabEventName,
    args: unknown[]
  ): void {
    this.extensionRuntimeUnit.notifyExtensionTab(tabId, projectId, boxId, name, args)
  }

  reportExtensionPageTabs(tabId: string): void {
    this.extensionRuntimeUnit.reportExtensionPageTabs(tabId)
  }

  extensionPageTabForContents(contentsId: number): BrowserExtensionPageTab | null {
    return this.extensionRuntimeUnit.extensionPageTabForContents(contentsId)
  }

  ensureExtensionPageTabsPreload(): Promise<string | null> {
    return this.extensionRuntimeUnit.ensureExtensionPageTabsPreload()
  }

  notifyExtensionWebNavigation(
    projectId: string,
    boxId: string | null,
    name: BrowserExtensionWebNavigationEventName,
    details: Record<string, unknown>
  ): void {
    this.extensionRuntimeUnit.notifyExtensionWebNavigation(projectId, boxId, name, details)
  }

  extensionWebNavigationDetails(
    tab: BrowserTab,
    url: string,
    options?: { transitionType?: 'link' | 'reload'; error?: string; documentGeneration?: number }
  ): Record<string, unknown> {
    return this.extensionRuntimeUnit.extensionWebNavigationDetails(tab, url, options)
  }

  notifyExtensionActivated(tabId: string): void {
    this.extensionRuntimeUnit.notifyExtensionActivated(tabId)
  }

  private extensionTabReplay(projectId: string, boxId: string | null): BrowserExtensionTabReplay[] {
    return this.extensionRuntimeUnit.extensionTabReplay(projectId, boxId)
  }

  extensionTabInfo(tabId: string, tab: BrowserTab): BrowserExtensionTabInfo {
    return this.extensionRuntimeUnit.extensionTabInfo(tabId, tab)
  }

  extensionMenuItems(
    page: BrowserMenuPage,
    params: Electron.ContextMenuParams
  ): MenuItemConstructorOptions[] {
    return this.extensionRuntimeUnit.extensionMenuItems(page, params)
  }

  private publishExtensionProgress(progress: BrowserExtensionProgress): void {
    this.extensionRuntimeUnit.publishExtensionProgress(progress)
  }

  // ---------------------------------------------------------------------------
  // browser-service-sessions.ts
  // ---------------------------------------------------------------------------

  sessionForProject(projectId: string, boxId: string | null = null): Session {
    return this.sessionsUnit.sessionForProject(projectId, boxId)
  }

  // ---------------------------------------------------------------------------
  // browser-service-permissions.ts
  // ---------------------------------------------------------------------------

  private resolveScreenShareOwner(frame: WebFrameMain | null): BrowserScreenShareOwner | null {
    return this.permissionsUnit.resolveScreenShareOwner(frame)
  }

  async promptFromDurableMemory(id: string): Promise<void> {
    return this.permissionsUnit.promptFromDurableMemory(id)
  }

  offerExternalNavigation(
    owner: BrowserPageOwner,
    url: string,
    requestingFrameUrl?: string | null
  ): boolean {
    return this.permissionsUnit.offerExternalNavigation(owner, url, requestingFrameUrl)
  }

  permissionLedgers(): {
    grants: Map<string, Set<string>>
    denies: Map<string, Set<string>>
  } {
    return this.permissionsUnit.permissionLedgers()
  }

  private dismissProjectPermissions(projectId: string): void {
    this.permissionsUnit.dismissProjectPermissions(projectId)
  }

  clearProjectPermissionMemory(projectId: string, extraPartitions: readonly string[] = []): void {
    this.permissionsUnit.clearProjectPermissionMemory(projectId, extraPartitions)
  }

  applySitePermission(
    partition: string,
    keys: readonly string[],
    action: 'allow' | 'block' | 'reset'
  ): void {
    this.permissionsUnit.applySitePermission(partition, keys, action)
  }

  reloadOriginTabs(partition: string, origin: string): void {
    this.permissionsUnit.reloadOriginTabs(partition, origin)
  }

  resolvePermission(requestId: string, resolution: PermissionResolution): void {
    this.permissionsUnit.resolvePermission(requestId, resolution)
  }

  injectDialogContext(tabId: string, frame?: WebFrameMain): void {
    this.permissionsUnit.injectDialogContext(tabId, frame)
  }

  // ---------------------------------------------------------------------------
  // browser-service-navigation.ts
  // ---------------------------------------------------------------------------

  activeTabIdInProject(projectId: string): string | null {
    return this.navigationUnit.activeTabIdInProject(projectId)
  }

  load(tabId: string, url: string): void {
    this.navigationUnit.load(tabId, url)
  }

  navigateTo(tabId: string, url: string): Promise<void> {
    return this.navigationUnit.navigateTo(tabId, url)
  }

  isAllowedTabNavigation(projectId: string, boxId: string | null, url: string): boolean {
    return this.navigationUnit.isAllowedTabNavigation(projectId, boxId, url)
  }

  validateTabNavigationUrl(projectId: string, boxId: string | null, value: unknown): string {
    return this.navigationUnit.validateTabNavigationUrl(projectId, boxId, value)
  }

  resolveLoadOutcome(tabId: string): void {
    this.navigationUnit.resolveLoadOutcome(tabId)
  }

  setTabLoadError(tabId: string, error: BrowserLoadError | null): void {
    this.navigationUnit.setTabLoadError(tabId, error)
  }

  // ---------------------------------------------------------------------------
  // browser-service-menus.ts
  // ---------------------------------------------------------------------------

  async savePage(contents: WebContents): Promise<void> {
    return this.menusUnit.savePage(contents)
  }

  showPageMenu(tabId: string, x: number, y: number): void {
    this.menusUnit.showPageMenu(tabId, x, y)
  }

  showTabContextMenu(tabId: string, params: Electron.ContextMenuParams): void {
    this.menusUnit.showTabContextMenu(tabId, params)
  }

  showPageContextMenu(
    page: BrowserMenuPage,
    params: Electron.ContextMenuParams,
    frame: BrowserViewBounds | null,
    extraItems: MenuItemConstructorOptions[] = []
  ): void {
    this.menusUnit.showPageContextMenu(page, params, frame, extraItems)
  }

  // ---------------------------------------------------------------------------
  // browser-service-new-tabs.ts
  // ---------------------------------------------------------------------------

  openNewTabFor(
    owner: BrowserPageOwner,
    url: string,
    peek = false,
    origin: BrowserViewBounds | null = null,
    childContents?: WebContents
  ): WebContents {
    return this.newTabsUnit.openNewTabFor(owner, url, peek, origin, childContents)
  }

  openPeekFrom(
    owner: BrowserPageOwner,
    contents: WebContents,
    url: string,
    frame: BrowserViewBounds | null,
    point: BrowserPeekPoint | null,
    media: BrowserPeekMediaTarget | null = null
  ): void {
    this.newTabsUnit.openPeekFrom(owner, contents, url, frame, point, media)
  }

  // ---------------------------------------------------------------------------
  // browser-service-page-state.ts
  // ---------------------------------------------------------------------------

  stateFor(tabId: string, tab: BrowserTab): BrowserPageState {
    return this.pageStateUnit.stateFor(tabId, tab)
  }

  utilityTabContext(
    tabId: string,
    tab: BrowserTab
  ): {
    tabId: string
    projectId: string
    threadId: string
  } {
    return this.pageStateUnit.utilityTabContext(tabId, tab)
  }

  publishState(tabId: string): void {
    this.pageStateUnit.publishState(tabId)
  }

  appendConsoleEntry(
    tabId: string,
    input: {
      level: BrowserConsoleLevel
      message: string
      sourceId: string
      lineNumber: number
      frameUrl: string | null
    }
  ): void {
    this.pageStateUnit.appendConsoleEntry(tabId, input)
  }

  // ---------------------------------------------------------------------------
  // browser-service-view-lifecycle.ts
  // ---------------------------------------------------------------------------

  guardAgainstStrandedView(): void {
    this.viewLifecycleUnit.guardAgainstStrandedView()
  }

  parkedViewportFor(tab: BrowserTab): BrowserViewport {
    return this.viewLifecycleUnit.parkedViewportFor(tab)
  }

  schedulePark(tabId: string): void {
    this.viewLifecycleUnit.schedulePark(tabId)
  }

  dropPendingPark(tabId: string): void {
    this.viewLifecycleUnit.dropPendingPark(tabId)
  }

  parkTab(tabId: string, options: ParkBrowserTabOptions = {}): void {
    this.viewLifecycleUnit.parkTab(tabId, options)
  }

  showActiveView(): void {
    this.viewLifecycleUnit.showActiveView()
  }

  focusPage(tabId: string): void {
    this.viewLifecycleUnit.focusPage(tabId)
  }

  focusPageView(tabId: string, tab: BrowserTab): void {
    this.viewLifecycleUnit.focusPageView(tabId, tab)
  }

  private restorePageFocus(): void {
    this.viewLifecycleUnit.restorePageFocus()
  }

  isPageOnScreen(tabId: string): boolean {
    return this.viewLifecycleUnit.isPageOnScreen(tabId)
  }

  forgetParked(tabId: string): void {
    this.viewLifecycleUnit.forgetParked(tabId)
  }

  touchParkedTab(tabId: string): void {
    this.viewLifecycleUnit.touchParkedTab(tabId)
  }

  rememberReveal(tabId: string, threadId: string): void {
    this.viewLifecycleUnit.rememberReveal(tabId, threadId)
  }

  markRevealShown(tabId: string): void {
    this.viewLifecycleUnit.markRevealShown(tabId)
  }

  noteDepartedReveal(tabId: string): void {
    this.viewLifecycleUnit.noteDepartedReveal(tabId)
  }

  isRelaxed(threadId: string): boolean {
    return this.viewLifecycleUnit.isRelaxed(threadId)
  }

  // ---------------------------------------------------------------------------
  // browser-service-status-overlay.ts
  // ---------------------------------------------------------------------------

  setToastVisible(visible: boolean): void {
    this.statusOverlayUnit.setToastVisible(visible)
  }

  onTargetUrlReport(tabId: string, url: string): void {
    this.statusOverlayUnit.onTargetUrlReport(tabId, url)
  }

  clearStatusDelay(): void {
    this.statusOverlayUnit.clearStatusDelay()
  }

  refreshStatusOverlay(): void {
    this.statusOverlayUnit.refreshStatusOverlay()
  }

  dismissStatusOverlay(): void {
    this.statusOverlayUnit.dismissStatusOverlay()
  }

  // ---------------------------------------------------------------------------
  // browser-service-jars.ts
  // ---------------------------------------------------------------------------

  async clearBoxData(projectId: string, boxId: string): Promise<void> {
    return this.jarsUnit.clearBoxData(projectId, boxId)
  }

  async forgetBox(projectId: string, boxId: string): Promise<void> {
    return this.jarsUnit.forgetBox(projectId, boxId)
  }

  async forgetProject(projectId: string): Promise<string[]> {
    return this.jarsUnit.forgetProject(projectId)
  }

  dropProjectTabs(projectId: string): void {
    this.jarsUnit.dropProjectTabs(projectId)
  }

  private liveJars(): { projectId: string; boxId: string | null }[] {
    return this.jarsUnit.liveJars()
  }

  jarHasLivePage(projectId: string, boxId: string | null): boolean {
    return this.jarsUnit.jarHasLivePage(projectId, boxId)
  }

  private projectJars(projectId: string): (string | null)[] {
    return this.jarsUnit.projectJars(projectId)
  }

  // ---------------------------------------------------------------------------
  // browser-service-conversation-pages.ts
  // ---------------------------------------------------------------------------

  utilityTarget(input: {
    scope: string
    threadId: string
    contextKey: string
    page: BrowserUtilityPage | null
  }): { tabId: string; tab: BrowserTab; attached: boolean } | null {
    return this.conversationPagesUnit.utilityTarget(input)
  }

  threadBrowserHint(
    scope: string,
    answeredTabId: string | null
  ): {
    threadBrowser?: {
      tabId: string
      url: string
      title: string
      boxId: string | null
      detail: string
    }
  } {
    return this.conversationPagesUnit.threadBrowserHint(scope, answeredTabId)
  }

  conversationScope(projectId: string, threadId: string): string {
    return this.conversationPagesUnit.conversationScope(projectId, threadId)
  }
}
