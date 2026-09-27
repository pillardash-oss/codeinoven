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

import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { BrowserOpenRequestContext, BrowserPageState } from '$shared/ipc-contract'
import { GLOBAL_BROWSER_PROJECT_ID, GLOBAL_BROWSER_THREAD_ID } from '$shared/ipc-contract'
import { appConfigState } from './app-config.svelte'
import { reportError } from './app-errors.svelte'
import {
  loadGlobalBrowserSnapshot,
  persistGlobalBrowserSnapshot,
  type GlobalBrowserSnapshot
} from './global-browser-persistence'
import {
  IDLE_GLOBAL_BROWSER_RUNTIME,
  MAX_BROWSER_GROUP_NAME_LENGTH,
  MAX_BROWSER_TAB_NOTE_LENGTH,
  MAX_GLOBAL_BROWSER_GROUPS,
  MAX_GLOBAL_BROWSER_TABS,
  browserTabTitleForUrl,
  isBrowserGroupIconId,
  isTabIdlePastWindow,
  type BrowserGroupIconId,
  type GlobalBrowserGroup,
  type GlobalBrowserRuntime,
  type GlobalBrowserTab
} from './global-browser-types'

/** How often the idle sweep runs. One coarse check a minute is enough to keep
 *  the promise "a tab idle for the configured window hibernates", and it costs
 *  nothing between sweeps. */
const HIBERNATION_SWEEP_INTERVAL_MS = 60_000

export class GlobalBrowserState {
  tabs: GlobalBrowserTab[] = $state([])
  groups: GlobalBrowserGroup[] = $state([])
  activeTabId: string | null = $state(null)
  /** True once the browser view has been opened at least once this session. */
  opened = $state(false)
  /** Whether the left sidebar (browser chrome and tab strip) is shown. Hiding
   *  it is how the user gets an uninterrupted page. */
  sidebarVisible = $state(true)
  /** Whether the right rail (per-tab notes) is shown. It is a tab-scoped
   *  context rail, so it is independent of the strip's own visibility. */
  contextSidebarVisible = $state(true)
  /** Whether the address spotlight is up. It lives here rather than in a surface
   *  because it is summoned from anywhere in the browser view (Cmd/Ctrl+L) and
   *  from a freshly opened tab, which has no surface of its own yet. */
  addressSpotlightOpen = $state(false)
  /** The tab currently being dragged in the strip, or null. It lives in the
   *  store because the drop targets (group headers, other rows) are siblings of
   *  the dragged row, so the drag has to be visible outside the row's own scope. */
  draggingTabId: string | null = $state(null)

  private readonly runtime = new SvelteMap<string, GlobalBrowserRuntime>()
  private sweepTimer: number | null = null

  constructor(snapshot: GlobalBrowserSnapshot = loadGlobalBrowserSnapshot()) {
    this.tabs = snapshot.tabs
    this.groups = snapshot.groups
    this.activeTabId = snapshot.activeTabId
    // One app-lifetime subscription keeps every tab's runtime state current,
    // including tabs with no surface mounted: a background tab that starts
    // playing audio must still light up its indicator in the strip.
    subscribe('browser:state', (state) => this.applyPageState(state))
    // A page that opens a window (an OAuth redirect, a wallet popup, a site's
    // own "open in new window") is routed by main into a new tab under this same
    // reserved context, so the strip adopts it instead of losing it.
    subscribe('browser:openRequested', (url, context) => this.adoptOpenRequest(url, context))
    if (typeof window !== 'undefined') {
      this.sweepTimer = window.setInterval(
        () => this.sweepIdleTabs(),
        HIBERNATION_SWEEP_INTERVAL_MS
      )
    }
  }

  /** Release the sweep timer. The store lives for the renderer's lifetime, so
   *  this exists for tests and a deliberate teardown rather than normal use. */
  dispose(): void {
    if (this.sweepTimer !== null) window.clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  get activeTab(): GlobalBrowserTab | null {
    if (!this.activeTabId) return null
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null
  }

  /** Tabs of one group, in strip order. A null group means the ungrouped rest. */
  tabsInGroup(groupId: string | null): GlobalBrowserTab[] {
    return this.tabs.filter((tab) => tab.groupId === groupId)
  }

  groupById(groupId: string): GlobalBrowserGroup | null {
    return this.groups.find((group) => group.id === groupId) ?? null
  }

  /** Live runtime of one tab, or the shared idle value while main has reported
   *  nothing for it. */
  runtimeFor(tabId: string): GlobalBrowserRuntime {
    return this.runtime.get(tabId) ?? IDLE_GLOBAL_BROWSER_RUNTIME
  }

  /** Whether a browser tab with this address is already open. A blank address
   *  never matches, so "new tab" always makes a new one. */
  findTabByUrl(url: string): GlobalBrowserTab | null {
    if (url === '') return null
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
    this.activeTabId = tabId
    tab.lastUsedAt = Date.now()
    if (tab.hibernated) tab.hibernated = false
    this.persist()
  }

  /** Mark the workspace as opened, so the first activation can reveal a tab. */
  markOpened(): void {
    this.opened = true
  }

  toggleSidebar(): void {
    this.sidebarVisible = !this.sidebarVisible
  }

  toggleContextSidebar(): void {
    this.contextSidebarVisible = !this.contextSidebarVisible
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
        url,
        favicon: null,
        // A popup belongs beside the page that opened it.
        groupId: this.activeTab?.groupId ?? null,
        createdAt: now,
        lastUsedAt: now,
        hibernated: false,
        note: ''
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
      url,
      favicon: null,
      groupId: this.groups.some((group) => group.id === groupId) ? groupId : null,
      createdAt: now,
      lastUsedAt: now,
      hibernated: false,
      note: ''
    }
    this.tabs = [...this.tabs, tab]
    this.activeTabId = tab.id
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
      this.activeTabId = neighbour?.id ?? null
      if (neighbour) neighbour.lastUsedAt = Date.now()
    }
    this.persist()
    void invoke('browser:destroy', tabId).catch(() => {})
  }

  /** Record the user's context note for a tab. The note travels with the tab
   *  through hibernation, group moves and restarts, because it is the reason the
   *  tab exists in the user's head rather than the page's. */
  setNote(tabId: string, note: string): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    const bounded = note.slice(0, MAX_BROWSER_TAB_NOTE_LENGTH)
    if (tab.note === bounded) return
    tab.note = bounded
    this.persist()
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

  // ─── Groups ───────────────────────────────────────────────────────────────

  createGroup(name: string, color: string, icon: BrowserGroupIconId | null): string {
    const id = `group:${crypto.randomUUID()}`
    if (this.groups.length >= MAX_GLOBAL_BROWSER_GROUPS) return id
    this.groups = [
      ...this.groups,
      {
        id,
        name: name.trim().slice(0, MAX_BROWSER_GROUP_NAME_LENGTH) || 'New group',
        color,
        icon: icon && isBrowserGroupIconId(icon) ? icon : null
      }
    ]
    this.persist()
    return id
  }

  updateGroup(id: string, patch: Partial<Omit<GlobalBrowserGroup, 'id'>>): void {
    const group = this.groups.find((candidate) => candidate.id === id)
    if (!group) return
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, MAX_BROWSER_GROUP_NAME_LENGTH)
      if (name) group.name = name
    }
    if (patch.color !== undefined) group.color = patch.color
    if (patch.icon !== undefined) {
      group.icon = patch.icon && isBrowserGroupIconId(patch.icon) ? patch.icon : null
    }
    this.persist()
  }

  /** Remove a group. Its tabs stay open and become ungrouped, because losing a
   *  fold must never silently close the pages inside it. */
  deleteGroup(id: string): void {
    if (!this.groups.some((group) => group.id === id)) return
    this.groups = this.groups.filter((group) => group.id !== id)
    for (const tab of this.tabs) {
      if (tab.groupId === id) tab.groupId = null
    }
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
    for (const tab of this.tabs) {
      if (tab.id === this.activeTabId) continue
      if (tab.url === '') continue
      const runtime = this.runtimeFor(tab.id)
      if (runtime.audible && !runtime.muted) continue
      if (runtime.capturing) continue
      if (!isTabIdlePastWindow(tab, now, windowMs)) continue
      tab.hibernated = true
      this.runtime.delete(tab.id)
      void invoke('browser:destroy', tab.id).catch(() => {})
    }
    this.persist()
  }

  /** Close the oldest idle tabs when the strip is at its cap. */
  private enforceTabCap(): void {
    if (this.tabs.length < MAX_GLOBAL_BROWSER_TABS) return
    const victim = [...this.tabs]
      .filter((tab) => tab.id !== this.activeTabId)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
    if (victim) this.close(victim.id)
    if (this.tabs.length >= MAX_GLOBAL_BROWSER_TABS) {
      // Nothing left that may be closed without touching the active tab.
      reportError(new Error('Browser tab limit reached'), 'Too many browser tabs are open.')
    }
  }

  private persist(): void {
    persistGlobalBrowserSnapshot({
      tabs: this.tabs,
      groups: this.groups,
      activeTabId: this.activeTabId
    })
  }
}

export const globalBrowser = new GlobalBrowserState()

/** The reserved ownership context every global tab is created under. */
export const GLOBAL_BROWSER_CONTEXT = {
  projectId: GLOBAL_BROWSER_PROJECT_ID,
  threadId: GLOBAL_BROWSER_THREAD_ID
} as const
