import { invoke } from '$lib/ipc.svelte'
import { SidebarBrowserTabs } from './context-sidebar-browser.svelte'
import type { BrowserTabRuntime } from './browser-tab-status'
import type { BrowserPageState } from '$shared/ipc-contract'
import { loadTerminalPlacement, saveTerminalPlacement } from './context-sidebar-persistence'
import { SidebarTabContexts } from './context-sidebar-tabs.svelte'
import {
  EMPTY_TABS,
  isProjectTab,
  NOTIFICATIONS_TAB,
  TEMPORARY_CHAT_INACTIVITY_MS,
  type ContextSidebarTab,
  type MemorySection,
  type TemporaryChatContextTab,
  type TemporaryChatMode,
  type TerminalContextTab,
  type TerminalPlacement
} from './context-sidebar-types'
import type { AgentSubagentActivity, ThreadSettings } from '$shared/types'

export type {
  ActionsContextTab,
  BrowserContextTab,
  CloudDeploymentContextTab,
  ContextSidebarTab,
  CoordinatorContextTab,
  DebuggerContextTab,
  DiffContextTab,
  FilesContextTab,
  GitContextTab,
  MemoryContextTab,
  MemorySection,
  NotificationContextTab,
  SourcesContextTab,
  SubagentContextTab,
  TemporaryChatContextTab,
  TemporaryChatMode,
  TerminalContextTab,
  TerminalPlacement,
  ThreadNoteContextTab
} from './context-sidebar-types'
export { EXPLAIN_SELECTION_PROMPT } from './context-sidebar-types'

const CONTEXT_SIDEBAR_MIN_WIDTH = 340
const CONTEXT_SIDEBAR_MAX_WIDTH = 1600
const TERMINAL_DOCK_MIN_HEIGHT = 180
const TERMINAL_DOCK_MAX_HEIGHT = 560

class ContextSidebarState {
  private activeProjectId: string | null = $state(null)
  /** The thread the user actually opened, used for restore and identity reads. */
  private activeThreadId: string | null = $state(null)
  /** The sidebar row that stands for the open thread: a worker/auditor child
   *  delegates to its coordinator, so the child opens the parent's tab context
   *  instead of an empty one. See `activeThreadRowId`. */
  private activeRowThreadId: string | null = $state(null)
  private notificationsVisible = $state(false)
  width = $state(480)
  terminalHeight = $state(320)
  terminalPlacement = $state<TerminalPlacement>(loadTerminalPlacement())
  /** Monotonic trigger: each `requestCloseActiveTab()` call bumps this so a
   *  consumer (Workspace) can run the close-through-confirmation flow. */
  closeActiveTabRequest = $state(0)
  /** The tab a pending close-shortcut request targets. Captured when the
   *  request is made, because closing a tab changes which tab is active: a
   *  consumer that resolved the tab itself would close the next one too, and
   *  then every panel the user opened afterwards. */
  private closeShortcutTabId: string | null = null
  /** Requests already served, so one request closes exactly one tab. */
  private consumedCloseActiveTabRequestCount = 0

  private tabContexts = new SidebarTabContexts({
    activeProjectId: () => this.activeProjectId,
    activeThreadId: () => this.activeRowThreadId ?? this.activeThreadId,
    terminalPlacement: () => this.terminalPlacement,
    hideBrowserForFocus: () => this.browser.hideForFocus(),
    clearNotifications: () => {
      this.notificationsVisible = false
    }
  })

  private browser = new SidebarBrowserTabs({
    activeProjectId: () => this.activeProjectId,
    activeThreadId: () => this.activeThreadId,
    clearNotifications: () => {
      this.notificationsVisible = false
    }
  })

  get tabs(): ContextSidebarTab[] {
    return [
      ...(this.tabContexts.activeProjectContext?.tabs ?? EMPTY_TABS),
      ...(this.tabContexts.activeContext?.tabs.filter((tab) => !isProjectTab(tab)) ?? EMPTY_TABS),
      ...this.browser.activeTabs,
      ...(this.notificationsVisible ? [NOTIFICATIONS_TAB] : [])
    ]
  }

  /** Resolve a live temporary-chat tab without passing its mutable proxy
   *  through a component prop. The sidebar store remains the sole owner. */
  temporaryChatTab(tabId: string): TemporaryChatContextTab | null {
    return this.tabContexts.temporaryChatTab(tabId)
  }

  get activeTabId(): string | null {
    return this.sidebarActiveTabId
  }

  get visible(): boolean {
    return this.sidebarVisible
  }

  get activeTab(): ContextSidebarTab | null {
    return this.sidebarActiveTab
  }

  get rememberedBrowserTabId(): string | null {
    return this.browser.rememberedTabId
  }

  /**
   * Tabs shown in the right sidebar. When the terminal is docked at the
   * bottom, terminal tabs live in the dock and are excluded here; otherwise
   * every tab (including terminals) renders in the sidebar.
   */
  get sidebarTabs(): ContextSidebarTab[] {
    const tabs = [
      ...(this.tabContexts.activeProjectContext?.tabs ?? EMPTY_TABS),
      ...(this.tabContexts.activeContext?.tabs.filter((tab) => !isProjectTab(tab)) ?? EMPTY_TABS),
      ...this.browser.activeTabs
    ]
    const positionedTabs =
      this.terminalPlacement === 'bottom' ? tabs.filter((tab) => tab.kind !== 'terminal') : tabs
    return this.notificationsVisible ? [...positionedTabs, NOTIFICATIONS_TAB] : positionedTabs
  }

  /** Tabs shown in the bottom terminal dock. Empty while docked to the right. */
  get terminalTabs(): TerminalContextTab[] {
    if (this.terminalPlacement !== 'bottom') return EMPTY_TABS as TerminalContextTab[]
    return (this.tabContexts.activeProjectContext?.tabs ?? EMPTY_TABS).filter(
      (tab): tab is TerminalContextTab => tab.kind === 'terminal'
    )
  }

  /**
   * Whether the right sidebar should render at all. Independent of the bottom
   * terminal dock: when the sidebar has no non-terminal tabs it still renders
   * its empty/actions state so the user can add files, git, sources, etc.
   */
  get sidebarVisible(): boolean {
    if (this.notificationsVisible) return true
    if (this.browser.visible && this.browser.activeTabs.length > 0) return true
    return this.activeThreadId !== null && (this.tabContexts.activeProjectContext?.visible ?? false)
  }

  /**
   * Whether the bottom terminal dock should render at all. Fully independent
   * of the right sidebar, hiding the sidebar never hides the dock.
   */
  get terminalDockVisible(): boolean {
    return (
      this.terminalPlacement === 'bottom' &&
      this.activeThreadId !== null &&
      this.tabContexts.activeProjectContext?.terminalDockOpen !== false &&
      this.terminalTabs.length > 0
    )
  }

  /**
   * Whether the bottom terminal dock is folded into its thin restore bar.
   * True while the dock is closed but terminal tabs still exist, so a user can
   * expand the shell back to its previous height from the chevron bar.
   */
  get terminalDockCollapsed(): boolean {
    return (
      this.terminalPlacement === 'bottom' &&
      this.activeThreadId !== null &&
      this.tabContexts.activeProjectContext?.terminalDockOpen === false &&
      this.terminalTabs.length > 0
    )
  }

  /** Toggle the bottom terminal dock without touching the sidebar. */
  toggleTerminalDock(): void {
    const context = this.tabContexts.activeProjectContext
    if (!context || this.terminalPlacement !== 'bottom') return
    context.terminalDockOpen = !context.terminalDockOpen
  }

  /** Move terminals between the sidebar and the bottom dock. */
  setTerminalPlacement(placement: TerminalPlacement): void {
    this.terminalPlacement = placement
    saveTerminalPlacement(placement)
    const context = this.tabContexts.activeProjectContext
    if (!context) return
    const terminalTabs = context.tabs.filter(
      (tab): tab is TerminalContextTab => tab.kind === 'terminal'
    )
    const rememberedTerminalId = context.terminalActiveTabId ?? context.activeTabIds.terminal
    const activeTerminalId =
      rememberedTerminalId && terminalTabs.some((tab) => tab.id === rememberedTerminalId)
        ? rememberedTerminalId
        : (terminalTabs.at(-1)?.id ?? null)

    this.notificationsVisible = false
    if (placement === 'bottom') {
      context.terminalDockOpen = true
      context.terminalActiveTabId = activeTerminalId
      // Moving the terminal out of the sidebar also closes that region. The
      // bottom dock is the only panel the placement action should reveal.
      context.visible = false
    } else {
      // Terminals rejoin the sidebar as the active tool, rather than revealing
      // whichever non-terminal panel happened to be active before docking.
      if (activeTerminalId) {
        context.activeKind = 'terminal'
        context.activeTabIds.terminal = activeTerminalId
        context.visible = true
      }
    }
  }

  /** Active tab id for the right sidebar (ignores terminal tabs). */
  get sidebarActiveTabId(): string | null {
    if (this.notificationsVisible) return NOTIFICATIONS_TAB.id
    if (this.browser.visible) {
      return this.browser.activeTabIdOrLast()
    }
    const project = this.tabContexts.activeProjectContext
    const kind = project?.activeKind
    if (!project || !kind) return null
    const tabs = this.sidebarTabs.filter((tab) => tab.kind === kind)
    const activeId = this.tabContexts.activeTabIdForKind(kind)?.[kind]
    return activeId && tabs.some((tab) => tab.id === activeId)
      ? activeId
      : (tabs.at(-1)?.id ?? null)
  }

  /** Active tab id for the bottom terminal dock. */
  get terminalActiveTabId(): string | null {
    if (this.terminalPlacement !== 'bottom') return null
    const context = this.tabContexts.activeProjectContext
    if (!context) return null
    if (
      context.terminalActiveTabId &&
      this.terminalTabs.some((tab) => tab.id === context.terminalActiveTabId)
    ) {
      return context.terminalActiveTabId
    }
    return this.terminalTabs.at(-1)?.id ?? null
  }

  /** The tab the sidebar content should render for. */
  get sidebarActiveTab(): ContextSidebarTab | null {
    if (this.notificationsVisible) return NOTIFICATIONS_TAB
    return this.sidebarTabs.find((tab) => tab.id === this.sidebarActiveTabId) ?? null
  }

  /** The terminal the dock content should render for. */
  get terminalActiveTab(): TerminalContextTab | null {
    return this.terminalTabs.find((tab) => tab.id === this.terminalActiveTabId) ?? null
  }

  threadIdForProject(projectId: string): string | null {
    return this.activeProjectId === projectId ? this.activeThreadId : null
  }

  /** `rowThreadId` is the sidebar row that represents `threadId`. A worker or
   *  auditor child passes its coordinator so the child opens the parent's tab
   *  context, which is where the coordinator panel is docked. It defaults to
   *  `threadId` for every normal thread. */
  activateThread(
    projectId: string,
    threadId: string,
    threadTitle?: string,
    rowThreadId?: string
  ): void {
    const keepNotificationsVisible = this.notificationsVisible
    const projectChanged = this.activeProjectId !== projectId
    // Capture before `activeProjectId` moves: the native view (if any) belongs
    // to the outgoing project and must be detached from the store layer so the
    // floating view never outlives its sidebar visibility.
    const browserWasVisible = this.browser.visible
    const previousBrowserTabId =
      this.browser.activeTabId ?? this.browser.activeTabs.at(-1)?.id ?? null
    this.activeProjectId = projectId
    this.activeThreadId = threadId
    this.activeRowThreadId = rowThreadId ?? threadId
    const contextThreadId = this.activeRowThreadId
    this.tabContexts.ensureProjectContext(projectId)
    this.tabContexts.ensureContext(projectId, contextThreadId)
    this.tabContexts.rebindProjectTabs(projectId, contextThreadId)
    this.tabContexts.ensureActiveThreadPanel(projectId, contextThreadId, threadTitle)
    this.notificationsVisible = keepNotificationsVisible
    this.browser.visible =
      !keepNotificationsVisible &&
      !projectChanged &&
      this.browser.visible &&
      this.browser.activeTabs.length > 0
    if (browserWasVisible && !this.browser.visible && previousBrowserTabId) {
      void invoke('browser:hide', previousBrowserTabId)
    }
  }

  deactivateThread(): void {
    this.browser.hide()
    this.activeProjectId = null
    this.activeThreadId = null
    this.activeRowThreadId = null
  }

  /**
   * Which region last held the sidebar: a context panel, the browser tabs, or
   * the notifications list. Recorded as the region leaves the screen, so the
   * toggle shortcut (Cmd/Ctrl+Shift+S) can bring back exactly what the user was
   * looking at instead of guessing from whatever panel is still remembered.
   */
  private lastRegion: 'context' | 'browser' | 'notifications' = 'context'

  /**
   * Toggle the sidebar region without picking a panel for it: hide whatever is
   * on screen, otherwise bring back the region the user last selected there.
   *
   * Returns false when no region has ever been selected (a fresh thread that
   * opened nothing yet), so the caller can open a sensible default tool instead
   * of leaving the shortcut dead.
   */
  toggleLastSelected(): boolean {
    if (this.sidebarVisible) {
      this.hide()
      return true
    }
    if (this.lastRegion === 'notifications') {
      // Notifications are hidden right now, so this reveals them again (and
      // detaches the browser view the same way the header button does).
      this.toggleNotifications()
      return true
    }
    if (this.lastRegion === 'browser') {
      const tabId = this.browser.rememberedTabId
      if (tabId) {
        this.focus(tabId)
        return true
      }
      // Every browser tab for this project is gone: fall through to the panel.
    }
    const context = this.activeProjectId
      ? this.tabContexts.ensureProjectContext(this.activeProjectId)
      : null
    if (!context || this.sidebarActiveTab === null) return false
    context.visible = true
    return true
  }

  hide(): void {
    if (this.notificationsVisible) {
      this.lastRegion = 'notifications'
      this.notificationsVisible = false
      return
    }
    if (this.browser.visible) {
      this.lastRegion = 'browser'
      this.browser.hideForFocus()
      const context = this.tabContexts.activeProjectContext
      if (context) context.visible = false
      return
    }
    this.lastRegion = 'context'
    const context = this.tabContexts.activeProjectContext
    if (context) context.visible = false
  }

  /** Opened from the dock rail's Files icon. Reveals whatever file panel was
   *  last in focus instead of always jumping to the empty "Open file"
   *  browser tab, hiding the sidebar must not lose the file the user was
   *  looking at. The browser tab only ever appears when no file has been
   *  opened yet. */
  openFiles(projectId: string, threadId: string): void {
    this.tabContexts.openFiles(projectId, threadId)
  }

  openProjectFile(
    projectId: string,
    threadId: string,
    fileTabId: string,
    path: string,
    preview = false
  ): void {
    this.tabContexts.openProjectFile(projectId, threadId, fileTabId, path, preview)
  }

  updateProjectFileMapping(
    projectId: string,
    previousFileTabId: string,
    nextFileTabId: string,
    nextPath: string
  ): void {
    this.tabContexts.updateProjectFileMapping(projectId, previousFileTabId, nextFileTabId, nextPath)
  }

  /** Rewrite a sidebar tab's file mapping. Returns whether any tab was remapped
   *  so callers can fall back to opening a fresh sidebar tab when the workspace
   *  tab has no matching sidebar tab anymore (e.g. after the tab was closed). */
  remapProjectFile(
    projectId: string,
    previousFileTabId: string,
    nextFileTabId: string,
    nextPath: string,
    preview: boolean,
    focus: boolean
  ): boolean {
    return this.tabContexts.remapProjectFile(
      projectId,
      previousFileTabId,
      nextFileTabId,
      nextPath,
      preview,
      focus
    )
  }

  /** Stop rendering a file tab as a preview (italicised), used when the user
   *  starts editing it, which pins the tab. */
  pinProjectFile(projectId: string, fileTabId: string): void {
    this.tabContexts.pinProjectFile(projectId, fileTabId)
  }

  closeProjectFile(projectId: string, fileTabIds: ReadonlySet<string>): void {
    this.tabContexts.closeProjectFile(projectId, fileTabIds)
  }

  /** `checkpointId`/`revealPath` are `undefined` (omitted) for a plain
   *  reopen, the dock rail's toggle calls this with no reveal target and
   *  must not clobber whatever checkpoint the user already had selected.
   *  `null` is only meaningful when explicitly passed, e.g. to clear a
   *  reveal. Without this distinction every dock-icon toggle reset the tab
   *  back to its defaults, which is what made the panel look like it never
   *  remembered anything and re-fetched from scratch every time. */
  openDiff(
    projectId: string,
    threadId: string,
    checkpointId?: string | null,
    revealPath?: string | null
  ): void {
    this.tabContexts.openDiff(projectId, threadId, checkpointId, revealPath)
  }

  openSources(projectId: string, threadId: string): void {
    this.tabContexts.openSources(projectId, threadId)
  }

  openGit(projectId: string, threadId: string): void {
    this.tabContexts.openGit(projectId, threadId)
  }

  openActions(projectId: string, threadId: string): void {
    this.tabContexts.openActions(projectId, threadId)
  }

  openBrowser(url: string, requestedTabId?: string): string | null {
    return this.browser.open(url, requestedTabId)
  }

  openBrowserForContext(
    url: string,
    projectId: string,
    threadId: string,
    requestedTabId?: string,
    reveal = false
  ): string {
    return this.browser.openForContext(url, projectId, threadId, requestedTabId, reveal)
  }

  updateBrowserTab(tabId: string, url: string, title?: string, favicon?: string | null): void {
    this.browser.updateTab(tabId, url, title, favicon)
  }

  /** Live audio and capture state of a browser tab, as the tab strips read it. */
  browserRuntime(tabId: string): BrowserTabRuntime {
    return this.browser.runtimeFor(tabId)
  }

  /** Mute or unmute one browser tab's audio output. */
  toggleBrowserTabMute(tabId: string): void {
    this.browser.toggleMute(tabId)
  }

  /** Apply a live page snapshot: the tab's identity, and its audio and capture
   *  state. The browser store already applies every `browser:state` event; this
   *  entry point is for a surface that also receives one directly, so the tab
   *  strip still shows the audio state of a tab that main kept alive across a
   *  renderer reload. */
  applyBrowserPageState(state: BrowserPageState): void {
    this.browser.applyPageState(state)
  }

  removeProjectBrowsers(projectId: string): string[] {
    return this.browser.removeForProject(projectId)
  }

  removeThreadBrowsers(projectId: string, threadId: string): string[] {
    return this.browser.removeForThread(projectId, threadId)
  }

  /** Opens the thread's note as a sidebar panel, creating one the first time
   *  it's visited so the panel is ready to write into even before a note
   *  exists. The body loads asynchronously onto the tab itself (not local
   *  component state) so an in-progress draft survives the panel being
   *  hidden and shown again. */
  openThreadNote(
    projectId: string,
    threadId: string,
    threadTitle: string,
    options: { edit?: boolean; focusEditor?: boolean } = {}
  ): void {
    this.tabContexts.openThreadNote(projectId, threadId, threadTitle, options)
  }

  openCloudDeployments(projectId: string, threadId: string): void {
    this.tabContexts.openCloudDeployments(projectId, threadId)
  }

  /**
   * Dock the coordinator for a thread. The title tracks the coordination kind
   * (Assignment vs Achievement vs Audit), so an existing tab is re-titled rather than
   * duplicated when a thread switches modes.
   */
  openCoordinator(projectId: string, threadId: string, title: string): void {
    this.tabContexts.openCoordinator(projectId, threadId, title)
  }

  /** Whether the coordinator tab is already docked for a thread. */
  hasCoordinator(projectId: string, threadId: string): boolean {
    return this.tabContexts.hasCoordinator(projectId, threadId)
  }

  /** Close the coordinator tab for a thread whose coordination ended, e.g.
   *  the Independent Audit switch was turned off before its first run. The
   *  whole sidebar shell closes with the tab, not just the panel. */
  closeCoordinator(projectId: string, threadId: string): void {
    this.tabContexts.closeCoordinator(projectId, threadId)
  }

  openMemory(projectId: string, threadId: string, section?: MemorySection): void {
    this.tabContexts.openMemory(projectId, threadId, section)
  }

  toggleNotifications(): void {
    this.notificationsVisible = !this.notificationsVisible
    if (this.notificationsVisible) {
      if (this.browser.visible) this.browser.detachView()
      this.browser.visible = false
    }
  }

  openTemporaryChat(
    projectId: string,
    threadId: string,
    mode: TemporaryChatMode,
    selection: string,
    initialContext: string,
    settings: ThreadSettings,
    selectionAttached = true,
    autoPrompt?: string
  ): TemporaryChatContextTab {
    return this.tabContexts.openTemporaryChat(
      projectId,
      threadId,
      mode,
      selection,
      initialContext,
      settings,
      selectionAttached,
      autoPrompt
    )
  }

  /** Reveal the sidebar and focus one of the thread's temporary-chat tabs,
   *  the deep-link target for a side-chat notification. Returns false when
   *  the tab no longer exists (closed or never opened), so the caller can
   *  drop the unread badge instead of leaving it stuck. */
  focusTemporaryChat(projectId: string, threadId: string, temporaryChatId: string): boolean {
    return this.tabContexts.focusTemporaryChat(projectId, threadId, temporaryChatId)
  }

  touchTemporaryChat(
    tab: TemporaryChatContextTab,
    expiresAt = Date.now() + TEMPORARY_CHAT_INACTIVITY_MS
  ): void {
    this.tabContexts.touchTemporaryChat(tab, expiresAt)
  }

  expireTemporaryChat(tab: TemporaryChatContextTab, closeRemote = true): void {
    this.tabContexts.expireTemporaryChat(tab, closeRemote)
  }

  restartTemporaryChat(tab: TemporaryChatContextTab): void {
    this.tabContexts.restartTemporaryChat(tab)
  }

  openPrimaryTerminal(projectId: string, threadId: string): void {
    this.tabContexts.openPrimaryTerminal(projectId, threadId)
  }

  openNewTerminal(projectId: string, threadId: string): string {
    return this.tabContexts.openNewTerminal(projectId, threadId)
  }

  openDebugger(projectId: string, threadId: string): void {
    this.tabContexts.openDebugger(projectId, threadId)
  }

  openSubagent(
    projectId: string,
    threadId: string,
    partId: string,
    activity: AgentSubagentActivity
  ): void {
    this.tabContexts.openSubagent(projectId, threadId, partId, activity)
  }

  updateSubagent(
    projectId: string,
    threadId: string,
    partId: string,
    activity: AgentSubagentActivity
  ): void {
    this.tabContexts.updateSubagent(projectId, threadId, partId, activity)
  }

  focus(id: string): void {
    if (this.browser.has(id)) {
      this.browser.focus(id)
      return
    }
    this.tabContexts.focusTab(id)
  }

  close(id: string): void {
    if (id === NOTIFICATIONS_TAB.id) {
      this.notificationsVisible = false
      return
    }
    if (this.browser.has(id)) {
      this.browser.close(id)
      return
    }
    this.tabContexts.closeContextTab(id)
  }

  /** Signal Workspace to close the active tab of `region` through its
   *  confirmation flow (unsaved-file dialog). The tab is not closed here,
   *  Workspace decides. Returns whether a closeable tab was actually found: a
   *  request for a region that is not on screen (or holds no tab) is dropped
   *  instead of arming a close the user never asked for. */
  requestCloseActiveTab(region: 'sidebar' | 'dock' = 'sidebar'): boolean {
    const tabId = this.closeShortcutTabFor(region)
    if (!tabId) return false
    this.closeShortcutTabId = tabId
    this.closeActiveTabRequest += 1
    return true
  }

  /** The active tab a close-shortcut request for `region` targets, or null when
   *  that surface is off screen: a collapsed bottom dock and a hidden right
   *  sidebar both keep their tabs in memory, and the shortcut must never close
   *  a tab the user cannot see. */
  private closeShortcutTabFor(region: 'sidebar' | 'dock'): string | null {
    if (region === 'dock') return this.terminalDockVisible ? this.terminalActiveTabId : null
    return this.sidebarVisible ? this.sidebarActiveTabId : null
  }

  /** Take the tab id of the pending close-shortcut request, if one is waiting.
   *  One request is served once; a consumer that asks again gets nothing, so
   *  closing a tab can never cascade into closing the next active one. */
  consumeCloseActiveTabRequest(): string | null {
    if (this.consumedCloseActiveTabRequestCount === this.closeActiveTabRequest) return null
    this.consumedCloseActiveTabRequestCount = this.closeActiveTabRequest
    return this.closeShortcutTabId
  }

  reorder(id: string, targetId: string, position: 'before' | 'after'): void {
    if (this.browser.has(id)) {
      this.browser.reorder(id, targetId, position)
      return
    }
    this.tabContexts.reorderContextTab(id, targetId, position)
  }

  setWidth(width: number): void {
    this.width = Math.max(CONTEXT_SIDEBAR_MIN_WIDTH, Math.min(width, CONTEXT_SIDEBAR_MAX_WIDTH))
  }

  setTerminalHeight(height: number): void {
    this.terminalHeight = Math.max(
      TERMINAL_DOCK_MIN_HEIGHT,
      Math.min(height, TERMINAL_DOCK_MAX_HEIGHT)
    )
  }
}

export const contextSidebarState = new ContextSidebarState()
