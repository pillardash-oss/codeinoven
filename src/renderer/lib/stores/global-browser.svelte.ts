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
  BrowserOpenRequestContext,
  BrowserPageState,
  BrowserPopupWindow
} from '$shared/ipc-contract'
import type { GlobalBrowserTabsSnapshot } from '$shared/browser/global-browser-tabs'
import { GLOBAL_BROWSER_PROJECT_ID, GLOBAL_BROWSER_THREAD_ID } from '$shared/ipc-contract'
import { appConfigState } from './app-config.svelte'
import { reportError } from './app-errors.svelte'
import { browserPopupWindows } from './browser-popup-windows.svelte'
import { contextSidebarState, type TemporaryChatContextTab } from './context-sidebar.svelte'
import { sidebarState } from './sidebar.svelte'
import { defaultSettingsFor } from './thread-settings.svelte'
import { threadNotesState } from './thread-notes.svelte'
import { recentVisits } from './recent-visits.svelte'
import {
  clearLegacyGlobalBrowserTabs,
  globalBrowserTabsSnapshot,
  loadLegacyGlobalBrowserTabs,
  loadStoredGlobalBrowserTabs,
  runtimeGroupFromPersisted,
  runtimeTabFromPersisted,
  saveStoredGlobalBrowserTabs
} from './global-browser-persistence'
import {
  IDLE_GLOBAL_BROWSER_RUNTIME,
  MAX_BROWSER_GROUP_NAME_LENGTH,
  MAX_BROWSER_TAB_TITLE_LENGTH,
  MAX_GLOBAL_BROWSER_GROUPS,
  MAX_GLOBAL_BROWSER_TABS,
  browserTabLabel,
  browserTabTitleForUrl,
  isBlankBrowserAddress,
  isSameBrowserLoadError,
  isTabIdlePastWindow,
  type BrowserGroupAppearance,
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

export class GlobalBrowserState {
  tabs: GlobalBrowserTab[] = $state([])
  groups: GlobalBrowserGroup[] = $state([])
  /** Data URLs for groups with a picked image icon, keyed by group id. Loaded
   *  lazily, because a stored icon is a file path on disk and not inline bytes. */
  groupIconUrls: SvelteMap<string, string> = $state(new SvelteMap())
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
   *  and its agent conversation, plus the browser's own downloads; exactly one
   *  is shown at a time, the way the context dock picks one tool in every other
   *  view. Downloads belong to the shared profile rather than a tab, so that tool
   *  is the one entry that can stay open with no tab. */
  contextSidebarTool = $state<'note' | 'agent' | 'downloads' | 'popups'>('note')
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
  private readonly runtime = new SvelteMap<string, GlobalBrowserRuntime>()
  /** The agent side chat bound to each browser tab, keyed by browser tab id.
   *  Session-scoped on purpose: a tab's conversation is an ephemeral side chat
   *  and its backend session does not outlive the app, so a restart starts fresh
   *  rather than pointing at a session that is gone. */
  private readonly agentChatIds = new SvelteMap<string, string>()
  /** Popup windows this renderer has already reported on, so only the arrival of
   *  a new one brings the rail's popup panel up. Bounded by the live list: an id
   *  whose popup is gone is forgotten. */
  private readonly seenPopupWindowIds = new SvelteSet<string>()
  private sweepTimer: number | null = null
  /** The coalesced write still waiting to leave, or null. */
  private saveTimer: number | null = null
  /** Whether this session changed the strip. A change that lands while the stored
   *  list is still arriving belongs to the user, so it is kept and stored rather
   *  than replaced by what was read. */
  private mutatedSinceBoot = false

  constructor() {
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
    void this.hydrate()
  }

  /** Release the sweep timer and the pending write. The store lives for the
   *  renderer's lifetime, so this exists for tests and a deliberate teardown
   *  rather than normal use. */
  dispose(): void {
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
    this.activeTabId = snapshot.activeTabId
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
  }

  /**
   * Take main's popup windows into the rail.
   *
   * A popup opened by the tab on screen is shown, because the user asked for it by
   * clicking something: the rail comes up on it and the tab it just opened reads as
   * current. A popup opened by a background tab is not a reason to move the user
   * away from what they are reading, so it waits in its own tab's strip. A further
   * popup only joins the list, so a page cannot move the panel under the user's
   * hands while they are using the one already up.
   */
  private applyPopupWindows(popups: BrowserPopupWindow[]): void {
    // The live ids are a list rather than a set: there are as many as the tab has
    // popups open, which is a handful, and this runs on every report about one.
    const live = popups.map((popup) => popup.id)
    for (const id of [...this.seenPopupWindowIds]) {
      if (!live.includes(id)) this.seenPopupWindowIds.delete(id)
    }
    const tabId = this.activeTabId
    for (const popup of popups) {
      if (this.seenPopupWindowIds.has(popup.id)) continue
      this.seenPopupWindowIds.add(popup.id)
      if (tabId !== null && popup.tabId === tabId) {
        browserPopupWindows.select(popup.id)
        this.showPopupsSidebar()
      }
    }
    // The panel belongs to one tab's windows, so when that tab holds none there is
    // nothing left for the rail to show and it closes with the last of them rather
    // than sitting there as an empty strip.
    this.closePopupsWithNoWindows()
  }

  /** Close the popup tool once the tab on screen has no popup windows left. */
  private closePopupsWithNoWindows(): void {
    if (!this.contextSidebarVisible) return
    if (this.contextSidebarTool !== 'popups') return
    const tab = this.activeTab
    if (tab && browserPopupWindows.forTab(tab.id).length > 0) return
    this.contextSidebarVisible = false
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
    if (this.contextSidebarTool === 'downloads') return true
    return this.activeTab !== null
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

  /** Live runtime of one tab, or the shared idle value while main has reported
   *  nothing for it. */
  runtimeFor(tabId: string): GlobalBrowserRuntime {
    return this.runtime.get(tabId) ?? IDLE_GLOBAL_BROWSER_RUNTIME
  }

  /** Whether a browser tab with this address is already open. A blank address
   *  never matches, so "new tab" always makes a new one. */
  findTabByUrl(url: string): GlobalBrowserTab | null {
    if (isBlankBrowserAddress(url)) return null
    return this.tabs.find((tab) => tab.url === url) ?? null
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

  /** Mark the workspace as opened, so the first activation can reveal a tab. */
  markOpened(): void {
    this.opened = true
    this.dockActiveTabNote()
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
   * Reveal the rail on the active tab's popup windows.
   *
   * A popup window is a window the user asked for by clicking something in the
   * page, so it is shown rather than parked in silence. The panel belongs to the
   * tab on screen, which is the tab whose page opened it in every flow that has
   * one (a sign-in, a checkout), and a popup opened by a background tab waits in
   * its own tab's panel until the user goes back to it.
   */
  showPopupsSidebar(): void {
    if (!this.activeTab) return
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
   * Drop the notifications tool when another rail tool takes over. The
   * notifications flag lives in the context-sidebar store (the header bell owns
   * it), so the rail can only ask it to close, and only while it is the tool on
   * screen.
   */
  private dismissNotifications(): void {
    if (this.notificationsShown) contextSidebarState.toggleNotifications()
  }

  /** Reveal the rail on the active tab's agent conversation, creating it on the
   *  first open. The chat is the app's own temporary side chat, so it binds to a
   *  browser tab the way a side chat binds to a thread. */
  showAgentSidebar(): void {
    const tab = this.activeTab
    if (!tab) return
    this.dismissNotifications()
    this.ensureAgentChat(tab)
    this.contextSidebarTool = 'agent'
    this.contextSidebarVisible = true
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

  /** The agent side chat bound to a browser tab, or null before its first open. */
  agentChatTabFor(tabId: string): TemporaryChatContextTab | null {
    const chatId = this.agentChatIds.get(tabId)
    if (!chatId) return null
    return contextSidebarState.temporaryChatTab(`temporary-chat:${chatId}`)
  }

  /** The harness a browser tab's agent chat runs on, for the strip row's second
   *  line. Null while the tab has no agent chat. */
  agentHarnessFor(tabId: string): string | null {
    return this.agentChatTabFor(tabId)?.settings.harnessId ?? null
  }

  /**
   * Create (or return) the side chat bound to one browser tab.
   *
   * A browser tab has no thread of its own, so the chat resolves its scope
   * against the browser's reserved parent thread and carries the page identity
   * as hidden context, which is what lets the agent answer about the page on
   * screen. An expired chat is replaced rather than reused.
   */
  ensureAgentChat(tab: GlobalBrowserTab): TemporaryChatContextTab {
    const existingId = this.agentChatIds.get(tab.id)
    if (existingId) {
      const existing = contextSidebarState.temporaryChatTab(`temporary-chat:${existingId}`)
      if (existing && !existing.expired) return existing
    }
    const temporaryChatId = crypto.randomUUID()
    const chat = contextSidebarState.ensureBrowserAgentChat(
      GLOBAL_BROWSER_PROJECT_ID,
      GLOBAL_BROWSER_THREAD_ID,
      temporaryChatId,
      defaultSettingsFor('chat'),
      browserAgentPageContext(tab)
    )
    this.agentChatIds.set(tab.id, temporaryChatId)
    return chat
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
    // tab's own conversation must be the one on screen, and the popup panel, which
    // belongs to the tab whose page opened the windows, closes when that tab has
    // none.
    if (this.contextSidebarTool === 'agent' && this.contextSidebarVisible && this.activeTab) {
      this.ensureAgentChat(this.activeTab)
    }
    if (this.contextSidebarTool === 'popups') this.closePopupsWithNoWindows()
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
   *  new tab is for. */
  openNewTabAddress(groupId: string | null = null): void {
    this.createTab('', groupId)
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
        createdAt: now,
        lastUsedAt: now,
        hibernated: false,
        pinned: false,
        pinnedAt: null,
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

  /** Open an address: focus the tab already showing it, otherwise create one. */
  open(url: string, groupId: string | null = null): string {
    const existing = this.findTabByUrl(url)
    if (existing) {
      this.activate(existing.id)
      return existing.id
    }
    return this.createTab(url, groupId)
  }

  /** Create a tab for an address (blank allowed) and make it active. */
  createTab(url: string, groupId: string | null = null): string {
    this.enforceTabCap()
    const now = Date.now()
    const tab: GlobalBrowserTab = {
      id: `browser:${crypto.randomUUID()}`,
      title: browserTabTitleForUrl(url),
      customTitle: null,
      url,
      favicon: null,
      groupId: this.groups.some((group) => group.id === groupId) ? groupId : null,
      createdAt: now,
      lastUsedAt: now,
      hibernated: false,
      pinned: false,
      pinnedAt: null,
      color: null,
      iconType: null,
      customSvg: null,
      imagePath: null
    }
    this.tabs = [...this.tabs, tab]
    this.setActiveTab(tab.id)
    this.persist()
    return tab.id
  }

  /** Close a tab and land on its neighbour in the strip. */
  close(tabId: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    const remaining = this.tabs.filter((tab) => tab.id !== tabId)
    this.tabs = remaining
    this.runtime.delete(tabId)
    if (this.activeTabId === tabId) {
      const neighbour = remaining[Math.min(index, remaining.length - 1)]
      this.setActiveTab(neighbour?.id ?? null)
      if (neighbour) neighbour.lastUsedAt = Date.now()
    }
    if (this.tabs.length === 0 && this.contextSidebarTool !== 'downloads') {
      // With no tab left the note and agent tools have no subject, so the rail
      // returns to its closed default instead of lingering for the next tab.
      // Downloads need no tab, so they stay open.
      this.contextSidebarVisible = false
    }
    this.persist()
    void invoke('browser:destroy', tabId).catch(() => {})
    // A tab's note is keyed by the tab id, so closing the tab is what removes
    // it   exactly the way deleting a thread removes its note.
    if (threadNotesState.has(tabId)) {
      void invoke('note:delete', GLOBAL_BROWSER_PROJECT_ID, tabId).catch(() => {})
    }
    // The tab's agent chat is the same kind of subject-scoped state: closing the
    // tab closes its side chat and releases the backend session.
    this.closeAgentChatFor(tabId)
  }

  /** Tear down one browser tab's agent chat: close its harness session and drop
   *  its tab from the browser's reserved context. */
  private closeAgentChatFor(tabId: string): void {
    const chatId = this.agentChatIds.get(tabId)
    if (!chatId) return
    const chatTab = contextSidebarState.temporaryChatTab(`temporary-chat:${chatId}`)
    if (chatTab) contextSidebarState.expireTemporaryChat(chatTab)
    contextSidebarState.removeBrowserAgentChat(
      GLOBAL_BROWSER_PROJECT_ID,
      GLOBAL_BROWSER_THREAD_ID,
      chatId
    )
    this.agentChatIds.delete(tabId)
  }

  moveToGroup(tabId: string, groupId: string | null): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    const target = this.groups.some((group) => group.id === groupId) ? groupId : null
    if (tab.groupId === target) return
    tab.groupId = target
    this.persist()
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

  // ─── Page state ───────────────────────────────────────────────────────────

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
      changed = true
    }
    const title = state.title.trim()
    if (title && tab.title !== title) {
      tab.title = title
      changed = true
    }
    if (state.favicon !== tab.favicon) {
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
   * notice. A hibernated tab keeps its title, favicon, group and address, so
   * the strip is unchanged and the page simply reloads on the next visit.
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
      void invoke('browser:destroy', tab.id).catch(() => {})
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
    if (victim) this.close(victim.id)
    if (this.tabs.length >= MAX_GLOBAL_BROWSER_TABS) {
      // Nothing left that may be closed without touching the active tab.
      reportError(new Error('Browser tab limit reached'), 'Too many browser tabs are open.')
    }
  }

  /** The strip in its stored shape. */
  private snapshot(): GlobalBrowserTabsSnapshot {
    return globalBrowserTabsSnapshot(this.tabs, this.groups, this.activeTabId)
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
 *  question with no page named still knows which page it is about. */
function browserAgentPageContext(tab: GlobalBrowserTab): string {
  const lines = ['The user is asking about a web page they have open in the built-in browser.']
  const title = browserTabLabel(tab).trim()
  if (title) lines.push(`Page title: ${title}`)
  if (tab.url) lines.push(`Page URL: ${tab.url}`)
  return lines.join('\n')
}
