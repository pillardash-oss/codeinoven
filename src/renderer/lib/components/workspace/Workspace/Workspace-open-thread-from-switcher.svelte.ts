import { contentThreadFamily } from '$lib/content-view-threads'
import { invoke } from '$lib/ipc.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { browserStore, loadBrowser } from '$lib/stores/browser-access.svelte'
import { browserAddressFocus } from '$lib/stores/browser-address-focus'
import { contextSidebarState, type ContextSidebarTab } from '$lib/stores/context-sidebar.svelte'
import { coordinatorDockState } from '$lib/stores/coordinator-dock.svelte'
import { designCoordinatorState } from '$lib/stores/design-coordinator.svelte'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { pinnedFold } from '$lib/stores/pinned-fold.svelte'
import { threadUnreadIntent } from '$lib/stores/thread-unread-intent'
import { workspaceState } from '$lib/stores/workspace.svelte'
import type { AgentPart, Thread } from '$shared/types'
import {
  activeThreadRowId,
  coordinatorHasActiveDelegates,
  INBOX_PROJECT_ID,
  isThreadBusy,
  threadTracksReadStatus,
  usesThreadWorkspaceMount
} from '$shared/types'
import { tick } from 'svelte'
import type { ProjectFamilyLanding } from '../../layout/AppHeaderNavigationController.svelte'
import { type ContextDockItem } from '../../layout/ContextDock.svelte'
import { type ThreadSwitcherEntry } from '../../threads/thread-switcher-entries'
import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceOpenThreadFromSwitcher {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root)
      throw new Error('WorkspaceOpenThreadFromSwitcher read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  /** The reader has taken over the scroll for the current thread. Cleared when
   *  they pick another thread, move to another mode, or scroll the active row
   *  back into view. */
  sidebarReaderOwnsScroll = $state(false)

  findThreadRow(threadId: string): HTMLElement | null {
    if (typeof document === 'undefined') return null
    const root = this.root.switcherPanelTabs.sidebarScroller ?? document
    // Only the active sidebar mode is mounted, so this resolves to the active
    // row without traversing duplicate hidden lists.
    const rows = root.querySelectorAll<HTMLElement>(`[data-thread-row="${threadId}"]`)
    for (const row of rows) {
      if (row.offsetParent !== null || row.getClientRects().length > 0) return row
    }
    return null
  }

  /**
   * Bring a thread's row into view.
   *
   * `force` is for the pin of the thread in focus (see `togglePin`): that row is
   * the one the reader is reading, so a pin re-hosting it between the Pinned
   * section and its own list is followed wherever it goes. The forced reveal
   * therefore takes the scroll over (the same hold the reader's own gesture
   * takes, which is also what keeps the focus-follow effect from pulling the
   * list back a frame later) and keeps correcting until the row is actually
   * visible rather than merely rendered, because the move is animated.
   *
   * The default honours the reader's hold on the scroll: a row already in view
   * stays put, and this run gives the scroll back to the thread.
   */
  async revealThreadInSidebar(thread: Thread, force = false): Promise<void> {
    // A reveal the user asked for is the reader handing the scroll over: they
    // are looking for this row now. Taking the hold here is also what keeps the
    // focus-follow effect from pulling the list back to the active thread's row
    // a frame later, which is what used to undo this scroll.
    if (force) this.sidebarReaderOwnsScroll = true
    // The row can only be measured once it is rendered, so prepare it first.
    this.root.switcherPanelTabs.prepareThreadRow(thread)
    // Flush Svelte's DOM update (folder expansion / mode switch / re-sort), then
    // scroll   the first attempt lands before the next paint. Retry over a few
    // frames because the folder's rows can mount a tick later than expected
    // in Projects mode the row only appears once the folder has expanded.
    await tick()
    for (let attempt = 0; attempt < 12; attempt++) {
      // The first attempt runs in the same task as the DOM update, before the
      // next paint, so the incoming list never shows the outgoing mode's scroll
      // position for a frame. The later frames only serve rows that mount a tick
      // late (a folder expanding to reveal the row it holds).
      if (attempt > 0) await this.root.switcherPanelTabs.nextAnimationFrame()
      this.root.switcherPanelTabs.scrollThreadRowIntoView(thread.id)
      if (
        force
          ? this.root.switcherPanelTabs.isThreadRowVisible(thread.id)
          : this.findThreadRow(thread.id)
      )
        break
    }
  }

  /** Selection + terminal state live in the shared store (drives the app header). */
  selectedThread = $derived(workspaceState.selectedThread)

  activeProject = $derived(workspaceState.activeProject)

  selectedThreadHasDraft = $derived(
    this.selectedThread
      ? rendererRecovery.hasDraftContent(this.selectedThread.projectId, this.selectedThread.id)
      : false
  )

  async openFiles(): Promise<void> {
    if (!this.selectedThread) return
    if (this.selectedThread.settings?.ovenId && this.selectedThread.settings.ovenId !== 'local') {
      projectFilesWorkspace.setThreadMount(this.selectedThread.projectId, this.selectedThread.id)
      // Open first and read after. The read is an SSH round trip that can outlast
      // the click that asked for it, so awaiting it here made a down Oven look
      // like a dead button. Opened first, the panel shows its loading layer and,
      // when the Oven cannot answer, the reason with a retry.
      contextSidebarState.openFiles(this.selectedThread.projectId, this.selectedThread.id)
      void projectFilesWorkspace.loadDirectory(this.selectedThread.projectId, '')
      return
    }
    // Conversations browse their own app-owned workspace directory instead of a
    // project root (a chat's artifact directory, an assistant task's working
    // directory); the mount must be registered before the root listing.
    if (usesThreadWorkspaceMount(this.selectedThread.projectId)) {
      projectFilesWorkspace.ensureState(this.selectedThread.projectId)
      projectFilesWorkspace.setThreadMount(this.selectedThread.projectId, this.selectedThread.id)
      await projectFilesWorkspace.loadDirectory(this.selectedThread.projectId, '')
      contextSidebarState.openFiles(this.selectedThread.projectId, this.selectedThread.id)
      return
    }
    if (this.activeProject?.source !== 'local' || !this.activeProject.path) return
    await projectFilesWorkspace.loadDirectory(this.selectedThread.projectId, '')
    contextSidebarState.openFiles(this.selectedThread.projectId, this.selectedThread.id)
  }

  openDiff(): void {
    if (!this.selectedThread) return
    if (
      !(this.selectedThread.settings?.ovenId && this.selectedThread.settings.ovenId !== 'local') &&
      (this.activeProject?.source !== 'local' || !this.activeProject.path)
    )
      return
    contextSidebarState.openDiff(this.selectedThread.projectId, this.selectedThread.id)
  }

  openNewTerminal(): string | null {
    if (!this.selectedThread) return null
    return contextSidebarState.openNewTerminal(
      this.selectedThread.projectId,
      this.selectedThread.id
    )
  }

  /**
   * Open one new browser tab and settle every surface that shows a browser tab
   * on it: the sidebar strip, the full screen overlay while it is up, and the
   * caret in the address bar.
   *
   * The strip's create button and the browser's own new-tab chord are the same
   * request, so they share this. They could not always: the chord is claimed in
   * the page's `before-input-event` and comes back as a panel shortcut, because
   * a key pressed in a native page never arrives as a DOM event. Answering it
   * separately is how it came to open a tab the full screen overlay never
   * showed, and every step below would have to be written twice from then on.
   *
   * A new tab starts blank: no URL is loaded, the address bar stays empty, and
   * the page only loads once the user types an address. It takes the keyboard
   * with it, so the user can start typing without reaching for the address bar
   * first.
   *
   * `sourceTab` names the container when the request came from a page: the tab
   * the chord was pressed in owns the conversation the new tab joins, so a key
   * can never open a tab in a strip the user is not looking at. A click, and a
   * chord pressed in the sidebar's own chrome, name nothing and take the
   * conversation on screen.
   */
  openNewBrowserTab(sourceTab?: Extract<ContextSidebarTab, { kind: 'browser' }>): void {
    const tabId = sourceTab
      ? contextSidebarState.openBrowserForContext(
          '',
          sourceTab.projectId,
          sourceTab.threadId,
          undefined,
          true
        )
      : contextSidebarState.openBrowser('')
    if (!tabId) return
    // The overlay records the tab it is showing separately from the strip, so it
    // has to be told. It is up only while one of its tabs is on screen, which is
    // exactly when this is the surface the user is looking at.
    if (this.browserFullscreenTabId) this.browserFullscreenTabId = tabId
    browserAddressFocus.request(tabId)
  }

  openDebugger(): void {
    if (!this.selectedThread || !import.meta.env.DEV) return
    contextSidebarState.openDebugger(this.selectedThread.projectId, this.selectedThread.id)
  }

  openSourcesTab(): void {
    if (!this.selectedThread) return
    if (
      contextSidebarState.sidebarVisible &&
      contextSidebarState.sidebarActiveTab?.kind === 'sources'
    ) {
      contextSidebarState.hide()
      return
    }
    contextSidebarState.openSources(this.selectedThread.projectId, this.selectedThread.id)
  }

  openActionsTab(): void {
    if (!this.selectedThread) return
    contextSidebarState.openActions(this.selectedThread.projectId, this.selectedThread.id)
  }

  openCloudDeploymentsTab(): void {
    if (!this.selectedThread) return
    contextSidebarState.openCloudDeployments(this.selectedThread.projectId, this.selectedThread.id)
  }

  /**
   * Cmd/Ctrl+Shift+S toggles the whole right sidebar instead of one tool: it
   * hides whatever is on screen, or brings back the tool the user last had
   * selected there. Nothing selected yet means there is nothing to bring back,
   * so the file tree opens when the thread on screen has one and otherwise the
   * first tool the context rail offers, which is exactly what that rail icon
   * would do.
   */
  toggleContextSidebar(): void {
    if (contextSidebarState.toggleLastSelected()) return
    if (this.fileTreeAvailable) {
      void this.openFiles()
      return
    }
    this.root.switcherPanelTabs.firstContextTool()?.onSelect()
  }

  openMemoryTab(): void {
    if (!this.selectedThread) return
    contextSidebarState.openMemory(
      this.selectedThread.projectId,
      this.selectedThread.id,
      undefined,
      this.selectedThread.assistantId
    )
  }

  /** The coordinator published by the thread on screen, if it coordinates work.
   *  A worker/auditor child publishes under its coordinator's id, so the panel
   *  stays docked as the user moves between its children. */
  coordinator = $derived(
    coordinatorDockState.forThread(
      this.selectedThread?.projectId,
      activeThreadRowId(this.selectedThread)
    )
  )

  /** The auditor thread of the on-screen coordinator, if one exists. Orchestration
   *  children stay out of the visible thread list but land in the scope store
   *  through their broadcast updates, so the rail can mirror their state. */
  auditorThread = $derived.by(() => {
    const auditorId = this.selectedThread?.auditorThreadId
    if (!auditorId) return null
    return scopeState.allScopeThreads.find((candidate) => candidate.id === auditorId) ?? null
  })

  /** Rail badge for the coordinator dock item, mirroring the auditor's live
   *  state so a hidden context sidebar still reports working / error / done. */
  coordinatorRailBadge = $derived.by((): ContextDockItem['badge'] => {
    if (!this.selectedThread) return undefined
    const auditor = this.auditorThread
    if (auditor?.status === 'failed') return 'error'
    if (auditor?.status === 'awaiting_approval') return 'attention'
    // A usage-limit wait parks the auditor in `working-paused` (the scheduled
    // auto-resume), which reads as "will retry", not actively working.
    if (auditor?.status === 'working-paused') return 'working-paused'
    if (
      this.selectedThread.auditState === 'report_ready' &&
      (auditor === null || auditor.status === 'completed')
    ) {
      return 'done'
    }
    if (coordinatorHasActiveDelegates(this.selectedThread, scopeState.allScopeThreads))
      return 'working'
    if (
      auditor &&
      (isThreadBusy(auditor) ||
        (agentRuns.hasSettled(auditor.projectId, auditor.id) &&
          agentRuns.isBusy(auditor.projectId, auditor.id)))
    ) {
      return 'working'
    }
    return undefined
  })

  openCoordinatorTab(): void {
    if (!this.coordinator) return
    coordinatorDockState.restore(this.coordinator.projectId, this.coordinator.threadId)
    contextSidebarState.openCoordinator(
      this.coordinator.projectId,
      this.coordinator.threadId,
      this.coordinator.label
    )
  }

  /**
   * Show the project's authored work on the thread the user is already on.
   *
   * The rail's design or video entry belongs to the project, not to a session, so
   * it opens the board for the kind the user picked even though this thread is not
   * in that session. The user reviews the work without hunting for the thread that
   * made it.
   */
  authoredWorkActive(kind: 'design' | 'video'): boolean {
    if (
      !this.selectedThread ||
      !this.root.switcherPanelTabs.dockKindActive('coordinator') ||
      this.coordinator?.panel.component !== 'design'
    ) {
      return false
    }
    const shownKind =
      this.coordinator.panel.props.kind ??
      designCoordinatorState.stateFor(this.selectedThread.projectId, this.selectedThread.id)?.kind
    return shownKind === kind
  }

  openAuthoredWork(kind: 'design' | 'video'): void {
    const thread = this.selectedThread
    if (!thread) return
    if (this.authoredWorkActive(kind)) {
      contextSidebarState.hide()
      return
    }
    designCoordinatorState.openBoard(thread.projectId, thread.id, kind)
  }

  /** Terminals toggle their own region: the bottom dock when docked there,
   *  otherwise the right sidebar like every other tool. */
  toggleTerminal(): void {
    const thread = this.selectedThread
    if (!thread) return
    if (thread.settings?.ovenId && thread.settings.ovenId !== 'local') {
      this.root.switcherPanelTabs.toggleDockPanel('oven', () =>
        contextSidebarState.openOven(thread.projectId, thread.id)
      )
      return
    }

    if (contextSidebarState.terminalPlacement === 'bottom') {
      // The bottom dock is an independent region, so the rail toggles the dock
      // itself   never the focused tab. Whether a terminal happens to hold the
      // global focus is irrelevant: if the dock exists in any form it folds
      // away, and only a dock with no terminals at all opens a fresh shell.
      if (contextSidebarState.terminalDockVisible || contextSidebarState.terminalDockCollapsed) {
        contextSidebarState.toggleTerminalDock()
        return
      }
      contextSidebarState.openPrimaryTerminal(thread.projectId, thread.id)
      return
    }

    // Docked to the right, the terminal is just another sidebar panel.
    const sidebarTab = contextSidebarState.sidebarActiveTab
    const terminalFocused =
      sidebarTab?.kind === 'terminal' &&
      sidebarTab.projectId === thread.projectId &&
      sidebarTab.threadId === thread.id

    if (contextSidebarState.sidebarVisible && terminalFocused) {
      contextSidebarState.hide()
    } else {
      contextSidebarState.openPrimaryTerminal(thread.projectId, thread.id)
    }
  }

  /** Workspace tools target either a local project or the selected Oven. */
  projectToolsAvailable = $derived(
    Boolean(
      (this.activeProject?.source === 'local' && this.activeProject.path) ||
      (this.selectedThread?.settings?.ovenId && this.selectedThread.settings.ovenId !== 'local')
    )
  )

  /** Whether the file tree can be opened for the thread on screen: a local
   *  project with a real path, or a conversation that owns its own workspace
   *  directory (a chat's artifact directory, an assistant task's working
   *  directory). */
  fileTreeAvailable = $derived(
    Boolean(
      this.selectedThread &&
      (usesThreadWorkspaceMount(this.selectedThread.projectId) || this.projectToolsAvailable)
    )
  )

  openNestedSubagent(part: Extract<AgentPart, { type: 'subagent' }>): void {
    if (!this.selectedThread) return
    contextSidebarState.openSubagent(
      this.selectedThread.projectId,
      this.selectedThread.id,
      part.id,
      part.activity
    )
  }

  terminalFullscreenTabId = $state<string | null>(null)

  browserFullscreenTabId = $state<string | null>(null)

  /** Close a tab from a fullscreen strip without tearing the fullscreen down
   *  unless it was the last tab of that kind. */
  closeFullscreenTab(kind: 'terminal' | 'browser', tabId: string): void {
    this.closeContextTab(tabId)
    if (kind === 'terminal') {
      // Nothing left of that kind: the surface has no tab to show, so the record
      // has to go with it rather than point at the tab that just closed.
      const remaining = contextSidebarState.tabs.filter(
        (tab) => tab.kind === 'terminal' && tab.id !== tabId
      )
      this.terminalFullscreenTabId = remaining.at(-1)?.id ?? null
      return
    }
    // The store already fell back when the tab closed, so its active browser tab
    // is the one to show. Reading it here instead of the last browser-kind tab
    // keeps the overlay inside the conversation on screen even while other
    // projects' browser tabs are open, and nulls it when nothing is left.
    this.browserFullscreenTabId = contextSidebarState.activeBrowserTabId
  }

  /**
   * Whether the keep-mounted Git panel is the surface the user is looking at.
   *
   * A remote thread has no turn checkpoints, because those track writes this app
   * made locally, so its Changes tab shows the Oven’s own Git state through this
   * same panel instead of mounting a second one.
   */
  gitPanelVisible = $derived.by(() => {
    const tab = contextSidebarState.sidebarActiveTab
    if (!tab) return false
    if (tab.kind === 'git') return true
    if (tab.kind !== 'diff' || !('projectId' in tab)) return false
    const ovenId = this.selectedThread?.settings?.ovenId
    return !!ovenId && ovenId !== 'local' && tab.projectId === this.selectedThread?.projectId
  })

  /** Show one context tab fullscreen. Only one surface can own the window, so
   *  opening one closes the other kind instead of leaving two full screen dialogs
   *  stacked, where the lower one's suppression block would blank the browser's
   *  native view. */
  openTabFullscreen(tabId: string): void {
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === tabId)
    if (tab?.kind === 'browser') {
      this.root.switcherPanelTabs.browserFullscreenThreadId = this.selectedThread?.id ?? null
      this.browserFullscreenTabId = tabId
      this.terminalFullscreenTabId = null
    }
    if (tab?.kind === 'terminal') {
      this.terminalFullscreenTabId = tabId
      this.browserFullscreenTabId = null
    }
  }

  closeContextTab(id: string): void {
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    if (tab.kind === 'files' && tab.fileTabId) {
      const pending = this.root.mergeThreadsInList.pendingFileCloseTarget(tab)
      if (pending) {
        this.root.switcherPanelTabs.closeTabTarget = pending
        return
      }
    }
    this.closeContextTabNow(id, tab)
  }

  closeContextTabNow(id: string, tab: ContextSidebarTab): void {
    if (tab.kind === 'files' && tab.fileTabId) {
      projectFilesWorkspace.closeTab(tab.projectId, tab.fileTabId)
    }
    // Closing the coordinator is a dismissal for this thread, remembered across
    // restarts: it stays undocked until the user brings it back from the rail.
    if (tab.kind === 'coordinator') coordinatorDockState.dismiss(tab.projectId, tab.threadId)
    if (tab.kind === 'browser') {
      // A thread browser tab that is closed takes its Back/Forward stack out of
      // the strip with it, but main keeps it in the session's reopen set so
      // Cmd/Ctrl+Shift+T can bring the tab back on the page it was left on.
      // Quitting the app clears that set. There is no hibernation on this surface,
      // so a destroy here is otherwise the tab really going away.
      browserStore()?.closeSourcePeek(tab.id)
      void invoke('browser:destroy', tab.id, 'closed')
    }
    // Symmetric with the browser: closing the terminal that is showing fullscreen
    // would otherwise leave the fullscreen record pointing at a tab that is gone.
    if (tab.kind === 'terminal' && this.terminalFullscreenTabId === tab.id) {
      this.terminalFullscreenTabId = null
    }
    contextSidebarState.close(id)
    if (tab.kind === 'browser' && this.browserFullscreenTabId === tab.id) {
      this.browserFullscreenTabId = contextSidebarState.activeBrowserTabId
    }
    if (tab.kind === 'temporary-chat') {
      void invoke('agent:closeTemporaryChat', tab.temporaryChatId)
    }
  }

  /**
   * Pinning puts a row in a section of its own, at the top of the sidebar (and
   * unpinning sends it back into the list it came from), so the thread's row is
   * re-hosted somewhere else in the DOM either way.
   *
   * The scroll does not follow that move on its own: the sort key driving the
   * follow effect reads the status bucket, not the pinned flag, and a list
   * reorder commits no status. So a pin used to leave the sidebar where it was,
   * hiding the very row the user had just pinned   and a folded Pinned section
   * did not draw the row at all. Open the section the row will land in, so it
   * has somewhere to be drawn, and let the caller reveal it afterwards.
   */
  openPinnedSection(thread: Thread): void {
    if (this.root.props.mode === 'assistant') {
      pinnedFold.setFolded('assistant', false)
      return
    }
    // The row lands in the section named for the view's own thread kind: the
    // Threads view owns the flat timeline's pinned block, Chats owns the inbox's
    // chats, and Projects owns its project threads. `setFolded` is a no-op when
    // the section is already open, so nothing is written for a reader who keeps
    // it that way.
    const section =
      this.root.props.mode === 'threads'
        ? 'threads'
        : thread.projectId === INBOX_PROJECT_ID
          ? 'chats'
          : 'projects-threads'
    pinnedFold.setFolded(section, false)
  }

  async deleteProject(projectId: string, deleteFolder = false): Promise<void> {
    if (this.root.createThreadInProject.projectDialogs.deletingProjectId !== null) return
    const project = this.root.createThreadInProject.projects.find((p) => p.id === projectId)
    if (!project) return
    this.root.createThreadInProject.projectDialogs.deletingProjectId = projectId

    // Deletion is transactional: the backend either deletes everything or
    // nothing (folder erasure runs first and gates every other step). The UI
    // mirrors the change only after the backend confirms success, so a failed
    // deletion leaves the sidebar, threads, and icon exactly as they were.
    try {
      await invoke('project:delete', projectId, { deleteFolder })
    } catch (error) {
      reportError(error, 'The project could not be deleted.')
      return
    } finally {
      this.root.createThreadInProject.projectDialogs.deletingProjectId = null
    }

    // Backend deletion succeeded; now mirror it in the UI state.
    const browserTabIds = contextSidebarState.removeProjectBrowsers(projectId)
    if (this.browserFullscreenTabId && browserTabIds.includes(this.browserFullscreenTabId)) {
      this.browserFullscreenTabId = null
    }
    this.root.createThreadInProject.projects = this.root.createThreadInProject.projects.filter(
      (p) => p.id !== projectId
    )
    this.root.createThreadInProject.allThreads = this.root.createThreadInProject.allThreads.filter(
      (t) => t.projectId !== projectId
    )
    this.root.createThreadInProject.projectIcons.delete(projectId)
    // The shared scope state feeds the spotlight, the project switcher and the
    // scope board. Leaving the deleted project there keeps offering a project
    // and threads that no longer exist, and makes re-adding the same folder
    // look like a duplicate.
    scopeState.removeProject(projectId)
    this.root.switcherPanelTabs.sidebar.expandedFolders.delete(projectId)
    if (this.selectedThread?.projectId === projectId) workspaceState.clearThread()
    // Best-effort teardown of the project's browser sessions. The project is
    // already gone backend-side, so a failure here must not roll the UI back.
    void invoke('browser:destroyProject', projectId).catch(() => {})
  }

  openThread(thread: Thread): void {
    workspaceState.openThread(
      thread,
      this.root.createThreadInProject.projects.find((p) => p.id === thread.projectId) ?? null
    )
    void scopeState.ensureBoardLoaded(thread.projectId)
    // Opening a thread is the signal that ends a deliberate unread mark.
    threadUnreadIntent.clear(thread.id)
    if (threadTracksReadStatus(thread))
      this.root.markThreadReadAndApply.markThreadReadAfterPaint(thread)
    // Reveal immediately and again once any read-state update re-sorts the list.
    this.revealThreadInSidebar(thread)
  }

  /**
   * A Ctrl+Tab selection is a deliberate jump to one specific thread, so the
   * shell lands in the view that owns that thread's family: a chat is only ever
   * shown by Chats, an assistant task only by Assistant, and a project thread by
   * whichever project view the user last used (Projects, Threads, Scoped or
   * Board), because that is the view the rail's project badge rides. Without
   * this the switcher could select a thread in a view that does not own it,
   * leaving the wrong sidebar and that view's own tools on screen for it.
   */
  async openThreadFromSwitcher(thread: Thread): Promise<void> {
    const family = contentThreadFamily(thread)
    // The switcher can be opened from the browser view, where Ctrl+Tab is
    // claimed inside a page, or from Settings: the shell is mounted but not the
    // on-screen view. A project thread then has to bring the shell forward,
    // because `mode` still reads the last content view and the guard below would
    // change only a selection nobody can see, leaving the browser (or Settings)
    // on screen. On the Scope page the landing resolves to the page itself, so a
    // switch made there stays on the board and only follows the picked project.
    const shellHidden = !this.root.props.active && !this.root.props.scopeViewActive
    /** Whether the landing selected the thread already, because it needed to. */
    let openedThread = false
    /** The project family's landing when this jump re-enters it, else null. */
    let projectLanding: ProjectFamilyLanding | null = null
    if (family === 'chats') this.root.props.navigate('chats')
    else if (family === 'assistant') this.root.props.navigate('assistant')
    else if (
      this.root.props.mode === 'chats' ||
      this.root.props.mode === 'assistant' ||
      shellHidden
    ) {
      // A project thread can be shown by several project views, so the jump
      // returns to the one the user last used (the view the rail's project
      // badge rides) instead of resetting to the default Projects view.
      projectLanding = this.root.props.lastProjectViewLanding()
      if (projectLanding === 'threads') this.root.props.navigate('threads')
      else if (projectLanding === 'scope') {
        // The Scope page activates the open thread's project, so the thread is
        // selected before the page is entered; otherwise the board would follow
        // the thread the user left instead of the one they picked.
        await this.openThread(thread)
        openedThread = true
        this.root.props.navigate('scope')
      } else this.root.props.navigate('projects')
    }
    // The scope store reads its own activeProjectId / sidebarContext, not the
    // workspace selection, so a cross-project Ctrl+Tab jump must sync it
    // otherwise the scope view tabs and the scope-state sidebar stay stuck on
    // the previous project. On the Scope page the view itself follows the
    // thread's project; an active scope-state sidebar follows the thread and
    // its own scope bucket. Only the projects family has a scope state.
    if (family === 'projects') {
      if (this.root.props.scopeViewActive) {
        void scopeState.activateProject(thread.projectId)
      } else if (projectLanding === 'scoped' || scopeState.sidebarContext) {
        // The scoped state is the projects view carrying the scope sidebar: the
        // sidebar is what the rail reports as Scoped, so a landing there has to
        // bring it back focused on the thread the user picked.
        scopeState.showSidebarForThread(thread)
      }
    }
    if (!openedThread) await this.openThread(thread)
    // A Ctrl+Tab selection is a deliberate jump to a specific thread: the reader
    // hands the sidebar scroll back here, and the row is revealed once the mode
    // switch has settled the incoming list.
    this.sidebarReaderOwnsScroll = false
    void tick().then(() => this.revealThreadInSidebar(thread))
  }

  /**
   * Open whatever the Ctrl+Tab switcher landed on. A browser entry reveals the
   * browser view and switches to that tab, which also hands the page the keyboard
   * (or opens a blank tab's address spotlight); a thread entry takes the same path
   * it always did, landing in the view that owns the thread's family.
   */
  async openSwitcherEntry(entry: ThreadSwitcherEntry): Promise<void> {
    if (entry.kind === 'browser') {
      this.root.props.navigate('browser')
      // An entry for a browser tab only exists once the browser is loaded, so
      // this resolves immediately; asking through the access seam is what keeps
      // that fact out of this component's imports.
      void loadBrowser().then((browser) => browser.switchTo(entry.tab.id))
      return
    }
    if (entry.kind === 'panel') {
      // A panel tab lives in the workspace surface (the right sidebar or the
      // bottom terminal dock), so leave the full screen browser first, exactly as
      // opening a project file does, then focus the tab so its panel reveals.
      if (!this.root.props.active) this.root.props.navigate(this.root.props.mode)
      contextSidebarState.focus(entry.tab.id)
      return
    }
    await this.openThreadFromSwitcher(entry.thread)
  }

  async togglePin(thread: Thread): Promise<void> {
    // A pin re-hosts the row into the Pinned section and an unpin sends it back
    // into its own list, so both directions move it in the DOM. Open the section
    // that will hold it   a folded one would not draw the row at all, so the pin
    // would look like it did nothing (see `openPinnedSection`). The unfold is
    // unconditional: it is content, not the viewport, that has to change for the
    // row to land anywhere, and the browser's own scroll anchoring keeps the
    // reader's place through a section opening above them.
    //
    // The scroll belongs to the thread in focus, so only that thread's pin moves
    // the viewport. Pinning the row the reader is reading re-hosts it out from
    // under them, and the reveal puts it back on screen; pinning anybody else's
    // row moves a row they are not looking at, and the list stays exactly where
    // they left it.
    const isFocusedThread =
      this.selectedThread !== null && activeThreadRowId(this.selectedThread) === thread.id
    if (!isFocusedThread) {
      // Nobody else's pin moves this viewport, not even through this update: the
      // follow effect would pull the list back to the active row the moment that
      // row is out of view, which is a scroll the user never asked for. Taking
      // the reader's hold says what their own gesture says   they are driving
      // this list right now   and the hold is handed back the moment they pick
      // another thread or the active row comes into view.
      this.sidebarReaderOwnsScroll = true
    }
    this.openPinnedSection(thread)
    const updated = thread.bookmarked
      ? await invoke('thread:setBookmarked', thread.projectId, thread.id, false)
      : await invoke('thread:setPinned', thread.projectId, thread.id, !thread.pinned)
    this.root.createThreadInProject.upsertThreadInList(updated)
    scopeState.updateThread(updated)
    workspaceState.updateThread(updated)
    if (!isFocusedThread) return
    // The reopen above is synchronous, so the incoming list may be measured in
    // the same task. A section that had to unfold mounts its rows a tick later,
    // which the reveal's own retry covers.
    await this.revealThreadInSidebar(updated, true)
  }
}
