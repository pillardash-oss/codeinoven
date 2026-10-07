import { SvelteMap } from 'svelte/reactivity'
import { isConversationContainer } from '$shared/types'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { BrowserPageState } from '$shared/ipc-contract'
import { isStorableBrowserFavicon } from '$shared/browser/global-browser-tabs'
import { reportError } from './app-errors.svelte'
import { BrowserTabFavicons } from './browser-tab-favicon'
import { loadPersistedBrowserTabs, persistBrowserTabs } from './context-sidebar-persistence'
import { browserHistory } from './browser-history.svelte'
import { threadBrowserTabs } from './thread-browser-tabs.svelte'
import type { BrowserContextTab } from './context-sidebar-types'
import { MAX_REOPENED_BROWSER_TABS } from './global-browser-types'
import { IDLE_BROWSER_TAB_RUNTIME, type BrowserTabRuntime } from './browser-tab-status'

const EMPTY_BROWSER_TABS: BrowserContextTab[] = []

/** One thread-browser tab closed this session, kept for a reopen of its own
 *  conversation. `scopeId` is the conversation it belonged to, so a reopen only
 *  reaches the browser that is on screen. */
interface ClosedSidebarBrowserTab {
  tab: BrowserContextTab
  index: number
  scopeId: string
}

/**
 * How long a change to the sidebar's tab list waits before it is written.
 *
 * A page reports its title, its address and its icon as it loads, so a single
 * navigation is a burst of changes, and the list is written to renderer storage
 * with a synchronous write. One write per burst keeps that off the loading path,
 * and the size of the list makes it worth doing: with the tabs' own icons in it a
 * write is no longer a few kilobytes. A quit flushes the pending write outright,
 * so the delay can never lose what the user had.
 */
const TAB_SAVE_COALESCE_MS = 400

/**
 * The persisted browser tab list, parsed on first use.
 *
 * Reading it is synchronous: a JSON parse of up to fifty tabs out of
 * `localStorage`. Doing that at module load put it on the first-paint path, so
 * it is deferred to the moment the sidebar's browser tabs are actually wired
 * (see `SidebarBrowserTabs.start`).
 */
let persistedBrowserTabs: { tabs: BrowserContextTab[]; activeTabId: string | null } | null = null

function restoredBrowserTabs(): { tabs: BrowserContextTab[]; activeTabId: string | null } {
  persistedBrowserTabs ??= loadPersistedBrowserTabs()
  return persistedBrowserTabs
}

/**
 * Host access the browser-tabs controller needs from the sidebar store.
 * The controller owns the browser tab list and its visibility; the store owns
 * the active project/thread and the notifications flag.
 */
export interface SidebarBrowserTabsHost {
  activeProjectId(): string | null
  activeThreadId(): string | null
  /**
   * The conversation a thread's browser tabs belong to (see
   * `conversationScopeId`). The sidebar store holds no thread rows, so the
   * workspace resolves this one identity: a routine's threads share the routine,
   * a standalone chat or routine-less task owns its own, a project's threads
   * share the project.
   */
  threadScopeId(projectId: string, threadId: string): string
  clearNotifications(): void
}

/**
 * Browser tabs docked in the sidebar. Owns the tab list, the remembered active
 * tab, and visibility, plus persistence and the native view detach. Conversation
 * scoping is resolved through the host, so the store never reads thread rows and
 * stays the active-identity owner.
 */
export class SidebarBrowserTabs {
  tabs: BrowserContextTab[] = $state([])
  activeTabId: string | null = $state(null)
  visible = $state(false)
  /**
   * Thread-browser tabs closed this session, most recently closed last.
   *
   * A thread browser is scoped to a conversation, so each entry remembers the
   * scope it belonged to and a reopen only brings back a tab of the
   * conversation on screen. Memory-only: quitting the app clears it, exactly as
   * a browser's own reopen history is cleared.
   */
  private closedTabs: ClosedSidebarBrowserTab[] = $state([])

  /**
   * Whether {@link start} has restored the stored tabs and wired the runtime.
   * The sidebar's browser is not part of the first paint, so both the parse above
   * and the page-state subscription wait for the runtime seam.
   */
  private started = false

  /** Host access the controller needs, resolved by the sidebar store. */
  private readonly host: SidebarBrowserTabsHost

  constructor(host: SidebarBrowserTabsHost) {
    this.host = host
  }

  /** Live audio and capture state per tab, keyed by tab id. Main reports it
   *  through `browser:state` for every tab it owns, whether or not the tab is on
   *  screen, so this is the one place a tab strip can read it from. Runtime state
   *  is deliberately never persisted: it describes a live page, not the tab. */
  private readonly runtime = new SvelteMap<string, BrowserTabRuntime>()

  /**
   * The box a scope's next tabs are created in, keyed by conversation scope.
   *
   * Absent (or null) means the scope's own jar, which is where every scope
   * starts. A named box is the profile's one jar for that box rather than the
   * scope's own, so a tab created in it shares the box's cookies and logins with
   * every other context that picks it. The choice lives for the sidebar session
   * only and is deliberately not persisted: a scope reverts to its own box once
   * its last tab is closed, so reopening the thread browser starts from the scope
   * again. Tabs already on screen keep the box they were created in, because a jar
   * cannot be migrated.
   */
  private readonly scopeBoxChoices = new SvelteMap<string, string | null>()

  /** Fills in the icon of a tab the app has no page for, from the tab's own
   *  address (see {@link ensureFavicon}). */
  private readonly tabFavicons = new BrowserTabFavicons()

  /** The coalesced write still waiting to leave, or null. */
  private saveTimer: number | null = null

  /** Restore the stored tabs and wire the runtime's subscription. Idempotent.
   *
   * The stored list only lands while the strip is still empty: a tab the user
   * created before this ran is theirs, and must not be replaced by what was on
   * disk. */
  start(): void {
    if (this.started) return
    this.started = true
    const restored = restoredBrowserTabs()
    if (this.tabs.length === 0) {
      this.tabs = restored.tabs
      this.activeTabId = restored.activeTabId
    }
    // One app-lifetime subscription drives every tab's runtime state. A panel
    // only exists for the tab on screen, so a page that keeps playing audio in
    // a background tab would otherwise have no listener at all.
    subscribe('browser:state', (state) => this.applyPageState(state))
    // A quit is the one moment the coalesced write cannot wait any longer.
    subscribe('window:beforeQuit', () => this.flushPersist())
  }

  /** Browser tabs for the active conversation.
   *
   *  A project's threads share one browser tab list, so switching between a
   *  project's threads keeps the browser the user was reading. A hidden
   *  conversation container (the inbox, the assistant space) is different: it is
   *  one project holding many independent conversations, so its tabs are scoped
   *  to the conversation instead. An assistant routine is one such conversation
   *  whatever thread of it is open   its how-to host and each of its runs share
   *  the routine (see `conversationScopeId`)   so switching between a routine's
   *  threads keeps the page those threads opened, instead of closing the browser
   *  on every switch. */
  get activeTabs(): BrowserContextTab[] {
    const projectId = this.host.activeProjectId()
    if (!projectId) return EMPTY_BROWSER_TABS
    const projectTabs = this.tabs.filter((tab) => tab.projectId === projectId)
    if (!isConversationContainer(projectId)) return projectTabs
    const threadId = this.host.activeThreadId()
    if (!threadId) return EMPTY_BROWSER_TABS
    const scopeId = this.host.threadScopeId(projectId, threadId)
    return projectTabs.filter(
      (tab) => this.host.threadScopeId(tab.projectId, tab.threadId) === scopeId
    )
  }

  has(id: string): boolean {
    return this.tabs.some((tab) => tab.id === id)
  }

  /**
   * Whether the browser surface a visit belongs to still has a tab.
   *
   * The browsing history keeps one list per surface and a thread browser's list
   * dies with the browser, so it asks this of the list that owns the surface. A
   * surface is a conversation (see the host's `threadScopeId`), which is exactly
   * what the strip groups its tabs by, so this is the same identity the history
   * files its lists under.
   */
  isScopeLive(scope: string): boolean {
    return this.tabs.some((tab) => this.host.threadScopeId(tab.projectId, tab.threadId) === scope)
  }

  /**
   * The browser tab to focus when the browser workspace is revealed: the
   * remembered active tab when it still belongs to the active project,
   * otherwise the project's last open tab. Restarts, project switches and
   * tab closures all funnel through this so the sidebar never falls back to
   * an arbitrary tab.
   */
  get rememberedTabId(): string | null {
    const tabs = this.activeTabs
    if (tabs.length === 0) return null
    return this.activeTabId && tabs.some((tab) => tab.id === this.activeTabId)
      ? this.activeTabId
      : (tabs.at(-1)?.id ?? null)
  }

  /** Active tab id for the browser region of the sidebar (never null while visible). */
  activeTabIdOrLast(): string | null {
    return this.activeTabId && this.activeTabs.some((tab) => tab.id === this.activeTabId)
      ? this.activeTabId
      : (this.activeTabs.at(-1)?.id ?? null)
  }

  setVisible(value: boolean): void {
    this.visible = value
  }

  /** Detach the native browser view without changing store visibility. */
  detachView(): void {
    const tabId = this.activeTabId ?? this.activeTabs.at(-1)?.id
    if (tabId) void invoke('browser:hide', tabId)
  }

  /** Hide the browser region and detach its native view. */
  hide(): void {
    this.detachView()
    this.visible = false
  }

  /** Hide the browser region when a context tab takes focus, detaching only
   *  when the native view was actually visible. */
  hideForFocus(): void {
    if (this.visible) this.detachView()
    this.visible = false
  }

  /**
   * The project thread a browser tab opened right now would belong to, or null
   * when none is active. A tab is always owned by a project thread, so this is
   * both the availability answer and the identity `open` needs   one resolution,
   * so an availability check can never promise what the open itself refuses.
   *
   * An empty thread id (a project activated before any thread exists) counts as
   * missing: there is no thread to own a tab.
   */
  private get openContext(): { projectId: string; threadId: string } | null {
    const projectId = this.host.activeProjectId()
    const threadId = this.host.activeThreadId()
    if (!projectId || !threadId) return null
    return { projectId, threadId }
  }

  /** Whether a page can be opened right now. */
  get canOpen(): boolean {
    return this.openContext !== null
  }

  open(url: string, requestedTabId?: string): string | null {
    const context = this.openContext
    if (!context) return null
    return this.openForContext(url, context.projectId, context.threadId, requestedTabId, true)
  }

  openForContext(
    url: string,
    projectId: string,
    threadId: string,
    requestedTabId?: string,
    reveal = false,
    requestedBoxId?: string | null
  ): string {
    const id = requestedTabId ?? `browser:${crypto.randomUUID()}`
    const existing = this.tabs.find((tab) => tab.id === id && tab.projectId === projectId)
    if (existing) {
      existing.url = url
      existing.threadId = threadId
      this.persist()
      if (reveal && this.isShownConversation(projectId, threadId)) {
        this.focus(id)
      }
      return id
    }
    let title = url === '' ? 'New Tab' : 'Browser'
    if (url !== '') {
      try {
        // eslint-disable-next-line svelte/prefer-svelte-reactivity
        const parsed = new URL(url)
        title = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
      } catch {
        // The main-process browser boundary reports malformed custom URLs.
      }
    }
    const tab: BrowserContextTab = {
      id,
      kind: 'browser',
      title,
      projectId,
      threadId,
      url,
      favicon: null,
      // The box the scope is currently creating tabs in, or the scope's own jar
      // when the user has not picked one this session.
      boxId:
        requestedBoxId !== undefined
          ? requestedBoxId
          : this.boxForScope(this.host.threadScopeId(projectId, threadId))
    }
    // A tab a page asked for (a link, an image, a popup) belongs beside the page
    // that asked, exactly as a browser places it: next to the tab in use, not at
    // the end of the strip. A request for a scope that is not on screen is
    // appended instead, because there is no page in use to sit beside and it
    // must not reorder the strip the user is looking at.
    const anchorId =
      reveal && this.isShownConversation(projectId, threadId) ? this.activeTabId : null
    const anchorIndex = anchorId
      ? this.tabs.findIndex((candidate) => candidate.id === anchorId)
      : -1
    if (anchorIndex >= 0) {
      const ordered = [...this.tabs]
      ordered.splice(anchorIndex + 1, 0, tab)
      this.tabs = ordered
    } else {
      this.tabs = [...this.tabs, tab]
    }
    this.persist()
    if (reveal && this.isShownConversation(projectId, threadId)) {
      this.focus(id)
    }
    return id
  }

  /**
   * The box a scope's next tab runs in: the box the user picked for it this
   * session, or null for the scope's own jar. A named box is the profile's jar
   * for that box, shared with every other context that picks it.
   */
  private boxForScope(scopeId: string): string | null {
    return this.scopeBoxChoices.get(scopeId) ?? null
  }

  /**
   * Reopen a tab in another box.
   *
   * A jar cannot move between boxes, so the tab cannot either: this is a close
   * plus an open. The chosen box becomes the scope's own for new tabs, the tab on
   * screen is replaced in place by an equivalent tab in the new box, and every
   * other open tab keeps the box it was created in. The target is the profile's
   * one jar for that box, so the reopened page comes back with whatever the box
   * already holds, a sign-in another context made included. Returns the new tab
   * id, or null when the tab is gone or already in the box.
   */
  reopenInBox(tabId: string, boxId: string | null): string | null {
    const index = this.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return null
    const tab = this.tabs[index]
    if (tab.boxId === boxId) return null
    this.scopeBoxChoices.set(this.host.threadScopeId(tab.projectId, tab.threadId), boxId)
    const replacement: BrowserContextTab = {
      id: `browser:${crypto.randomUUID()}`,
      kind: 'browser',
      title: tab.title,
      projectId: tab.projectId,
      threadId: tab.threadId,
      url: tab.url,
      favicon: tab.favicon,
      boxId
    }
    const tabs = [...this.tabs]
    tabs.splice(index, 1, replacement)
    this.tabs = tabs
    this.forgetRuntime([tabId])
    if (this.activeTabId === tabId) this.activeTabId = replacement.id
    this.persist()
    // The old page lives in the old jar, so it is destroyed rather than shown
    // again: a show for the removed id would be refused as a different box.
    void invoke('browser:destroy', tabId, 'closed').catch(() => {})
    return replacement.id
  }

  /**
   * Drop the picked box of every scope that no longer has a tab.
   *
   * The choice is deliberately session-scoped and reverts to the scope's own box
   * once its last tab is closed, which is what "closing the thread browser"
   * means: with no tab of the scope left, the next tab starts from the scope
   * again.
   */
  private pruneScopeBoxChoices(): void {
    if (this.scopeBoxChoices.size === 0) return
    for (const scopeId of [...this.scopeBoxChoices.keys()]) {
      const live = this.tabs.some(
        (tab) => this.host.threadScopeId(tab.projectId, tab.threadId) === scopeId
      )
      if (!live) this.scopeBoxChoices.delete(scopeId)
    }
  }

  /**
   * Whether the sidebar is showing the conversation a tab is opening for. A
   * reveal is delivered to the conversation on screen, which for an assistant
   * routine is every one of its threads: a run that opens a page while the user
   * reads its sibling opens it in the browser already on screen.
   */
  private isShownConversation(projectId: string, threadId: string): boolean {
    if (this.host.activeProjectId() !== projectId) return false
    const activeThreadId = this.host.activeThreadId()
    if (!activeThreadId) return false
    return (
      this.host.threadScopeId(projectId, threadId) ===
      this.host.threadScopeId(projectId, activeThreadId)
    )
  }

  updateTab(tabId: string, url: string, title?: string, favicon?: string | null): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    let changed = false
    if (tab.url !== url) {
      tab.url = url
      // The icon is the icon of an address, so a tab that moved is not the tab
      // the stored icon was read from: it goes with the address it came from, and
      // the row picks up the new one from the page or from the address itself
      // (see `ensureFavicon`).
      if (tab.favicon !== null) {
        tab.favicon = null
        this.tabFavicons.forget(tabId)
      }
      changed = true
    }
    const trimmedTitle = title?.trim()
    if (trimmedTitle && tab.title !== trimmedTitle) {
      tab.title = trimmedTitle
      changed = true
    }
    // An icon the document reported is adopted. A report of none is deliberately
    // not an erasure: Chromium announces an icon only when it differs from the one
    // the tab already holds, so a restored tab's page would blank its own row on
    // the way back, and a page that reloads at the same address would lose the
    // mark it just had. Only the address changing replaces the icon, above.
    if (isStorableBrowserFavicon(favicon) && tab.favicon !== favicon) {
      tab.favicon = favicon
      changed = true
    }
    // Main reports page state on every load, title and favicon update, so the
    // write is guarded by an actual change instead of a storage write per event.
    if (changed) this.persist()
  }

  /**
   * Give one tab the icon its address is known by, when it has none.
   *
   * Called for every browser tab the strip draws, so a tab the app has no page for
   * (one a restart restored, one main released before its page announced an icon)
   * wears the site's mark instead of a globe. The answer is written down with the
   * tab list, which is what makes it durable across the next launch. One lookup per
   * address per tab, and none at all for a tab that already holds an icon.
   */
  async ensureFavicon(tabId: string): Promise<void> {
    const favicon = await this.tabFavicons.resolve(
      tabId,
      () => this.tabs.find((candidate) => candidate.id === tabId) ?? null
    )
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (favicon === null || !tab || tab.favicon !== null) return
    tab.favicon = favicon
    this.persist()
  }

  /**
   * Apply a live page snapshot reported by main: the navigation identity onto
   * the tab, and the audio/capture state onto the runtime map the strips read.
   */
  applyPageState(state: BrowserPageState): void {
    const tab = this.tabs.find((candidate) => candidate.id === state.tabId)
    if (tab) {
      // A document with no committed URL yet (a fresh tab, an about:blank
      // popup) reports an empty URL and must not erase the address on screen.
      this.updateTab(state.tabId, state.url || tab.url, state.title, state.favicon)
    }
    const current = this.runtime.get(state.tabId)
    if (
      current &&
      current.audible === state.audible &&
      current.muted === state.muted &&
      current.capturing === state.capturing
    ) {
      return
    }
    this.runtime.set(state.tabId, {
      audible: state.audible,
      muted: state.muted,
      capturing: state.capturing
    })
  }

  /** Live audio and capture state of one tab, or the shared idle state while
   *  main has reported nothing for it. */
  runtimeFor(tabId: string): BrowserTabRuntime {
    return this.runtime.get(tabId) ?? IDLE_BROWSER_TAB_RUNTIME
  }

  /**
   * Toggle one tab's audio output. The change is applied optimistically so the
   * indicator answers the click immediately; main's published state stays the
   * source of truth and corrects the optimistic value if the toggle failed.
   */
  toggleMute(tabId: string): void {
    const current = this.runtimeFor(tabId)
    const muted = !current.muted
    this.runtime.set(tabId, { ...current, muted })
    void invoke('browser:setMuted', tabId, muted).catch((error: unknown) => {
      const latest = this.runtime.get(tabId)
      // Undo only our own optimistic write; a state event may already have
      // replaced it with main's answer.
      if (latest?.muted === muted) this.runtime.set(tabId, { ...latest, muted: current.muted })
      reportError(
        error,
        muted ? 'Tab audio could not be muted.' : 'Tab audio could not be unmuted.'
      )
    })
  }

  removeForProject(projectId: string): string[] {
    // A closed tab of a project that is gone can never be reopened, so its
    // session entry goes with the project. This runs before the early return: a
    // project with no live tab left may still have a closed one remembered.
    this.closedTabs = this.closedTabs.filter((entry) => entry.tab.projectId !== projectId)
    const removedIds = this.tabs.filter((tab) => tab.projectId === projectId).map((tab) => tab.id)
    if (removedIds.length === 0) return []
    this.tabs = this.tabs.filter((tab) => tab.projectId !== projectId)
    this.forgetRuntime(removedIds)
    this.pruneScopeBoxChoices()
    if (this.activeTabId && removedIds.includes(this.activeTabId)) {
      this.activeTabId = null
    }
    if (this.host.activeProjectId() === projectId) this.visible = false
    this.persist()
    return removedIds
  }

  removeForThread(projectId: string, threadId: string): string[] {
    this.closedTabs = this.closedTabs.filter(
      (entry) => entry.tab.projectId !== projectId || entry.tab.threadId !== threadId
    )
    const removedIds = this.tabs
      .filter((tab) => tab.projectId === projectId && tab.threadId === threadId)
      .map((tab) => tab.id)
    if (removedIds.length === 0) return []
    this.tabs = this.tabs.filter((tab) => tab.projectId !== projectId || tab.threadId !== threadId)
    this.forgetRuntime(removedIds)
    this.pruneScopeBoxChoices()
    if (this.activeTabId && removedIds.includes(this.activeTabId)) {
      this.activeTabId = this.activeTabs.at(-1)?.id ?? null
    }
    if (this.activeTabs.length === 0) this.visible = false
    this.persist()
    return removedIds
  }

  /** Close one browser tab and fall back to its previous neighbour in the
   *  active container (a project's threads or the open chat). A close the user
   *  asked for is remembered so it can be reopened; a close that replaces the
   *  tab (a reopen in another box) opts out, because nothing left the strip. */
  close(id: string, options: { recordForReopen?: boolean } = {}): void {
    const browserIndex = this.tabs.findIndex((tab) => tab.id === id)
    if (browserIndex < 0) return
    const closing = this.tabs[browserIndex]
    const activeIndex = this.activeTabs.findIndex((tab) => tab.id === id)
    if (options.recordForReopen !== false) this.rememberClosedTab(closing, browserIndex)
    this.tabs = this.tabs.filter((tab) => tab.id !== id)
    this.forgetRuntime([id])
    this.pruneScopeBoxChoices()
    if (this.activeTabId === id) {
      this.activeTabId = this.activeTabs[Math.max(0, activeIndex - 1)]?.id ?? null
    }
    if (this.activeTabs.length === 0) this.visible = false
    this.persist()
  }

  /**
   * Remember a just-closed tab for a reopen.
   *
   * The tab and its strip position are cloned, the scope is resolved now (a tab
   * is always owned by a conversation), and the oldest entry falls off once the
   * cap is reached.
   */
  private rememberClosedTab(tab: BrowserContextTab, index: number): void {
    const entry: ClosedSidebarBrowserTab = {
      tab: { ...tab },
      index,
      scopeId: this.host.threadScopeId(tab.projectId, tab.threadId)
    }
    const next = [...this.closedTabs, entry]
    this.closedTabs = next.slice(Math.max(0, next.length - MAX_REOPENED_BROWSER_TABS))
  }

  /**
   * Reopen the most recently closed tab of the conversation on screen.
   *
   * A thread browser is per-conversation, so a reopen only reaches a tab that
   * belonged to the same conversation: a tab closed in another thread must not
   * appear in this one. The tab keeps its id, so main hands its stored Back/
   * Forward history back to the page. Returns the reopened tab id, or null when
   * this conversation has nothing to reopen.
   */
  reopenLastClosedTab(): string | null {
    const projectId = this.host.activeProjectId()
    const threadId = this.host.activeThreadId()
    if (!projectId || !threadId) return null
    const scopeId = this.host.threadScopeId(projectId, threadId)
    let entryIndex = -1
    for (let index = this.closedTabs.length - 1; index >= 0; index -= 1) {
      if (this.closedTabs[index].scopeId === scopeId) {
        entryIndex = index
        break
      }
    }
    if (entryIndex < 0) return null
    const entry = this.closedTabs[entryIndex]
    this.closedTabs = this.closedTabs.filter((_, index) => index !== entryIndex)
    const restored: BrowserContextTab = { ...entry.tab }
    const ordered = [...this.tabs]
    ordered.splice(Math.min(entry.index, ordered.length), 0, restored)
    this.tabs = ordered
    this.focus(restored.id)
    this.persist()
    return restored.id
  }

  focus(id: string): void {
    const tab = this.tabs.find((candidate) => candidate.id === id)
    if (!tab || tab.projectId !== this.host.activeProjectId()) return
    if (isConversationContainer(tab.projectId)) {
      const activeThreadId = this.host.activeThreadId()
      if (!activeThreadId) return
      // A tab of the active conversation may be focused from any thread that
      // shares it, which is what lets a routine keep one browser across its
      // threads. A tab of another conversation never is.
      const scopeId = this.host.threadScopeId(tab.projectId, activeThreadId)
      if (this.host.threadScopeId(tab.projectId, tab.threadId) !== scopeId) return
    }
    this.activeTabId = id
    this.visible = true
    this.host.clearNotifications()
    // Recency is what a Ctrl+Tab inside the full screen browser walks, so it is
    // recorded here, at the one place a tab becomes the one in use.
    threadBrowserTabs.record(id)
    this.persist()
  }

  reorder(id: string, targetId: string, position: 'before' | 'after'): void {
    const fromIndex = this.tabs.findIndex((tab) => tab.id === id)
    const toIndex = this.tabs.findIndex((tab) => tab.id === targetId)
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return
    const ordered = [...this.tabs]
    const [moved] = ordered.splice(fromIndex, 1)
    const adjustedTarget = ordered.findIndex((tab) => tab.id === targetId)
    ordered.splice(position === 'before' ? adjustedTarget : adjustedTarget + 1, 0, moved)
    this.tabs = ordered
    this.persist()
  }

  /** Drop the runtime state of tabs that no longer exist, so a closed tab can
   *  never leave a stale speaker or recording indicator behind. */
  private forgetRuntime(tabIds: readonly string[]): void {
    for (const tabId of tabIds) {
      this.runtime.delete(tabId)
      this.tabFavicons.forget(tabId)
      threadBrowserTabs.forget(tabId)
    }
  }

  /** Queue a write of the current tab list.
   *
   * Never written before the stored list has landed: an unread list is not an
   * empty one, and writing here would replace what the user had with nothing.
   */
  private persist(): void {
    if (!this.started) return
    // The tab list is the only thing that can end a browser surface, so this is
    // where the history of a surface that just lost its last tab is discarded. A
    // close that leaves the surface with a tab left changes nothing, and a state
    // report arriving after a close is caught by the history store's own check.
    browserHistory.pruneThreadScopes()
    if (this.saveTimer !== null) return
    this.saveTimer = window.setTimeout(() => this.flushPersist(), TAB_SAVE_COALESCE_MS)
  }

  /** Write the tab list right now, dropping any pending write. The quit path and
   *  the timer behind {@link persist} both land here. */
  private flushPersist(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.started) return
    persistBrowserTabs(this.tabs, this.activeTabId)
  }
}
