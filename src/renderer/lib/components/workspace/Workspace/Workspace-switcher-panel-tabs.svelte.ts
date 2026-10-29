import { invoke } from '$lib/ipc.svelte'
import { appConfigState } from '$lib/stores/app-config.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import { browserStore, switcherBrowserTabs } from '$lib/stores/browser-access.svelte'
import {
  contextSidebarState,
  type ContextSidebarTab,
  type TemporaryChatContextTab
} from '$lib/stores/context-sidebar.svelte'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { browserTabVisitKey, recentVisits } from '$lib/stores/recent-visits.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { threadVisitKey, workspaceState } from '$lib/stores/workspace.svelte'
import type { Project, Thread } from '$shared/types'
import { ASSISTANT_SPACE_ID, conversationScopeId, INBOX_PROJECT_ID } from '$shared/types'
import { tick } from 'svelte'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { type ContextDockItem } from '../../layout/ContextDock.svelte'
import {
  buildThreadSwitcherEntries,
  type SwitcherPanelTab
} from '../../threads/thread-switcher-entries'
import { WorkspaceBrowserController } from '../WorkspaceBrowserController.svelte'
import { WorkspaceSidebarController } from '../WorkspaceSidebarController.svelte'
import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceSwitcherPanelTabs {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root)
      throw new Error('WorkspaceSwitcherPanelTabs read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  HISTORY_PAGE_LIMIT = 50

  /**
   * The context rail's dock groups, read when they are needed.
   *
   * The groups are built by the surface because each row carries the snippet that
   * draws its menu, and a snippet only exists in the component; the surface hands
   * them over once and this unit asks for them at the moment it opens a tool.
   */
  private contextGroups: () => ContextDockItem[][] = () => []

  /** Called by the surface with the live dock groups. */
  setContextGroups(read: () => ContextDockItem[][]): void {
    this.contextGroups = read
  }

  /** Threads fetched from the DB per project when a list is expanded past its
   *  initial per-project hydration slice. */
  PROJECT_PAGE_LIMIT = 50

  loading = $state(true)

  historyLoading = $state(false)

  /** Per-project DB paging state for "Show more" beyond the hydrated slice:
   *  how many rows were fetched so far, and whether the project has more. */
  projectPageOffsets = new SvelteMap<string, number>()

  projectExhausted = new SvelteSet<string>()

  projectPageLoading = $state<string | null>(null)

  // ─── Sidebar focus-follow ────────────────────────────────────────────────
  // The active thread owns the sidebar's scroll position. Three things can move
  // the list, and their precedence is the whole contract:
  //
  // 1. The reader's own wheel or touch gesture hands the scroll over: while they
  //    hold it, background list changes may not move the viewport.
  // 2. Selecting another thread reveals its row, and so does a row the active
  //    thread moves by itself (typing an unsent draft sends it to the top, and a
  //    pin re-hosts it between the Pinned section and its own list).
  // 3. Switching sidebar mode settles the incoming list on the active thread's
  //    row, keeping that mode's remembered place when it already shows the row.
  sidebarScroller: HTMLElement | null = $state(null)

  isThreadRowVisible(threadId: string): boolean {
    const row = this.root.openThreadFromSwitcher.findThreadRow(threadId)
    if (!row) return false
    const scroller = this.sidebarScroller
    if (!scroller) return true
    const rowRect = row.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    return (
      rowRect.top >= scrollerRect.top - 1 &&
      rowRect.bottom <= scrollerRect.bottom + 1 &&
      rowRect.width > 0 &&
      rowRect.height > 0
    )
  }

  nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }

  scrollThreadRowIntoView(threadId: string): void {
    // Native scrollIntoView scrolls the sidebar scroller (and any intermediate
    // containers) the minimal amount to bring the row fully into view. Manual
    // scrollTop math here is fragile: measuring the row before the expanded
    // folder's layout settles produced wrong offsets and jumped to the top.
    this.root.openThreadFromSwitcher.findThreadRow(threadId)?.scrollIntoView({ block: 'nearest' })
  }

  /**
   * Expand the folder that owns a thread so the row exists in the DOM by the
   * time the reveal measures it. The folder renders the active thread as an
   * artificial last row when it sits past the "show more" budget, so the
   * budget itself stays collapsed: the row is in focus without growing the
   * list to its natural position. In Threads mode the flat list renders every
   * row already, so this costs nothing but a set insert.
   */
  prepareThreadRow(thread: Thread): void {
    if (thread.projectId === INBOX_PROJECT_ID) return
    this.sidebar.expandedFolders.add(thread.projectId)
  }

  /** A wheel or touch gesture on the sidebar hands its scroll to the reader. */
  handleSidebarUserScroll(): void {
    this.root.openThreadFromSwitcher.sidebarReaderOwnsScroll = true
  }

  // ─── Per-mode sidebar place ─────────────────────────────────────────────
  // Switching between Projects/Chats/Threads swaps the sidebar content
  // wholesale. Each mode remembers where the reader left its list, so coming
  // back restores that place when it still shows the active thread's row; a
  // remembered place that hides the row is settled onto the row instead, which
  // is what keeps the thread in charge of the scroll across a view switch.
  sidebarScrollByMode = new SvelteMap<'projects' | 'chats' | 'threads' | 'assistant', number>()

  /**
   * The incoming mode's list has not settled yet. The focus-follow effect leaves
   * the scroll to the settle below while this is set, because it would measure
   * the outgoing list's position rather than the place the reader is about to
   * see.
   */
  sidebarModeSettlePending = $state(false)

  /**
   * Which mode switch the pending settle belongs to. A second switch while the
   * first one is still rendering must not apply the older mode's remembered
   * place to the newer mode's list.
   */
  sidebarSettleGeneration = 0

  /**
   * Put the sidebar where the incoming mode's list belongs: the reader's
   * remembered place for that mode, which the focus-follow effect then settles
   * onto the active thread's row when that place hides it.
   */
  async settleSidebarForMode(
    settledMode: typeof this.root.props.mode,
    generation: number
  ): Promise<void> {
    // The mode's own list is mounted by the end of this flush, so the remembered
    // place is written against the list the reader is about to see, never the
    // one they just left. A microtask is all this waits for, so the follow
    // effect below is never held off by a window that stopped painting.
    await tick()
    if (generation !== this.sidebarSettleGeneration) return
    const scroller = this.sidebarScroller
    const remembered = this.sidebarScrollByMode.get(settledMode)
    if (scroller && remembered !== undefined) scroller.scrollTop = remembered
    this.sidebarModeSettlePending = false
  }

  sidebar = new WorkspaceSidebarController()

  /** Clicking into the chat composer means the user found what they were
   *  looking for: any open sidebar thread search is dismissed immediately
   *  ("click and go") instead of lingering and blocking the composer. Runs in
   *  the capture phase so it fires before focus settles into the editor. */
  handleComposerPointerDown(event: Event): void {
    const target = event.target
    if (!(target instanceof Element)) return
    if (!target.closest('[data-onboarding="composer"]')) return
    this.sidebar.closeAllSearches()
  }

  // ─── Context dock (right rail) ───────────────────────────────────────────

  /** Whether `kind` is the panel currently on screen in the right sidebar. */
  dockKindActive(kind: ContextSidebarTab['kind']): boolean {
    return contextSidebarState.sidebarVisible && contextSidebarState.sidebarActiveTab?.kind === kind
  }

  /**
   * The dock's toggle contract: clicking the active tool collapses the panel,
   * clicking any other tool swaps the panel content without closing it.
   */
  toggleDockPanel(kind: ContextSidebarTab['kind'], open: () => void): void {
    if (this.dockKindActive(kind)) {
      contextSidebarState.hide()
      return
    }
    open()
  }

  /** The first tool on the context rail that opens a panel in the right sidebar.
   *  History is a floating flyout rather than a panel, and a terminal docked at
   *  the bottom has left the sidebar for the dock, so neither answers the
   *  fallback: toggling the right sidebar must not reveal the bottom dock. */
  firstContextTool(): ContextDockItem | undefined {
    const opensInSidebar = (item: ContextDockItem): boolean =>
      item.id !== 'history' &&
      !(item.id === 'terminal' && contextSidebarState.terminalPlacement === 'bottom')
    return this.contextGroups().flat().find(opensInSidebar)
  }

  coordinatorRailBadgeTitle = $derived.by(() => {
    switch (this.root.openThreadFromSwitcher.coordinatorRailBadge) {
      case 'working':
        return 'Auditor working'
      case 'working-paused':
        return 'Auditor waiting to retry'
      case 'error':
        return 'Auditor failed'
      case 'attention':
        return 'Auditor needs attention'
      case 'done':
        return 'Audit report ready'
      default:
        return undefined
    }
  })

  browser = new WorkspaceBrowserController({
    getSelectedProjectId: () => this.root.openThreadFromSwitcher.selectedThread?.projectId ?? null
  })

  browserFullscreenThreadId = $state<string | null>(null)

  /** The terminal tab actually shown fullscreen, or null when the recorded id no
   *  longer names an open terminal.
   *
   *  A bare id is not enough. It is what publishes the `workspace-terminal-fullscreen`
   *  suppression block below, and a tab can disappear without any of the three
   *  closers running   its thread or project can be deleted, or the whole sidebar
   *  can be rebuilt. A stale id would then keep the browser's native view
   *  detached with nothing on screen to justify it, which reads as a browser
   *  panel that never paints. Deriving from the live tab list makes that
   *  unreachable, and it is also the id the fullscreen surface itself renders
   *  from, so a stale one can no longer reopen an empty terminal dialog later. */
  terminalFullscreenTab = $derived(
    contextSidebarState.tabs.find(
      (tab) =>
        tab.id === this.root.openThreadFromSwitcher.terminalFullscreenTabId &&
        tab.kind === 'terminal'
    ) ?? null
  )

  /** A files tab with unsaved changes waiting on a save/discard decision. */
  closeTabTarget = $state<{
    sidebarTabId: string
    projectId: string
    fileTabId: string
    path: string
  } | null>(null)

  async saveAndCloseTab(): Promise<void> {
    const target = this.closeTabTarget
    if (!target) return
    this.closeTabTarget = null
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === target.sidebarTabId)
    if (!tab || tab.kind !== 'files') return
    await projectFilesWorkspace.save(target.projectId, target.path)
    this.root.openThreadFromSwitcher.closeContextTabNow(target.sidebarTabId, tab)
  }

  discardCloseTab(): void {
    const target = this.closeTabTarget
    if (!target) return
    this.closeTabTarget = null
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === target.sidebarTabId)
    if (!tab || tab.kind !== 'files') return
    this.root.openThreadFromSwitcher.closeContextTabNow(target.sidebarTabId, tab)
  }

  /**
   * Every assistant thread's browser scope, keyed by thread id: an assistant's
   * knowledge host and each of its runs share the assistant, and an assistant-less task
   * owns its own. The sidebar resolves a tab's scope through this, so switching
   * between an assistant's threads keeps the browser those threads opened instead
   * of closing it.
   */
  assistantBrowserScopes = $derived.by(() => {
    const scopes = new SvelteMap<string, string>()
    for (const thread of this.root.createThreadInProject.allThreads) {
      if (thread.projectId !== ASSISTANT_SPACE_ID) continue
      scopes.set(thread.id, conversationScopeId(thread.projectId, thread.id, thread.assistantId))
    }
    return scopes
  })

  /**
   * The browser tab on screen while the browser view is the surface the user is
   * looking at, and null in every other view.
   *
   * The switcher both leads with this tab and starts cycling from it, so one
   * Control+Tab out of the browser lands on the surface the user was on before
   * it, and one Control+Tab back into the browser always reaches the tab they
   * left instead of sending them to the mouse.
   */
  currentBrowserTabId = $derived.by(() => {
    if (this.root.props.active) return null
    const browser = browserStore()
    return browser?.opened ? browser.activeTabId : null
  })

  recentSwitcherEntries = $derived.by(() =>
    buildThreadSwitcherEntries({
      // One recency order across every switchable surface: a project thread, a
      // chat, an assistant task, an open browser tab or a panel tab, interleaved
      // by when each was last visited.
      visits: recentVisits.all,
      threads: this.root.createThreadInProject.allThreads.filter((thread) => !thread.archived),
      tabs: switcherBrowserTabs(),
      panelTabs: this.switcherPanelTabs,
      currentBrowserTabId: this.currentBrowserTabId
    })
  )

  /**
   * The panel tabs the switcher may list: the open terminal, file and
   * thread-browser tabs of the active context, each gated by its setting so a
   * user who does not want a panel's tabs in the switcher never sees them. The
   * empty "Open file" browser a Files panel starts on is not a file the user
   * opened and is left out.
   */
  switcherPanelTabs = $derived.by(() => {
    const includeTerminal = appConfigState.switcherTerminalTabs
    const includeFiles = appConfigState.switcherFileTabs
    const includeBrowser = appConfigState.switcherThreadBrowserTabs
    if (!includeTerminal && !includeFiles && !includeBrowser) return []
    return contextSidebarState.tabs.filter((tab): tab is SwitcherPanelTab => {
      if (tab.kind === 'terminal') return includeTerminal
      if (tab.kind === 'files') return includeFiles && tab.fileTabId !== null
      if (tab.kind === 'browser') return includeBrowser
      return false
    })
  })

  /** The entry the switcher starts cycling from: the active browser tab while the
   *  browser view is on screen, otherwise the selected thread. */
  switcherSelectedKey = $derived.by(() => {
    if (this.currentBrowserTabId) return browserTabVisitKey(this.currentBrowserTabId)
    const thread = this.root.openThreadFromSwitcher.selectedThread
    return thread ? threadVisitKey(thread) : null
  })

  unpinnedTimelineThreads = $derived(this.root.markThreadReadAndApply.timelineLists.statusListed)

  /** New thread inside the board's active scope bucket. */
  newThreadInScopeContext(): void {
    const context = scopeState.sidebarContext
    const project = this.root.createThreadInProject.projects.find(
      (candidate) => candidate.id === context?.projectId
    )
    if (!context || !project) return
    void this.root.createThreadInProject.createThreadInProject(project, context.bucketId)
  }

  /**
   * Draft refs a pass already resolved as unreachable for a reason that is
   * reversible, so one app run asks about each exactly once.
   *
   * A thread that was archived, or that is an orchestration child, is excluded
   * from the listing by design and can be unarchived later, so its draft has to
   * survive. But re-asking on every pass is what turned a stored draft into a
   * per-switch cost: the sidebar refresh runs on every return to the workspace,
   * and each pass re-fetched the same rows to reach the same verdict. A ref that
   * becomes reachable again shows up in `allThreads`, which the candidate check
   * already skips, so remembering the verdict can never hide a live draft.
   */
  unreachableDraftRefs = new SvelteSet<string>()

  /** One draft ref's identity as a set key. */
  draftRefKey(projectId: string, threadId: string): string {
    return `${projectId}:${threadId}`
  }

  /** How many draft refs are resolved at once. Draft rescue only ever fetches
   *  refs the bounded slice did not cover, which is small once the dead ones are
   *  gone, but it must not become a serial waterfall or a burst that hammers the
   *  single-flight database worker when it is not. */
  DRAFT_RESCUE_CONCURRENCY = 8

  /**
   * Threads whose unsent composer content fell outside the bounded first-paint
   * hydration - drafts persist in renderer storage only (never the DB), so the
   * SQL slice cannot know about them. Drafts load unbounded, like unread:
   * each is fetched with `thread:get` and merged into both the project-list
   * (`allThreads`) and the scope store so it shows everywhere immediately,
   * pinned to its project list via the draft sort.
   *
   * The fetch is where this used to cost a third of a second on every return to
   * the workspace: one `thread:get` per stored draft, awaited in sequence, for a
   * set that only ever grew because a draft whose thread had been deleted was
   * never dropped. A ref whose row is gone is now forgotten on the spot, other
   * verdicts are remembered for the run, and the refs that remain are resolved a
   * few at a time.
   */
  rescuingDraftThreads = false

  /** Whether a project's sidebar list still has unfetched older rows in the DB. */
  projectHasMoreInDb(projectId: string): boolean {
    return !this.projectExhausted.has(projectId)
  }

  async handleProjectCreated(project: Project): Promise<void> {
    this.root.createThreadInProject.projects = [
      project,
      ...this.root.createThreadInProject.projects
    ]
    this.sidebar.expandedFolders.add(project.id)
    if (project.icon) {
      const url = await invoke('project:getIcon', project.id)
      if (url) this.root.createThreadInProject.projectIcons.set(project.id, url)
    } else {
      // Still add an entry so the iconUrl check resolves correctly
      this.root.createThreadInProject.projectIcons.delete(project.id)
    }
    // Land the user in a fresh thread with the new project selected.
    await this.root.createThreadInProject.createThreadInProject(project)
  }

  handleExistingProject(project: Project): void {
    this.sidebar.expandedFolders.add(project.id)
  }

  /** Open the task and dock its note panel in the context sidebar. */
  openAssistantTaskNotes(task: Thread): void {
    this.root.markThreadReadAndApply.openAssistantTask(task)
    contextSidebarState.openThreadNote(task.projectId, task.id, task.title, {
      edit: true,
      focusEditor: true
    })
  }

  /**
   * Hide an assistant's knowledge thread. Hiding is the only state the thread can
   * change: it stays pinned, so archiving it is what takes it out of the
   * sidebar until the knowledge panel reveals it again.
   */
  async hideAssistantKnowledge(task: Thread): Promise<void> {
    if (!task.assistantId) return
    try {
      const updated = await assistants.setKnowledgeHidden(task.assistantId, true)
      this.root.createThreadInProject.upsertThreadInList(updated)
      scopeState.updateThread(updated)
    } catch (error) {
      reportError(error, 'Could not hide the assistant behavior thread')
    }
  }

  async openScopedThread(thread: Thread): Promise<void> {
    const context = scopeState.sidebarContext
    if (context) scopeState.showSidebarForThread(thread, context.bucketId)
    await this.root.openThreadFromSwitcher.openThread(thread)
  }

  async handleRename(thread: Thread, newName: string): Promise<void> {
    const updated = await invoke('thread:update', thread.projectId, thread.id, {
      title: newName,
      titleSource: 'manual'
    })
    this.root.createThreadInProject.upsertThreadInList(updated)
    workspaceState.updateThread(updated)
  }

  async handleDelete(thread: Thread): Promise<void> {
    this.root.createThreadInProject.allThreads = this.root.createThreadInProject.allThreads.filter(
      (t) => t.id !== thread.id
    )
    scopeState.removeThread(thread.id)
    if (this.root.openThreadFromSwitcher.selectedThread?.id === thread.id)
      workspaceState.clearThread()
    try {
      await invoke('thread:delete', thread.projectId, thread.id)
    } catch (error) {
      this.root.createThreadInProject.upsertThreadInList(thread)
      scopeState.updateThread(thread)
      reportError(error, 'The thread could not be deleted.')
    }
  }

  async forkThread(thread: Thread): Promise<void> {
    const forked = await invoke(
      'thread:fork',
      thread.projectId,
      thread.id,
      `${thread.title} (fork)`
    )
    scopeState.updateThread(forked)
    if (scopeState.sidebarContext?.projectId === forked.projectId) {
      scopeState.showSidebarForThread(forked, scopeState.sidebarContext.bucketId)
    }
    // Land the fork in the view that owns it, exactly like every other created
    // thread: an assistant fork belongs in Assistant View, not in whatever view
    // happened to be on screen when it was made.
    this.openCreatedThread(forked)
  }

  /** A message-level fork succeeded inside the thread view   surface and open it. */
  handleForkedThread(forked: Thread): void {
    this.openCreatedThread(forked)
  }

  /** Register a thread that arrived from another view, then hand it to the shell
   *  so it lands in the view that owns it with its composer focused. A chat
   *  continued into a project, an assistant task handed off, and a side chat
   *  promoted to a thread all arrive while a view of another family is on screen,
   *  so selecting the thread without moving used to leave it open invisibly. */
  openCreatedThread(thread: Thread): void {
    this.root.createThreadInProject.upsertThreadInList(thread)
    scopeState.updateThread(thread)
    workspaceState.openThreadInOwningView(
      thread,
      this.root.createThreadInProject.projects.find((p) => p.id === thread.projectId) ?? null
    )
  }

  /** A chat was continued into a project   register the thread and open it there. */
  handleContinuedInProject(forked: Thread): void {
    this.openCreatedThread(forked)
  }

  /** An assistant task was forked to a project: open it in the projects view. */
  handleAssistantHandoff(forked: Thread): void {
    this.openCreatedThread(forked)
  }

  /** Register a freshly added project without landing in a new thread   used by
   *  the continue-chat-in-project flow which creates its own thread. */
  async handleChatProjectCreated(project: Project): Promise<void> {
    this.root.createThreadInProject.projects = [
      project,
      ...this.root.createThreadInProject.projects
    ]
    this.sidebar.expandedFolders.add(project.id)
    if (project.icon) {
      const url = await invoke('project:getIcon', project.id)
      if (url) this.root.createThreadInProject.projectIcons.set(project.id, url)
    } else {
      this.root.createThreadInProject.projectIcons.delete(project.id)
    }
  }

  /**
   * Promote a side chat (quick chat) into a regular thread: the conversation
   * is persisted as a new thread and opened so the user can keep prompting.
   */
  async handleContinueInThread(tab: TemporaryChatContextTab): Promise<void> {
    const converted = await invoke(
      'temporary-chat:convertToThread',
      tab.projectId,
      tab.threadId,
      tab.temporaryChatId,
      tab.settings
    )
    contextSidebarState.close(tab.id)
    this.openCreatedThread(converted)
  }
}
