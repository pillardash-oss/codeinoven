import { SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { peekLandingFor } from '$lib/components/browser/browser-peek-transition'
import { type GlobalBrowserTabsSnapshot } from '$shared/browser/global-browser-tabs'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import { reportError } from '../app-errors.svelte'
import { browserAssistant, type BrowserAssistantChat } from '../browser-assistant.svelte'
import { contextSidebarState } from '../context-sidebar.svelte'
import { browserAudio } from '../browser-audio.svelte'
import { sidebarState } from '../sidebar.svelte'
import { threadNotesState } from '../thread-notes.svelte'
import { recentVisits } from '../recent-visits.svelte'
import {
  clearLegacyGlobalBrowserTabs,
  globalBrowserTabsSnapshot,
  loadLegacyGlobalBrowserTabs,
  loadStoredGlobalBrowserTabs,
  runtimeBoxFromPersisted,
  runtimeGroupFromPersisted,
  runtimeTabFromPersisted,
  saveStoredGlobalBrowserTabs
} from '../global-browser-persistence'
import {
  MAX_BROWSER_BOX_NAME_LENGTH,
  MAX_BROWSER_GROUP_NAME_LENGTH,
  MAX_BROWSER_TAB_TITLE_LENGTH,
  MAX_GLOBAL_BROWSER_BOXES,
  MAX_GLOBAL_BROWSER_GROUPS,
  MAX_GLOBAL_BROWSER_TABS,
  MAX_REOPENED_BROWSER_TABS,
  browserTabLabel,
  browserTabTitleForUrl,
  canHibernateTab,
  isBlankBrowserAddress,
  DEFAULT_BOX_ID,
  jarIdForBox,
  isTabIdlePastWindow,
  type BrowserBoxAppearance,
  type BrowserGroupAppearance,
  type ClosedGlobalBrowserTab,
  type GlobalBrowserBox,
  type GlobalBrowserGroup,
  type GlobalBrowserTab
} from '../global-browser-types'
import { GLOBAL_BROWSER_CONTEXT, withDefaultBox } from '../global-browser.svelte'
import type { GlobalBrowserState } from '../global-browser.svelte'

/** GlobalBrowserState runtime: one concern, moved verbatim from the composition root. */
export class GlobalBrowserStateRuntime {
  constructor(private readonly host: GlobalBrowserState) {}

  /** Answer the in-app screen-share picker: a source id, or null to cancel. */
  async resolveScreenShare(sourceId: string | null): Promise<void> {
    const prompt = this.host.screenSharePrompt
    if (!prompt) return
    this.host.screenSharePrompt = null
    await invoke('browser:resolveScreenShare', prompt.requestId, sourceId).catch(() => {})
  }

  peekContext(tabId: string): { projectId: string; threadId: string } | null {
    for (const peek of this.host.peeks.values()) {
      if (peek.tab.id === tabId) return { projectId: peek.projectId, threadId: peek.threadId }
    }
    return null
  }

  /**
   * Ask the current Peek Window to close.
   *
   * This only asks. The surface plays the flight first, shrinking the page back
   * into the link it came from, and the drop happens on `peekFlightLanded`: a
   * closed peek that vanished on the click would lose the one thing the flight is
   * for, which is showing the user where the page went.
   */
  closePeek(): void {
    if (!this.host.peekTab) return
    if (this.host.peekPhase === 'closing' || this.host.peekPhase === 'expanding') return
    this.host.peekPhase = 'closing'
  }

  /**
   * Close the current Peek Window now, with no flight.
   *
   * For the one case that has nothing left to animate: the surface that draws the
   * peek is being torn down, so a flight would be run by a component that is
   * already gone and the tab would outlive the surface that owned it.
   */
  dropPeek(): void {
    const tab = this.host.peekTab
    if (!tab) return
    this.destroyPeekTab(tab)
  }

  async expandPeek(): Promise<void> {
    const tab = this.host.peekTab
    if (!tab) return
    if (this.host.peekPhase === 'closing' || this.host.peekPhase === 'expanding') return
    try {
      await invoke('browser:expandPeek', tab.id)
    } catch (error: unknown) {
      reportError(error, 'Peek Window could not be expanded.')
      return
    }
    // The peek can be gone by the time main answers. A close the user asked for
    // while that call was in flight has already destroyed the tab, so there is
    // nothing left to promote and nowhere for a flight to land.
    if (this.host.peekTab?.id !== tab.id) return
    // The tab joins the list before the flight starts, because the flight lands on
    // the row it is about to become and a row exists only once the strip knows
    // about the tab. Activation waits for the landing: until then the strip is
    // behind the surface, drawing a row nobody can see.
    this.enforceTabCap()
    const context = this.host.peekContext(tab.id)
    if (context && context.projectId !== GLOBAL_BROWSER_PROJECT_ID) {
      contextSidebarState.openBrowserForContext(
        tab.url,
        context.projectId,
        context.threadId,
        tab.id,
        false,
        tab.boxId
      )
    } else this.host.tabs = [...this.host.tabs, tab]
    this.host.peekPhase = 'expanding'
  }

  /**
   * The surface's flight is over, so the peek takes the step its phase asked for.
   *
   * This is the other half of `closePeek` and `expandPeek`. Neither of them can
   * finish on its own, because neither can finish before the surface has shown the
   * user what happened: a close drops the tab here, an expansion promotes it into
   * the strip, and an opening simply parks the peek where it landed.
   */
  peekFlightLanded(): void {
    const tab = this.host.peekTab
    if (!tab) return
    const landing = peekLandingFor(this.host.peekPhase ?? 'open')
    if (landing === 'open') {
      this.host.peekPhase = 'open'
      // The page may be uncovered from here on, which is also the only state in
      // which it can be pictured on the way back out.
      this.host.peekLanded = true
      return
    }
    if (landing === 'close') {
      this.destroyPeekTab(tab)
      return
    }
    if (landing !== 'expand') return
    const context = this.host.peekContext(tab.id)
    this.host.units['queries'].forgetPeek()
    if (context && context.projectId !== GLOBAL_BROWSER_PROJECT_ID)
      contextSidebarState.focus(tab.id)
    else {
      this.host.activate(tab.id)
      this.host.units['queries'].persist()
    }
  }

  /** Drop a peek's tab for good: it is over, and its runtime describes a page
   *  nothing will ever show again. */
  destroyPeekTab(tab: GlobalBrowserTab): void {
    this.host.units['queries'].forgetPeek()
    this.host.runtime.delete(tab.id)
    browserAudio.forget(tab.id)
    void invoke('browser:destroy', tab.id, 'closed').catch((error: unknown) =>
      reportError(error, 'Peek Window could not be closed.')
    )
  }

  closeSourcePeek(sourceId: string): void {
    const peek = this.host.peeks.get(sourceId)
    if (!peek) return
    this.host.peeks.delete(sourceId)
    this.host.runtime.delete(peek.tab.id)
    browserAudio.forget(peek.tab.id)
    void invoke('browser:destroy', peek.tab.id, 'closed').catch(() => {})
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
  async hydrate(): Promise<void> {
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
      if (this.host.mutatedSinceBoot) {
        this.mergeStoredSnapshot(restored)
        this.host.units['queries'].persist()
      } else {
        this.host.units['installation'].adoptSnapshot(restored)
      }
    }
    this.host.hydrated = true
    void browserAssistant.restoreChats(this.host.tabs)
    // A box's icon is a file on disk, so its bytes are read once, here rather than
    // by whichever surface happens to show a box first: the rail, a tab row and
    // the boxes panel all draw the same icon, and none of them should have to wait
    // for another to be opened before it can.
    for (const box of this.host.boxes) {
      if (box.imagePath) void this.host.ensureBoxIconLoaded(box.id)
    }
    try {
      // Nothing to write when the durable file already holds the whole list.
      if (!stored || legacy) await saveStoredGlobalBrowserTabs(this.host.snapshot())
      if (legacy) clearLegacyGlobalBrowserTabs()
    } catch (error) {
      reportError(error, 'The browser tabs could not be saved.')
    }
  }

  /** Fold a stored list into the strip a change left on screen, skipping the tabs
   *  and folds it already holds so nothing is duplicated. */
  mergeStoredSnapshot(snapshot: GlobalBrowserTabsSnapshot): void {
    // Two bounded arrays rather than sets: the strip holds at most 100 tabs, and
    // this runs once, at the only moment the two lists can coexist.
    const knownIds = this.host.tabs.map((tab) => tab.id)
    const knownUrls = this.host.tabs.map((tab) => tab.url).filter((url) => url !== '')
    for (const persisted of snapshot.tabs) {
      if (knownIds.includes(persisted.id)) continue
      const tab = runtimeTabFromPersisted(persisted)
      if (tab.url !== '' && knownUrls.includes(tab.url)) continue
      knownIds.push(tab.id)
      knownUrls.push(tab.url)
      this.host.tabs = [...this.host.tabs, tab]
    }
    for (const persisted of snapshot.groups) {
      if (this.host.groups.some((group) => group.id === persisted.id)) continue
      this.host.groups = [...this.host.groups, runtimeGroupFromPersisted(persisted)]
    }
    for (const persisted of snapshot.boxes ?? []) {
      if (this.host.boxes.some((box) => box.id === persisted.id)) continue
      this.host.boxes = [...this.host.boxes, runtimeBoxFromPersisted(persisted)]
    }
    // Outside the loop and unconditional on purpose. The default box is not one of
    // the stored boxes, so a merge that already knows every stored box would run the
    // loop zero times and never mint it, which is exactly what happened when this
    // first shipped: a profile with one box showed one box and no default.
    this.host.boxes = withDefaultBox(this.host.boxes)
    // A session that has not chosen a default of its own takes the stored one, so a
    // change that landed before the read still shows the box the user last picked.
    // A session that already chose keeps its choice: that is the newer intent.
    if (!this.host.defaultBoxChosen)
      this.host.units['installation'].adoptDefaultBox(snapshot.defaultBoxId)
  }

  /** Tabs of one group, in strip order. A null group means the ungrouped rest.
   *  Pinned tabs are excluded: they always render in the pinned block above. */
  tabsInGroup(groupId: string | null): GlobalBrowserTab[] {
    return this.host.tabs.filter((tab) => tab.groupId === groupId && !tab.pinned)
  }

  groupById(groupId: string): GlobalBrowserGroup | null {
    return this.host.groups.find((group) => group.id === groupId) ?? null
  }

  /** The loaded data URL for a group's picked image icon, when there is one. A
   *  group without a stored image resolves its icon from colour/SVG instead. */
  groupIconUrl(groupId: string): string | null {
    return this.host.groupIconUrls.get(groupId) ?? null
  }

  /** One box by id, or null once it has been deleted. */
  boxById(boxId: string): GlobalBrowserBox | null {
    return this.host.boxes.find((box) => box.id === boxId) ?? null
  }

  /** The loaded data URL for a box's picked image icon, when there is one. */
  boxIconUrl(boxId: string): string | null {
    return this.host.boxIconUrls.get(boxId) ?? null
  }

  /** One tab by id, or null once it has been closed. */
  tabById(tabId: string): GlobalBrowserTab | null {
    return (
      this.host.tabs.find((tab) => tab.id === tabId) ??
      [...this.host.peeks.values()].find((peek) => peek.tab.id === tabId)?.tab ??
      null
    )
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
    this.host.activate(tabId)
    this.host.closeTabSearch()
    const tab = this.host.activeTab
    if (!tab || tab.id !== tabId) return
    if (isBlankBrowserAddress(tab.url)) {
      this.host.openAddressSpotlight()
      return
    }
    // Landing on a page takes the palette down. It belongs to the tab it was
    // opened for, and a tab switch is the moment the user chose the page over
    // the field: leaving it up would hold the new page off screen behind it.
    this.host.closeAddressSpotlight()
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
    this.host.opened = true
    this.dockActiveTabNote()
    if (this.host.activeTabId) recentVisits.recordBrowserTab(this.host.activeTabId)
  }

  /** The notes chord and the notes dock item both land here: it reveals the
   *  note tool, or hides the rail when the note tool is already the one shown. */
  toggleContextSidebar(): void {
    // The rail belongs to a tab: with nothing open there is no note to show, so
    // the chord does nothing rather than opening an empty panel.
    if (!this.host.activeTab) return
    if (this.host.contextSidebarTool === 'note' && this.host.contextSidebarVisible) {
      this.host.contextSidebarVisible = false
      return
    }
    this.host.showNoteSidebar()
  }

  /** Reveal the rail on the active tab's note. */
  showNoteSidebar(): void {
    if (!this.host.activeTab) return
    this.host.units['queries'].dismissNotifications()
    this.host.contextSidebarTool = 'note'
    this.host.contextSidebarVisible = true
    this.dockActiveTabNote()
  }

  /** Reveal the rail on the saved pages. */
  showBookmarksSidebar(): void {
    this.host.units['queries'].dismissNotifications()
    this.host.contextSidebarTool = 'bookmarks'
    this.host.contextSidebarVisible = true
  }

  toggleBookmarksSidebar(): void {
    if (this.host.contextSidebarTool === 'bookmarks' && this.host.contextSidebarVisible) {
      this.host.closeBookmarksSidebar()
      return
    }
    this.host.showBookmarksSidebar()
  }

  closeBookmarksSidebar(): void {
    if (this.host.contextSidebarTool === 'bookmarks') this.host.contextSidebarVisible = false
  }

  /**
   * Reveal the rail on the profile's boxes.
   *
   * Boxes belong to the browser rather than to a tab, like downloads do, so the
   * panel is reachable with the strip empty. That is also what makes it the tool
   * a user opens first, before any tab exists in a box.
   */
  showBoxesSidebar(): void {
    this.host.units['queries'].dismissNotifications()
    this.host.contextSidebarTool = 'boxes'
    this.host.contextSidebarVisible = true
  }

  toggleBoxesSidebar(): void {
    if (this.host.contextSidebarTool === 'boxes' && this.host.contextSidebarVisible) {
      this.host.closeBoxesSidebar()
      return
    }
    this.host.showBoxesSidebar()
  }

  closeBoxesSidebar(): void {
    if (this.host.contextSidebarTool === 'boxes') this.host.contextSidebarVisible = false
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
    this.host.units['queries'].dismissNotifications()
    this.host.contextSidebarTool = 'extensions'
    this.host.contextSidebarVisible = true
  }

  toggleExtensionsSidebar(): void {
    if (this.host.contextSidebarTool === 'extensions' && this.host.contextSidebarVisible) {
      this.host.closeExtensionsSidebar()
      return
    }
    this.host.showExtensionsSidebar()
  }

  closeExtensionsSidebar(): void {
    if (this.host.contextSidebarTool === 'extensions') this.host.contextSidebarVisible = false
  }

  /** Reveal the rail on the active tab's agent conversation, creating it on the
   *  first open. A tab's conversation is a real chat thread of the reserved
   *  browser project, so it is created once and then kept until the user closes
   *  it (or closes the tab it belongs to). */
  showAgentSidebar(): void {
    browserAssistant.showConversation()
    const tab = this.host.activeTab
    if (!tab) return
    this.host.units['queries'].dismissNotifications()
    this.host.contextSidebarTool = 'agent'
    this.host.contextSidebarVisible = true
    void this.host.units['queries'].ensureAssistantChat(tab)
  }

  toggleAgentSidebar(): void {
    if (this.host.contextSidebarTool === 'agent' && this.host.contextSidebarVisible) {
      this.host.closeAgentSidebar()
      return
    }
    this.host.showAgentSidebar()
  }

  closeAgentSidebar(): void {
    if (this.host.contextSidebarTool === 'agent') this.host.contextSidebarVisible = false
  }

  /** The agent conversation bound to a browser tab, or null before its first
   *  open (or while the row behind its durable link is still being resolved). */
  agentChatFor(tabId: string): BrowserAssistantChat | null {
    return browserAssistant.chatForTab(tabId)
  }

  /**
   * The active tab moved. Owning this in one place is what keeps the rail's
   * note docked: the right rail always shows the note of whichever tab is on
   * screen, so that tab's note has to be created the moment it becomes active,
   * and only while the rail is actually shown. `ContextSidebar.ensureNoteTab`
   * is idempotent, so re-activating a tab costs nothing.
   */
  setActiveTab(tabId: string | null): void {
    // The address palette belongs to the tab it was opened for. Every way the
    // tab on screen can change   a row in the strip, a close that falls back, a
    // switcher, a popup revealing itself   lands here, so taking the palette
    // down here is what keeps it from hanging over a page it was not opened on.
    if (this.host.activeTabId !== tabId) this.host.closeAddressSpotlight()
    // Every activation, from any surface (strip, sidebar, switcher, a popup that
    // reveals itself), counts as a visit so the Ctrl+Tab switcher lists this tab
    // by the moment it was last used, exactly as it does a thread.
    if (tabId) recentVisits.recordBrowserTab(tabId)
    this.host.activeTabId = tabId
    this.dockActiveTabNote()
    // The rail follows the active tab: while the agent tool is shown, the new
    // tab's own conversation must be the one on screen. A tab the user has never
    // asked the agent about shows its start state instead of being given a
    // conversation nobody asked for; the rail's own action creates it.
    if (this.host.contextSidebarTool === 'popups') {
      // Popup windows belong to the browser, so changing tabs leaves the rail
      // open while any popup remains in its shared list.
      this.host.units['panels'].closePopupsWithNoWindows(
        this.host.units['panels'].hasOpenPopupWindows()
      )
    }
    if (this.host.contextSidebarTool === 'extension-side-panel') {
      // The same rule as popups: the panel belongs to one tab's visit, so moving
      // to a tab that holds none closes the rail rather than leaving an empty
      // frame over the new page.
      this.host.units['panels'].closeExtensionSidePanelWithNoPanels(
        this.host.units['panels'].activeTabHoldsExtensionSidePanel()
      )
    }
  }

  dockActiveTabNote(): void {
    if (!this.host.contextSidebarVisible) return
    const tab = this.host.activeTab
    if (!tab) return
    contextSidebarState.ensureNoteTab(GLOBAL_BROWSER_PROJECT_ID, tab.id, browserTabLabel(tab))
  }

  beginDrag(tabId: string): void {
    this.host.draggingTabId = tabId
  }

  endDrag(): void {
    this.host.draggingTabId = null
  }

  openAddressSpotlight(): void {
    this.host.addressSpotlightOpen = true
  }

  closeAddressSpotlight(): void {
    this.host.addressSpotlightOpen = false
  }

  /** Open a blank tab and put the caret in the address field, which is what a
   *  new tab is for. A box is named here, so the empty strip's new-tab menu can
   *  start a tab directly inside one. */
  openNewTabAddress(groupId?: string | null, boxId?: string | null): void {
    this.host.createTab('', groupId, boxId)
    this.host.addressSpotlightOpen = true
  }

  /** Open the shared search panel and reveal the sidebar containing its results. */
  openTabSearch(groupId: string | null = null): void {
    this.host.tabSearchGroupId = groupId
    this.host.tabSearchQuery = ''
    this.host.tabSearchOpen = true
    this.host.tabSearchFocusRequest += 1
    // Keep the filtered tab results visible while searching.
    sidebarState.redock()
  }

  closeTabSearch(): void {
    this.host.tabSearchOpen = false
    this.host.tabSearchQuery = ''
    this.host.tabSearchGroupId = null
  }

  setTabSearchQuery(query: string): void {
    this.host.tabSearchQuery = query
  }

  /** Drop the query and the group scope while leaving the field open, which is
   *  what the field's own clear control does. */
  clearTabSearch(): void {
    this.host.tabSearchQuery = ''
    this.host.tabSearchGroupId = null
  }

  toggleTabSearch(): void {
    if (this.host.tabSearchOpen) this.host.closeTabSearch()
    else this.host.openTabSearch()
  }

  /**
   * Place a tab the main process created beside the page that opened it, so a
   * link opened in a new tab lands next to the tab in use rather than after
   * every other row. A tab with no known source keeps the old end-of-strip
   * behaviour.
   */
  insertTabBeside(newTab: GlobalBrowserTab, sourceTabId?: string): GlobalBrowserTab[] {
    if (!sourceTabId) return [...this.host.tabs, newTab]
    const index = this.host.tabs.findIndex((candidate) => candidate.id === sourceTabId)
    if (index === -1) return [...this.host.tabs, newTab]
    const ordered = [...this.host.tabs]
    ordered.splice(index + 1, 0, newTab)
    return ordered
  }

  // ─── Tabs ─────────────────────────────────────────────────────────────────

  /** Open an address: focus the tab already showing it, otherwise create one.
   *  A named box scopes the match, so the same address in another jar opens its
   *  own tab rather than stealing the one already logged in elsewhere; with no
   *  box named, an open copy of the address is focused wherever it lives.
   *
   *  A page arriving with no box named is a link or an external open, not a tab
   *  opened beside another, so it starts in the profile's chosen default box
   *  instead of inheriting the box of whatever tab happens to be on screen. */
  open(
    url: string,
    groupId: string | null = null,
    boxId: string | null | undefined = undefined
  ): string {
    const existing = this.host.findTabByUrl(url, boxId ?? undefined)
    if (existing) {
      this.host.activate(existing.id)
      return existing.id
    }
    return this.host.createTab(url, groupId, boxId === undefined ? this.newTabBoxId() : boxId)
  }

  /**
   * Open an address in the tab on screen, or start the browser with a first tab when
   * there is none.
   *
   * This is what the address spotlight and a history row do: unlike
   * {@link open}, which is how a link arriving from a thread finds the tab already
   * showing it, these are the user saying "take me there now", so the page on screen
   * is the one that moves.
   */
  openInActiveTab(url: string): void {
    const tab = this.host.activeTab
    if (!tab) {
      this.host.createTab(url)
      return
    }
    // A tab with no address yet takes the address it was just told to load, at
    // once: the row stops reading "New Tab", the empty state ends, and coming
    // back to this tab while the page is still loading no longer looks like a
    // tab that was never given an address.
    if (isBlankBrowserAddress(tab.url)) {
      tab.url = url
      tab.title = browserTabTitleForUrl(url)
      this.host.units['queries'].persist()
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
   * `boxId` names the jar the tab runs in, or null for the profile's own. `anchor`
   * places the new row before or after an existing tab and, when no group or box
   * is named, inherits both from that tab, which keeps "new tab here" a one-click
   * gesture that lands beside the page it came from.
   *
   * With no box named and no tab to inherit from at all   the browser's first tab,
   * an external open   the tab starts in the profile's chosen default box. That
   * fallback is the global browser's alone: a thread browser never reaches this
   * store, so a thread tab with nothing to inherit stays in the thread's own jar.
   */
  createTab(
    url: string,
    groupId: string | null | undefined = undefined,
    boxId: string | null | undefined = undefined,
    anchor: { tabId: string; position: 'before' | 'after' } | null = null
  ): string {
    this.enforceTabCap()
    const anchorTab = anchor ? this.host.tabById(anchor.tabId) : this.host.activeTab
    const targetGroupId = groupId === undefined ? (anchorTab?.groupId ?? null) : groupId
    const targetBoxId =
      boxId !== undefined ? boxId : anchorTab ? anchorTab.boxId : this.newTabBoxId()
    const now = Date.now()
    const tab: GlobalBrowserTab = {
      id: `browser:${crypto.randomUUID()}`,
      title: browserTabTitleForUrl(url),
      customTitle: null,
      url,
      favicon: null,
      groupId: this.host.groups.some((group) => group.id === targetGroupId) ? targetGroupId : null,
      boxId: this.host.boxes.some((box) => box.id === targetBoxId) ? targetBoxId : null,
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
      const index = this.host.tabs.findIndex((candidate) => candidate.id === anchorTab.id)
      const at = anchor?.position === 'before' ? index : index + 1
      const ordered = [...this.host.tabs]
      ordered.splice(at, 0, tab)
      this.host.tabs = ordered
    } else {
      this.host.tabs = [...this.host.tabs, tab]
    }
    this.setActiveTab(tab.id)
    this.host.units['queries'].persist()
    return tab.id
  }

  /** Duplicate a tab beside its source, carrying its address and appearance. */
  duplicateTab(tabId: string): string | null {
    const source = this.host.tabById(tabId)
    if (!source) return null
    const duplicateId = this.host.createTab(source.url, source.groupId, source.boxId, {
      tabId,
      position: 'after'
    })
    this.host.updateTab(duplicateId, {
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
    const index = this.host.tabs.findIndex((candidate) => candidate.id === tabId)
    if (index < 0) return null
    const tab = this.host.tabs[index]
    if (tab.boxId === boxId) return null
    const url = tab.url
    const groupId = tab.groupId
    const appearance = {
      customTitle: tab.customTitle,
      color: tab.color,
      iconType: tab.iconType,
      customSvg: tab.customSvg,
      imagePath: tab.imagePath
    }
    const pinned = tab.pinned
    const pinnedAt = tab.pinnedAt
    // Not a reopenable close: the page is deliberately coming back in another
    // box, so recording it would offer the user a tab that never left.
    // No focus handover for the tab in between: the new tab takes it below.
    this.host.close(tabId, { recordForReopen: false, focusNeighbour: false })
    const nextId = this.host.createTab(url, groupId, boxId)
    this.host.updateTab(nextId, appearance)
    if (pinned) this.host.updateTab(nextId, { pinned, pinnedAt })
    // A reopen is a replacement, not a new row: the tab keeps the position of
    // the page it replaces instead of moving to the end of the strip.
    const currentIndex = this.host.tabs.findIndex((candidate) => candidate.id === nextId)
    if (currentIndex >= 0 && currentIndex !== Math.min(index, this.host.tabs.length - 1)) {
      const ordered = [...this.host.tabs]
      const [replacement] = ordered.splice(currentIndex, 1)
      ordered.splice(Math.min(index, ordered.length), 0, replacement)
      this.host.tabs = ordered
      this.host.units['queries'].persist()
    }
    if (!isBlankBrowserAddress(url)) {
      void invoke('browser:focusPage', nextId).catch(() => {})
    }
    return nextId
  }

  /**
   * Close a tab and land on its neighbour in the strip.
   *
   * A close the user asked for is remembered so `reopenLastClosedTab` can undo
   * it, which is what `recordForReopen` opts a caller out of. A close that is
   * really a replacement (a reopen in another box) or an eviction has no tab to
   * bring back, so recording it would only push a phantom onto the reopen stack.
   */
  close(
    tabId: string,
    options: { recordForReopen?: boolean; focusNeighbour?: boolean } = {}
  ): void {
    const index = this.host.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    const closing = this.host.tabs[index]
    // The strip order must be read before the tab is removed. It is derived from
    // `this.host.tabs`, so once the closing tab is gone its row position cannot be
    // found there, and a lookup after the removal resolves to nothing. The strip
    // order is what "the previous tab" means   the stored list order is not it,
    // because a grouped tab keeps its stored index while its row moves into the
    // fold, so a pinned or grouped row would otherwise move the landing tab.
    const stripBeforeClose = this.host.stripOrder
    const visualIndex = stripBeforeClose.findIndex((tab) => tab.id === tabId)
    const visuallyRemaining = stripBeforeClose.filter((tab) => tab.id !== tabId)
    this.host.closeSourcePeek(tabId)
    if (options.recordForReopen !== false) this.rememberClosedTab(closing, index)
    // The tab can never be switched to again, so its Ctrl+Tab visit goes with it
    // instead of holding a slot in the recency list.
    recentVisits.forgetBrowserTab(tabId)
    const closedThreadId = closing.assistantThreadId
    const remaining = this.host.tabs.filter((tab) => tab.id !== tabId)
    this.host.tabs = remaining
    this.host.runtime.delete(tabId)
    browserAudio.forget(tabId)
    this.host.tabFavicons.forget(tabId)
    if (this.host.activeTabId === tabId) {
      // Closing the active tab lands on the previous tab of the strip order,
      // not the next one, so focus moves back through the tabs as the user
      // sees them. Closing the first row has no previous, so it falls through
      // to what is now first; only a strip with nothing left lands on the
      // empty state.
      const neighbour =
        visuallyRemaining[visualIndex - 1] ??
        visuallyRemaining[Math.min(Math.max(visualIndex, 0), visuallyRemaining.length - 1)]
      this.setActiveTab(neighbour?.id ?? null)
      if (neighbour) {
        neighbour.lastUsedAt = Date.now()
        // The page held the keyboard through the native view, which dies with
        // the tab: hand it to the tab landing on screen so a repeated close
        // (or an undo) still reaches the browser instead of breaking the flow.
        // A blank tab has no page, so there is nothing to hand over. A close
        // that is really a step toward another tab (a reopen in another box)
        // opts out and hands over to its own target instead.
        if (options.focusNeighbour !== false && !isBlankBrowserAddress(neighbour.url)) {
          void invoke('browser:focusPage', neighbour.id).catch(() => {})
        }
      }
    }
    if (this.host.tabs.length === 0 && !this.host.railToolNeedsNoTab) {
      // With no tab left the note and agent tools have no subject, so the rail
      // returns to its closed default instead of lingering for the next tab.
      // The library tools need no tab, so they stay open.
      this.host.contextSidebarVisible = false
    }
    this.host.units['queries'].persist()
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
    this.host.units['queries'].closeAssistantChatFor(tabId, closedThreadId)
  }

  /**
   * Remember a tab just closed so it can be reopened.
   *
   * The tab is cloned, so later edits to the strip cannot reach back into the
   * stack, and the oldest entry falls off the end once the cap is reached. This
   * stack is memory-only by design: nothing here is written to the durable tab
   * list, so quitting the app forgets it exactly as a browser does.
   */
  rememberClosedTab(tab: GlobalBrowserTab, index: number): void {
    const entry: ClosedGlobalBrowserTab = { tab: { ...tab }, index }
    const next = [...this.host.closedTabs, entry]
    this.host.closedTabs = next.slice(Math.max(0, next.length - MAX_REOPENED_BROWSER_TABS))
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
    const entry = this.host.closedTabs[this.host.closedTabs.length - 1]
    if (!entry) return null
    this.host.closedTabs = this.host.closedTabs.slice(0, -1)
    const restored: GlobalBrowserTab = {
      ...entry.tab,
      groupId:
        entry.tab.groupId !== null &&
        this.host.groups.some((group) => group.id === entry.tab.groupId)
          ? entry.tab.groupId
          : null,
      boxId:
        entry.tab.boxId !== null && this.host.boxes.some((box) => box.id === entry.tab.boxId)
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
    const ordered = [...this.host.tabs]
    ordered.splice(Math.min(entry.index, ordered.length), 0, restored)
    this.host.tabs = ordered
    this.setActiveTab(restored.id)
    this.host.units['queries'].persist()
    // The reopened page takes the keyboard back, so repeated undos keep
    // reaching the browser. A blank tab has no page to hand it to.
    if (!isBlankBrowserAddress(restored.url)) {
      void invoke('browser:focusPage', restored.id).catch(() => {})
    }
    return restored.id
  }

  moveToGroup(tabId: string, groupId: string | null): void {
    const tab = this.host.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    const target = this.host.groups.some((group) => group.id === groupId) ? groupId : null
    if (tab.groupId === target) return
    tab.groupId = target
    this.host.units['queries'].persist()
  }

  /** Move several tabs into one group and persist the change once. */
  moveTabsToGroup(tabIds: readonly string[], groupId: string | null): void {
    const target = this.host.groups.some((group) => group.id === groupId) ? groupId : null
    const selectedIds = new SvelteSet(tabIds)
    let changed = false
    for (const tab of this.host.tabs) {
      if (!selectedIds.has(tab.id) || tab.groupId === target) continue
      tab.groupId = target
      changed = true
    }
    if (changed) this.host.units['queries'].persist()
  }

  /** Move a tab beside another, within the strip. */
  reorder(tabId: string, targetId: string, position: 'before' | 'after'): void {
    const from = this.host.tabs.findIndex((tab) => tab.id === tabId)
    if (from < 0 || tabId === targetId) return
    const ordered = [...this.host.tabs]
    const [moved] = ordered.splice(from, 1)
    const target = ordered.findIndex((tab) => tab.id === targetId)
    if (target < 0) return
    // A drop beside a grouped tab adopts that tab's group, which is what makes
    // dragging a tab into a fold work without a separate drop target.
    moved.groupId = ordered[target].groupId
    ordered.splice(position === 'before' ? target : target + 1, 0, moved)
    this.host.tabs = ordered
    this.host.units['queries'].persist()
  }

  // ─── Tab identity and pinning ─────────────────────────────────────────────

  /**
   * Edit a tab's own identity: a custom label and the appearance it shares with
   * a project (colour, icon, pasted SVG, picked image). A blank title clears the
   * override, so the strip returns to the page's live title.
   */
  updateTab(id: string, patch: Partial<Omit<GlobalBrowserTab, 'id'>>): void {
    const tab = this.host.tabs.find((candidate) => candidate.id === id)
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
    this.host.units['queries'].persist()
    // The rail's note is titled with the tab's label, so a rename follows.
    this.dockActiveTabNote()
    if (imageChanged) {
      this.host.tabIconUrls.delete(id)
      void this.host.ensureTabIconLoaded(id)
    }
  }

  /** Pin a tab to the top of the strip, or unpin it. Pin order is preserved so
   *  the pinned block does not reshuffle on every toggle. */
  toggleTabPin(tabId: string): void {
    const tab = this.host.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    tab.pinned = !tab.pinned
    tab.pinnedAt = tab.pinned ? Date.now() : null
    this.host.units['queries'].persist()
  }

  /** The loaded data URL for a tab's picked image icon, when there is one. */
  tabIconUrl(tabId: string): string | null {
    return this.host.tabIconUrls.get(tabId) ?? null
  }

  // ─── Groups ───────────────────────────────────────────────────────────────

  createGroup(
    name: string,
    appearance: Partial<BrowserGroupAppearance> = {},
    description = ''
  ): string {
    const id = `group:${crypto.randomUUID()}`
    if (this.host.groups.length >= MAX_GLOBAL_BROWSER_GROUPS) return id
    this.host.groups = [
      ...this.host.groups,
      {
        id,
        name: name.trim().slice(0, MAX_BROWSER_GROUP_NAME_LENGTH) || 'New group',
        description: description.trim(),
        pinned: false,
        collapsed: false,
        color: appearance.color ?? null,
        iconType: appearance.iconType ?? null,
        customSvg: appearance.customSvg ?? null,
        imagePath: appearance.imagePath ?? null
      }
    ]
    this.host.units['queries'].persist()
    return id
  }

  updateGroup(id: string, patch: Partial<Omit<GlobalBrowserGroup, 'id'>>): void {
    const group = this.host.groups.find((candidate) => candidate.id === id)
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
    this.host.units['queries'].persist()
    // A new or cleared image must not keep showing the previous one's bytes.
    if (patch.imagePath !== undefined) {
      this.host.groupIconUrls.delete(id)
      void this.host.ensureGroupIconLoaded(id)
    }
  }

  /** Remove a group. Its tabs stay open and become ungrouped, because losing a
   *  fold must never silently close the pages inside it. */
  deleteGroup(id: string): void {
    if (!this.host.groups.some((group) => group.id === id)) return
    this.host.groups = this.host.groups.filter((group) => group.id !== id)
    this.host.groupIconUrls.delete(id)
    for (const tab of this.host.tabs) {
      if (tab.groupId === id) tab.groupId = null
    }
    this.host.units['queries'].persist()
  }

  /** Fold a group without changing the active tab or loading its pages. */
  toggleGroupCollapsed(groupId: string): void {
    const group = this.host.groupById(groupId)
    if (!group) return
    group.collapsed = !group.collapsed
    this.host.units['queries'].persist()
  }

  reorderGroup(groupId: string, targetId: string, position: 'before' | 'after'): void {
    if (groupId === targetId) return
    const group = this.host.groupById(groupId)
    const target = this.host.groupById(targetId)
    if (!group || !target) return
    group.pinned = target.pinned
    const ordered = this.host.groups.filter((candidate) => candidate.id !== groupId)
    const index = ordered.findIndex((candidate) => candidate.id === targetId)
    ordered.splice(index + (position === 'after' ? 1 : 0), 0, group)
    this.host.groups = ordered
    this.host.units['queries'].persist()
  }

  /** Pin a fold to the top of the strip, or unpin it. */
  toggleGroupPin(groupId: string): void {
    const group = this.host.groupById(groupId)
    if (!group) return
    group.pinned = !group.pinned
    this.host.units['queries'].persist()
  }

  // ─── Boxes ────────────────────────────────────────────────────────────────

  /** Create a box and return its id. The cap is enforced the way the group cap
   *  is: at the limit the call is a no-op that returns an unusable id, so a caller
   *  cannot keep making partitions without bound. */
  createBox(name: string, appearance: Partial<BrowserBoxAppearance> = {}): string {
    const id = `box:${crypto.randomUUID()}`
    // The default box is not one of the user's, so it does not count against the
    // cap the user's own boxes obey: it exists whether they make any or not.
    const userBoxCount = this.host.boxes.filter((box) => box.id !== DEFAULT_BOX_ID).length
    if (userBoxCount >= MAX_GLOBAL_BROWSER_BOXES) return id
    this.host.boxes = withDefaultBox([
      ...this.host.boxes,
      {
        id,
        name: name.trim().slice(0, MAX_BROWSER_BOX_NAME_LENGTH) || 'New box',
        color: appearance.color ?? null,
        iconType: appearance.iconType ?? null,
        customSvg: appearance.customSvg ?? null,
        imagePath: appearance.imagePath ?? null
      }
    ])
    this.host.units['queries'].persist()
    if (appearance.imagePath) void this.host.ensureBoxIconLoaded(id)
    return id
  }

  updateBox(id: string, patch: Partial<Omit<GlobalBrowserBox, 'id'>>): void {
    const box = this.host.boxById(id)
    if (!box) return
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, MAX_BROWSER_BOX_NAME_LENGTH)
      if (name) box.name = name
    }
    if (patch.color !== undefined) box.color = patch.color
    if (patch.iconType !== undefined) box.iconType = patch.iconType
    if (patch.customSvg !== undefined) box.customSvg = patch.customSvg
    if (patch.imagePath !== undefined) box.imagePath = patch.imagePath
    this.host.units['queries'].persist()
    if (patch.imagePath !== undefined) {
      this.host.boxIconUrls.delete(id)
      void this.host.ensureBoxIconLoaded(id)
    }
  }

  /**
   * Choose the box a brand-new global-browser tab starts in.
   *
   * This is the box a tab with nothing to inherit lands in   the first tab, an
   * external open, a link   so it is the profile's answer to "where do my new
   * tabs go", not a thread's. A box the profile does not offer is ignored rather
   * than stored, because a default that names nothing would silently start tabs in
   * the wrong jar.
   */
  setDefaultBox(boxId: string): void {
    if (boxId !== DEFAULT_BOX_ID && !this.host.boxById(boxId)) return
    if (this.host.defaultBoxId === boxId) return
    this.host.defaultBoxId = boxId
    this.host.defaultBoxChosen = true
    this.host.units['queries'].persist()
  }

  /**
   * The jar a new global-browser tab starts in when it has no tab to inherit.
   *
   * The profile's own box is its own jar, which main names as no box, so the
   * chosen default goes through `jarIdForBox` before it reaches a tab. Only the
   * global browser reads this; a thread browser falls back to the thread's jar.
   */
  newTabBoxId(): string | null {
    return jarIdForBox(this.host.defaultBoxId)
  }

  /** How many tabs currently run in a jar. The argument is a jar id, not a box id:
   *  the default box's jar is the absent id, so pass it through `jarIdForBox`. */
  tabCountInBox(jarId: string | null): number {
    return this.host.tabs.filter((tab) => tab.boxId === jarId).length
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
    if (!this.host.boxes.some((box) => box.id === id)) return
    for (const tab of this.host.tabs.filter((candidate) => candidate.boxId === id)) {
      // The box is being removed, so a reopen would have no jar to restore into.
      this.host.close(tab.id, { recordForReopen: false })
    }
    this.host.boxes = this.host.boxes.filter((box) => box.id !== id)
    this.host.boxIconUrls.delete(id)
    // A default box that no longer exists would start new tabs in a jar nothing
    // owns, so the profile's own box takes it back.
    if (this.host.defaultBoxId === id) this.host.defaultBoxId = DEFAULT_BOX_ID
    this.host.units['queries'].persist()
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
    const favicon = await this.host.tabFavicons.resolve(tabId, () => this.host.tabById(tabId))
    const tab = this.host.tabById(tabId)
    if (favicon === null || !tab || tab.favicon !== null) return
    tab.favicon = favicon
    this.host.units['queries'].persist()
  }

  /** Toggle one tab's audio output, optimistically so the indicator answers the
   *  click immediately. Main's published state stays the source of truth. */
  toggleMute(tabId: string): void {
    const current = this.host.runtimeFor(tabId)
    const muted = !current.muted
    this.host.runtime.set(tabId, { ...current, muted })
    // Mirror the optimistic mute here too, so the Browser rail item stops saying
    // the profile is playing the moment the user silences the tab, without
    // waiting for main to publish the same state back.
    browserAudio.reportGlobalTab(tabId, current.audible && !muted)
    void invoke('browser:setMuted', tabId, muted).catch((error: unknown) => {
      const latest = this.host.runtime.get(tabId)
      if (latest?.muted === muted) this.host.runtime.set(tabId, { ...latest, muted: current.muted })
      reportError(
        error,
        muted ? 'Tab audio could not be muted.' : 'Tab audio could not be unmuted.'
      )
    })
  }

  /**
   * Release one tab's page now, keeping its row in the strip.
   *
   * The idle sweep's own move, available on demand from the tab's menu. Which
   * tabs may be released is `canHibernateTab`'s answer and nobody else's, so the
   * menu, this method and the sweep can never disagree about it.
   */
  hibernate(tabId: string): boolean {
    const tab = this.host.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || !canHibernateTab(tab, this.host.activeTabId)) return false
    this.releasePage(tab)
    return true
  }

  /**
   * Drop a tab's live page and write the change down.
   *
   * Only the page is released: the row stays in the strip, so main writes the
   * tab's stack down before the view goes and the next visit restores it.
   */
  releasePage(tab: GlobalBrowserTab): void {
    tab.hibernated = true
    this.host.runtime.delete(tab.id)
    browserAudio.forget(tab.id)
    void invoke('browser:destroy', tab.id, 'hibernated').catch(() => {})
    this.host.units['queries'].persist()
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
    const windowMs = this.host.hibernationWindowMs
    // A sweep that released nothing touches nothing: the write lives inside
    // `releasePage`, so the minute-long clock never rewrites the file for its own
    // sake and a run of releases coalesces into one write.
    for (const tab of this.host.tabs) {
      if (tab.id === this.host.activeTabId) continue
      const runtime = this.host.runtimeFor(tab.id)
      if (runtime.audible && !runtime.muted) continue
      if (runtime.capturing) continue
      if (!isTabIdlePastWindow(tab, now, windowMs)) continue
      this.releasePage(tab)
    }
  }

  /** Close the oldest idle tabs when the strip is at its cap. A pinned tab is
   *  spared the way a pinned thread survives cleanup, so the cap only ever hits
   *  unpinned tabs unless nothing else is left. */
  enforceTabCap(): void {
    if (this.host.tabs.length < MAX_GLOBAL_BROWSER_TABS) return
    const closable = this.host.tabs.filter((tab) => tab.id !== this.host.activeTabId && !tab.pinned)
    const victim =
      [...closable].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0] ??
      [...this.host.tabs]
        .filter((tab) => tab.id !== this.host.activeTabId)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
    if (victim) this.host.close(victim.id, { recordForReopen: false })
    if (this.host.tabs.length >= MAX_GLOBAL_BROWSER_TABS) {
      // Nothing left that may be closed without touching the active tab.
      reportError(new Error('Browser tab limit reached'), 'Too many browser tabs are open.')
    }
  }

  /** The strip in its stored shape. */
  snapshot(): GlobalBrowserTabsSnapshot {
    return globalBrowserTabsSnapshot(
      this.host.tabs,
      this.host.groups,
      this.host.boxes,
      this.host.activeTabId,
      this.host.defaultBoxId
    )
  }

  async saveStoredTabs(): Promise<void> {
    try {
      await saveStoredGlobalBrowserTabs(this.host.snapshot())
    } catch (error) {
      reportError(error, 'The browser tabs could not be saved.')
    }
  }

  /** Write the coalesced change now, for a quit that is about to end the process. */
  flushPendingSave(): void {
    if (this.host.saveTimer === null) return
    window.clearTimeout(this.host.saveTimer)
    this.host.saveTimer = null
    void this.saveStoredTabs()
  }
}
