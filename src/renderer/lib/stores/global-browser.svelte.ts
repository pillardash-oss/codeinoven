/**
 * The global (personal) browser workspace.
 *
 * This is the state behind the app's top-level Browser view: the durable tab
 * strip, its groups, which tab is on screen, and the idle clock that hibernates
 * a tab nobody is looking at. It talks to the existing main-process browser
 * service through the reserved global context (`GLOBAL_BROWSER_PROJECT_ID` /
 * `GLOBAL_BROWSER_THREAD_ID`), so every global tab shares one dedicated
 * persistent profile that is isolated from every project's browser.
 *
 * The store owns the model; the surfaces own their rendering. Hibernation is
 * enforced here because the renderer is the only side that knows which tab the
 * user is actually looking at.
 */

import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type {
  BrowserExtensionSidePanel,
  BrowserOpenRequestContext,
  BrowserPageState,
  BrowserPopupWindow
} from '$shared/ipc-contract'
import {
  isStorableBrowserFavicon,
  type GlobalBrowserTabsSnapshot
} from '$shared/browser/global-browser-tabs'
import { GLOBAL_BROWSER_PROJECT_ID, GLOBAL_BROWSER_THREAD_ID } from '$shared/ipc-contract'
import { appConfigState } from './app-config.svelte'
import { reportError } from './app-errors.svelte'
import { BrowserTabFavicons } from './browser-tab-favicon'
import {
  browserAssistant,
  BROWSER_ASSISTANT_DEFAULT_TITLE,
  type BrowserAssistantChat
} from './browser-assistant.svelte'
import { browserExtensionSidePanels } from './browser-extension-side-panels.svelte'
import { browserPopupWindows } from './browser-popup-windows.svelte'
import { contextSidebarState } from './context-sidebar.svelte'
import { sidebarState } from './sidebar.svelte'
import { defaultSettingsFor } from './thread-settings.svelte'
import { threadNotesState } from './thread-notes.svelte'
import { recentVisits } from './recent-visits.svelte'
import {
  clearLegacyGlobalBrowserTabs,
  globalBrowserTabsSnapshot,
  loadLegacyGlobalBrowserTabs,
  loadStoredGlobalBrowserTabs,
  runtimeBoxFromPersisted,
  runtimeGroupFromPersisted,
  runtimeTabFromPersisted,
  saveStoredGlobalBrowserTabs
} from './global-browser-persistence'
import {
  IDLE_GLOBAL_BROWSER_RUNTIME,
  MAX_BROWSER_BOX_NAME_LENGTH,
  MAX_BROWSER_GROUP_NAME_LENGTH,
  MAX_BROWSER_TAB_TITLE_LENGTH,
  MAX_GLOBAL_BROWSER_BOXES,
  MAX_GLOBAL_BROWSER_GROUPS,
  MAX_GLOBAL_BROWSER_TABS,
  MAX_REOPENED_BROWSER_TABS,
  browserTabLabel,
  browserTabTitleForUrl,
  isBlankBrowserAddress,
  isSameBrowserLoadError,
  DEFAULT_BOX_ID,
  boxIdForJar,
  defaultBrowserBox,
  isTabIdlePastWindow,
  type BrowserBoxAppearance,
  type BrowserGroupAppearance,
  type ClosedGlobalBrowserTab,
  type GlobalBrowserBox,
  type GlobalBrowserGroup,
  type GlobalBrowserRuntime,
  type GlobalBrowserTab
} from './global-browser-types'

/** How often the idle sweep runs. One coarse check a minute is enough to keep
 *  the promise "a tab idle for the configured window hibernates", and it costs
 *  nothing between sweeps. */
const HIBERNATION_SWEEP_INTERVAL_MS = 60_000

/** How long a change waits before it is written, so a burst of tab edits (a
 *  drag, a page reporting its title) becomes one write instead of many. Short
 *  enough that a quit moments after a change loses nothing: the quit path flushes
 *  the pending write outright. */
const TAB_SAVE_COALESCE_MS = 250

/**
 * The stored boxes with the default box guaranteed present and first.
 *
 * The default box is not optional. It is the jar the browser's own pages live in,
 * so a snapshot from before it was named, or one written by a build that had no
 * such idea, still describes a browser whose unboxed pages have a box to belong to.
 */
function withDefaultBox(boxes: GlobalBrowserBox[]): GlobalBrowserBox[] {
  if (boxes.some((box) => box.id === DEFAULT_BOX_ID)) return boxes
  return [defaultBrowserBox(), ...boxes]
}

export class GlobalBrowserState {
  tabs: GlobalBrowserTab[] = $state([])
  /**
   * Tabs closed this session, most recently closed last.
   *
   * This is the app's reopen stack (Cmd/Ctrl+Shift+T). It exists only in
   * memory: nothing writes it to the durable tab list, so quitting the app
   * clears it, exactly as a browser's own reopen history is cleared.
   */
  private closedTabs: ClosedGlobalBrowserTab[] = $state([])
  groups: GlobalBrowserGroup[] = $state([])
  /** The profile's boxes: each one jar for the whole profile, with its own cookies,
   *  site data and extension set, shared by every context that picks it. A box owns
   *  no tab; the tabs that name it do, and a box nobody uses is a row here and a
   *  profile directory on disk, nothing more. */
  boxes: GlobalBrowserBox[] = $state([])
  /** Data URLs for groups with a picked image icon, keyed by group id. Loaded
   *  lazily, because a stored icon is a file path on disk and not inline bytes. */
  groupIconUrls: SvelteMap<string, string> = $state(new SvelteMap())
  /** Data URLs for boxes with a picked image icon, keyed by box id. */
  boxIconUrls: SvelteMap<string, string> = $state(new SvelteMap())
  /** Data URLs for tabs with a picked image icon, keyed by tab id. */
  tabIconUrls: SvelteMap<string, string> = $state(new SvelteMap())
  activeTabId: string | null = $state(null)
  /** True once the browser view has been opened at least once this session. */
  opened = $state(false)
  /** Whether the right rail is shown. It is a tab-scoped context rail, so it is
   *  independent of the strip's own visibility. Closed by default: both of its
   *  panels belong to one tab's visit and never open on their own. */
  contextSidebarVisible = $state(false)
  /** Which tool of the rail is on screen. The rail hosts the active tab's note
   *  and its agent conversation, plus the browser's own downloads, history and
   *  bookmarks; exactly one is shown at a time, the way the context dock picks one
   *  tool in every other view. Downloads, history and bookmarks belong to the
   *  shared browser library rather than a tab, so those tools are the entries that
   *  can stay open with no tab. */
  contextSidebarTool = $state<
    | 'note'
    | 'agent'
    | 'downloads'
    | 'popups'
    | 'history'
    | 'bookmarks'
    | 'boxes'
    | 'extensions'
    | 'extension-side-panel'
  >('note')
  /** Whether the address spotlight is up. It lives here rather than in a surface
   *  because it is summoned from anywhere in the browser view (Cmd/Ctrl+L) and
   *  from a freshly opened tab, which has no surface of its own yet. */
  addressSpotlightOpen = $state(false)
  /** The tab currently being dragged in the strip, or null. It lives in the
   *  store because the drop targets (group headers, other rows) are siblings of
   *  the dragged row, so the drag has to be visible outside the row's own scope. */
  draggingTabId: string | null = $state(null)
  /** Whether the tab-search field is revealed. The button that opens it is one
   *  of the browser view's header actions while the field itself filters the
   *  strip, so the state lives here rather than in either surface. */
  tabSearchOpen = $state(false)
  /** What the tab search is filtering on. It sits beside the reveal flag so a
   *  closed search can never keep filtering the strip. */
  tabSearchQuery = $state('')
  /** The fold the search is scoped to, or null for the whole strip. */
  tabSearchGroupId = $state<string | null>(null)
  /** Bumped every time the search is opened, so the strip's field can take the
   *  caret without the header reaching into another surface. */
  tabSearchFocusRequest = $state(0)

  /** True once the stored tab list has been read. Nothing is written before then,
   *  so a store that has not seen the stored list can never overwrite it. */
  hydrated = $state(false)
  /** The read behind {@link whenHydrated}, so a caller that has to resolve a tab
   *  against the list can wait for it instead of racing it. */
  private hydration: Promise<void> | null = null
  private readonly runtime = new SvelteMap<string, GlobalBrowserRuntime>()
  /** Fills in the icon of a tab the app has no page for, from the tab's own
   *  address. One per strip, because it owns the "asked at most once per address"
   *  bookkeeping that keeps the lookups bounded. */
  private readonly tabFavicons = new BrowserTabFavicons()
  /** Popup windows this renderer has already reported on, so a new or reactivated
   *  one brings the rail's popup panel up. Bounded by the live list. */
  private readonly popupWindowState = new SvelteMap<
    string,
    { tabId: string; activationSequence: number }
  >()
  /** Extension side panels this renderer has already reported on, so only the
   *  arrival of a new one brings the rail's side panel tool up. Bounded by the
   *  live list: a key whose panel is gone is forgotten. */
  private readonly seenExtensionSidePanelIds = new SvelteSet<string>()
  private sweepTimer: number | null = null
  /** The coalesced write still waiting to leave, or null. */
  private saveTimer: number | null = null
  /** Whether this session changed the strip. A change that lands while the stored
   *  list is still arriving belongs to the user, so it is kept and stored rather
   *  than replaced by what was read. */
  private mutatedSinceBoot = false

  /**
   * Whether {@link start} has wired the runtime.
   *
   * The strip's shape lives here for the renderer's whole lifetime, but nothing
   * that registers a listener, starts a timer or talks to main may happen until
   * the browser is asked for. The store is built while the renderer document
   * evaluates, so the app opens on projects and chat and a launch that never
   * touches the browser must not pay for one.
   */
  private started = false

  /**
   * Wire the runtime and read the stored tab list.
   *
   * This is the whole of the browser's startup cost, which is why it is not in
   * the constructor. `startBrowserRuntime` calls it from the runtime seam once the
   * first frame has painted, or sooner when something reaches for the browser.
   * Idempotent, so every caller can ask without coordinating.
   */
  start(): void {
    if (this.started) return
    this.started = true
    // One app-lifetime subscription keeps every tab's runtime state current,
    // including tabs with no surface mounted: a background tab that starts
    // playing audio must still light up its indicator in the strip.
    subscribe('browser:state', (state) => this.applyPageState(state))
    // A page that opens a window (an OAuth redirect, a wallet popup, a site's
    // own "open in new window") is routed by main into a new tab under this same
    // reserved context, so the strip adopts it instead of losing it.
    subscribe('browser:openRequested', (url, context) => this.adoptOpenRequest(url, context))
    // A popup window is a window the user asked for by clicking something, so the
    // first one a page opens for the tab on screen reveals the rail's popup panel,
    // exactly as the operating system would have put a window in front of them,
    // and the other direction of the same rule closes the panel when the last one
    // ends.
    subscribe('browser:popupWindows', (popups) => this.applyPopupWindows(popups))
    // An extension that asks to show its own side panel is asking for a place
    // beside the page, so the first panel for the tab on screen reveals the rail's
    // side panel tool, exactly as a popup window does, and the last one leaving
    // closes it again. This listener is registered before the side panel store's
    // own, so inside this dispatch the open/close decision answers from the report
    // itself rather than from a mirror that is one report behind.
    subscribe('browser:extensionSidePanels', (panels) => this.applyExtensionSidePanels(panels))
    // The app is quitting, so the coalesced write is the last chance the stored
    // list has to carry what the user just did. The shutdown pipeline keeps the
    // renderer alive for it, which is what makes this write land.
    subscribe('window:beforeQuit', () => this.flushPendingSave())
    if (typeof window !== 'undefined') {
      this.sweepTimer = window.setInterval(
        () => this.sweepIdleTabs(),
        HIBERNATION_SWEEP_INTERVAL_MS
      )
    }
    // The read is kept rather than dropped: a caller that has to resolve a tab
    // against the list (opening an address, switching to a tab) awaits it through
    // `whenHydrated` instead of racing it.
    this.hydration = this.hydrate()
  }

  /**
   * The durable tab list, once it has arrived.
   *
   * A caller that is about to act on one tab (switch to it, or open an address
   * that may already be open) has to resolve it against this list, and the list
   * arrives asynchronously: the store is published as soon as its modules load,
   * which is well before this read lands. Waiting here is what stops a cold
   * switch from being dropped against a list that is still empty. A store whose
   * runtime never started has nothing to read, so it is ready by definition.
   */
  get whenHydrated(): Promise<void> {
    const read = this.hydration
    if (!read) return Promise.resolve()
    // A read that failed has already been reported where it happened; the callers
    // waiting on this promise still have to run, or a browser view would never
    // open because its tab list never arrived.
    return read.then(
      () => undefined,
      () => undefined
    )
  }

  /** Release the sweep timer and the pending write. The store lives for the
   *  renderer's lifetime, so this exists for tests and a deliberate teardown
   *  rather than normal use. */
  dispose(): void {
    this.started = false
    if (this.sweepTimer !== null) window.clearInterval(this.sweepTimer)
    this.sweepTimer = null
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer)
    this.saveTimer = null
  }

  /**
   * Read the stored tab list and put it on screen.
   *
   * The list is durable app state owned by the main process, so it arrives
   * asynchronously and lands before the user can reach the strip: the store is
   * built while the renderer document evaluates, and nothing is written until
   * this completes, which is what stops an unread store from overwriting the
   * stored tabs with an empty list.
   *
   * A profile that predates the durable file keeps the tabs it had: its old
   * renderer storage is read once, adopted, and then stored, before that copy is
   * cleared. A change made while the read was still in flight is the user's own,
   * so what is on screen is merged with the stored tabs instead of being replaced
   * by them.
   */
  private async hydrate(): Promise<void> {
    let stored: GlobalBrowserTabsSnapshot | null = null
    try {
      stored = await loadStoredGlobalBrowserTabs()
    } catch (error) {
      reportError(error, 'The saved browser tabs could not be read.')
    }
    // A profile that predates the durable file still carries its list in the old
    // renderer storage. It is read whenever the durable file has nothing to
    // offer, so an upgrade keeps the tabs the user had even if another instance
    // wrote an empty file first.
    const legacy = !stored || stored.tabs.length === 0 ? loadLegacyGlobalBrowserTabs() : null
    const restored = legacy ?? stored
    if (restored) {
      if (this.mutatedSinceBoot) {
        this.mergeStoredSnapshot(restored)
        this.persist()
      } else {
        this.adoptSnapshot(restored)
      }
    }
    this.hydrated = true
    // A box's icon is a file on disk, so its bytes are read once, here rather than
    // by whichever surface happens to show a box first: the rail, a tab row and
    // the boxes panel all draw the same icon, and none of them should have to wait
    // for another to be opened before it can.
    for (const box of this.boxes) {
      if (box.imagePath) void this.ensureBoxIconLoaded(box.id)
    }
    try {
      // Nothing to write when the durable file already holds the whole list.
      if (!stored || legacy) await saveStoredGlobalBrowserTabs(this.snapshot())
      if (legacy) clearLegacyGlobalBrowserTabs()
    } catch (error) {
      reportError(error, 'The browser tabs could not be saved.')
    }
  }

  private adoptSnapshot(snapshot: GlobalBrowserTabsSnapshot): void {
    this.tabs = snapshot.tabs.map(runtimeTabFromPersisted)
    this.groups = snapshot.groups.map(runtimeGroupFromPersisted)
    this.boxes = withDefaultBox((snapshot.boxes ?? []).map(runtimeBoxFromPersisted))
    // Through `setActiveTab`, not a direct assignment: the restored tab is the one
    // the browser view is about to show, and it has to count as a visit for the
    // Ctrl+Tab switcher exactly as an activation does. `markOpened` runs before
    // this read lands, so it cannot cover the cold case on its own.
    this.setActiveTab(snapshot.activeTabId)
  }

  /** Fold a stored list into the strip a change left on screen, skipping the tabs
   *  and folds it already holds so nothing is duplicated. */
  private mergeStoredSnapshot(snapshot: GlobalBrowserTabsSnapshot): void {
    // Two bounded arrays rather than sets: the strip holds at most 100 tabs, and
    // this runs once, at the only moment the two lists can coexist.
    const knownIds = this.tabs.map((tab) => tab.id)
    const knownUrls = this.tabs.map((tab) => tab.url).filter((url) => url !== '')
    for (const persisted of snapshot.tabs) {
      if (knownIds.includes(persisted.id)) continue
      const tab = runtimeTabFromPersisted(persisted)
      if (tab.url !== '' && knownUrls.includes(tab.url)) continue
      knownIds.push(tab.id)
      knownUrls.push(tab.url)
      this.tabs = [...this.tabs, tab]
    }
    for (const persisted of snapshot.groups) {
      if (this.groups.some((group) => group.id === persisted.id)) continue
      this.groups = [...this.groups, runtimeGroupFromPersisted(persisted)]
    }
    for (const persisted of snapshot.boxes ?? []) {
      if (this.boxes.some((box) => box.id === persisted.id)) continue
      this.boxes = [...this.boxes, runtimeBoxFromPersisted(persisted)]
    }
    // Outside the loop and unconditional on purpose. The default box is not one of
    // the stored boxes, so a merge that already knows every stored box would run the
    // loop zero times and never mint it, which is exactly what happened when this
    // first shipped: a profile with one box showed one box and no default.
    this.boxes = withDefaultBox(this.boxes)
  }

  /**
   * Take main's popup windows into the rail.
   *
   * A popup opened by the tab on screen is shown, because the user asked for it by
   * clicking something: the rail comes up on it and the tab it just opened reads as
   * current. A popup opened by a background tab joins the browser-wide strip without
   * moving the user's focus away from the popup already on screen.
   */
  private applyPopupWindows(popups: BrowserPopupWindow[]): void {
    const live = new SvelteSet(popups.map((popup) => popup.id))
    for (const id of [...this.popupWindowState.keys()]) {
      if (!live.has(id)) this.popupWindowState.delete(id)
    }
    for (const popup of popups) {
      const previous = this.popupWindowState.get(popup.id)
      this.popupWindowState.set(popup.id, {
        tabId: popup.tabId,
        activationSequence: popup.activationSequence
      })
      const newlyOpenedOrActivated =
        previous === undefined ||
        previous.tabId !== popup.tabId ||
        previous.activationSequence !== popup.activationSequence
      if (popup.tabId === this.activeTabId && newlyOpenedOrActivated) {
        browserPopupWindows.select(popup.id)
        this.showPopupsSidebar()
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
  private closePopupsWithNoWindows(hasOpenPopups: boolean): void {
    if (!this.contextSidebarVisible) return
    if (this.contextSidebarTool !== 'popups') return
    if (hasOpenPopups) return
    this.contextSidebarVisible = false
  }

  /** Whether the browser has a visible popup in the popup store's mirror.
   *  Only for callers outside a popup report's own dispatch: the report handler
   *  answers from the report itself, because the mirror lags one event there. */
  private hasOpenPopupWindows(): boolean {
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
  private applyExtensionSidePanels(panels: BrowserExtensionSidePanel[]): void {
    const live = panels.map((panel) => this.extensionSidePanelKey(panel))
    for (const key of [...this.seenExtensionSidePanelIds]) {
      if (!live.includes(key)) this.seenExtensionSidePanelIds.delete(key)
    }
    const tabId = this.activeTabId
    for (const panel of panels) {
      const key = this.extensionSidePanelKey(panel)
      if (this.seenExtensionSidePanelIds.has(key)) continue
      this.seenExtensionSidePanelIds.add(key)
      if (tabId !== null && panel.appTabId === tabId) this.showExtensionSidePanelSidebar()
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
  private extensionSidePanelKey(panel: BrowserExtensionSidePanel): string {
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
  private closeExtensionSidePanelWithNoPanels(activeTabHoldsPanel: boolean): void {
    if (!this.contextSidebarVisible) return
    if (this.contextSidebarTool !== 'extension-side-panel') return
    if (activeTabHoldsPanel) return
    this.contextSidebarVisible = false
  }

  /** Whether the tab on screen holds an extension side panel in the panel store's
   *  mirror. Only for callers outside a panel report's own dispatch. */
  private activeTabHoldsExtensionSidePanel(): boolean {
    const tab = this.activeTab
    if (!tab) return false
    return browserExtensionSidePanels.hasPanelForTab(tab.id)
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  get activeTab(): GlobalBrowserTab | null {
    if (!this.activeTabId) return null
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null
  }

  /** Whether the shared notifications panel is the tool on the rail. The
   *  notification bell owns that flag in the context-sidebar store, so the rail
   *  reads it instead of keeping a second copy: notification, note and agent are
   *  tools of the one right sidebar, exactly as in every other view. */
  get notificationsShown(): boolean {
    return contextSidebarState.sidebarActiveTab?.kind === 'notifications'
  }

  /** Whether the app-wide sticky notes own this view's right rail. */
  get stickyNotesShown(): boolean {
    return contextSidebarState.sidebarActiveTab?.kind === 'sticky-notes'
  }

  /**
   * Whether the right rail is on screen for one of the browser's own tools.
   *
   * The note and agent tools belong to the tab on screen, so they exist only
   * while a tab is open. Downloads belong to the shared browser profile and are
   * reachable with no tab, which is what keeps the rail present here the way it
   * is in every other view. Notifications are a separate tool and never claim
   * this flag, so the two can never both read as active.
   */
  get contextSidebarShown(): boolean {
    if (this.notificationsShown) return false
    if (!this.contextSidebarVisible) return false
    // Browser library tools and popup windows belong to the browser rather than
    // the selected tab, so they keep the rail present across tab changes.
    if (this.railToolNeedsNoTab) return true
    return this.activeTab !== null
  }

  /** Whether the active rail tool belongs to the browser rather than its selected
   *  tab. This includes the profile's library tools and the global popup list. */
  private get railToolNeedsNoTab(): boolean {
    return (
      this.contextSidebarTool === 'downloads' ||
      this.contextSidebarTool === 'history' ||
      this.contextSidebarTool === 'bookmarks' ||
      this.contextSidebarTool === 'popups' ||
      this.contextSidebarTool === 'boxes' ||
      this.contextSidebarTool === 'extensions'
    )
  }

  /** Whether the rail is currently showing the browser's popup windows. */
  get popupsSidebarShown(): boolean {
    return this.contextSidebarShown && this.contextSidebarTool === 'popups'
  }

  /** Whether the rail is currently showing the browser's downloads. */
  get downloadsSidebarShown(): boolean {
    return this.contextSidebarShown && this.contextSidebarTool === 'downloads'
  }

  /** Whether the rail is currently showing the active tab's note. */
  get noteSidebarShown(): boolean {
    return this.contextSidebarShown && this.contextSidebarTool === 'note'
  }

  /** Tabs of one group, in strip order. A null group means the ungrouped rest.
   *  Pinned tabs are excluded: they always render in the pinned block above. */
  tabsInGroup(groupId: string | null): GlobalBrowserTab[] {
    return this.tabs.filter((tab) => tab.groupId === groupId && !tab.pinned)
  }

  /** Pinned tabs in pin order, shown in their own block at the top of the strip.
   *  A pinned tab keeps its place regardless of which group it belongs to. */
  get pinnedTabs(): GlobalBrowserTab[] {
    return this.tabs
      .filter((tab) => tab.pinned)
      .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))
  }

  /** Groups in strip order with pinned folds first, so a pinned group rises the
   *  way a pinned project does. */
  get orderedGroups(): GlobalBrowserGroup[] {
    return [...this.groups].sort((a, b) => Number(b.pinned) - Number(a.pinned))
  }

  groupById(groupId: string): GlobalBrowserGroup | null {
    return this.groups.find((group) => group.id === groupId) ?? null
  }

  /** The loaded data URL for a group's picked image icon, when there is one. A
   *  group without a stored image resolves its icon from colour/SVG instead. */
  groupIconUrl(groupId: string): string | null {
    return this.groupIconUrls.get(groupId) ?? null
  }

  /** One box by id, or null once it has been deleted. */
  boxById(boxId: string): GlobalBrowserBox | null {
    return this.boxes.find((box) => box.id === boxId) ?? null
  }

  /**
   * The box the page on screen lives in, named as a box rather than as a jar.
   *
   * A tab with no box is in the default box, so panels that have to say where the
   * user currently is answer with a box in every case.
   */
  get activeTabBoxId(): string {
    return boxIdForJar(this.activeTab?.boxId ?? null)
  }

  /** The loaded data URL for a box's picked image icon, when there is one. */
  boxIconUrl(boxId: string): string | null {
    return this.boxIconUrls.get(boxId) ?? null
  }

  /** Live runtime of one tab, or the shared idle value while main has reported
   *  nothing for it. */
  runtimeFor(tabId: string): GlobalBrowserRuntime {
    return this.runtime.get(tabId) ?? IDLE_GLOBAL_BROWSER_RUNTIME
  }

  /** Whether a browser tab with this address is already open. A blank address
   *  never matches, so "new tab" always makes a new one. When a box is named the
   *  match is scoped to it: the same address in two jars is two different sessions
   *  and must stay two tabs. */
  findTabByUrl(url: string, boxId?: string | null): GlobalBrowserTab | null {
    if (isBlankBrowserAddress(url)) return null
    return (
      this.tabs.find((tab) => tab.url === url && (boxId === undefined || tab.boxId === boxId)) ??
      null
    )
  }

  /** One tab by id, or null once it has been closed. */
  tabById(tabId: string): GlobalBrowserTab | null {
    return this.tabs.find((tab) => tab.id === tabId) ?? null
  }

  // ─── The active tab ───────────────────────────────────────────────────────

  /**
   * Put a tab on screen and count the moment as use, which is what resets its
   * hibernation clock and revives a released page.
   */
  activate(tabId: string): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    this.setActiveTab(tabId)
    tab.lastUsedAt = Date.now()
    if (tab.hibernated) tab.hibernated = false
    this.persist()
  }

  /**
   * Land on a tab the user picked, and hand its surface the keyboard.
   *
   * A tab's page is a native `WebContentsView` above the DOM, so landing on a tab
   * left DOM focus in the app chrome and the page took no keystroke until the
   * user clicked it. The switch is the moment the user chose the tab, so the page
   * takes the keyboard. A blank tab has no page to type into: its address
   * spotlight   the field where the search or the address is typed   is what a
   * new tab is, so that opens focused instead.
   *
   * Only a user switch goes through here. An agent reveal activates a tab through
   * `activate` alone, because pulling the keyboard out of a field the user is
   * typing in is not a reveal's job.
   */
  switchTo(tabId: string): void {
    this.activate(tabId)
    const tab = this.activeTab
    if (!tab || tab.id !== tabId) return
    if (isBlankBrowserAddress(tab.url)) {
      this.openAddressSpotlight()
      return
    }
    // Silent on failure: the tab can be destroyed between the switch and the
    // call, and a keyboard handover that did not land must not surface an error.
    void invoke('browser:focusPage', tab.id).catch(() => {})
  }

  /**
   * Mark the workspace as opened, so the first activation can reveal a tab.
   *
   * Opening the browser view is using the tab it shows, so that tab is counted as
   * a visit here rather than only when it is activated. Without this the tab the
   * user is looking at carries a stale (or absent) visit key, and the Ctrl+Tab
   * switcher either leaves it out or cycles from somewhere else: a blank tab
   * looked right only because creating it went through `setActiveTab`.
   */
  markOpened(): void {
    this.opened = true
    this.dockActiveTabNote()
    if (this.activeTabId) recentVisits.recordBrowserTab(this.activeTabId)
  }

  /** The notes chord and the notes dock item both land here: it reveals the
   *  note tool, or hides the rail when the note tool is already the one shown. */
  toggleContextSidebar(): void {
    // The rail belongs to a tab: with nothing open there is no note to show, so
    // the chord does nothing rather than opening an empty panel.
    if (!this.activeTab) return
    if (this.contextSidebarTool === 'note' && this.contextSidebarVisible) {
      this.contextSidebarVisible = false
      return
    }
    this.showNoteSidebar()
  }

  /** Reveal the rail on the active tab's note. */
  showNoteSidebar(): void {
    if (!this.activeTab) return
    this.dismissNotifications()
    this.contextSidebarTool = 'note'
    this.contextSidebarVisible = true
    this.dockActiveTabNote()
  }

  /** Hide browser-owned rail tools before the app-wide sticky note panel opens. */
  hideContextSidebarForAppPanel(): void {
    this.contextSidebarVisible = false
  }

  /** Reveal the rail on the browser's downloads. Downloads are the one browser
   *  tool that needs no tab, so this is also how the rail stays present with the
   *  strip empty. */
  showDownloadsSidebar(): void {
    this.dismissNotifications()
    this.contextSidebarTool = 'downloads'
    this.contextSidebarVisible = true
  }

  toggleDownloadsSidebar(): void {
    if (this.contextSidebarTool === 'downloads' && this.contextSidebarVisible) {
      this.closeDownloadsSidebar()
      return
    }
    this.showDownloadsSidebar()
  }

  closeDownloadsSidebar(): void {
    if (this.contextSidebarTool === 'downloads') this.contextSidebarVisible = false
  }

  /**
   * Reveal the rail on the browsing history.
   *
   * History belongs to the browser rather than to a tab, like downloads do, so this
   * is one of the tools that keeps the rail present with no tab on screen.
   */
  showHistorySidebar(): void {
    this.dismissNotifications()
    this.contextSidebarTool = 'history'
    this.contextSidebarVisible = true
  }

  toggleHistorySidebar(): void {
    if (this.contextSidebarTool === 'history' && this.contextSidebarVisible) {
      this.closeHistorySidebar()
      return
    }
    this.showHistorySidebar()
  }

  closeHistorySidebar(): void {
    if (this.contextSidebarTool === 'history') this.contextSidebarVisible = false
  }

  /** Whether the rail is currently showing the browsing history. */
  get historySidebarShown(): boolean {
    return this.contextSidebarShown && this.contextSidebarTool === 'history'
  }

  /** Reveal the rail on the saved pages. */
  showBookmarksSidebar(): void {
    this.dismissNotifications()
    this.contextSidebarTool = 'bookmarks'
    this.contextSidebarVisible = true
  }

  toggleBookmarksSidebar(): void {
    if (this.contextSidebarTool === 'bookmarks' && this.contextSidebarVisible) {
      this.closeBookmarksSidebar()
      return
    }
    this.showBookmarksSidebar()
  }

  closeBookmarksSidebar(): void {
    if (this.contextSidebarTool === 'bookmarks') this.contextSidebarVisible = false
  }

  /** Whether the rail is currently showing the saved pages. */
  get bookmarksSidebarShown(): boolean {
    return this.contextSidebarShown && this.contextSidebarTool === 'bookmarks'
  }

  /**
   * Reveal the rail on the profile's boxes.
   *
   * Boxes belong to the browser rather than to a tab, like downloads do, so the
   * panel is reachable with the strip empty. That is also what makes it the tool
   * a user opens first, before any tab exists in a box.
   */
  showBoxesSidebar(): void {
    this.dismissNotifications()
    this.contextSidebarTool = 'boxes'
    this.contextSidebarVisible = true
  }

  toggleBoxesSidebar(): void {
    if (this.contextSidebarTool === 'boxes' && this.contextSidebarVisible) {
      this.closeBoxesSidebar()
      return
    }
    this.showBoxesSidebar()
  }

  closeBoxesSidebar(): void {
    if (this.contextSidebarTool === 'boxes') this.contextSidebarVisible = false
  }

  /** Whether the rail is currently showing the profile's boxes. */
  get boxesSidebarShown(): boolean {
    return this.contextSidebarShown && this.contextSidebarTool === 'boxes'
  }

  /**
   * Reveal the rail on the profile's installed extensions.
   *
   * An extension belongs to the profile rather than to a page, like a box, so the
   * panel is reachable with the strip empty. That is the order the work happens
   * in: an extension is installed and its compatibility report read before any
   * box exists to contain it.
   */
  showExtensionsSidebar(): void {
    this.dismissNotifications()
    this.contextSidebarTool = 'extensions'
    this.contextSidebarVisible = true
  }

  toggleExtensionsSidebar(): void {
    if (this.contextSidebarTool === 'extensions' && this.contextSidebarVisible) {
      this.closeExtensionsSidebar()
      return
    }
    this.showExtensionsSidebar()
  }

  closeExtensionsSidebar(): void {
    if (this.contextSidebarTool === 'extensions') this.contextSidebarVisible = false
  }

  /** Whether the rail is currently showing the profile's installed extensions. */
  get extensionsSidebarShown(): boolean {
    return this.contextSidebarShown && this.contextSidebarTool === 'extensions'
  }

  /**
   * Reveal the rail on the browser's popup windows.
   *
   * A popup window is a window the user asked for by clicking something in the
   * page, so it is shown rather than parked in silence. Its page stays in the
   * session of the tab and box that opened it while the rail remains browser-wide.
   */
  showPopupsSidebar(): void {
    this.dismissNotifications()
    this.contextSidebarTool = 'popups'
    this.contextSidebarVisible = true
  }

  togglePopupsSidebar(): void {
    if (this.contextSidebarTool === 'popups' && this.contextSidebarVisible) {
      this.closePopupsSidebar()
      return
    }
    this.showPopupsSidebar()
  }

  closePopupsSidebar(): void {
    if (this.contextSidebarTool === 'popups') this.contextSidebarVisible = false
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
    if (!this.activeTab) return
    this.dismissNotifications()
    this.contextSidebarTool = 'extension-side-panel'
    this.contextSidebarVisible = true
  }

  /** Hide the side panel tool without ending the panel: main keeps the document
   *  running, so it is still there when the tool is shown again. */
  closeExtensionSidePanelSidebar(): void {
    if (this.contextSidebarTool === 'extension-side-panel') this.contextSidebarVisible = false
  }

  /** Whether the rail is currently showing an extension's own side panel. */
  get extensionSidePanelSidebarShown(): boolean {
    return this.contextSidebarShown && this.contextSidebarTool === 'extension-side-panel'
  }

  /**
   * Drop the notifications tool when another rail tool takes over. The
   * notifications flag lives in the context-sidebar store (the header bell owns
   * it), so the rail can only ask it to close, and only while it is the tool on
   * screen.
   */
  private dismissNotifications(): void {
    if (contextSidebarState.sidebarActiveTab?.kind === 'sticky-notes') {
      contextSidebarState.hide()
      return
    }
    if (this.notificationsShown) contextSidebarState.toggleNotifications()
  }

  /** Reveal the rail on the active tab's agent conversation, creating it on the
   *  first open. A tab's conversation is a real chat thread of the reserved
   *  browser project, so it is created once and then kept until the user closes
   *  it (or closes the tab it belongs to). */
  showAgentSidebar(): void {
    const tab = this.activeTab
    if (!tab) return
    this.dismissNotifications()
    this.contextSidebarTool = 'agent'
    this.contextSidebarVisible = true
    void this.ensureAssistantChat(tab)
  }

  toggleAgentSidebar(): void {
    if (this.contextSidebarTool === 'agent' && this.contextSidebarVisible) {
      this.closeAgentSidebar()
      return
    }
    this.showAgentSidebar()
  }

  closeAgentSidebar(): void {
    if (this.contextSidebarTool === 'agent') this.contextSidebarVisible = false
  }

  /** Whether the rail is currently showing the active tab's agent chat. */
  get agentSidebarShown(): boolean {
    return this.contextSidebarShown && this.contextSidebarTool === 'agent'
  }

  /**
   * Put the tab that owns one assistant conversation on screen with that chat
   * open, and report whether it landed.
   *
   * A conversation parked on a question is only ever reached through here: it is
   * held out of every thread list on purpose, so the notification that says it
   * needs an answer is the one thing that has to be able to bring it back. The
   * conversation is resolved first (creating it if the tab's link was never
   * followed), because the rail only knows about conversations it has seen, and
   * the page binding is what lets the agent read the tab it is answering about.
   *
   * `activate` rather than `switchTo`: this is not a user tab switch, so the
   * native page must not take the keyboard out of whatever the user was typing in.
   */
  async revealAssistantChat(threadId: string): Promise<boolean> {
    const chat = browserAssistant.chatForThread(threadId)
    if (!chat) return false
    const tab = this.tabById(chat.browserTabId)
    if (!tab) return false
    await this.ensureAssistantChat(tab)
    this.activate(tab.id)
    this.showAgentSidebar()
    return this.activeTabId === tab.id
  }

  /** The agent conversation bound to a browser tab, or null before its first
   *  open (or while the row behind its durable link is still being resolved). */
  agentChatFor(tabId: string): BrowserAssistantChat | null {
    return browserAssistant.chatForTab(tabId)
  }

  /**
   * Resolve (creating on the very first open) the assistant conversation bound to
   * one browser tab, and hand main the page it answers about.
   *
   * The conversation and the tab point at each other: the thread id is written
   * into the tab's durable row, so a restart restores the link, and main is told
   * which browser tab the thread is looking at, which is what lets the agent's
   * browser capability read the page the user is on rather than a page of its own.
   */
  private async ensureAssistantChat(tab: GlobalBrowserTab): Promise<void> {
    try {
      const chat = await browserAssistant.ensureChat({
        browserTabId: tab.id,
        existingThreadId: tab.assistantThreadId,
        title: browserAssistantChatTitle(tab),
        settings: defaultSettingsFor('chat')
      })
      if (tab.assistantThreadId !== chat.threadId) {
        tab.assistantThreadId = chat.threadId
        this.persist()
      }
      void invoke('browser:bindAssistantPage', chat.threadId, tab.id).catch(() => {})
    } catch (error) {
      reportError(error, 'The assistant conversation could not be started.')
    }
  }

  /**
   * The active tab moved. Owning this in one place is what keeps the rail's
   * note docked: the right rail always shows the note of whichever tab is on
   * screen, so that tab's note has to be created the moment it becomes active,
   * and only while the rail is actually shown. `ContextSidebar.ensureNoteTab`
   * is idempotent, so re-activating a tab costs nothing.
   */
  private setActiveTab(tabId: string | null): void {
    // Every activation, from any surface (strip, sidebar, switcher, a popup that
    // reveals itself), counts as a visit so the Ctrl+Tab switcher lists this tab
    // by the moment it was last used, exactly as it does a thread.
    if (tabId) recentVisits.recordBrowserTab(tabId)
    this.activeTabId = tabId
    this.dockActiveTabNote()
    // The rail follows the active tab: while the agent tool is shown, the new
    // tab's own conversation must be the one on screen. A tab the user has never
    // asked the agent about shows its start state instead of being given a
    // conversation nobody asked for; the rail's own action creates it.
    if (this.contextSidebarTool === 'popups') {
      // Popup windows belong to the browser, so changing tabs leaves the rail
      // open while any popup remains in its shared list.
      this.closePopupsWithNoWindows(this.hasOpenPopupWindows())
    }
    if (this.contextSidebarTool === 'extension-side-panel') {
      // The same rule as popups: the panel belongs to one tab's visit, so moving
      // to a tab that holds none closes the rail rather than leaving an empty
      // frame over the new page.
      this.closeExtensionSidePanelWithNoPanels(this.activeTabHoldsExtensionSidePanel())
    }
  }

  private dockActiveTabNote(): void {
    if (!this.contextSidebarVisible) return
    const tab = this.activeTab
    if (!tab) return
    contextSidebarState.ensureNoteTab(GLOBAL_BROWSER_PROJECT_ID, tab.id, browserTabLabel(tab))
  }

  beginDrag(tabId: string): void {
    this.draggingTabId = tabId
  }

  endDrag(): void {
    this.draggingTabId = null
  }

  openAddressSpotlight(): void {
    this.addressSpotlightOpen = true
  }

  closeAddressSpotlight(): void {
    this.addressSpotlightOpen = false
  }

  /** Open a blank tab and put the caret in the address field, which is what a
   *  new tab is for. A box is named here, so the empty strip's new-tab menu can
   *  start a tab directly inside one. */
  openNewTabAddress(groupId: string | null = null, boxId: string | null = null): void {
    this.createTab('', groupId, boxId)
    this.addressSpotlightOpen = true
  }

  /** Reveal the tab search, optionally scoped to one group.
   *
   *  The field filters the strip, so opening the search also reveals the sidebar:
   *  a hidden strip has nothing for the search to filter and no field to type in. */
  openTabSearch(groupId: string | null = null): void {
    this.tabSearchGroupId = groupId
    this.tabSearchQuery = ''
    this.tabSearchOpen = true
    this.tabSearchFocusRequest += 1
    // The field lives in the left sidebar, so revealing the search also docks
    // that sidebar: a folded strip has no field for the search to sit in.
    sidebarState.redock()
  }

  closeTabSearch(): void {
    this.tabSearchOpen = false
    this.tabSearchQuery = ''
    this.tabSearchGroupId = null
  }

  setTabSearchQuery(query: string): void {
    this.tabSearchQuery = query
  }

  /** Drop the query and the group scope while leaving the field open, which is
   *  what the field's own clear control does. */
  clearTabSearch(): void {
    this.tabSearchQuery = ''
    this.tabSearchGroupId = null
  }

  toggleTabSearch(): void {
    if (this.tabSearchOpen) this.closeTabSearch()
    else this.openTabSearch()
  }

  /**
   * Adopt a tab the main process created on a page's behalf.
   *
   * Main parks and loads the popup before this arrives, so the renderer only has
   * to give it a row. A request outside the global context belongs to a project
   * browser and is left alone.
   */
  adoptOpenRequest(url: string, context?: BrowserOpenRequestContext): void {
    if (!context || context.projectId !== GLOBAL_BROWSER_PROJECT_ID) return
    const tabId = context.requestedTabId
    if (!tabId) return
    const existing = this.tabs.find((tab) => tab.id === tabId)
    if (existing) {
      if (url && existing.url !== url) existing.url = url
      if (context.reveal) this.activate(existing.id)
      this.persist()
      return
    }
    this.enforceTabCap()
    const now = Date.now()
    this.tabs = [
      ...this.tabs,
      {
        id: tabId,
        title: browserTabTitleForUrl(url),
        customTitle: null,
        url,
        favicon: null,
        // A popup belongs beside the page that opened it.
        groupId: this.activeTab?.groupId ?? null,
        // Main creates the tab in the opener's jar and hands back the box it
        // used, so the row and the session agree from the first show. Main is the
        // only side that knows the true owner when a background tab opens the
        // popup, so its answer is trusted over the active tab's box.
        boxId: context.boxId ?? null,
        createdAt: now,
        lastUsedAt: now,
        hibernated: false,
        pinned: false,
        pinnedAt: null,
        assistantThreadId: null,
        color: null,
        iconType: null,
        customSvg: null,
        imagePath: null
      }
    ]
    if (context.reveal) this.activate(tabId)
    this.persist()
  }

  // ─── Tabs ─────────────────────────────────────────────────────────────────

  /** Open an address: focus the tab already showing it, otherwise create one.
   *  A named box scopes the match, so the same address in another jar opens its
   *  own tab rather than stealing the one already logged in elsewhere; with no
   *  box named, an open copy of the address is focused wherever it lives. */
  open(url: string, groupId: string | null = null, boxId: string | null = null): string {
    const existing = this.findTabByUrl(url, boxId ?? undefined)
    if (existing) {
      this.activate(existing.id)
      return existing.id
    }
    return this.createTab(url, groupId, boxId)
  }

  /**
   * Open an address in the tab on screen, or start the browser with a first tab when
   * there is none.
   *
   * This is what the address spotlight, a history row and a bookmark all do: unlike
   * {@link open}, which is how a link arriving from a thread finds the tab already
   * showing it, these are the user saying "take me there now", so the page on screen
   * is the one that moves.
   */
  openInActiveTab(url: string): void {
    const tab = this.activeTab
    if (!tab) {
      this.createTab(url)
      return
    }
    // Silent on failure: the tab can be destroyed between the click and the call.
    // The tab's own box rides along, so an existing tab is ensured in the jar it
    // already lives in rather than the default one.
    void invoke(
      'browser:navigate',
      tab.id,
      GLOBAL_BROWSER_CONTEXT.projectId,
      GLOBAL_BROWSER_CONTEXT.threadId,
      url,
      tab.boxId
    ).catch(() => {})
  }

  /**
   * Create a tab for an address (blank allowed) and make it active.
   *
   * `boxId` names the jar the tab runs in, or null for the default one. `anchor`
   * places the new row before or after an existing tab and, when no group or box
   * is named, inherits both from that tab, which keeps "new tab here" a one-click
   * gesture that lands beside the page it came from.
   */
  createTab(
    url: string,
    groupId: string | null = null,
    boxId: string | null = null,
    anchor: { tabId: string; position: 'before' | 'after' } | null = null
  ): string {
    this.enforceTabCap()
    const anchorTab = anchor ? this.tabById(anchor.tabId) : null
    const targetGroupId = groupId ?? anchorTab?.groupId ?? null
    const targetBoxId = boxId ?? anchorTab?.boxId ?? null
    const now = Date.now()
    const tab: GlobalBrowserTab = {
      id: `browser:${crypto.randomUUID()}`,
      title: browserTabTitleForUrl(url),
      customTitle: null,
      url,
      favicon: null,
      groupId: this.groups.some((group) => group.id === targetGroupId) ? targetGroupId : null,
      boxId: this.boxes.some((box) => box.id === targetBoxId) ? targetBoxId : null,
      createdAt: now,
      lastUsedAt: now,
      hibernated: false,
      pinned: false,
      pinnedAt: null,
      assistantThreadId: null,
      color: null,
      iconType: null,
      customSvg: null,
      imagePath: null
    }
    if (anchorTab) {
      const index = this.tabs.findIndex((candidate) => candidate.id === anchorTab.id)
      const at = anchor?.position === 'before' ? index : index + 1
      const ordered = [...this.tabs]
      ordered.splice(at, 0, tab)
      this.tabs = ordered
    } else {
      this.tabs = [...this.tabs, tab]
    }
    this.setActiveTab(tab.id)
    this.persist()
    return tab.id
  }

  /** Duplicate a tab beside its source, carrying its address and appearance. */
  duplicateTab(tabId: string): string | null {
    const source = this.tabById(tabId)
    if (!source) return null
    const duplicateId = this.createTab(source.url, source.groupId, source.boxId, {
      tabId,
      position: 'after'
    })
    this.updateTab(duplicateId, {
      customTitle: source.customTitle,
      color: source.color,
      iconType: source.iconType,
      customSvg: source.customSvg,
      imagePath: source.imagePath
    })
    return duplicateId
  }

  /**
   * Reopen a tab in another box.
   *
   * Cookies do not migrate between jars, so a tab cannot change boxes in place:
   * this closes the tab and opens its address in the target box, which is the only
   * honest move and why the menu item says "Reopen" rather than "Move". The target
   * is the profile's one jar for that box, so the page comes back with whatever
   * that box already holds, a sign-in another context made included. Returns the
   * new tab id, or null when the source tab is gone or already in the box.
   */
  reopenInBox(tabId: string, boxId: string | null): string | null {
    const tab = this.tabById(tabId)
    if (!tab || tab.boxId === boxId) return null
    const url = tab.url
    const groupId = tab.groupId
    // Not a reopenable close: the page is deliberately coming back in another
    // box, so recording it would offer the user a tab that never left.
    this.close(tabId, { recordForReopen: false })
    return this.createTab(url, groupId, boxId)
  }

  /**
   * Close a tab and land on its neighbour in the strip.
   *
   * A close the user asked for is remembered so `reopenLastClosedTab` can undo
   * it, which is what `recordForReopen` opts a caller out of. A close that is
   * really a replacement (a reopen in another box) or an eviction has no tab to
   * bring back, so recording it would only push a phantom onto the reopen stack.
   */
  close(tabId: string, options: { recordForReopen?: boolean } = {}): void {
    const index = this.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    const closing = this.tabs[index]
    if (options.recordForReopen !== false) this.rememberClosedTab(closing, index)
    // The tab can never be switched to again, so its Ctrl+Tab visit goes with it
    // instead of holding a slot in the recency list.
    recentVisits.forgetBrowserTab(tabId)
    const closedThreadId = closing.assistantThreadId
    const remaining = this.tabs.filter((tab) => tab.id !== tabId)
    this.tabs = remaining
    this.runtime.delete(tabId)
    this.tabFavicons.forget(tabId)
    if (this.activeTabId === tabId) {
      const neighbour = remaining[Math.min(index, remaining.length - 1)]
      this.setActiveTab(neighbour?.id ?? null)
      if (neighbour) neighbour.lastUsedAt = Date.now()
    }
    if (this.tabs.length === 0 && !this.railToolNeedsNoTab) {
      // With no tab left the note and agent tools have no subject, so the rail
      // returns to its closed default instead of lingering for the next tab.
      // The library tools need no tab, so they stay open.
      this.contextSidebarVisible = false
    }
    this.persist()
    // The tab's row is gone from the strip, so main destroys the view but keeps
    // its Back/Forward stack in the session's reopen set, which is what lets a
    // reopen put the page back on the entry it was left on.
    void invoke('browser:destroy', tabId, 'closed').catch(() => {})
    // A tab's note is keyed by the tab id, so closing the tab is what removes
    // it   exactly the way deleting a thread removes its note.
    if (threadNotesState.has(tabId)) {
      void invoke('note:delete', GLOBAL_BROWSER_PROJECT_ID, tabId).catch(() => {})
    }
    // The tab's agent conversation is the same kind of subject-scoped state:
    // closing the tab closes the conversation it owns, because the conversation
    // exists for that page and is unreachable without it.
    this.closeAssistantChatFor(tabId, closedThreadId)
  }

  /**
   * Remember a tab just closed so it can be reopened.
   *
   * The tab is cloned, so later edits to the strip cannot reach back into the
   * stack, and the oldest entry falls off the end once the cap is reached. This
   * stack is memory-only by design: nothing here is written to the durable tab
   * list, so quitting the app forgets it exactly as a browser does.
   */
  private rememberClosedTab(tab: GlobalBrowserTab, index: number): void {
    const entry: ClosedGlobalBrowserTab = { tab: { ...tab }, index }
    const next = [...this.closedTabs, entry]
    this.closedTabs = next.slice(Math.max(0, next.length - MAX_REOPENED_BROWSER_TABS))
  }

  /** Whether anything is left to reopen this session. */
  get canReopenClosedTab(): boolean {
    return this.closedTabs.length > 0
  }

  /**
   * Reopen the most recently closed tab, in the strip position it held.
   *
   * This is the app's own "Reopen closed tab": like a browser's, it restores the
   * tab and its Back/Forward history, and it is gone once the app is quit. The
   * tab keeps its id so main can hand its stored stack back to the page, its
   * conversation is not restored (that thread was deleted with the tab), and a
   * group or box that has since been removed is cleared rather than left as a
   * dangling reference. Returns the reopened tab id, or null when there is
   * nothing to reopen.
   */
  reopenLastClosedTab(): string | null {
    const entry = this.closedTabs[this.closedTabs.length - 1]
    if (!entry) return null
    this.closedTabs = this.closedTabs.slice(0, -1)
    const restored: GlobalBrowserTab = {
      ...entry.tab,
      groupId:
        entry.tab.groupId !== null && this.groups.some((group) => group.id === entry.tab.groupId)
          ? entry.tab.groupId
          : null,
      boxId:
        entry.tab.boxId !== null && this.boxes.some((box) => box.id === entry.tab.boxId)
          ? entry.tab.boxId
          : null,
      // The tab's conversation was deleted with it, so a reopened tab starts
      // with none and asks the agent again if it wants one.
      assistantThreadId: null,
      // It is being put back on screen, so any hibernation the close found it in
      // no longer applies: the page is created fresh as the surface shows it.
      hibernated: false,
      lastUsedAt: Date.now()
    }
    const ordered = [...this.tabs]
    ordered.splice(Math.min(entry.index, ordered.length), 0, restored)
    this.tabs = ordered
    this.setActiveTab(restored.id)
    this.persist()
    return restored.id
  }

  /**
   * Tear down one browser tab's agent conversation: the thread that holds its
   * transcript is deleted with the tab that owned it.
   *
   * The link is read from the store first and from the tab's own durable field
   * second, so a conversation this session never opened (a tab restored from a
   * previous launch) is still cleaned up instead of being left behind as a
   * thread nothing can reach.
   */
  private closeAssistantChatFor(tabId: string, linkedThreadId: string | null): void {
    const threadId = browserAssistant.releaseTab(tabId) ?? linkedThreadId
    if (!threadId) return
    void invoke('thread:delete', GLOBAL_BROWSER_PROJECT_ID, threadId).catch(() => {})
    void invoke('browser:unbindAssistantPage', threadId).catch(() => {})
  }

  moveToGroup(tabId: string, groupId: string | null): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    const target = this.groups.some((group) => group.id === groupId) ? groupId : null
    if (tab.groupId === target) return
    tab.groupId = target
    this.persist()
  }

  /** Move several tabs into one group and persist the change once. */
  moveTabsToGroup(tabIds: readonly string[], groupId: string | null): void {
    const target = this.groups.some((group) => group.id === groupId) ? groupId : null
    const selectedIds = new SvelteSet(tabIds)
    let changed = false
    for (const tab of this.tabs) {
      if (!selectedIds.has(tab.id) || tab.groupId === target) continue
      tab.groupId = target
      changed = true
    }
    if (changed) this.persist()
  }

  /** Move a tab beside another, within the strip. */
  reorder(tabId: string, targetId: string, position: 'before' | 'after'): void {
    const from = this.tabs.findIndex((tab) => tab.id === tabId)
    if (from < 0 || tabId === targetId) return
    const ordered = [...this.tabs]
    const [moved] = ordered.splice(from, 1)
    const target = ordered.findIndex((tab) => tab.id === targetId)
    if (target < 0) return
    // A drop beside a grouped tab adopts that tab's group, which is what makes
    // dragging a tab into a fold work without a separate drop target.
    moved.groupId = ordered[target].groupId
    ordered.splice(position === 'before' ? target : target + 1, 0, moved)
    this.tabs = ordered
    this.persist()
  }

  // ─── Tab identity and pinning ─────────────────────────────────────────────

  /**
   * Edit a tab's own identity: a custom label and the appearance it shares with
   * a project (colour, icon, pasted SVG, picked image). A blank title clears the
   * override, so the strip returns to the page's live title.
   */
  updateTab(id: string, patch: Partial<Omit<GlobalBrowserTab, 'id'>>): void {
    const tab = this.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    let imageChanged = false
    if (patch.customTitle !== undefined) {
      const title = patch.customTitle?.trim().slice(0, MAX_BROWSER_TAB_TITLE_LENGTH) ?? ''
      tab.customTitle = title === '' ? null : title
    }
    if (patch.color !== undefined) tab.color = patch.color
    if (patch.iconType !== undefined) tab.iconType = patch.iconType
    if (patch.customSvg !== undefined) tab.customSvg = patch.customSvg
    if (patch.imagePath !== undefined) {
      tab.imagePath = patch.imagePath
      imageChanged = true
    }
    this.persist()
    // The rail's note is titled with the tab's label, so a rename follows.
    this.dockActiveTabNote()
    if (imageChanged) {
      this.tabIconUrls.delete(id)
      void this.ensureTabIconLoaded(id)
    }
  }

  /** Pin a tab to the top of the strip, or unpin it. Pin order is preserved so
   *  the pinned block does not reshuffle on every toggle. */
  toggleTabPin(tabId: string): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    tab.pinned = !tab.pinned
    tab.pinnedAt = tab.pinned ? Date.now() : null
    this.persist()
  }

  /** The loaded data URL for a tab's picked image icon, when there is one. */
  tabIconUrl(tabId: string): string | null {
    return this.tabIconUrls.get(tabId) ?? null
  }

  /** Read a tab's picked image icon into a data URL, once. Best-effort: a
   *  missing file leaves the tab on its favicon or colour/SVG icon. */
  async ensureTabIconLoaded(tabId: string): Promise<void> {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab?.imagePath) {
      this.tabIconUrls.delete(tabId)
      return
    }
    if (this.tabIconUrls.has(tabId)) return
    try {
      const url = await invoke('file:readAsDataUrl', tab.imagePath)
      if (url) this.tabIconUrls.set(tabId, url)
    } catch {
      // Icon loading is best-effort; the resolver's fallback remains.
    }
  }

  // ─── Groups ───────────────────────────────────────────────────────────────

  createGroup(
    name: string,
    appearance: Partial<BrowserGroupAppearance> = {},
    description = ''
  ): string {
    const id = `group:${crypto.randomUUID()}`
    if (this.groups.length >= MAX_GLOBAL_BROWSER_GROUPS) return id
    this.groups = [
      ...this.groups,
      {
        id,
        name: name.trim().slice(0, MAX_BROWSER_GROUP_NAME_LENGTH) || 'New group',
        description: description.trim(),
        pinned: false,
        color: appearance.color ?? null,
        iconType: appearance.iconType ?? null,
        customSvg: appearance.customSvg ?? null,
        imagePath: appearance.imagePath ?? null
      }
    ]
    this.persist()
    return id
  }

  /** Read a group's picked image icon into a data URL, once. Best-effort: a
   *  missing or unreadable file leaves the group on its colour/SVG icon. */
  async ensureGroupIconLoaded(groupId: string): Promise<void> {
    const group = this.groupById(groupId)
    if (!group?.imagePath) {
      this.groupIconUrls.delete(groupId)
      return
    }
    if (this.groupIconUrls.has(groupId)) return
    try {
      const url = await invoke('file:readAsDataUrl', group.imagePath)
      if (url) this.groupIconUrls.set(groupId, url)
    } catch {
      // Icon loading is best-effort; the resolver's fallback remains.
    }
  }

  updateGroup(id: string, patch: Partial<Omit<GlobalBrowserGroup, 'id'>>): void {
    const group = this.groups.find((candidate) => candidate.id === id)
    if (!group) return
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, MAX_BROWSER_GROUP_NAME_LENGTH)
      if (name) group.name = name
    }
    if (patch.color !== undefined) group.color = patch.color
    if (patch.iconType !== undefined) group.iconType = patch.iconType
    if (patch.customSvg !== undefined) group.customSvg = patch.customSvg
    if (patch.imagePath !== undefined) group.imagePath = patch.imagePath
    if (patch.description !== undefined) group.description = patch.description.trim()
    if (patch.pinned !== undefined) group.pinned = patch.pinned
    this.persist()
    // A new or cleared image must not keep showing the previous one's bytes.
    if (patch.imagePath !== undefined) {
      this.groupIconUrls.delete(id)
      void this.ensureGroupIconLoaded(id)
    }
  }

  /** Remove a group. Its tabs stay open and become ungrouped, because losing a
   *  fold must never silently close the pages inside it. */
  deleteGroup(id: string): void {
    if (!this.groups.some((group) => group.id === id)) return
    this.groups = this.groups.filter((group) => group.id !== id)
    this.groupIconUrls.delete(id)
    for (const tab of this.tabs) {
      if (tab.groupId === id) tab.groupId = null
    }
    this.persist()
  }

  /** Pin a fold to the top of the strip, or unpin it. */
  toggleGroupPin(groupId: string): void {
    const group = this.groupById(groupId)
    if (!group) return
    group.pinned = !group.pinned
    this.persist()
  }

  // ─── Boxes ────────────────────────────────────────────────────────────────

  /** Create a box and return its id. The cap is enforced the way the group cap
   *  is: at the limit the call is a no-op that returns an unusable id, so a caller
   *  cannot keep making partitions without bound. */
  createBox(name: string, appearance: Partial<BrowserBoxAppearance> = {}): string {
    const id = `box:${crypto.randomUUID()}`
    // The default box is not one of the user's, so it does not count against the
    // cap the user's own boxes obey: it exists whether they make any or not.
    const userBoxCount = this.boxes.filter((box) => box.id !== DEFAULT_BOX_ID).length
    if (userBoxCount >= MAX_GLOBAL_BROWSER_BOXES) return id
    this.boxes = withDefaultBox([
      ...this.boxes,
      {
        id,
        name: name.trim().slice(0, MAX_BROWSER_BOX_NAME_LENGTH) || 'New box',
        color: appearance.color ?? null,
        iconType: appearance.iconType ?? null,
        customSvg: appearance.customSvg ?? null,
        imagePath: appearance.imagePath ?? null
      }
    ])
    this.persist()
    if (appearance.imagePath) void this.ensureBoxIconLoaded(id)
    return id
  }

  /** Read a box's picked image icon into a data URL, once. Best-effort: a missing
   *  or unreadable file leaves the box on its colour/SVG icon. */
  async ensureBoxIconLoaded(boxId: string): Promise<void> {
    const box = this.boxById(boxId)
    if (!box?.imagePath) {
      this.boxIconUrls.delete(boxId)
      return
    }
    if (this.boxIconUrls.has(boxId)) return
    try {
      const url = await invoke('file:readAsDataUrl', box.imagePath)
      if (url) this.boxIconUrls.set(boxId, url)
    } catch {
      // Icon loading is best-effort; the resolver's fallback remains.
    }
  }

  updateBox(id: string, patch: Partial<Omit<GlobalBrowserBox, 'id'>>): void {
    const box = this.boxById(id)
    if (!box) return
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, MAX_BROWSER_BOX_NAME_LENGTH)
      if (name) box.name = name
    }
    if (patch.color !== undefined) box.color = patch.color
    if (patch.iconType !== undefined) box.iconType = patch.iconType
    if (patch.customSvg !== undefined) box.customSvg = patch.customSvg
    if (patch.imagePath !== undefined) box.imagePath = patch.imagePath
    this.persist()
    if (patch.imagePath !== undefined) {
      this.boxIconUrls.delete(id)
      void this.ensureBoxIconLoaded(id)
    }
  }

  /** How many tabs currently run in a jar. The argument is a jar id, not a box id:
   *  the default box's jar is the absent id, so pass it through `jarIdForBox`. */
  tabCountInBox(jarId: string | null): number {
    return this.tabs.filter((tab) => tab.boxId === jarId).length
  }

  /**
   * The box the tab on screen runs in.
   *
   * A tab with no box is in the default box, so this is never null: the rail's
   * active-box chip and the extensions panel's scope both name a box in every case,
   * including the browser's own first launch with nothing made yet.
   */
  get activeBox(): GlobalBrowserBox {
    return this.boxById(this.activeTabBoxId) ?? defaultBrowserBox()
  }

  /**
   * Remove a box.
   *
   * Its tabs close with it: a tab cannot change jars, so keeping them open while
   * the jar goes away would leave rows claiming a session nothing owns. The box is
   * one jar for the whole profile, so removing it takes that jar away from every
   * context that picked it, a thread browser included. The caller erases the box's
   * cookies separately, because that is the destructive choice and belongs behind
   * its own confirmation.
   */
  deleteBox(id: string): void {
    // The default box is the jar the context's own pages live in, so it is the one
    // box that cannot be removed: every unboxed tab already belongs to it, and
    // there would be no way to name its replacement.
    if (id === DEFAULT_BOX_ID) return
    if (!this.boxes.some((box) => box.id === id)) return
    for (const tab of this.tabs.filter((candidate) => candidate.boxId === id)) {
      // The box is being removed, so a reopen would have no jar to restore into.
      this.close(tab.id, { recordForReopen: false })
    }
    this.boxes = this.boxes.filter((box) => box.id !== id)
    this.boxIconUrls.delete(id)
    this.persist()
  }

  /** Erase a box's cookies, site data and cache in the main process. Best-effort
   *  with a report, because the user asked for the data to be gone and a silent
   *  failure would leave them believing it is. */
  async clearBoxData(boxId: string): Promise<void> {
    try {
      await invoke('browser:clearBoxData', GLOBAL_BROWSER_CONTEXT.projectId, boxId)
    } catch (error) {
      reportError(error, 'The box\u2019s cookies and site data could not be cleared.')
    }
  }

  /** A box was deleted: erase it and take its Chromium profile with it. Nothing can
   *  name a deleted box's jar again, so leaving the profile in place would strand
   *  its cache on disk. Best-effort with a report, exactly like `clearBoxData`: the
   *  user asked for the data to be gone, and a silent failure would leave them
   *  believing it is. */
  async forgetBox(boxId: string): Promise<void> {
    try {
      await invoke('browser:forgetBox', GLOBAL_BROWSER_CONTEXT.projectId, boxId)
    } catch (error) {
      reportError(error, 'The box\u2019s data could not be erased.')
    }
  }

  // ─── Page state ───────────────────────────────────────────────────────

  /**
   * Give one tab the icon its address is known by, when it has none.
   *
   * Called for every tab the strip draws, so a tab the app has no page for (one a
   * restart restored, one hibernated before its page announced an icon, one an
   * agent opened and never showed) wears the site's mark instead of a globe. The
   * answer is written down with the tab, which is what makes it durable: the read
   * already happened when the looked-up icon lands, so the store cannot gain a
   * write of its own unless the icon is new. One lookup per address per tab, and
   * none at all for a tab that already holds an icon.
   */
  async ensureFavicon(tabId: string): Promise<void> {
    const favicon = await this.tabFavicons.resolve(tabId, () => this.tabById(tabId))
    const tab = this.tabById(tabId)
    if (favicon === null || !tab || tab.favicon !== null) return
    tab.favicon = favicon
    this.persist()
  }

  /** Apply a live page snapshot: the navigation identity onto the tab, and the
   *  loading/audio/capture state onto the map the strip and header read. */
  applyPageState(state: BrowserPageState): void {
    const tab = this.tabs.find((candidate) => candidate.id === state.tabId)
    if (!tab) return
    let changed = false
    // A document with no committed address yet (a fresh tab, an about:blank
    // popup) reports an empty URL and must not erase the address on screen.
    if (state.url && tab.url !== state.url) {
      tab.url = state.url
      // The icon is the icon of an address, so a tab that moved is not the tab
      // the stored icon was read from: it goes with the address it came from, and
      // the row picks up the new one from the page or from the address itself
      // (see `ensureFavicon`).
      if (tab.favicon !== null) {
        tab.favicon = null
        this.tabFavicons.forget(tab.id)
      }
      changed = true
    }
    const title = state.title.trim()
    if (title && tab.title !== title) {
      tab.title = title
      changed = true
    }
    // An icon the document reported is adopted. A report of none is deliberately
    // not an erasure: Chromium announces an icon only when it differs from the one
    // the tab already holds, so a reopened hibernated tab (whose page has no
    // remembered icon yet) would blank its own row on the way back, and a page
    // that reloads at the same address would lose the mark it just had. Only the
    // address changing replaces the icon, above.
    if (isStorableBrowserFavicon(state.favicon) && tab.favicon !== state.favicon) {
      tab.favicon = state.favicon
      changed = true
    }
    // Loading a page is a use of the tab, which is what keeps a tab the user is
    // actively navigating from being hibernated mid-load.
    if (state.loading) tab.lastUsedAt = Date.now()
    if (changed) this.persist()
    const current = this.runtime.get(state.tabId)
    if (
      current &&
      current.audible === state.audible &&
      current.muted === state.muted &&
      current.capturing === state.capturing &&
      current.loading === state.loading &&
      isSameBrowserLoadError(current.loadError, state.loadError) &&
      current.canGoBack === state.canGoBack &&
      current.canGoForward === state.canGoForward
    ) {
      return
    }
    this.runtime.set(state.tabId, {
      audible: state.audible,
      muted: state.muted,
      capturing: state.capturing,
      loading: state.loading,
      loadError: state.loadError,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward
    })
  }

  /** Toggle one tab's audio output, optimistically so the indicator answers the
   *  click immediately. Main's published state stays the source of truth. */
  toggleMute(tabId: string): void {
    const current = this.runtimeFor(tabId)
    const muted = !current.muted
    this.runtime.set(tabId, { ...current, muted })
    void invoke('browser:setMuted', tabId, muted).catch((error: unknown) => {
      const latest = this.runtime.get(tabId)
      if (latest?.muted === muted) this.runtime.set(tabId, { ...latest, muted: current.muted })
      reportError(
        error,
        muted ? 'Tab audio could not be muted.' : 'Tab audio could not be unmuted.'
      )
    })
  }

  // ─── Hibernation ──────────────────────────────────────────────────────────

  /** The configured idle window, from the setting. */
  get hibernationWindowMs(): number {
    return appConfigState.browserHibernationMinutes * 60_000
  }

  /**
   * Release the page of every tab idle past the window.
   *
   * The active tab, a tab playing audio, and a tab holding a capture are never
   * hibernated: those are exactly the tabs whose disappearance the user would
   * notice. A hibernated tab keeps its title, its own icon, its group and its
   * address, and all four are written down, so the strip reads the same before and
   * after a restart; only the page is gone, and it reloads on the next visit.
   */
  sweepIdleTabs(now: number = Date.now()): void {
    const windowMs = this.hibernationWindowMs
    let changed = false
    for (const tab of this.tabs) {
      if (tab.id === this.activeTabId) continue
      if (tab.url === '') continue
      const runtime = this.runtimeFor(tab.id)
      if (runtime.audible && !runtime.muted) continue
      if (runtime.capturing) continue
      if (!isTabIdlePastWindow(tab, now, windowMs)) continue
      tab.hibernated = true
      changed = true
      this.runtime.delete(tab.id)
      // Only the page is released: the row stays in the strip, so main writes the
      // tab's stack down before the view goes and the next visit restores it.
      void invoke('browser:destroy', tab.id, 'hibernated').catch(() => {})
    }
    // A sweep that released nothing leaves the stored list untouched, so the
    // minute-long clock never rewrites the file for its own sake.
    if (changed) this.persist()
  }

  /** Close the oldest idle tabs when the strip is at its cap. A pinned tab is
   *  spared the way a pinned thread survives cleanup, so the cap only ever hits
   *  unpinned tabs unless nothing else is left. */
  private enforceTabCap(): void {
    if (this.tabs.length < MAX_GLOBAL_BROWSER_TABS) return
    const closable = this.tabs.filter((tab) => tab.id !== this.activeTabId && !tab.pinned)
    const victim =
      [...closable].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0] ??
      [...this.tabs]
        .filter((tab) => tab.id !== this.activeTabId)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
    if (victim) this.close(victim.id, { recordForReopen: false })
    if (this.tabs.length >= MAX_GLOBAL_BROWSER_TABS) {
      // Nothing left that may be closed without touching the active tab.
      reportError(new Error('Browser tab limit reached'), 'Too many browser tabs are open.')
    }
  }

  /** The strip in its stored shape. */
  private snapshot(): GlobalBrowserTabsSnapshot {
    return globalBrowserTabsSnapshot(this.tabs, this.groups, this.boxes, this.activeTabId)
  }

  /**
   * Queue a write of the current strip.
   *
   * Nothing is written before the stored list has been read, so a store that has
   * never seen it cannot erase it. Changes coalesce into one write, and the quit
   * path flushes whatever is still pending.
   */
  private persist(): void {
    this.mutatedSinceBoot = true
    if (!this.hydrated) return
    if (this.saveTimer !== null) return
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null
      void this.saveStoredTabs()
    }, TAB_SAVE_COALESCE_MS)
  }

  private async saveStoredTabs(): Promise<void> {
    try {
      await saveStoredGlobalBrowserTabs(this.snapshot())
    } catch (error) {
      reportError(error, 'The browser tabs could not be saved.')
    }
  }

  /** Write the coalesced change now, for a quit that is about to end the process. */
  private flushPendingSave(): void {
    if (this.saveTimer === null) return
    window.clearTimeout(this.saveTimer)
    this.saveTimer = null
    void this.saveStoredTabs()
  }
}

export const globalBrowser = new GlobalBrowserState()

/** The reserved ownership context every global tab is created under. */
export const GLOBAL_BROWSER_CONTEXT = {
  projectId: GLOBAL_BROWSER_PROJECT_ID,
  threadId: GLOBAL_BROWSER_THREAD_ID
} as const

/** The hidden page identity handed to a browser tab's agent as context, so a
 *  question with no page named still knows which page it is about.
 *
 * It rides every turn of the conversation, not only the first: a lasting chat
 * outlives the page it started on, and the tab may have navigated many times by
 * the time the user asks something. The text also names the page the agent's own
 * browser capability is pointed at, which is what makes an answer about "this
 * page" a reading of the page that is actually on screen. */
export function browserAgentPageContext(tab: GlobalBrowserTab): string {
  const lines = ['The user is asking about a web page they have open in the built-in browser.']
  const title = browserTabLabel(tab).trim()
  if (title) lines.push(`Page title: ${title}`)
  if (tab.url) lines.push(`Page URL: ${tab.url}`)
  lines.push(
    'The page is attached to this conversation: the in-app browser capability (`cio:browser`) reads this very page, so `snapshot`, `screenshot` and `console` answer about what the user is looking at. Opening or driving a page of your own uses the same capability and never moves the user\u2019s page.'
  )
  return lines.join('\n')
}

/** The title a browser tab's conversation starts on, before the model names it
 *  from the user's first question. The page's own label is what the user would
 *  call that conversation, and the first turn replaces it with the generated
 *  title. */
function browserAssistantChatTitle(tab: GlobalBrowserTab): string {
  const label = browserTabLabel(tab).trim()
  return label === '' ? BROWSER_ASSISTANT_DEFAULT_TITLE : label
}
