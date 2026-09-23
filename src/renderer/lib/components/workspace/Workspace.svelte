<script lang="ts">
  import { tick } from 'svelte'
  import { fly } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { motionDuration } from '$lib/motion'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import {
    Plus,
    SquarePen,
    Bot,
    BrainCircuit,
    Bug,
    Cloud,
    FileDiff,
    MonitorCog,
    FolderTree,
    Globe2,
    History,
    Info,
    MessageCircleDashed,
    SquareTerminal,
    StickyNote
  } from '@lucide/svelte'
  import { keymapKeys } from '$lib/keymap/keymap'
  import ThreadProjectFilterMenu from '../shared/ThreadProjectFilterMenu.svelte'
  import SidebarSearchControl from './SidebarSearchControl.svelte'
  import ThreadSwitcher from '../threads/ThreadSwitcher.svelte'
  import ContextSidebar from '../layout/ContextSidebar.svelte'
  import ContextDock, { type ContextDockItem } from '../layout/ContextDock.svelte'
  import { coordinatorDockState } from '$lib/stores/coordinator-dock.svelte'
  import ProjectCreateControl from '../shared/ProjectCreateControl.svelte'
  import ThreadSearchControl from '../shared/ThreadSearchControl.svelte'
  import { ScopeActionsController } from '../scope/ScopeActionsController.svelte'
  import { WorkspaceBrowserController } from './WorkspaceBrowserController.svelte'
  import { WorkspaceProjectDialogs } from './WorkspaceProjectDialogs.svelte'
  import { WorkspaceSidebarController } from './WorkspaceSidebarController.svelte'
  import WorkspaceSidebar from './WorkspaceSidebar.svelte'
  import WorkspaceBrowserMenu from './WorkspaceBrowserMenu.svelte'
  import WorkspaceHistoryMenu from './WorkspaceHistoryMenu.svelte'
  import WorkspaceBrowserDataModal from './WorkspaceBrowserDataModal.svelte'
  import WorkspaceBrowserDownloadsModal from './WorkspaceBrowserDownloadsModal.svelte'
  import WorkspaceRemoveProjectModals from './WorkspaceRemoveProjectModals.svelte'
  import WorkspaceEditProjectModal from './WorkspaceEditProjectModal.svelte'
  import WorkspaceFullscreenTerminal from './WorkspaceFullscreenTerminal.svelte'
  import WorkspaceFullscreenBrowser from './WorkspaceFullscreenBrowser.svelte'
  import WorkspaceUnsavedChangesDialog from './WorkspaceUnsavedChangesDialog.svelte'
  import WorkspaceContextPanelContent from './WorkspaceContextPanelContent.svelte'
  import WorkspaceTerminalDockContent from './WorkspaceTerminalDockContent.svelte'
  import WorkspaceConversationPane from './WorkspaceConversationPane.svelte'
  import ScopeCreateControl from '../shared/ScopeCreateControl.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { scheduleDeferredWork } from '$lib/deferred-work'
  import { projectActionsState } from '$lib/stores/project-actions.svelte'
  import { loadProjectIcons, getProjectIcon } from '$lib/project-icons'
  import { chatDraft } from '$lib/stores/chat-draft'
  import { threadSettings, chatEffectiveSettings } from '$lib/stores/thread-settings.svelte'
  import {
    inheritEngineeringLifecycle,
    persistInheritedThreadSettings,
    settingsForNewThread,
    threadWithInheritedSettings
  } from '$lib/thread-settings-inheritance'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import {
    contextSidebarState,
    type ContextSidebarTab,
    type TemporaryChatContextTab
  } from '$lib/stores/context-sidebar.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { threadNotesState } from '$lib/stores/thread-notes.svelte'
  import { memoryProposalState } from '$lib/stores/memory-proposals.svelte'
  import { rendererRecovery, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { speechController } from '$lib/speech/speech-controller.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { logRendererError } from '$lib/system/renderer-logger'
  import {
    threadSort,
    pinnedThreadSort,
    threadStatusSort,
    findEmptyNewThread,
    threadVisitKey
  } from '$lib/stores/workspace.svelte'
  import { threadProjectFilterState } from '$lib/stores/thread-project-filter.svelte'
  import { threadHasVisibleWork } from './workspace-thread-helpers'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { scopeState, STAGE_ORDER } from '$lib/stores/scope.svelte'
  import { viewActions, type ViewActionItem } from '$lib/stores/view-actions.svelte'
  import {
    coordinatorHasActiveDelegates,
    activeThreadRowId,
    INBOX_PROJECT_ID,
    DEFAULT_THREAD_TITLE,
    DEFAULT_SCOPE_BUCKET_ID,
    isThreadBusy,
    isOrchestrationChildThread,
    threadTracksReadStatus
  } from '$shared/types'
  import type {
    AgentPart,
    AppConfig,
    AppConfigPatch,
    Project,
    PromptAttachment,
    Thread
  } from '$shared/types'

  interface Props {
    /** Which sidebar the shell shows   the main content stays mounted across modes. */
    mode: 'projects' | 'chats' | 'threads'
    /** Whether the shell is the on-screen view (hidden while in Settings/Scope). */
    active?: boolean
    /** True while the Scope page is on screen   thread switches must keep the
     *  scope store's active project in sync with the selected thread. */
    scopeViewActive?: boolean
    navigate: (view: MainView) => void
    /** Global app config   drives the image-descriptor default + ask-again flag. */
    config?: AppConfig
    updateConfig?: (patch: AppConfigPatch) => Promise<void>
  }

  let {
    mode,
    active = true,
    scopeViewActive = false,
    navigate,
    config,
    updateConfig
  }: Props = $props()

  const HISTORY_PAGE_LIMIT = 50
  /** Threads fetched from the DB per project when a list is expanded past its
   *  initial per-project hydration slice. */
  const PROJECT_PAGE_LIMIT = 50

  let projects = $state<Project[]>([])
  let allThreads = $state<Thread[]>([])
  let loading = $state(true)
  let historyOffset = $state(0)
  let historyLoading = $state(false)
  let hasMoreHistory = $state(true)
  /** Per-project DB paging state for "Show more" beyond the hydrated slice:
   *  how many rows were fetched so far, and whether the project has more. */
  const projectPageOffsets = new SvelteMap<string, number>()
  const projectExhausted = new SvelteSet<string>()
  let projectPageLoading = $state<string | null>(null)
  /** Remounts the empty-state chats composer to restore a failed first send. */
  let chatsComposerRestoreKey = $state(0)

  // ─── Sidebar focus-follow ────────────────────────────────────────────────
  // While a thread is selected, the sidebar keeps its row (and thus its
  // project) in view. A user-initiated scroll of the sidebar suppresses that
  // until the next thread is selected (or the thread comes back into view).
  let sidebarScroller: HTMLElement | null = $state(null)
  let sidebarFocusSuppressed = $state(false)
  let lastFocusedThreadId: string | null = null
  let sidebarSuppressTimer: ReturnType<typeof setTimeout> | undefined
  const SIDEBAR_FOCUS_RELEASE_MS = 4000

  function findThreadRow(threadId: string): HTMLElement | null {
    if (typeof document === 'undefined') return null
    const root = sidebarScroller ?? document
    // Only the active sidebar mode is mounted, so this resolves to the active
    // row without traversing duplicate hidden lists.
    const rows = root.querySelectorAll<HTMLElement>(`[data-thread-row="${threadId}"]`)
    for (const row of rows) {
      if (row.offsetParent !== null || row.getClientRects().length > 0) return row
    }
    return null
  }

  function isThreadRowVisible(threadId: string): boolean {
    const row = findThreadRow(threadId)
    if (!row) return false
    const scroller = sidebarScroller
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

  function nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }

  function scrollThreadRowIntoView(threadId: string): void {
    // Native scrollIntoView scrolls the sidebar scroller (and any intermediate
    // containers) the minimal amount to bring the row fully into view. Manual
    // scrollTop math here is fragile: measuring the row before the expanded
    // folder's layout settles produced wrong offsets and jumped to the top.
    findThreadRow(threadId)?.scrollIntoView({ block: 'nearest' })
  }

  async function revealThreadInSidebar(threadId: string): Promise<void> {
    const active = selectedThread
    // In Projects mode the target thread may sit in a collapsed folder and/or
    // past the per-folder "show more" cutoff. Expand its folder and raise the
    // row budget so the row actually renders. We intentionally don't gate this
    // on the current mode: when Ctrl+Tab crosses modes (e.g. Chats → Projects)
    // the mode prop may not have propagated yet, but expanding is harmless and
    // ensures the folder is open by the time the scroll step runs. In Threads
    // mode the flat list always renders every row, so only the scroll applies.
    if (active && active.projectId !== INBOX_PROJECT_ID) {
      sidebar.expandedFolders.add(active.projectId)
      const folderThreads = threadsByProject.get(active.projectId) ?? []
      const threadIndex = folderThreads.findIndex((candidate) => candidate.id === threadId)
      if (threadIndex >= 0) {
        sidebar.ensureRowVisible(active.projectId, threadIndex + 1)
      }
    }
    // Flush Svelte's DOM update (folder expansion / mode switch / re-sort), then
    // wait frames so the browser has final layout, then scroll. Retry over a few
    // frames because the folder's rows can mount a tick later than expected
    // in Projects mode the row only appears once the folder has expanded and the
    // per-folder row budget has grown to include it.
    await tick()
    for (let attempt = 0; attempt < 12; attempt++) {
      await nextAnimationFrame()
      scrollThreadRowIntoView(threadId)
      if (findThreadRow(threadId)) break
    }
  }

  function handleSidebarUserScroll(): void {
    sidebarFocusSuppressed = true
    // A user taking over the scroll ends the post-mode-change suppression window.
    sidebarRevealSuppressed = false
    clearTimeout(sidebarRevealSuppressTimer)
    clearTimeout(sidebarSuppressTimer)
    sidebarSuppressTimer = setTimeout(() => {
      // Release the suppression once the user stops interacting AND the active
      // thread is back in view, so a brief/accidental scroll doesn't disable
      // focus-follow for the rest of the session on that thread.
      const thread = selectedThread
      if (!thread || !isThreadRowVisible(thread.id)) return
      sidebarFocusSuppressed = false
    }, SIDEBAR_FOCUS_RELEASE_MS)
  }

  // ─── Per-mode sidebar scroll preservation ───────────────────────────────
  // Switching between Projects/Chats/Threads swaps the sidebar content
  // wholesale, which would otherwise drop the user's place in the thread list.
  // Keep each mode's scroll position and restore it when the mode comes back,
  // and briefly suppress the focus-follow reveal so it doesn't yank the
  // restored scroll back to the selected thread's row.
  const sidebarScrollByMode = new SvelteMap<'projects' | 'chats' | 'threads', number>()
  // Intentional initial-value capture   the map is keyed by the mode prop.
  // svelte-ignore state_referenced_locally
  let previousMode = mode
  // Reactive so the focus-follow effect re-runs (and re-reveals the active
  // thread) the moment the mode-switch suppression window closes. As a plain
  // `let` the reveal would be skipped forever whenever a mode switch coincided
  // with the active thread falling out of view.
  let sidebarRevealSuppressed = $state(false)
  let sidebarRevealSuppressTimer: ReturnType<typeof setTimeout> | undefined

  // Runs before the DOM swaps: capture the outgoing mode's scrollTop while its
  // list is still mounted, and open the suppression window for the switch.
  $effect.pre(() => {
    if (mode === previousMode) return
    const scroller = sidebarScroller
    if (scroller) sidebarScrollByMode.set(previousMode, scroller.scrollTop)
    previousMode = mode
    sidebarRevealSuppressed = true
    clearTimeout(sidebarRevealSuppressTimer)
    sidebarRevealSuppressTimer = setTimeout(() => {
      sidebarRevealSuppressed = false
    }, 2000)
  })

  // After the incoming mode's list has rendered, restore its saved scroll.
  $effect(() => {
    const saved = sidebarScrollByMode.get(mode)
    if (saved === undefined) return
    void tick().then(() => {
      const scroller = sidebarScroller
      if (scroller) scroller.scrollTop = saved
    })
  })

  const sidebar = new WorkspaceSidebarController()

  /** Selection + terminal state live in the shared store (drives the app header). */
  let selectedThread = $derived(workspaceState.selectedThread)
  let activeProject = $derived(workspaceState.activeProject)

  let selectedThreadHasDraft = $derived(
    selectedThread
      ? rendererRecovery.hasDraftContent(selectedThread.projectId, selectedThread.id)
      : false
  )
  /** Threads holding any unsent composer content stay pinned at the top of their list,
      even after the user navigates away, so they are easy to find mid-task.
      An active voice capture counts as draft activity too   draft status must
      drive sort order regardless of whether the user is typing or dictating. */
  let draftThreadKeys = $derived.by(() => {
    const keys = new SvelteSet<string>()
    for (const t of allThreads) {
      if (t.archived) continue
      if (
        rendererRecovery.hasDraftContent(t.projectId, t.id) ||
        speechController.isCapturingThread(t.id)
      )
        keys.add(threadVisitKey(t))
    }
    return keys
  })

  let projectCreateTrigger = $state(0)
  /** Which add-project flow the next trigger should start. */
  let projectCreateTriggerKind = $state<'local' | 'git-clone'>('local')
  let prevCreateThreadCount = 0
  let prevAddProjectCount = 0
  let prevNewChatCount = 0
  let prevProjectFileOpenCount = 0
  let prevToggleContextSidebarCount = 0
  let creatingThread = false

  // This view hosts the terminal panel   advertise it to the header.
  $effect(() => {
    workspaceState.terminalAvailable = true
    return () => {
      workspaceState.terminalAvailable = false
    }
  })

  /** Resolve the project a pending create-thread request targets: an explicit
   *  scope bucket matching the docked scoped-threads sidebar overrides the
   *  active project (which is null in that sidebar's empty state, when no
   *  thread is open yet). */
  function createThreadRequestProject(): Project | null {
    const pendingBucket = workspaceState.pendingScopeBucketId
    const context = scopeState.sidebarContext
    if (pendingBucket && context && context.bucketId === pendingBucket) {
      const scopedProject = projects.find((candidate) => candidate.id === context.projectId)
      if (scopedProject) return scopedProject
    }
    return workspaceState.activeProject
  }

  /** React to Cmd/Ctrl+N → create thread in active project (optionally in a scope bucket). */
  $effect(() => {
    const current = workspaceState.requestCreateThreadCount
    if (
      current !== prevCreateThreadCount &&
      !creatingThread &&
      workspaceState.consumeCreateThreadRequest()
    ) {
      prevCreateThreadCount = current
      const project = createThreadRequestProject()
      if (project) {
        handleCreateThreadRequest(project, workspaceState.pendingScopeBucketId ?? undefined)
      }
      workspaceState.pendingScopeBucketId = null
    }
  })

  async function handleCreateThreadRequest(
    project: Project,
    scopeBucketId?: string
  ): Promise<void> {
    creatingThread = true
    try {
      await createThreadInProject(project, scopeBucketId)
    } finally {
      creatingThread = false
      // If more requests queued up while we were creating, process the latest
      if (
        workspaceState.requestCreateThreadCount !== prevCreateThreadCount &&
        workspaceState.consumeCreateThreadRequest()
      ) {
        prevCreateThreadCount = workspaceState.requestCreateThreadCount
        const queuedProject = createThreadRequestProject()
        if (queuedProject) {
          handleCreateThreadRequest(queuedProject, workspaceState.pendingScopeBucketId ?? undefined)
        }
        workspaceState.pendingScopeBucketId = null
      }
    }
  }

  /** React to Cmd/Ctrl+N (no active project) → trigger add-project flow. */
  $effect(() => {
    const current = workspaceState.requestAddProjectCount
    if (current !== prevAddProjectCount && workspaceState.consumeAddProjectRequest()) {
      prevAddProjectCount = current
      projectCreateTrigger++
    }
  })

  /** React to Ctrl+K → New chat. */
  $effect(() => {
    const current = workspaceState.requestNewChatCount
    if (current !== prevNewChatCount && workspaceState.consumeNewChatRequest()) {
      prevNewChatCount = current
      startNewChat()
    }
  })

  /** React to Cmd/Ctrl+Shift+S → toggle the right (context) sidebar. */
  $effect(() => {
    const current = workspaceState.requestToggleContextSidebarCount
    if (current !== prevToggleContextSidebarCount) {
      prevToggleContextSidebarCount = current
      if (workspaceState.consumeToggleContextSidebarRequest()) toggleContextSidebar()
    }
  })

  /** Reveal a file selected from the cross-project Ctrl+K search. */
  $effect(() => {
    const current = workspaceState.requestProjectFileOpenCount
    if (current !== prevProjectFileOpenCount && !loading) {
      prevProjectFileOpenCount = current
      const request = workspaceState.consumeProjectFileOpenRequest()
      if (request) void openProjectFileFromCommand(request.projectId, request.path, request.kind)
    }
  })

  /** Pick up projects added externally (e.g. from the Scope view) so the sidebar stays in sync. */
  $effect(() => {
    const project = workspaceState.pendingAddedProject
    if (project) {
      workspaceState.pendingAddedProject = null
      void handleProjectCreated(project)
    }
  })

  /** Clicking into the chat composer means the user found what they were
   *  looking for: any open sidebar thread search is dismissed immediately
   *  ("click and go") instead of lingering and blocking the composer. Runs in
   *  the capture phase so it fires before focus settles into the editor. */
  function handleComposerPointerDown(event: Event): void {
    const target = event.target
    if (!(target instanceof Element)) return
    if (!target.closest('[data-onboarding="composer"]')) return
    sidebar.closeAllSearches()
  }

  /** Project icon data URLs keyed by project id. */
  const projectIcons = new SvelteMap<string, string>()

  const projectDialogs = new WorkspaceProjectDialogs({
    getProjects: () => projects,
    setProjects: (next) => (projects = next),
    getProjectIcons: () => projectIcons,
    deleteProject
  })

  // Scope actions (edit, pin, archive, worktree lifecycle, merge, delete) shared
  // with the scope board, so the sidebar scope and the board offer the same set.
  const scopeActions = new ScopeActionsController({
    getProjectId: () => scopeState.sidebarContext?.projectId ?? scopeState.activeProjectId,
    onNavigateToScopedThreads: () => navigate('projects-scope')
  })

  async function openFiles(): Promise<void> {
    if (!selectedThread) return
    // Inbox chats browse the thread's own artifact directory instead of a
    // project root; the mount must be registered before the root listing.
    if (selectedThread.projectId === INBOX_PROJECT_ID) {
      projectFilesWorkspace.ensureState(selectedThread.projectId)
      projectFilesWorkspace.setChatThread(selectedThread.projectId, selectedThread.id)
      await projectFilesWorkspace.loadDirectory(selectedThread.projectId, '')
      contextSidebarState.openFiles(selectedThread.projectId, selectedThread.id)
      return
    }
    if (activeProject?.source !== 'local' || !activeProject.path) return
    await projectFilesWorkspace.loadDirectory(selectedThread.projectId, '')
    contextSidebarState.openFiles(selectedThread.projectId, selectedThread.id)
  }

  function openDiff(): void {
    if (!selectedThread || activeProject?.source !== 'local' || !activeProject.path) return
    contextSidebarState.openDiff(selectedThread.projectId, selectedThread.id)
  }

  function openNewTerminal(): string | null {
    if (!selectedThread) return null
    return contextSidebarState.openNewTerminal(selectedThread.projectId, selectedThread.id)
  }

  function openNewBrowser(): string | null {
    // A new tab starts blank: no URL is loaded, the address bar stays empty,
    // and the page only loads once the user types an address.
    return contextSidebarState.openBrowser('')
  }

  function openDebugger(): void {
    if (!selectedThread || !import.meta.env.DEV) return
    contextSidebarState.openDebugger(selectedThread.projectId, selectedThread.id)
  }

  function openSourcesTab(): void {
    if (!selectedThread) return
    if (
      contextSidebarState.sidebarVisible &&
      contextSidebarState.sidebarActiveTab?.kind === 'sources'
    ) {
      contextSidebarState.hide()
      return
    }
    contextSidebarState.openSources(selectedThread.projectId, selectedThread.id)
  }

  function openActionsTab(): void {
    if (!selectedThread) return
    contextSidebarState.openActions(selectedThread.projectId, selectedThread.id)
  }

  function openCloudDeploymentsTab(): void {
    if (!selectedThread) return
    contextSidebarState.openCloudDeployments(selectedThread.projectId, selectedThread.id)
  }

  // ─── Context dock (right rail) ───────────────────────────────────────────

  /** Whether `kind` is the panel currently on screen in the right sidebar. */
  function dockKindActive(kind: ContextSidebarTab['kind']): boolean {
    return contextSidebarState.sidebarVisible && contextSidebarState.sidebarActiveTab?.kind === kind
  }

  /**
   * The dock's toggle contract: clicking the active tool collapses the panel,
   * clicking any other tool swaps the panel content without closing it.
   */
  function toggleDockPanel(kind: ContextSidebarTab['kind'], open: () => void): void {
    if (dockKindActive(kind)) {
      contextSidebarState.hide()
      return
    }
    open()
  }

  /**
   * Cmd/Ctrl+Shift+S toggles the whole right sidebar instead of one tool: it
   * hides whatever is on screen, or brings back the tool the user last had
   * selected there. Nothing selected yet means there is nothing to bring back,
   * so the file tree opens when the thread on screen has one and otherwise the
   * first tool the context rail offers, which is exactly what that rail icon
   * would do.
   */
  function toggleContextSidebar(): void {
    if (contextSidebarState.toggleLastSelected()) return
    if (fileTreeAvailable) {
      void openFiles()
      return
    }
    firstContextTool()?.onSelect()
  }

  /** The first tool on the context rail that opens a panel in the right sidebar.
   *  History is a floating flyout rather than a panel, and a terminal docked at
   *  the bottom has left the sidebar for the dock, so neither answers the
   *  fallback: toggling the right sidebar must not reveal the bottom dock. */
  function firstContextTool(): ContextDockItem | undefined {
    const opensInSidebar = (item: ContextDockItem): boolean =>
      item.id !== 'history' &&
      !(item.id === 'terminal' && contextSidebarState.terminalPlacement === 'bottom')
    return dockGroups.flat().find(opensInSidebar)
  }

  /** Quick chats and explains open from inside a thread and live in the sidebar
   *  as tabs. The rail mirrors them so they can be toggled away and back without
   *  losing the conversation. Durable audits use the coordinator dock instead. */
  let temporaryChatTabs = $derived(
    contextSidebarState.sidebarTabs.filter((tab) => tab.kind === 'temporary-chat')
  )

  function focusTemporaryChat(): void {
    const tab = temporaryChatTabs.at(-1)
    if (tab) contextSidebarState.focus(tab.id)
  }

  let subagentTabs = $derived(
    contextSidebarState.sidebarTabs.filter((tab) => tab.kind === 'subagent')
  )

  let browserTabs = $derived(
    contextSidebarState.sidebarTabs.filter((tab) => tab.kind === 'browser')
  )

  function focusBrowser(): void {
    // Prefer the remembered active tab over the last one so a restart (or any
    // path that lost track of the active tab) reopens what the user last saw.
    const id = contextSidebarState.rememberedBrowserTabId
    if (id) contextSidebarState.focus(id)
  }

  function focusSubagent(): void {
    const tab = subagentTabs.at(-1)
    if (tab) contextSidebarState.focus(tab.id)
  }

  function openMemoryTab(): void {
    if (!selectedThread) return
    contextSidebarState.openMemory(selectedThread.projectId, selectedThread.id)
  }

  /** The coordinator published by the thread on screen, if it coordinates work.
   *  A worker/auditor child publishes under its coordinator's id, so the panel
   *  stays docked as the user moves between its children. */
  let coordinator = $derived(
    coordinatorDockState.forThread(selectedThread?.projectId, activeThreadRowId(selectedThread))
  )

  /** The auditor thread of the on-screen coordinator, if one exists. Orchestration
   *  children stay out of the visible thread list but land in the scope store
   *  through their broadcast updates, so the rail can mirror their state. */
  let auditorThread = $derived.by(() => {
    const auditorId = selectedThread?.auditorThreadId
    if (!auditorId) return null
    return scopeState.allScopeThreads.find((candidate) => candidate.id === auditorId) ?? null
  })

  /** Auditor threads are orchestration children: the bounded initial paint and
   *  scope hydration both skip them, so after a reload the scope store only
   *  knows about one if a live broadcast happened in this session. Fetch it
   *  once and merge it in, so the rail badge can never silently miss a
   *  persisted terminal state (failed, report ready). */
  const auditorFetchRequested = new SvelteSet<string>()
  $effect(() => {
    const current = selectedThread
    const auditorId = current?.auditorThreadId
    if (!current || !auditorId) return
    const scopeKey = `${current.projectId}:${auditorId}`
    if (auditorThread || auditorFetchRequested.has(scopeKey)) return
    auditorFetchRequested.add(scopeKey)
    void invoke('thread:get', current.projectId, auditorId)
      .then((fetched) => {
        if (fetched) scopeState.updateThread(fetched)
      })
      .catch(() => {
        // Missing or deleted auditor: leave the badge unlit rather than retry
        // forever on a thread that cannot exist.
      })
  })

  /** Rail badge for the coordinator dock item, mirroring the auditor's live
   *  state so a hidden context sidebar still reports working / error / done. */
  let coordinatorRailBadge = $derived.by((): ContextDockItem['badge'] => {
    if (!selectedThread) return undefined
    const auditor = auditorThread
    if (auditor?.status === 'failed') return 'error'
    if (auditor?.status === 'awaiting_approval') return 'attention'
    // A usage-limit wait parks the auditor in `working-paused` (the scheduled
    // auto-resume), which reads as "will retry", not actively working.
    if (auditor?.status === 'working-paused') return 'working-paused'
    if (
      selectedThread.auditState === 'report_ready' &&
      (auditor === null || auditor.status === 'completed')
    ) {
      return 'done'
    }
    if (coordinatorHasActiveDelegates(selectedThread, scopeState.allScopeThreads)) return 'working'
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

  let coordinatorRailBadgeTitle = $derived.by(() => {
    switch (coordinatorRailBadge) {
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

  function openCoordinatorTab(): void {
    if (!coordinator) return
    coordinatorDockState.setAutoOpen(true)
    contextSidebarState.openCoordinator(
      coordinator.projectId,
      coordinator.threadId,
      coordinator.label
    )
  }

  /** Terminals toggle their own region: the bottom dock when docked there,
   *  otherwise the right sidebar like every other tool. */
  function toggleTerminal(): void {
    if (!selectedThread) return

    if (contextSidebarState.terminalPlacement === 'bottom') {
      // The bottom dock is an independent region, so the rail toggles the dock
      // itself   never the focused tab. Whether a terminal happens to hold the
      // global focus is irrelevant: if the dock exists in any form it folds
      // away, and only a dock with no terminals at all opens a fresh shell.
      if (contextSidebarState.terminalDockVisible || contextSidebarState.terminalDockCollapsed) {
        contextSidebarState.toggleTerminalDock()
        return
      }
      contextSidebarState.openPrimaryTerminal(selectedThread.projectId, selectedThread.id)
      return
    }

    // Docked to the right, the terminal is just another sidebar panel.
    const sidebarTab = contextSidebarState.sidebarActiveTab
    const terminalFocused =
      sidebarTab?.kind === 'terminal' &&
      sidebarTab.projectId === selectedThread.projectId &&
      sidebarTab.threadId === selectedThread.id

    if (contextSidebarState.sidebarVisible && terminalFocused) {
      contextSidebarState.hide()
    } else {
      contextSidebarState.openPrimaryTerminal(selectedThread.projectId, selectedThread.id)
    }
  }

  /** True while a terminal is on screen in whichever region hosts terminals. */
  let terminalOpen = $derived(
    contextSidebarState.terminalPlacement === 'bottom'
      ? contextSidebarState.terminalDockVisible
      : Boolean(
          contextSidebarState.sidebarVisible && contextSidebarState.activeTab?.kind === 'terminal'
        )
  )

  /** Project files and diffs only exist for local projects with a real path. */
  let projectToolsAvailable = $derived(
    Boolean(activeProject?.source === 'local' && activeProject.path)
  )

  /** Whether the file tree can be opened for the thread on screen: a local
   *  project with a real path, or an inbox chat's own artifact directory. */
  let fileTreeAvailable = $derived(
    Boolean(
      selectedThread && (selectedThread.projectId === INBOX_PROJECT_ID || projectToolsAvailable)
    )
  )

  /** Whether the message-history jump menu (first item on the context dock) is open. */
  let showHistoryMenu = $state(false)
  const browser = new WorkspaceBrowserController({
    getSelectedProjectId: () => selectedThread?.projectId ?? null
  })
  function jumpToHistoryMessage(id: string): void {
    showHistoryMenu = false
    workspaceState.jumpToMessage?.(id)
  }

  /**
   * Dock contents, grouped: history, then workspace tools, then session tools.
   * Every entry is a toggle   the rail itself is always visible, only the
   * panel (or, for history, the floating jump menu) comes and goes.
   */
  let dockGroups = $derived.by((): ContextDockItem[][] => {
    if (!selectedThread) return []

    // Chats are pure conversations: their rail only carries session tools
    // (sources, memory, debugger in dev)   never project, terminal or cloud tools.
    const isChatThread = selectedThread.projectId === INBOX_PROJECT_ID

    // The message-history counter leads the rail so it reads first, like a
    // running tally of the conversation   click to jump to any past message.
    // Before the first message it falls back to a plain history icon: there's
    // no count worth showing yet, and "0" reads as a stuck/broken badge.
    const hasMessages = workspaceState.messageCount > 0
    const history: ContextDockItem[] = [
      {
        id: 'history',
        label: hasMessages
          ? `Message history (${workspaceState.messageCount} messages you sent)`
          : 'Message history',
        icon: hasMessages ? undefined : History,
        countLabel: hasMessages ? String(workspaceState.messageCount) : undefined,
        active: showHistoryMenu,
        menu: showHistoryMenu ? historyMenu : undefined,
        onSelect: () => (showHistoryMenu = !showHistoryMenu)
      }
    ]

    const workspaceTools: ContextDockItem[] = []
    // Chats surface their own per-thread artifact directory as the file tree.
    if (isChatThread) {
      workspaceTools.push({
        id: 'files',
        label: 'Artifacts',
        icon: FolderTree,
        active: dockKindActive('files'),
        onSelect: () => toggleDockPanel('files', () => void openFiles())
      })
    }
    if (!isChatThread && projectToolsAvailable) {
      workspaceTools.push(
        {
          id: 'files',
          label: 'Files',
          icon: FolderTree,
          active: dockKindActive('files'),
          onSelect: () => toggleDockPanel('files', () => void openFiles())
        },
        {
          id: 'diff',
          label: 'Changes',
          icon: FileDiff,
          active: dockKindActive('diff'),
          onSelect: () => toggleDockPanel('diff', openDiff)
        }
      )
    }
    if (!isChatThread && workspaceState.terminalAvailable) {
      workspaceTools.push({
        id: 'terminal',
        label: terminalOpen ? 'Hide terminal' : 'Show terminal',
        icon: SquareTerminal,
        active: terminalOpen,
        onSelect: toggleTerminal
      })
      const runningActions = projectActionsState.runningCount(selectedThread.projectId)
      workspaceTools.push({
        id: 'actions',
        label: runningActions > 0 ? `Actions (${runningActions} running)` : 'Actions',
        icon: MonitorCog,
        active: dockKindActive('actions'),
        countBadge: runningActions > 0 ? String(runningActions) : undefined,
        countBadgeTone: runningActions > 0 ? 'working' : undefined,
        onSelect: () => toggleDockPanel('actions', openActionsTab)
      })
    }

    const sessionTools: ContextDockItem[] = [
      {
        id: 'sources',
        label:
          workspaceState.sourceProcessCount > 0
            ? `Sources (${workspaceState.sourceProcessCount} ${workspaceState.sourceProcessCount === 1 ? 'process' : 'processes'} running)`
            : 'Sources',
        icon: Info,
        active: dockKindActive('sources'),
        countBadge:
          workspaceState.sourceProcessCount > 0
            ? String(workspaceState.sourceProcessCount)
            : undefined,
        onSelect: () => toggleDockPanel('sources', openSourcesTab)
      },
      {
        id: 'memory',
        label: 'Memory',
        icon: BrainCircuit,
        active: dockKindActive('memory'),
        badge: memoryProposalState.hasPending ? 'attention' : undefined,
        badgeTitle: `${memoryProposalState.pendingCount} memory proposals need attention`,
        onSelect: () => toggleDockPanel('memory', openMemoryTab)
      }
    ]
    if (!isChatThread) {
      sessionTools.push({
        id: 'cloud-deployment',
        label: 'Cloud deployments',
        icon: Cloud,
        active: dockKindActive('cloud-deployment'),
        onSelect: () => toggleDockPanel('cloud-deployment', openCloudDeploymentsTab)
      })
    }
    if (import.meta.env.DEV) {
      sessionTools.push({
        id: 'debugger',
        label: 'Debugger',
        icon: Bug,
        active: dockKindActive('debugger'),
        onSelect: () => toggleDockPanel('debugger', openDebugger)
      })
    }

    // Temporary chats get their own hairline-separated slot: they are ephemeral
    // side conversations, not standing tools, and one button toggles the whole
    // set because the panel tabs them.
    const temporaryChats: ContextDockItem[] = []
    if (temporaryChatTabs.length > 0) {
      const name =
        temporaryChatTabs.length === 1
          ? (temporaryChatTabs.at(-1)?.title ?? 'Quick chat')
          : `${temporaryChatTabs.length} quick chats`
      temporaryChats.push({
        id: 'temporary-chat',
        label: dockKindActive('temporary-chat') ? `Hide ${name}` : `Show ${name}`,
        icon: MessageCircleDashed,
        active: dockKindActive('temporary-chat'),
        tone: 'info',
        onSelect: () => toggleDockPanel('temporary-chat', focusTemporaryChat)
      })
    }

    // The coordinator sits alone at the bottom, below its own hairline: it is
    // the thread's own supervision surface, not a general workspace tool.
    const coordination: ContextDockItem[] = coordinator
      ? [
          {
            id: 'coordinator',
            label: coordinator.label,
            icon: coordinator.icon,
            active: dockKindActive('coordinator'),
            badge: coordinatorRailBadge,
            badgeTitle: coordinatorRailBadgeTitle,
            onSelect: () => toggleDockPanel('coordinator', openCoordinatorTab)
          }
        ]
      : []

    // The thread-note indicator sits below its own hairline. It's always
    // present   not just once a note exists   so it also doubles as the "add a
    // note" entry point; the amber tone only kicks in once there's something
    // written to draw attention to.
    const hasThreadNote = threadNotesState.has(selectedThread.id)
    const threadNote: ContextDockItem[] = [
      {
        id: 'note',
        label: hasThreadNote ? 'Note available' : 'Add note',
        icon: StickyNote,
        active: dockKindActive('thread-note'),
        tone: hasThreadNote ? 'warning' : undefined,
        onSelect: () =>
          toggleDockPanel('thread-note', () =>
            contextSidebarState.openThreadNote(
              selectedThread.projectId,
              selectedThread.id,
              selectedThread.title
            )
          )
      }
    ]
    if (browserTabs.length > 0) {
      const name =
        browserTabs.length === 1
          ? (browserTabs.at(-1)?.title ?? 'Browser')
          : `${browserTabs.length} browser tabs`
      threadNote.push({
        id: 'browser',
        label: dockKindActive('browser') ? `Hide ${name}` : `Show ${name}`,
        icon: Globe2,
        active: dockKindActive('browser'),
        countBadge:
          browser.activeDownloadCount > 0 ? String(browser.activeDownloadCount) : undefined,
        menu: browser.menuOpen ? browserMenu : undefined,
        onSelect: () => {
          browser.menuOpen = false
          toggleDockPanel('browser', focusBrowser)
        },
        onContextMenu: browser.openContextMenu
      })
    }

    // Sub-agents appear only after the first one is opened. The group shares
    // one toggle, while the sidebar keeps each sub-agent in its own tab.
    const subagents: ContextDockItem[] = []
    if (subagentTabs.length > 0) {
      const name =
        subagentTabs.length === 1
          ? (subagentTabs.at(-1)?.title ?? 'Sub-agent')
          : `${subagentTabs.length} sub-agents`
      subagents.push({
        id: 'subagent',
        label: dockKindActive('subagent') ? `Hide ${name}` : `Show ${name}`,
        icon: Bot,
        active: dockKindActive('subagent'),
        tone: 'info',
        onSelect: () => toggleDockPanel('subagent', focusSubagent)
      })
    }

    return [
      history,
      workspaceTools,
      sessionTools,
      temporaryChats,
      coordination,
      threadNote,
      subagents
    ]
  })

  function openNestedSubagent(part: Extract<AgentPart, { type: 'subagent' }>): void {
    if (!selectedThread) return
    contextSidebarState.openSubagent(
      selectedThread.projectId,
      selectedThread.id,
      part.id,
      part.activity
    )
  }

  let terminalFullscreenTabId = $state<string | null>(null)
  let browserFullscreenTabId = $state<string | null>(null)

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
  let terminalFullscreenTab = $derived(
    contextSidebarState.tabs.find(
      (tab) => tab.id === terminalFullscreenTabId && tab.kind === 'terminal'
    ) ?? null
  )

  /** Close a tab from a fullscreen strip without tearing the fullscreen down
   *  unless it was the last tab of that kind. */
  function closeFullscreenTab(kind: 'terminal' | 'browser', tabId: string): void {
    const openTabs = contextSidebarState.tabs.filter((tab) => tab.kind === kind)
    const remaining = openTabs.filter((tab) => tab.id !== tabId)
    closeContextTab(tabId)
    // Nothing left of that kind: the surface has no tab to show, so the record
    // has to go with it rather than point at the tab that just closed.
    const fallback = remaining.at(-1)?.id ?? null
    if (kind === 'terminal') terminalFullscreenTabId = fallback
    else browserFullscreenTabId = fallback
  }
  let sidebarVisible = $derived(contextSidebarState.sidebarVisible)
  let terminalDockVisible = $derived(contextSidebarState.terminalDockVisible)

  /** Project the git sidebar panel is kept mounted for. The panel stays alive
   *  across sidebar tab switches AND thread switches within that project   its
   *  visibility is toggled via CSS only, and scope-bucket changes are swapped
   *  in place by GitStatusPanel itself, so switching threads never tears the
   *  panel down. Only changing projects remounts it. */
  let gitPanelProjectId = $state<string | null>(null)
  let gitPanelScopeBucketId = $state(DEFAULT_SCOPE_BUCKET_ID)
  $effect(() => {
    const tab = contextSidebarState.sidebarActiveTab
    const openProjectId = activeProject?.id ?? null
    if (!tab || !('projectId' in tab)) {
      // No panel is claiming the keep-mounted host right now (the sidebar is
      // hidden, or a tab without a project is active). Hold the open project's
      // panel across thread switches, but drop it once the user has moved to
      // another project: a host left behind would bootstrap the repository the
      // user just left the moment the sidebar shows again.
      if (gitPanelProjectId !== null && gitPanelProjectId !== openProjectId) {
        gitPanelProjectId = null
      }
      return
    }
    if (tab.kind !== 'git') {
      if (tab.projectId !== gitPanelProjectId) gitPanelProjectId = null
      return
    }
    // Scope comes from the store's resolved bucket for that project (the open
    // thread's scope, else the project's last one). Reading it off the bounded
    // thread list missed a thread that was not hydrated yet and fell back to
    // the project root, so the panel swapped scopes twice on open.
    gitPanelProjectId = tab.projectId
    gitPanelScopeBucketId = workspaceState.activeScopeBucketIdFor(tab.projectId)
  })

  // A full-window DOM surface (fullscreen terminal, media previews, fullscreen
  // file editors) covers the workspace. The browser's native view floats above
  // every DOM surface, so it must be hidden while such a surface is open   the
  // browser panel asks the browser-visibility store and detaches its native
  // surface accordingly. The browser's own fullscreen dialog is not registered
  // here so the browser stays visible when the user fullscreens it deliberately.
  // Every modal publishes that block for itself now (`ui/Modal.svelte`), and the
  // full screen browser is the one surface that opts out of it
  // (`blocksBrowserView`), because the view it would suppress is the page it is
  // showing.
  $effect(() =>
    browserVisibility.hideWhile(
      'workspace-terminal-fullscreen',
      'fullscreen-surface',
      terminalFullscreenTab !== null
    )
  )

  // App.svelte keeps this Workspace mounted (but CSS-hidden) when the user
  // navigates to Settings/Scope, so its state survives the trip. The browser's
  // native view has no notion of that DOM hide and keeps floating at its last
  // screen bounds on top of whatever renders there instead   suppress it
  // whenever this Workspace isn't the active top-level view.
  $effect(() => browserVisibility.hideWhile('workspace-inactive', 'workspace-inactive', !active))

  // The grid column/row that hosts each panel collapses the instant
  // `sidebarVisible`/`terminalDockVisible` flips, but the panel itself keeps
  // playing its out:fly for PANEL_EXIT_MS. Without this, the closing panel is
  // orphaned outside the (now single-track) grid for that whole window
  // a stray gap opens up where its column used to be. Reserving the track
  // until the outro actually finishes keeps the panel inside its cell for
  // the whole animation.
  const PANEL_EXIT_MS = 160
  let sidebarTrackReserved = $state(false)
  let sidebarWasVisible = false
  $effect(() => {
    if (sidebarVisible) {
      sidebarWasVisible = true
      sidebarTrackReserved = true
      return
    }
    if (!sidebarWasVisible) return
    sidebarWasVisible = false
    const timer = setTimeout(
      () => {
        sidebarTrackReserved = false
      },
      motionDuration(PANEL_EXIT_MS + 40)
    )
    return () => clearTimeout(timer)
  })
  let terminalTrackReserved = $state(false)
  let terminalWasVisible = false
  $effect(() => {
    if (terminalDockVisible) {
      terminalWasVisible = true
      terminalTrackReserved = true
      return
    }
    if (!terminalWasVisible) return
    terminalWasVisible = false
    const timer = setTimeout(
      () => {
        terminalTrackReserved = false
      },
      motionDuration(PANEL_EXIT_MS + 40)
    )
    return () => clearTimeout(timer)
  })

  let contextPanelColumns = $derived(
    sidebarTrackReserved
      ? `minmax(360px, 1fr) minmax(0, min(${contextSidebarState.width}px, calc(100% - 360px)))`
      : 'minmax(0, 1fr)'
  )
  // A folded dock leaves no restore strip behind: the context dock's terminal
  // icon is always on screen and is the way back, so hiding the terminal really
  // does give the full height back to the thread.
  let contextPanelRows = $derived(
    terminalTrackReserved
      ? `minmax(240px, 1fr) minmax(0, min(${contextSidebarState.terminalHeight}px, calc(100% - 240px)))`
      : 'minmax(0, 1fr)'
  )

  /** Show one context tab fullscreen. Only one surface can own the window, so
   *  opening one closes the other kind instead of leaving two full screen dialogs
   *  stacked, where the lower one's suppression block would blank the browser's
   *  native view. */
  function openTabFullscreen(tabId: string): void {
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === tabId)
    if (tab?.kind === 'browser') {
      browserFullscreenTabId = tabId
      terminalFullscreenTabId = null
    }
    if (tab?.kind === 'terminal') {
      terminalFullscreenTabId = tabId
      browserFullscreenTabId = null
    }
  }

  /** A files tab with unsaved changes waiting on a save/discard decision. */
  let closeTabTarget = $state<{
    sidebarTabId: string
    projectId: string
    fileTabId: string
    path: string
  } | null>(null)

  function closeContextTab(id: string): void {
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === id)
    if (!tab) return
    if (tab.kind === 'files' && tab.fileTabId) {
      const pending = pendingFileCloseTarget(tab)
      if (pending) {
        closeTabTarget = pending
        return
      }
    }
    closeContextTabNow(id, tab)
  }

  function pendingFileCloseTarget(
    tab: ContextSidebarTab
  ): { sidebarTabId: string; projectId: string; fileTabId: string; path: string } | null {
    if (tab.kind !== 'files' || !tab.fileTabId) return null
    try {
      const fileState = projectFilesWorkspace.getState(tab.projectId)
      const fileTab = fileState.tabs.find((candidate) => candidate.id === tab.fileTabId)
      const session = fileTab ? fileState.sessions[fileTab.path] : undefined
      if (!fileTab || !session || session.draft === session.source.content) return null
      return {
        sidebarTabId: tab.id,
        projectId: tab.projectId,
        fileTabId: tab.fileTabId,
        path: fileTab.path
      }
    } catch {
      return null
    }
  }

  function closeContextTabNow(id: string, tab: ContextSidebarTab): void {
    if (tab.kind === 'files' && tab.fileTabId) {
      projectFilesWorkspace.closeTab(tab.projectId, tab.fileTabId)
    }
    // Closing the coordinator is a dismissal: it stays undocked until the user
    // brings it back from the rail, otherwise it would reappear immediately.
    if (tab.kind === 'coordinator') coordinatorDockState.setAutoOpen(false)
    if (tab.kind === 'browser') {
      if (browserFullscreenTabId === tab.id) browserFullscreenTabId = null
      void invoke('browser:destroy', tab.id)
    }
    // Symmetric with the browser: closing the terminal that is showing fullscreen
    // would otherwise leave the fullscreen record pointing at a tab that is gone.
    if (tab.kind === 'terminal' && terminalFullscreenTabId === tab.id) {
      terminalFullscreenTabId = null
    }
    contextSidebarState.close(id)
    if (tab.kind === 'temporary-chat') {
      void invoke('agent:closeTemporaryChat', tab.temporaryChatId)
    }
  }

  async function saveAndCloseTab(): Promise<void> {
    const target = closeTabTarget
    if (!target) return
    closeTabTarget = null
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === target.sidebarTabId)
    if (!tab || tab.kind !== 'files') return
    await projectFilesWorkspace.save(target.projectId, target.path)
    closeContextTabNow(target.sidebarTabId, tab)
  }

  function discardCloseTab(): void {
    const target = closeTabTarget
    if (!target) return
    closeTabTarget = null
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === target.sidebarTabId)
    if (!tab || tab.kind !== 'files') return
    closeContextTabNow(target.sidebarTabId, tab)
  }

  // ─── Derived ─────────────────────────────────────────────────────────────

  let pinnedThreads = $derived(
    allThreads
      .filter((t) => t.pinned && !t.archived && t.projectId !== INBOX_PROJECT_ID)
      .sort((a, b) => pinnedThreadSort(a, b, draftThreadKeys))
  )

  /** User-facing projects only   hidden ones (e.g. the chats inbox) stay out of the tree. */
  let visibleProjects = $derived(
    projects
      .filter((p) => !p.hidden)
      .sort((a, b) => {
        const aOrder = a.sortOrder ?? -1
        const bOrder = b.sortOrder ?? -1
        if (aOrder !== bOrder) return aOrder - bOrder
        return b.updatedAt - a.updatedAt
      })
  )

  let pinnedProjects = $derived(visibleProjects.filter((p) => p.pinned))
  let regularProjects = $derived(visibleProjects.filter((p) => !p.pinned))

  let threadsByProject = $derived.by(() => {
    const map = new SvelteMap<string, Thread[]>()
    for (const t of allThreads) {
      // Pinned threads live exclusively in the Pinned section.
      if (t.archived || t.pinned) continue
      const list = map.get(t.projectId) ?? []
      list.push(t)
      map.set(t.projectId, list)
    }
    // Working threads first, then by activity
    for (const list of map.values()) {
      list.sort((a, b) => threadSort(a, b, draftThreadKeys))
    }
    return map
  })

  /** Pinned standalone chats (inbox project), ordered newest-pinned first. */
  let pinnedInboxThreads = $derived(
    allThreads
      .filter((t) => t.projectId === INBOX_PROJECT_ID && !t.archived && t.pinned)
      .sort((a, b) => pinnedThreadSort(a, b, draftThreadKeys))
  )

  /** Non-pinned standalone chats (inbox project), working first then by activity. */
  let standaloneThreads = $derived(
    allThreads
      .filter((t) => t.projectId === INBOX_PROJECT_ID && !t.archived && !t.pinned)
      .sort((a, b) => threadSort(a, b, draftThreadKeys))
  )

  /** Threads mode: active threads of the filtered projects, sorted by the
   *  selected mode, persisted pins first. An empty project-filter selection
   *  means all projects. */
  let allThreadsFlat = $derived.by(() => {
    const list = allThreads.filter(
      (t) =>
        !t.archived &&
        t.projectId !== INBOX_PROJECT_ID &&
        threadProjectFilterState.matches(t.projectId)
    )
    // Pinned threads keep one shared pin-time order; the default status sort
    // (to-do top, last-activity middle, done last) applies to unpinned threads.
    const pinned = list
      .filter((t) => t.pinned)
      .sort((a, b) => pinnedThreadSort(a, b, draftThreadKeys))
    const unpinned = list.filter((t) => !t.pinned)
    unpinned.sort((a, b) => threadStatusSort(a, b, draftThreadKeys))
    return [...pinned, ...unpinned]
  })

  let recentThreads = $derived.by(() => {
    const availableThreads = allThreads.filter((thread) => !thread.archived)
    const byVisitKey = new Map(availableThreads.map((thread) => [threadVisitKey(thread), thread]))
    const visited = workspaceState.recentThreadVisits
      .map((visitKey) => byVisitKey.get(visitKey))
      .filter((thread): thread is Thread => thread !== undefined)
    const visitedIds = new Set(visited.map((thread) => threadVisitKey(thread)))
    const activityFallback = availableThreads
      .filter((thread) => !visitedIds.has(threadVisitKey(thread)))
      .sort((a, b) => b.lastActivity - a.lastActivity)
    return [...visited, ...activityFallback].slice(0, 10)
  })

  let recentScopeLoadRequest = 0

  async function ensureRecentScopeBoards(projectIds: string[]): Promise<void> {
    const request = ++recentScopeLoadRequest
    for (const projectId of projectIds) {
      if (request !== recentScopeLoadRequest) return
      await scopeState.ensureBoardLoaded(projectId)
    }
  }

  $effect(() => {
    // Load scope boards for every project that has threads in the sidebar, not
    // just the top-10 recent ones. Scope tags and the two-row layout resolve per
    // thread through the project's own board, so after a refresh (when the boards
    // map starts empty) every visible project's board must be loaded or the tags
    // disappear until a project switch forces them in. ensureBoardLoaded is cached,
    // so this stays cheap after the first pass.
    const projectIds = [
      ...new Set(
        allThreads
          .filter((thread) => thread.projectId !== INBOX_PROJECT_ID)
          .map((thread) => thread.projectId)
      )
    ]
    void ensureRecentScopeBoards(projectIds)
  })

  let pinnedTimelineThreads = $derived(allThreadsFlat.filter((thread) => thread.pinned))
  let unpinnedTimelineThreads = $derived(allThreadsFlat.filter((thread) => !thread.pinned))

  // ─── Data loading ────────────────────────────────────────────────────────

  /** Keep keyed sidebar rows safe even when hydration and live updates overlap. */
  function uniqueThreadList(threads: Thread[]): Thread[] {
    const seen = new SvelteSet<string>()
    return threads.filter((thread) => {
      if (seen.has(thread.id)) return false
      seen.add(thread.id)
      return true
    })
  }

  /** Insert or refresh a thread in the sidebar list. The bounded hydration
   *  query only loads recent threads, so a thread opened from the scope board
   *  or history   or one the harness just started working on   must be added
   *  on first sighting instead of silently dropped. */
  function upsertThreadInList(thread: Thread): void {
    const index = allThreads.findIndex((candidate) => candidate.id === thread.id)
    if (index < 0) {
      allThreads = [thread, ...allThreads]
      return
    }
    const existing = allThreads[index]
    const hasDuplicate = allThreads.some(
      (candidate, candidateIndex) => candidateIndex !== index && candidate.id === thread.id
    )
    if (
      !hasDuplicate &&
      existing.updatedAt === thread.updatedAt &&
      existing.lastActivity === thread.lastActivity &&
      existing.status === thread.status &&
      existing.title === thread.title &&
      existing.pinned === thread.pinned &&
      existing.read === thread.read
    ) {
      return
    }
    let replaced = false
    allThreads = allThreads.flatMap((candidate) => {
      if (candidate.id !== thread.id) return [candidate]
      if (replaced) return []
      replaced = true
      return [thread]
    })
  }

  // Any thread the user lands on (notification click, cache restore, scope
  // board, switcher) must be visible in the regular sidebar even when it sits
  // beyond the bounded recent hydration list   otherwise its row never appears
  // and its live status transitions are lost.
  $effect(() => {
    const selected = workspaceState.selectedThread
    if (selected && !isOrchestrationChildThread(selected)) upsertThreadInList(selected)
  })

  // Full user-message history is prefetched by ThreadView shortly after mount
  // (idle-deferred off the first-paint path), so the panel is already populated
  // when the menu opens. This effect remains as a fallback: it re-fires when
  // the active thread changes (the callback pointer swaps on ThreadView mount)
  // so the list refreshes for the new thread if the menu is already open.
  $effect(() => {
    const load = workspaceState.loadUserMessageHistory
    if (!showHistoryMenu || !load) return
    void load()
  })

  // Live thread updates pushed from the main process (status/read changes
  // during agent runs)   keeps the sidebar indicators in sync without polling.
  // Updates are applied immediately so a finished turn flips the status badge
  // to done/unread the moment the harness reports it, never after a debounce.
  $effect(() => {
    return subscribe('thread:updated', (...args: unknown[]) => {
      const updated = args[0] as Thread
      scopeState.updateThread(updated)
      // Children stay out of the sidebar list, but the read flow below must
      // still cover them: the coordinator panel renders a worker's live status
      // chip from its own thread row, so an opened worker settles unread to
      // read exactly like a regular thread.
      if (!isOrchestrationChildThread(updated)) upsertThreadInList(updated)
      if (workspaceState.selectedThread?.id === updated.id) {
        workspaceState.updateThread(updated)
        // Auto-mark the selected thread read only while the window actually
        // has OS focus. While the user is away, the thread must stay unread:
        // the badge keeps counting it and the notification card stays up, and
        // the read transition happens once the user is back and a further
        // update arrives (or they explicitly open the thread). The confirmed
        // snapshot is applied to every sidebar store here so the badge can
        // never linger on a stale unread state when the backend's own
        // broadcast is missed.
        if (!updated.read && document.hasFocus() && threadTracksReadStatus(updated)) {
          requestThreadRead(updated.projectId, updated.id)
        }
      }
    })
  })

  /** Live draft-state updates pushed from the main process (this window's own
   *  commits plus other windows/instances): merge the drafting flag into every
   *  thread list and seed the local draft when this window does not have it. */
  $effect(() => {
    return subscribe('thread:draftUpdated', (...args: unknown[]) => {
      const [projectId, threadId, drafting, draftJson] = args as [
        string,
        string,
        boolean,
        string | null
      ]
      rendererRecovery.importDbDraft(projectId, threadId, draftJson)
      const withDraftState = (thread: Thread): Thread =>
        thread.id === threadId && thread.projectId === projectId
          ? { ...thread, drafting: drafting || undefined, draftJson }
          : thread
      allThreads = allThreads.map(withDraftState)
      for (const thread of scopeState.allScopeThreads) {
        if (thread.id === threadId && thread.projectId === projectId) {
          scopeState.updateThread(withDraftState(thread))
        }
      }
    })
  })

  // Selecting a thread through any path must settle its unread badge. Sidebar
  // clicks route through openThread, but every programmatic selection calls
  // workspaceState.openThread directly and bypasses it: the view-switch
  // reconcile in App.svelte (entering Chats restores the last chat), history
  // restore, and the startup restore below. Without this net the thread the
  // user is looking at would stay unread until they click a different row.
  // Keyed on the thread id so re-renders of the same selection are no-ops,
  // while switching away and back re-marks (marking read is idempotent).
  let readSettledThreadId: string | null = null
  $effect(() => {
    const thread = selectedThread
    if (!thread || thread.id === readSettledThreadId) return
    readSettledThreadId = thread.id
    // Only a thread that tracks read status settles here: a regular thread, or
    // a worker whose reporting the user switched off (the coordinator panel
    // shows its status chip, so an opened or selected non-reporting worker must
    // not stay unread). Reporting workers and auditors carry no read state:
    // the Assignment lifecycle is their indicator.
    if (thread.read || !threadTracksReadStatus(thread) || !document.hasFocus()) return
    markThreadReadAfterPaint(thread)
  })

  // Returning to the window with a thread already open must settle its unread
  // badge. While the window was unfocused the focus gate above deliberately
  // left the thread unread, but no further thread:updated may ever arrive once
  // the turn already finished   so without this the badge would linger green
  // while the user sits in the conversation reading it. Regaining focus is the
  // read signal for the open thread; marking read is idempotent.
  $effect(() => {
    const onWindowFocus = (): void => {
      const selected = workspaceState.selectedThread
      if (!selected || selected.read || !threadTracksReadStatus(selected)) return
      requestThreadRead(selected.projectId, selected.id)
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  })

  // Git branch settlement is deliberately a separate, lighter broadcast (see
  // `broadcastThreadBranchUpdated`) so it never routes through the full
  // `thread:updated` fan-out   that would force ThreadView's message
  // reconcile (and every other subscriber) to run at whatever moment the
  // branch resolves, including mid-typing on an already-open conversation.
  // Patch the field in place: mutating the proxied thread objects is enough
  // for the composer's branch pill to update reactively without rebuilding
  // any list or reloading messages.
  $effect(() => {
    return subscribe('thread:branchUpdated', (...args: unknown[]) => {
      const [projectId, threadId, branch] = args as [string, string, string | undefined]
      if (
        workspaceState.selectedThread?.projectId === projectId &&
        workspaceState.selectedThread.id === threadId
      ) {
        workspaceState.selectedThread.branch = branch
      }
      const listed = allThreads.find(
        (candidate) => candidate.projectId === projectId && candidate.id === threadId
      )
      if (listed) listed.branch = branch
    })
  })

  $effect(() => {
    return subscribe('thread:deleted', (projectId, threadId) => {
      allThreads = allThreads.filter((thread) => thread.id !== threadId)
      scopeState.removeThread(threadId)
      const browserTabIds = contextSidebarState.removeThreadBrowsers(projectId, threadId)
      if (browserFullscreenTabId && browserTabIds.includes(browserFullscreenTabId)) {
        browserFullscreenTabId = null
      }
      void invoke('browser:destroyThread', projectId, threadId)
      if (workspaceState.selectedThread?.id === threadId) workspaceState.clearThread()
    })
  })

  $effect(() => {
    return subscribe('agent:processesChanged', (projectId, threadId) => {
      if (
        workspaceState.selectedThread?.projectId === projectId &&
        workspaceState.selectedThread.id === threadId
      ) {
        void workspaceState.refreshSourceProcessCount(projectId, threadId)
      }
    })
  })

  $effect(() => {
    return subscribe('browser:openRequested', (url, context) => {
      if (context) {
        contextSidebarState.openBrowserForContext(
          url,
          context.projectId,
          context.threadId,
          context.requestedTabId,
          context.reveal
        )
        return
      }
      if (contextSidebarState.openBrowser(url) === null) void invoke('shell:openExternal', url)
    })
  })

  /** The last (thread, draft-state) pair the draft→todo nudge ran for, so the
   *  effect below only fires when the draft state actually transitions   never
   *  clobbering a manual slice switch while a draft stays unchanged. */
  let draftStageSyncKey: string | null = null

  // Sync the selected thread's draft state to scope so draft-aware slicing works.
  // This MUST run before the pending-updates effect so scope's draftThreadId is
  // always current when stageForThread is evaluated.
  $effect(() => {
    const id = selectedThread?.id ?? null
    const hasDraft = selectedThreadHasDraft
    scopeState.setSelectedThreadDraftState(id, hasDraft)
    // Immediately switch the scope sidebar to 'todo' when draft promotion kicks in
    // for the thread the sidebar is currently showing   but only when the draft
    // state changes. Reading sidebarContext here would otherwise make this effect
    // re-run on every manual stage change and undo the user's slice switch.
    const key = `${id}:${hasDraft}`
    if (
      id &&
      hasDraft &&
      scopeState.sidebarContext?.threadId === id &&
      scopeState.sidebarContext.stage !== 'todo' &&
      draftStageSyncKey !== key
    ) {
      scopeState.sidebarContext = { ...scopeState.sidebarContext, stage: 'todo' }
    }
    draftStageSyncKey = key
  })

  // Draft state is memory-only: any thread holding unsent composer content is
  // staged as draft ('todo') in scope views, and returns to its DB-derived
  // slice (done) the moment the user clears the draft again.
  $effect(() => {
    const ids: string[] = []
    for (const t of allThreads) {
      if (t.archived) continue
      if (
        rendererRecovery.hasDraftContent(t.projectId, t.id) ||
        speechController.isCapturingThread(t.id)
      ) {
        ids.push(t.id)
      }
    }
    scopeState.setDraftStageThreadIds(ids)
  })

  // Detect user-initiated scrolling of the sidebar so focus-follow doesn't
  // fight the user once they have taken over the scroll.
  $effect(() => {
    const scroller = sidebarScroller
    if (!scroller) return
    const onScrollGesture = (): void => handleSidebarUserScroll()
    scroller.addEventListener('wheel', onScrollGesture, { passive: true })
    scroller.addEventListener('touchmove', onScrollGesture, { passive: true })
    return () => {
      scroller.removeEventListener('wheel', onScrollGesture)
      scroller.removeEventListener('touchmove', onScrollGesture)
    }
  })

  /** Whether the sidebar is showing the scope-board project view. That view has
   *  its own per-stage lists and inner scrolling; the focus-follow reveal below
   *  is only for the regular Projects/Threads/Chats views. */
  let isScopeBoardView = $derived(mode === 'projects' && Boolean(scopeState.sidebarContext))

  // ─── Sidebar title dropdown   Projects / Scoped threads / Threads / Chats ──
  // The app header owns the view switcher now; the workspace only registers
  // the per-view quick actions that render next to it.
  $effect(() => {
    if (workspaceState.specStudioOpen) {
      viewActions.set('none', [])
      return
    }
    // Scope Board page: new scope, cross-scope search, new project   replacing
    // the old far-right toolbar of the scope view header.
    if (scopeViewActive) {
      const scopeBoardActions: ViewActionItem[] = [
        {
          id: 'new-scope',
          component: ScopeCreateControl as unknown as ViewActionItem['component'],
          props: { title: 'New scope' }
        },
        {
          id: 'search',
          component: ThreadSearchControl as unknown as ViewActionItem['component'],
          props: {
            threads: scopeState.allScopeThreads,
            contextLabel: 'threads across all scopes',
            title: 'Search threads across all scopes',
            onOpen: openThreadFromScopeSearch,
            fts: {}
          }
        },
        {
          id: 'new-project',
          component: ProjectCreateControl as unknown as ViewActionItem['component'],
          props: {
            projects,
            onProjectCreated: handleProjectCreated,
            onExisting: (project: Project) => void scopeState.activateProject(project.id),
            triggerAddProject: projectCreateTrigger,
            triggerKind: projectCreateTriggerKind
          }
        }
      ]
      viewActions.set('scope', scopeBoardActions)
      return
    }
    if (mode === 'threads') {
      const actions: ViewActionItem[] = [
        {
          id: 'search',
          component: SidebarSearchControl as unknown as ViewActionItem['component'],
          props: {
            open: sidebar.threadsSearchOpen,
            query: sidebar.threadsSearchQuery,
            onOpenChange: (open: boolean) => {
              if (open) sidebar.openThreadsSearch()
              else sidebar.closeThreadsSearch()
            },
            onQueryChange: sidebar.runThreadsSearch,
            ariaLabel: 'Search threads',
            title: 'Search threads',
            placeholder: 'Search threads…',
            size: 'md'
          }
        },
        ...(activeProject
          ? [
              {
                id: 'new-thread',
                icon: Plus,
                ariaLabel: `New thread in ${activeProject.name}`,
                title: `New thread in ${activeProject.name}`,
                shortcut: keymapKeys('nav-new-thread'),
                run: () => void createThreadInProject(activeProject)
              } satisfies ViewActionItem
            ]
          : []),
        {
          id: 'filter',
          component: ThreadProjectFilterMenu as unknown as ViewActionItem['component']
        }
      ]
      viewActions.set('threads', actions)
    } else if (mode === 'chats') {
      const chatsActions: ViewActionItem[] = [
        {
          id: 'search',
          component: ThreadSearchControl as unknown as ViewActionItem['component'],
          props: {
            threads: scopeState.allScopeThreads.filter(
              (thread) => thread.projectId === INBOX_PROJECT_ID
            ),
            contextLabel: 'chats',
            title: 'Search chats',
            onOpen: openThread,
            fts: { projectId: INBOX_PROJECT_ID }
          }
        },
        {
          id: 'new-chat',
          icon: SquarePen,
          ariaLabel: 'New chat',
          title: 'New chat',
          shortcut: keymapKeys('nav-new-thread'),
          run: startNewChat
        }
      ]
      viewActions.set('chats', chatsActions)
    } else if (mode === 'projects' && scopeState.sidebarContext) {
      // Same paradigm as every other view: search first, then new thread.
      const scopedActions: ViewActionItem[] = [
        {
          id: 'search',
          component: ThreadSearchControl as unknown as ViewActionItem['component'],
          props: {
            threads: STAGE_ORDER.flatMap((stage) =>
              scopeState.threadsFor(
                scopeState.sidebarContext?.bucketId ?? DEFAULT_SCOPE_BUCKET_ID,
                stage
              )
            ),
            contextLabel: 'threads in this scope',
            title: 'Search threads in this scope',
            onOpen: (thread: Thread) => void openScopedThread(thread),
            fts: {}
          }
        },
        {
          id: 'new-thread',
          icon: Plus,
          ariaLabel: 'New thread in this scope',
          title: 'New thread in this scope',
          shortcut: keymapKeys('nav-new-thread'),
          run: () => newThreadInScopeContext()
        },
        {
          id: 'new-scope',
          component: ScopeCreateControl as unknown as ViewActionItem['component'],
          props: { title: 'New scope' }
        }
      ]
      viewActions.set('scoped-threads', scopedActions)
    } else {
      const projectActions: ViewActionItem[] = [
        {
          id: 'search',
          component: ThreadSearchControl as unknown as ViewActionItem['component'],
          props: {
            threads: allThreads,
            contextLabel: 'threads',
            title: 'Search threads',
            onOpen: openThread,
            fts: {}
          }
        },
        {
          id: 'new-project',
          component: ProjectCreateControl as unknown as ViewActionItem['component'],
          props: {
            projects,
            onProjectCreated: handleProjectCreated,
            onExisting: handleExistingProject,
            triggerAddProject: projectCreateTrigger,
            triggerKind: projectCreateTriggerKind
          }
        }
      ]
      viewActions.set('projects', projectActions)
    }
  })

  /** View the shoe toggles back to   whatever the user was on right before the
   *  scoped projects view was opened via the shoe. */
  let scopeShoeReturnView: MainView = 'threads'

  /** Composer scope shoe: on an existing thread, clicking the scope toggles between
   *  the last view the user was on and the scoped projects view (sidebar focused
   *  on this thread). */
  async function openThreadScopeView(thread: Thread): Promise<void> {
    // Already on the registered scoped view (projects board with the scope
    // sidebar focused on this thread): bounce back to the view the user came
    // from when the shoe opened it (second half of the toggle).
    if (rendererRecovery.activeView === 'projects-scope' && scopeState.sidebarContext !== null) {
      navigate(scopeShoeReturnView)
      return
    }
    scopeShoeReturnView = rendererRecovery.activeView
    navigate('projects-scope')
    const allThreads: Thread[] = await invoke('thread:listAll')
    scopeState.setThreads(allThreads)
    await scopeState.activateProject(thread.projectId)
    scopeState.showSidebarForThread(thread)
    void scopeState.ensureBoardLoaded(thread.projectId)
  }

  /** New thread inside the board's active scope bucket. */
  function newThreadInScopeContext(): void {
    const context = scopeState.sidebarContext
    const project = projects.find((candidate) => candidate.id === context?.projectId)
    if (!context || !project) return
    void createThreadInProject(project, context.bucketId)
  }

  /** Open a thread from the Scope Board cross-scope search: land back in the
   *  project view, select it, hydrate its board and mark it read (mirrors the
   *  former app-shell openScopeThread flow). */
  async function openThreadFromScopeSearch(thread: Thread): Promise<void> {
    navigate('projects')
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
    workspaceState.openThread(thread, project)
    void scopeState.ensureBoardLoaded(thread.projectId)
    const updated = await invoke('thread:markRead', thread.projectId, thread.id)
    scopeState.updateThread(updated)
    workspaceState.updateThread(updated)
  }

  // The scope-state sidebar board reads its data from the active project's board
  // and thread list (`scopeState.board` / `currentProjectThreads`, keyed off
  // `activeProjectId`). The sidebar context is set with a fire-and-forget
  // `activateProject`, so `sidebarContext.projectId` and `activeProjectId` can be
  // out of sync on first entry   which would render stale/empty stage slices until
  // a project switch realigned them. Keep them aligned reactively so the board
  // hydrates immediately (mirrors ScopeView's own activeProjectId reload effect).
  $effect(() => {
    const context = scopeState.sidebarContext
    if (context && context.projectId !== scopeState.activeProjectId) {
      void scopeState.activateProject(context.projectId)
    }
  })

  // Keep managed-worktree health fresh for the scoped sidebar too, so the scope
  // menu offers "Repair worktree" exactly when the board would (deduped in the store).
  //
  // Worktree health belongs to a *scope*, not to a thread, so this is keyed on
  // the docked project+bucket values rather than on the sidebar-context object.
  // `showSidebarForThread` allocates a fresh context object on every thread
  // switch, so depending on the object made each switch inside one scope look
  // like a scope change. Depending on the two strings re-runs only when the
  // scope actually moves or the board changes.
  const dockedScopeProjectId = $derived(scopeState.sidebarContext?.projectId ?? '')
  const dockedScopeBucketId = $derived(scopeState.sidebarContext?.bucketId ?? '')
  $effect(() => {
    const projectId = dockedScopeProjectId
    if (!projectId) return
    const buckets = scopeState.boards.get(projectId)?.buckets
    scheduleDeferredWork('scope:boardHealth', () =>
      scopeState.syncBoardWorktreeHealth(projectId, buckets)
    )
  })

  // Switching the docked scope is an interaction with it: re-read that scope's
  // health so a checkout that changed on disk is reported right away. Same
  // value-keyed dependency as above, so a thread switch inside one scope asks
  // for nothing at all. What does need reading is queued for after the switch
  // has painted, because discovery shells out to Git.
  $effect(() => {
    const projectId = dockedScopeProjectId
    const bucketId = dockedScopeBucketId
    if (!projectId || !bucketId) return
    scheduleDeferredWork('scope:worktreeHealth', () => {
      void scopeState.revalidateWorktreeHealth(projectId, bucketId).catch(() => undefined)
    })
  })

  // While a thread is selected, keep its row (and project) in focus in the
  // sidebar. Selection changes expand the owning folder and reset any scroll
  // suppression; list changes re-reveal the row if background activity pushed
  // it out of view. The scope-board view is left untouched.
  $effect(() => {
    const thread = selectedThread
    if (!thread) return
    // Track the sort source arrays so the effect re-runs whenever the sidebar
    // lists reorder (thread updates, project reorders) and re-reveals if needed.
    void allThreads
    void projects
    if (thread.id !== lastFocusedThreadId) {
      lastFocusedThreadId = thread.id
      sidebarFocusSuppressed = false
      // A deliberate selection of a new thread overrides the mode-switch
      // suppression window so the chosen thread is always revealed, even right
      // after navigating across sidebar modes.
      sidebarRevealSuppressed = false
      clearTimeout(sidebarRevealSuppressTimer)
      if (thread.projectId !== INBOX_PROJECT_ID) {
        sidebar.expandedFolders.add(thread.projectId)
        // Ensure the folder shows enough rows for the focused thread so its
        // row is actually rendered, then reveal it once the rows mount.
        const folderThreads = threadsByProject.get(thread.projectId) ?? []
        const threadIndex = folderThreads.findIndex((candidate) => candidate.id === thread.id)
        if (threadIndex >= 0) {
          sidebar.ensureRowVisible(thread.projectId, threadIndex + 1)
        }
        if (!sidebarRevealSuppressed) {
          void tick().then(() => revealThreadInSidebar(thread.id))
        }
      } else if (!sidebarRevealSuppressed) {
        // Standalone chats (inbox) have no folder to expand   reveal directly
        // once the mode's list has rendered the row.
        void tick().then(() => revealThreadInSidebar(thread.id))
      }
    }
    if (sidebarFocusSuppressed || sidebarRevealSuppressed) return
    if (isScopeBoardView) return
    revealThreadInSidebar(thread.id)
  })

  // Keep the header icon in sync with the active project and icon cache.
  // Reading activeProjectIconUrl also re-syncs after a thread switch: openThread
  // resets the URL to null when the project has no custom icon, and switching
  // between threads of the same project leaves activeProject unchanged, so this
  // effect must re-run on the reset to restore the resolved fallback icon.
  $effect(() => {
    const project = workspaceState.activeProject
    if (project) {
      void workspaceState.activeProjectIconUrl
      const storedUrl = projectIcons.get(project.id)
      workspaceState.setActiveProjectIconUrl(getProjectIcon(project, storedUrl))
    }
  })

  // Keep active-project thread stats in sync for the header menu.
  $effect(() => {
    const projectId = workspaceState.activeProject?.id
    if (!projectId) {
      workspaceState.setActiveProjectStats(0, 0)
      return
    }
    const projectThreads = allThreads.filter((t) => t.projectId === projectId && !t.archived)
    const working = projectThreads.filter((thread) => threadHasVisibleWork(thread)).length
    workspaceState.setActiveProjectStats(projectThreads.length, working)
  })

  // Open the edit modal when AppHeader signals it.
  $effect(() => {
    const projectId = workspaceState.projectIdToEdit
    if (!projectId) return
    projectDialogs.askEditProject(projectId)
    workspaceState.closeProjectEdit()
  })

  async function loadData(): Promise<void> {
    try {
      const [projectList, threadList] = await Promise.all([
        invoke('project:list'),
        invoke('thread:listRecentPerProject')
      ])
      projects = projectList
      const uniqueThreads = uniqueThreadList(threadList)
      allThreads = uniqueThreads.filter((t) => !isOrchestrationChildThread(t))
      historyOffset = uniqueThreadList(threadList).length
      hasMoreHistory = false
      notificationPanelState.hydrateFromThreads(uniqueThreads, projectList)
      projectIcons.clear()
      // Publish the workspace with deterministic fallback icons immediately.
      // Custom icon IPC is cosmetic and must never delay the first usable frame.
      scopeState.setScopesFromProjects(projectList, projectIcons)
      scopeState.setThreads(uniqueThreads)
      void rescueDraftThreads()
      sidebar.initExpandedFolders(projectList.filter((p) => !p.hidden))
      void loadProjectIcons(projectList).then((icons) => {
        for (const [projectId, iconUrl] of icons) projectIcons.set(projectId, iconUrl)
        scopeState.setScopesFromProjects(projectList, projectIcons)
      })
      const saved = rendererRecovery.selectedThread
      const restoredThread = saved
        ? uniqueThreads.find(
            (candidate) =>
              candidate.id === saved.threadId &&
              candidate.projectId === saved.projectId &&
              !candidate.archived
          )
        : undefined
      if (restoredThread) {
        workspaceState.openThread(
          restoredThread,
          projectList.find((candidate) => candidate.id === restoredThread.projectId) ?? null
        )
        // Read-settling for programmatic selections is centralized in the
        // selected-thread effect above; startup restore needs no extra call.
        void scopeState.ensureBoardLoaded(restoredThread.projectId)
      } else if (saved) {
        // The saved thread may sit beyond the bounded recent hydration list
        // (e.g. it was manually reordered below the cut). Fetch it directly so
        // the workspace restores onto the same thread instead of clearing it.
        try {
          const savedThread = await invoke('thread:get', saved.projectId, saved.threadId)
          const project = projectList.find((candidate) => candidate.id === saved.projectId) ?? null
          if (savedThread && !savedThread.archived) {
            upsertThreadInList(savedThread)
            workspaceState.openThread(savedThread, project)
            void scopeState.ensureBoardLoaded(saved.projectId)
          } else {
            rendererRecovery.clearSelectedThread()
          }
        } catch {
          rendererRecovery.clearSelectedThread()
        }
      }

      // Restore the last active project even without a thread
      if (rendererRecovery.selectedProjectId && !workspaceState.activeProject) {
        const project = projectList.find((p) => p.id === rendererRecovery.selectedProjectId) ?? null
        if (project) {
          workspaceState.activeProject = project
          workspaceState.activeProjectIconUrl = projectIcons.get(project.id) ?? null
        }
      }
      // App-start Git discovery launches several local subprocesses, and its
      // stale-gated fetch opens a network round trip. Keep both out of the first
      // usable frame: the delay lands them once the restored conversation has
      // painted, and thread selection or opening the Git panel still triggers
      // them immediately when the user gets there first. Triggering the fetch
      // here is what keeps it off the panel's open path, where a user asking the
      // panel for something is the last moment a round trip should start.
      window.setTimeout(() => {
        gitState.notifyAppStarted(workspaceState.activeProject)
      }, 2000)

      // The workspace is the single owner of initial hydration. Keep provider
      // catalog work after the first data pass and after a frame so startup
      // thread rendering is not competing with model discovery.
      void invoke('app:waitForFeatures').then(() => {
        window.requestAnimationFrame(() => {
          const targets = scopeState.activeProjectId
            ? [scopeState.activeProjectId, INBOX_PROJECT_ID]
            : [INBOX_PROJECT_ID]
          void providerCatalog.init(targets, { refresh: true })
          void providerStore.init()
        })
      })

      // Never auto-create a chat, thread, or project on startup   the user
      // (or the onboarding tour) initiates that. When no thread was restored
      // from the recovery snapshot, reopen the last thread the user actually
      // visited (recentThreadVisits is persisted visit order); fall back to
      // the most recently active thread of the mode. allThreads order is not
      // visit recency (listRecent hoists the selected project first), so it
      // must never be used to guess the last-open thread.
      if (active && !workspaceState.selectedThread) {
        const wantChat = mode === 'chats'
        const candidates = allThreads.filter(
          (t) => !t.archived && (t.projectId === INBOX_PROJECT_ID) === wantChat
        )
        const byVisit = new Map(candidates.map((t) => [threadVisitKey(t), t]))
        const last =
          workspaceState.recentThreadVisits
            .map((key) => byVisit.get(key))
            .find((t) => t !== undefined) ??
          candidates.sort((a, b) => b.lastActivity - a.lastActivity)[0]
        if (last) {
          workspaceState.openThread(
            last,
            projectList.find((candidate) => candidate.id === last.projectId) ?? null
          )
          void scopeState.ensureBoardLoaded(last.projectId)
        }
      }
    } catch {
      projects = []
      allThreads = []
    } finally {
      loading = false
      void invoke('app:rendererReady').catch(() => undefined)
    }
  }

  /**
   * Lightweight re-sync of the project/thread lists when the shell becomes
   * visible again after a trip to Settings or Scope. The full loadData() pass
   * is intentionally not re-run: it would reset folder expansion and re-restore
   * the thread, and the open thread never unmounts so it needs no re-fetch.
   */
  async function refreshListData(): Promise<void> {
    try {
      const [projectList, threadList] = await Promise.all([
        invoke('project:list'),
        invoke('thread:listRecentPerProject')
      ])
      projects = projectList
      const uniqueThreads = uniqueThreadList(threadList)
      allThreads = uniqueThreads.filter((t) => !isOrchestrationChildThread(t))
      historyOffset = uniqueThreadList(threadList).length
      hasMoreHistory = false
      notificationPanelState.hydrateFromThreads(uniqueThreads, projectList)
      projectIcons.clear()
      for (const [projectId, iconUrl] of await loadProjectIcons(projectList)) {
        projectIcons.set(projectId, iconUrl)
      }
      scopeState.setScopesFromProjects(projectList, projectIcons)
      scopeState.setThreads(uniqueThreads)
      void rescueDraftThreads()
    } catch {
      // Non-fatal   keep the current lists on failure.
    }
  }

  /** Threads whose unsent composer content fell outside the bounded first-paint
   *  hydration - drafts persist in renderer storage only (never the DB), so the
   *  SQL slice cannot know about them. Drafts load unbounded, like unread:
   *  each is fetched with `thread:get` and merged into both the project-list
   *  (`allThreads`) and the scope store so it shows everywhere immediately,
   *  pinned to its project list via the draft sort. */
  let rescuingDraftThreads = false
  async function rescueDraftThreads(): Promise<void> {
    if (rescuingDraftThreads) return
    rescuingDraftThreads = true
    try {
      for (const ref of rendererRecovery.listDraftThreadRefs()) {
        if (
          allThreads.some((t) => t.id === ref.threadId) ||
          scopeState.allScopeThreads.some((t) => t.id === ref.threadId)
        ) {
          continue
        }
        const thread = await invoke('thread:get', ref.projectId, ref.threadId)
        if (!thread || thread.archived || isOrchestrationChildThread(thread)) continue
        upsertThreadInList(thread)
        scopeState.updateThread(thread)
      }
      // Threads flagged drafting in the DB (this or another instance's draft
      // commits) must surface too, even when they fell outside the bounded
      // first-paint slice: a thread being dictated in another window can never
      // be dropped from the listing. Their drafts seed the local recovery
      // store whenever this window does not hold a newer local draft.
      const draftingThreads = await invoke('thread:listDrafting').catch(() => [] as Thread[])
      for (const thread of draftingThreads) {
        rendererRecovery.importDbDraft(thread.projectId, thread.id, thread.draftJson ?? null)
        if (
          thread.archived ||
          isOrchestrationChildThread(thread) ||
          allThreads.some((t) => t.id === thread.id) ||
          scopeState.allScopeThreads.some((t) => t.id === thread.id)
        ) {
          continue
        }
        upsertThreadInList(thread)
        scopeState.updateThread(thread)
      }
    } finally {
      rescuingDraftThreads = false
    }
  }

  /** The scoped board renders only threads held in memory for its project.
   *  First-paint hydration is a bounded recent slice, so every open or restore
   *  of a scope hydrates that project's full thread list in the background. */
  $effect(() => {
    const projectId = scopeState.sidebarContext?.projectId
    if (projectId) void scopeState.ensureProjectThreadsLoaded(projectId)
  })

  let wasActive: boolean | null = null
  $effect(() => {
    const nowActive = active
    if (wasActive !== null && nowActive && !wasActive) {
      void refreshListData()
    }
    wasActive = nowActive
  })

  /** Cmd/Ctrl+W while the context sidebar has focus closes its active tab
   *  (through the unsaved-changes confirmation) rather than the thread. The
   *  store captures the tab id when the request is made and hands it over
   *  exactly once, and this effect reads nothing else: resolving the active tab
   *  here instead closed the *next* tab on every re-run, because closing a tab
   *  changes which tab is active, so one shortcut press cascaded through every
   *  panel the thread had and kept closing each new panel afterwards. */
  $effect(() => {
    const tabId = contextSidebarState.consumeCloseActiveTabRequest()
    if (tabId) closeContextTab(tabId)
  })

  /** Threads view must not be bounded by the per-project first-paint slices:
   *  it ranks threads by status and last activity globally, so a project whose
   *  recent slice simply never included an old done thread would distort the
   *  order. Switching to Threads view hydrates the global recent list, bounded
   *  to 200 combined rows with last-activity as the source of truth; deeper
   *  history stays available through the existing "Load older threads" pager. */
  const THREADS_VIEW_HYDRATION_LIMIT = 200
  let threadsViewHydrating = false
  async function ensureThreadsViewFullyLoaded(): Promise<void> {
    if (threadsViewHydrating) return
    threadsViewHydrating = true
    try {
      const page = await invoke('thread:listRecent', {
        limit: THREADS_VIEW_HYDRATION_LIMIT,
        offset: 0
      })
      const uniqueCurrentThreads = uniqueThreadList(allThreads)
      const known = new Set(uniqueCurrentThreads.map((thread) => thread.id))
      const additions = uniqueThreadList(page).filter(
        (thread) => !known.has(thread.id) && !isOrchestrationChildThread(thread)
      )
      for (const thread of page) {
        if (!thread.archived) scopeState.updateThread(thread)
      }
      if (additions.length > 0 || uniqueCurrentThreads.length !== allThreads.length) {
        allThreads = [...uniqueCurrentThreads, ...additions]
      }
      historyOffset = Math.max(historyOffset, page.length)
      hasMoreHistory = page.length === THREADS_VIEW_HYDRATION_LIMIT
    } finally {
      threadsViewHydrating = false
    }
  }

  $effect(() => {
    if (mode === 'threads' && active) void ensureThreadsViewFullyLoaded()
  })

  /** Filter backfill: the 200-row hydration window is unfiltered, so a narrowed
   *  project filter can render far fewer than 200 rows even though matching
   *  threads exist beyond the window. The filter must replace hidden rows with
   *  matching ones, so while the visible (unpinned) count is below the window
   *  and DB pages remain, keep pulling 50-row history pages. Each page changes
   *  `allThreads`/`hasMoreHistory` and re-runs this effect, so the loop is
   *  self-terminating and bounded by the pager's own exhaustion flag. */
  $effect(() => {
    if (mode !== 'threads' || !active) return
    if (threadProjectFilterState.isAll) return
    if (sidebar.threadsSearching && sidebar.threadsSearchQuery.trim()) return
    const visible = allThreads.filter(
      (t) =>
        !t.archived &&
        !t.pinned &&
        t.projectId !== INBOX_PROJECT_ID &&
        threadProjectFilterState.matches(t.projectId)
    ).length
    if (visible >= THREADS_VIEW_HYDRATION_LIMIT || !hasMoreHistory) return
    void loadHistoryPage()
  })

  /** Explicit timeline expansion. The initial shell intentionally carries
   * only a bounded recent slice; older tasks remain paged and deduped. */
  async function loadHistoryPage(): Promise<void> {
    if (historyLoading || !hasMoreHistory) return
    historyLoading = true
    try {
      const page = await invoke('thread:listHistoryPage', {
        limit: HISTORY_PAGE_LIMIT,
        offset: historyOffset
      })
      historyOffset += page.length
      hasMoreHistory = page.length === HISTORY_PAGE_LIMIT
      const uniqueCurrentThreads = uniqueThreadList(allThreads)
      const known = new Set(uniqueCurrentThreads.map((thread) => thread.id))
      const additions = uniqueThreadList(page).filter(
        (thread) => !known.has(thread.id) && !isOrchestrationChildThread(thread)
      )
      for (const thread of page) {
        if (!thread.archived) scopeState.updateThread(thread)
      }
      if (additions.length > 0 || uniqueCurrentThreads.length !== allThreads.length) {
        allThreads = [...uniqueCurrentThreads, ...additions]
      }
    } finally {
      historyLoading = false
    }
  }

  /**
   * Fetch a project's older threads from the DB when its sidebar list is
   * expanded past the per-project hydration slice. Results accumulate in
   * `allThreads`, so subsequent renders are served from the in-memory cache.
   */
  async function loadProjectThreadsPage(projectId: string): Promise<void> {
    if (projectPageLoading === projectId) return
    projectPageLoading = projectId
    try {
      const offset = projectPageOffsets.get(projectId) ?? 0
      const page = await invoke('thread:listProjectPage', {
        projectId,
        limit: PROJECT_PAGE_LIMIT,
        offset
      })
      projectPageOffsets.set(projectId, offset + page.length)
      if (page.length < PROJECT_PAGE_LIMIT) projectExhausted.add(projectId)
      const additions = page
        .filter((t) => !isOrchestrationChildThread(t))
        .filter((t) => !allThreads.some((existing) => existing.id === t.id))
      if (additions.length > 0) {
        allThreads = [...allThreads, ...additions]
        for (const thread of additions) {
          if (!thread.archived) scopeState.updateThread(thread)
        }
      }
      // Reveal the freshly fetched rows immediately   the user asked for older
      // threads, so they must not need a second "Show more" click to see them.
      if (additions.length > 0 || page.length > 0) {
        const folderThreads = allThreads.filter(
          (t) => t.projectId === projectId && !t.archived && !t.pinned
        )
        sidebar.extendVisibleCount(projectId, additions.length, folderThreads.length)
      }
    } finally {
      projectPageLoading = null
    }
  }

  /** Whether a project's sidebar list still has unfetched older rows in the DB. */
  function projectHasMoreInDb(projectId: string): boolean {
    return !projectExhausted.has(projectId)
  }

  async function handleProjectCreated(project: Project): Promise<void> {
    projects = [project, ...projects]
    sidebar.expandedFolders.add(project.id)
    if (project.icon) {
      const url = await invoke('project:getIcon', project.id)
      if (url) projectIcons.set(project.id, url)
    } else {
      // Still add an entry so the iconUrl check resolves correctly
      projectIcons.delete(project.id)
    }
    // Land the user in a fresh thread with the new project selected.
    await createThreadInProject(project)
  }

  function handleExistingProject(project: Project): void {
    sidebar.expandedFolders.add(project.id)
  }

  async function deleteProject(projectId: string, deleteFolder = false): Promise<void> {
    if (projectDialogs.deletingProjectId !== null) return
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    projectDialogs.deletingProjectId = projectId

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
      projectDialogs.deletingProjectId = null
    }

    // Backend deletion succeeded; now mirror it in the UI state.
    const browserTabIds = contextSidebarState.removeProjectBrowsers(projectId)
    if (browserFullscreenTabId && browserTabIds.includes(browserFullscreenTabId)) {
      browserFullscreenTabId = null
    }
    projects = projects.filter((p) => p.id !== projectId)
    allThreads = allThreads.filter((t) => t.projectId !== projectId)
    projectIcons.delete(projectId)
    if (selectedThread?.projectId === projectId) workspaceState.clearThread()
    // Best-effort teardown of the project's browser sessions. The project is
    // already gone backend-side, so a failure here must not roll the UI back.
    void invoke('browser:destroyProject', projectId).catch(() => {})
  }

  // ─── Folder ellipsis menu actions ────────────────────────────────────────

  // ─── Scope bucket actions ──────────────────────────────────────────────────

  // Scope actions live in the shared controller (see `scopeActions` above) so the
  // board and the scoped-threads sidebar run identical code paths.

  // ─── Drag-to-reorder ──────────────────────────────────────────────────────

  async function handleProjectMove(
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    const orderedIds = visibleProjects.map((p) => p.id)
    const fromIdx = orderedIds.indexOf(draggedId)
    const toIdx = orderedIds.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) return

    orderedIds.splice(fromIdx, 1)
    const adjustedTo = orderedIds.indexOf(targetId)
    if (adjustedTo === -1) return
    orderedIds.splice(position === 'before' ? adjustedTo : adjustedTo + 1, 0, draggedId)

    const updated = await invoke('project:reorder', orderedIds)
    for (const p of updated) {
      projects = projects.map((pr) => (pr.id === p.id ? p : pr))
    }
  }

  async function handleThreadMove(
    projectId: string,
    draggedId: string,
    targetId: string,
    position: 'before' | 'after',
    includePinned = false
  ): Promise<void> {
    const projectThreads = allThreads
      .filter((t) => t.projectId === projectId && !t.archived && (includePinned || !t.pinned))
      .sort((a, b) => threadSort(a, b, draftThreadKeys))
    const fromIdx = projectThreads.findIndex((t) => t.id === draggedId)
    const toIdx = projectThreads.findIndex((t) => t.id === targetId)
    if (fromIdx === -1 || toIdx === -1) return

    const dragged = projectThreads[fromIdx]
    projectThreads.splice(fromIdx, 1)
    const adjustedTo = projectThreads.findIndex((t) => t.id === targetId)
    if (adjustedTo === -1) return
    projectThreads.splice(position === 'before' ? adjustedTo : adjustedTo + 1, 0, dragged)

    // Assign a "frozen recency" anchor between the dragged thread's new
    // neighbours' effective keys, so it holds position while newer activity
    // can still bubble above it. The dragged thread's index in the new list is
    // where its anchor must sit.
    const idx = projectThreads.findIndex((t) => t.id === draggedId)
    const above = projectThreads[idx - 1]
    const below = projectThreads[idx + 1]
    const effectiveKey = (t: Thread) => Math.max(t.sortOrder ?? 0, t.lastActivity)
    const aboveKey = above ? effectiveKey(above) : Number.MAX_SAFE_INTEGER
    const belowKey = below ? effectiveKey(below) : 0
    let sortOrder: number
    if (above && below) {
      sortOrder = (aboveKey + belowKey) / 2
    } else if (above) {
      sortOrder = Math.max(aboveKey - 1, 0)
    } else if (below) {
      sortOrder = belowKey + 1
    } else {
      sortOrder = Date.now()
    }

    // Optimistic: anchor immediately so the sidebar reorders on drop.
    allThreads = allThreads.map((t) => (t.id === draggedId ? { ...t, sortOrder } : t))
    const persisted = await invoke('thread:setSortOrder', projectId, draggedId, sortOrder)
    upsertThreadInList(persisted)
  }

  /**
   * Manual reorder of the sidebar pinned section. Pin order is one shared
   * global sequence across every project group, so a drop relative to any
   * thread   same project or not   inserts the dragged thread at that point in
   * the global order. Visually the thread stays in its own project group and
   * lands at the group edge nearest the drop (top when dropped above a higher
   * group, bottom when dropped below a lower one). Rewrites pinned_at so the
   * first thread is most-recently pinned (top), applied optimistically so the
   * section reorders the moment the user drops.
   */
  async function handlePinnedThreadMove(
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    const pinnedIds = pinnedThreads.map((t) => t.id)
    const fromIdx = pinnedIds.indexOf(draggedId)
    const toIdx = pinnedIds.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) return

    pinnedIds.splice(fromIdx, 1)
    const adjustedTo = pinnedIds.indexOf(targetId)
    if (adjustedTo === -1) return
    pinnedIds.splice(position === 'before' ? adjustedTo : adjustedTo + 1, 0, draggedId)

    // Optimistic: assign new pinned_at immediately so the pinned section
    // reorders on drop, before the persisted result returns.
    const base = Date.now()
    allThreads = allThreads.map((t) => {
      const index =
        t.pinned && !t.archived && t.projectId !== INBOX_PROJECT_ID ? pinnedIds.indexOf(t.id) : -1
      return index !== -1 ? { ...t, pinnedAt: base - index } : t
    })

    const updated = await invoke('thread:reorderPinnedGlobal', pinnedIds)
    for (const t of updated) {
      upsertThreadInList(t)
    }
  }

  /**
   * Manual reorder of the global pinned section in Threads view. Rewrites
   * pinned_at across every project so the first thread is most-recently
   * pinned, applied optimistically so the section reorders the moment the
   * user drops. This is the only thing that changes pin order.
   */
  async function handleTimelinePinnedMove(
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    const pinnedIds = pinnedTimelineThreads.map((t) => t.id)
    const fromIdx = pinnedIds.indexOf(draggedId)
    const toIdx = pinnedIds.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) return

    pinnedIds.splice(fromIdx, 1)
    const adjustedTo = pinnedIds.indexOf(targetId)
    if (adjustedTo === -1) return
    pinnedIds.splice(position === 'before' ? adjustedTo : adjustedTo + 1, 0, draggedId)

    // Optimistic: assign new pinned_at immediately so the pinned section
    // reorders on drop, before the persisted result returns.
    const base = Date.now()
    allThreads = allThreads.map((t) => {
      const index =
        t.pinned && !t.archived && t.projectId !== INBOX_PROJECT_ID ? pinnedIds.indexOf(t.id) : -1
      return index !== -1 ? { ...t, pinnedAt: base - index } : t
    })

    const updated = await invoke('thread:reorderPinnedGlobal', pinnedIds)
    for (const t of updated) {
      upsertThreadInList(t)
    }
  }

  // ─── Thread actions ──────────────────────────────────────────────────────

  /** Create a project task by cloning the active thread; fresh installs use the saved defaults. */
  async function createThreadInProject(
    project: Project,
    requestedBucketId?: string
  ): Promise<void> {
    // Scope inheritance mirrors settings inheritance: the new thread object
    // carries the current thread's scope bucket, nothing more. It must never
    // activate the scope sidebar or switch the view  that side effect is
    // reserved for callers that explicitly ask for a scope bucket (scope
    // board's new-thread action, file-tree drop, ...).
    const activeThread = workspaceState.selectedThread
    const inheritedBucketId =
      activeThread && activeThread.projectId === project.id ? activeThread.scopeBucketId : undefined
    const scopeBucketId = requestedBucketId ?? inheritedBucketId
    const inheritedSettings = settingsForNewThread(activeThread, threadSettings.lastUsed)
    const existing = findEmptyNewThread(allThreads, project.id, scopeBucketId)
    if (existing) {
      if (workspaceState.selectedThread?.id === existing.id) {
        workspaceState.requestFocusComposer()
      } else {
        // Open instantly   settings/lifecycle sync is best-effort off the critical path
        const needsSettingsUpdate = Boolean(activeThread?.settings)
        const thread = existing
        upsertThreadInList(thread)
        threadMessages.seedEmpty(thread.projectId, thread.id)
        // Empty-state creation (no existing thread open): the reused blank
        // thread still counts as the fresh thread this moment created.
        if (!activeThread) workspaceState.markThreadFreshFromEmptyState(thread.id)
        workspaceState.openThread(thread, project)
        if (scopeBucketId) {
          scopeState.updateThread(thread)
        }
        if (requestedBucketId) {
          scopeState.showSidebarForThread(thread, requestedBucketId)
        }
        if (needsSettingsUpdate) {
          void invoke('thread:updateSettings', existing.projectId, existing.id, inheritedSettings)
            .then((updated) => upsertThreadInList(updated))
            .catch(() => {})
        }
        if (activeThread) {
          void inheritEngineeringLifecycle(project.id, activeThread.id, thread.id)
        }
      }
      return
    }
    // Instant mount: create optimistic thread locally so the composer
    // paints on the same tick as the click   no IPC on the critical path.
    // Git branch and persistence hydrate async via the thread:update broadcast.
    const optimisticId = (() => {
      const bytes = new Uint8Array(12)
      crypto.getRandomValues(bytes)
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    })()
    const optimisticThread = {
      id: optimisticId,
      projectId: project.id,
      providerId: 'pi' as const,
      title: DEFAULT_THREAD_TITLE,
      titleSource: 'default' as const,
      status: 'created' as const,
      pinned: false,
      archived: false,
      read: true,
      settings: inheritedSettings,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActivity: Date.now(),
      workingDirectory: project.path,
      ...(scopeBucketId ? { scopeBucketId } : {})
    }
    // Apply inherited settings immediately so the composer has correct model
    const thread = optimisticThread as unknown as typeof optimisticThread & {
      settings: typeof inheritedSettings
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsertThreadInList(thread as any)
    threadMessages.seedEmpty(thread.projectId, thread.id)
    sidebar.expandedFolders.add(project.id)
    if (scopeBucketId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (scopeBucketId) scopeState.updateThread(thread as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (requestedBucketId) scopeState.showSidebarForThread(thread as any, requestedBucketId)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workspaceState.openThread(thread as any, project)
    // Empty-state creation (no existing thread was open): this new thread gets
    // the centered composer head start even if the project holds other threads.
    // Threads created from an existing thread never get the marker.
    if (!activeThread) workspaceState.markThreadFreshFromEmptyState(thread.id)
    // Persist in background with the same stable id   no ID swap, branch
    // detection runs after the first thread:update broadcast, never blocking typing.
    void invoke('thread:create', {
      id: optimisticId,
      projectId: project.id,
      providerId: 'pi',
      title: DEFAULT_THREAD_TITLE,
      workingDirectory: project.path,
      settings: inheritedSettings,
      ...(scopeBucketId ? { scopeBucketId } : {})
    })
      .then((created) => {
        // Server confirms with same id; upsert the authoritative row (now with branch when ready)
        const confirmed = activeThread?.settings
          ? threadWithInheritedSettings(created, inheritedSettings)
          : created
        upsertThreadInList(confirmed)
        if (workspaceState.selectedThread?.id === optimisticId) {
          workspaceState.openThread(confirmed, project)
        }
        // Lifecycle inheritance must run only after the destination row is
        // durable: fired concurrently with creation, its internal `thread:get`
        // can race ahead of the insert and the "Thread not found" failure is
        // swallowed   leaving the toolbox icon lit while every switch reads off.
        if (activeThread) {
          void inheritEngineeringLifecycle(project.id, activeThread.id, optimisticId)
        }
        if (activeThread?.settings) {
          // Settings already applied optimistically and persisted by thread:create;
          // this update keeps the pre-fix main-process path honest now that the
          // row is guaranteed durable.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          void persistInheritedThreadSettings(thread as any, inheritedSettings).catch(() => {})
        }
      })
      .catch((error) => {
        // Creation failed   remove the optimistic thread so the UI does not strand on a phantom
        const idx = allThreads.findIndex((t) => t.id === optimisticId)
        if (idx !== -1) allThreads.splice(idx, 1)
        if (workspaceState.selectedThread?.id === optimisticId) {
          workspaceState.clearThread()
        }
        reportError(error, 'The new thread could not be created.')
      })
  }

  /** Start a fresh standalone chat   shows the composer immediately. */
  function startNewChat(): void {
    workspaceState.clearThread()
  }

  /** Create a standalone (project-less) chat from the composer's first message. */
  async function createStandaloneChat(
    message: string,
    files: PromptAttachment[] = []
  ): Promise<void> {
    const msg = message.trim()
    if (!msg && files.length === 0) return

    try {
      const inbox = await invoke('project:ensureInbox')
      const thread = await invoke('thread:create', {
        projectId: inbox.id,
        providerId: 'pi',
        title: DEFAULT_THREAD_TITLE,
        workingDirectory: '',
        settings: chatEffectiveSettings()
      })
      upsertThreadInList(thread)
      chatDraft.message = msg
      chatDraft.attachments = files
      workspaceState.openThread(thread, inbox)
    } catch (error) {
      // The thread was never created, so the message cannot appear anywhere.
      // Put it back in the composer so the user doesn't lose their first message.
      rendererRecovery.setDraft(INBOX_PROJECT_ID, 'new-chat', msg, files)
      chatsComposerRestoreKey += 1
      reportError(error, 'The chat could not be started.')
    }
  }

  /** In-flight mark-read requests keyed by `projectId:threadId`. A thread that
   *  is already being marked read is never re-requested, but a failure clears
   *  its key so a later interaction can retry. */
  const pendingReadThreads = new SvelteSet<string>()
  /** One delayed retry per failed mark-read, keyed the same way. */
  const readRetryTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>()

  /** Push a read snapshot into every sidebar store (regular list, scope board,
   *  selected thread) so the row badge settles in the same tick instead of
   *  waiting on the backend's own broadcast round-trip. */
  function applyThreadRead(thread: Thread): void {
    upsertThreadInList(thread)
    scopeState.updateThread(thread)
    if (workspaceState.selectedThread?.id === thread.id) {
      workspaceState.updateThread(thread)
    }
  }

  /** Mark a thread read through the backend and apply the confirmed snapshot.
   *  A failed or lost request must never leave a thread the user has already
   *  interacted with stuck on unread, so an unconfirmed read still applies
   *  locally (the next `thread:updated` broadcast reconciles any drift), and
   *  the request retries once after a short delay before the failure is
   *  surfaced to the durable log. */
  async function markThreadReadAndApply(projectId: string, threadId: string): Promise<void> {
    const key = `${projectId}:${threadId}`
    try {
      const updated = await invoke('thread:markRead', projectId, threadId)
      if (updated.read) {
        applyThreadRead(updated)
        return
      }
      // The backend answered but did not flip the flag (e.g. the thread row was
      // momentarily invisible through the worker read). Retry once.
      const retried = await invoke('thread:markRead', projectId, threadId)
      applyThreadRead(retried.read ? retried : { ...retried, read: true })
      if (!retried.read) {
        logRendererError(
          `Thread mark-read did not settle on the backend: thread ${threadId} in project ${projectId} stayed unread after retry`
        )
      }
    } catch (error) {
      // The backend never confirmed. Schedule one delayed retry so a transient
      // IPC or worker failure cannot leave the badge stuck on unread; clear the
      // pending key first so the retry is not gated as a duplicate.
      pendingReadThreads.delete(key)
      if (readRetryTimers.has(key)) return
      readRetryTimers.set(
        key,
        setTimeout(() => {
          readRetryTimers.delete(key)
          void markThreadReadAndApply(projectId, threadId).catch((retryError) => {
            logRendererError('Thread mark-read retry failed', retryError)
          })
        }, 2000)
      )
      logRendererError('Thread mark-read request failed; scheduled a retry', error)
    }
  }

  /** Entry point that gates duplicate in-flight requests per thread. */
  function requestThreadRead(projectId: string, threadId: string): void {
    const key = `${projectId}:${threadId}`
    if (pendingReadThreads.has(key)) return
    pendingReadThreads.add(key)
    void markThreadReadAndApply(projectId, threadId)
      .catch(() => undefined)
      .finally(() => pendingReadThreads.delete(key))
  }

  function markThreadReadAfterPaint(thread: Thread): void {
    if (thread.read) return
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        requestThreadRead(thread.projectId, thread.id)
      }, 0)
    })
  }

  function openThread(thread: Thread): void {
    workspaceState.openThread(thread, projects.find((p) => p.id === thread.projectId) ?? null)
    void scopeState.ensureBoardLoaded(thread.projectId)
    if (threadTracksReadStatus(thread)) markThreadReadAfterPaint(thread)
    // Reveal immediately and again once any read-state update re-sorts the list.
    revealThreadInSidebar(thread.id)
  }

  async function openThreadFromSwitcher(thread: Thread): Promise<void> {
    if (thread.projectId === INBOX_PROJECT_ID) navigate('chats')
    else if (mode === 'chats') navigate('projects')
    // The scope store reads its own activeProjectId / sidebarContext, not the
    // workspace selection, so a cross-project Ctrl+Tab jump must sync it
    // otherwise the scope view tabs and the scope-state sidebar stay stuck on
    // the previous project. On the Scope page the view itself follows the
    // thread's project; an active scope-state sidebar follows the thread and
    // its own scope bucket.
    if (thread.projectId !== INBOX_PROJECT_ID) {
      if (scopeViewActive) {
        void scopeState.activateProject(thread.projectId)
      } else if (scopeState.sidebarContext) {
        scopeState.showSidebarForThread(thread)
      }
    }
    await openThread(thread)
    // A Ctrl+Tab selection is a deliberate jump to a specific thread. When it
    // crosses modes (e.g. Chats → Projects) the mode switch opens a suppression
    // window and restores the incoming mode's saved scroll, which would keep the
    // chosen thread out of view. Cancel that suppression and reveal the row once
    // the restore + folder expansion have settled.
    sidebarRevealSuppressed = false
    clearTimeout(sidebarRevealSuppressTimer)
    if (thread.projectId !== INBOX_PROJECT_ID) sidebar.expandedFolders.add(thread.projectId)
    void tick().then(() => revealThreadInSidebar(thread.id))
  }

  async function openProjectFileFromCommand(
    projectId: string,
    path: string,
    kind: 'file' | 'directory'
  ): Promise<void> {
    const project = projects.find((candidate) => candidate.id === projectId)
    if (!project || project.source !== 'local' || !project.path) return

    // Preserve the current content view (remember the project sidebar state)
    // instead of forcing the Projects view. Chats cannot host a project file.
    if (mode === 'chats') {
      navigate('projects')
    } else if (!active) {
      navigate(mode)
    }

    let projectThread: Thread | null =
      selectedThread?.projectId === projectId
        ? selectedThread
        : allThreads
            .filter((thread) => thread.projectId === projectId && !thread.archived)
            .sort((a, b) => b.lastActivity - a.lastActivity)[0]

    if (projectThread) {
      await openThread(projectThread)
    } else {
      // No thread yet   create one so the file opens inside a real thread context.
      await createThreadInProject(project)
      projectThread =
        workspaceState.selectedThread?.projectId === projectId
          ? workspaceState.selectedThread
          : null
      if (!projectThread) {
        workspaceState.clearThread()
        workspaceState.activeProject = project
        workspaceState.activeProjectIconUrl = getProjectIcon(project, projectIcons.get(project.id))
        rendererRecovery.setSelectedProject(project.id)
        contextSidebarState.activateThread(project.id, '')
      }
    }

    await projectFilesWorkspace.loadDirectory(project.id, '')
    contextSidebarState.openFiles(project.id, projectThread?.id ?? '')
    if (kind === 'directory') {
      await projectFilesWorkspace.revealFile(project.id, path)
      projectFilesWorkspace.markDirectoryExpanded(project.id, path)
      await projectFilesWorkspace.loadDirectory(project.id, path, true)
    } else {
      await projectFilesWorkspace.openFile(project.id, path)
      await projectFilesWorkspace.revealFile(project.id, path)
    }
  }

  async function openScopedThread(thread: Thread): Promise<void> {
    const context = scopeState.sidebarContext
    if (context) scopeState.showSidebarForThread(thread, context.bucketId)
    await openThread(thread)
  }

  async function switchScopedProject(projectId: string): Promise<void> {
    const project = projects.find((candidate) => candidate.id === projectId)
    if (!project) return

    await scopeState.activateProject(projectId)
    const thread =
      allThreads
        .filter((candidate) => candidate.projectId === projectId && !candidate.archived)
        .sort((a, b) => b.lastActivity - a.lastActivity)[0] ?? null

    if (thread) {
      workspaceState.openThread(
        thread,
        project,
        getProjectIcon(project, projectIcons.get(projectId))
      )
      scopeState.showSidebarForThread(thread)
    } else {
      workspaceState.clearThread()
      workspaceState.activeProject = project
      workspaceState.activeProjectIconUrl = getProjectIcon(project, projectIcons.get(projectId))
      rendererRecovery.setSelectedProject(projectId)
      scopeState.showSidebarForProject(projectId)
    }
  }

  async function handleRename(thread: Thread, newName: string): Promise<void> {
    const updated = await invoke('thread:update', thread.projectId, thread.id, {
      title: newName,
      titleSource: 'manual'
    })
    upsertThreadInList(updated)
    workspaceState.updateThread(updated)
  }

  async function togglePin(thread: Thread): Promise<void> {
    const updated = await invoke('thread:setPinned', thread.projectId, thread.id, !thread.pinned)
    upsertThreadInList(updated)
    scopeState.updateThread(updated)
    workspaceState.updateThread(updated)
  }

  async function handleDelete(thread: Thread): Promise<void> {
    allThreads = allThreads.filter((t) => t.id !== thread.id)
    scopeState.removeThread(thread.id)
    if (selectedThread?.id === thread.id) workspaceState.clearThread()
    try {
      await invoke('thread:delete', thread.projectId, thread.id)
    } catch (error) {
      upsertThreadInList(thread)
      scopeState.updateThread(thread)
      reportError(error, 'The thread could not be deleted.')
    }
  }

  async function forkThread(thread: Thread): Promise<void> {
    const forked = await invoke(
      'thread:fork',
      thread.projectId,
      thread.id,
      `${thread.title} (fork)`
    )
    upsertThreadInList(forked)
    scopeState.updateThread(forked)
    if (scopeState.sidebarContext?.projectId === forked.projectId) {
      scopeState.showSidebarForThread(forked, scopeState.sidebarContext.bucketId)
    }
    workspaceState.openThread(forked, projects.find((p) => p.id === forked.projectId) ?? null)
  }

  /** A message-level fork succeeded inside the thread view   surface and open it. */
  function handleForkedThread(forked: Thread): void {
    upsertThreadInList(forked)
    workspaceState.openThread(forked, projects.find((p) => p.id === forked.projectId) ?? null)
  }

  /** A chat was continued into a project   register the thread and open it there. */
  function handleContinuedInProject(forked: Thread): void {
    upsertThreadInList(forked)
    scopeState.updateThread(forked)
    if (forked.projectId === INBOX_PROJECT_ID) navigate('chats')
    else if (mode === 'chats') navigate('projects')
    workspaceState.openThread(forked, projects.find((p) => p.id === forked.projectId) ?? null)
  }

  /** Register a freshly added project without landing in a new thread   used by
   *  the continue-chat-in-project flow which creates its own thread. */
  async function handleChatProjectCreated(project: Project): Promise<void> {
    projects = [project, ...projects]
    sidebar.expandedFolders.add(project.id)
    if (project.icon) {
      const url = await invoke('project:getIcon', project.id)
      if (url) projectIcons.set(project.id, url)
    } else {
      projectIcons.delete(project.id)
    }
  }

  /**
   * Promote a side chat (quick chat) into a regular thread: the conversation
   * is persisted as a new thread and opened so the user can keep prompting.
   */
  async function handleContinueInThread(tab: TemporaryChatContextTab): Promise<void> {
    const converted = await invoke(
      'temporary-chat:convertToThread',
      tab.projectId,
      tab.threadId,
      tab.temporaryChatId,
      tab.settings
    )
    contextSidebarState.close(tab.id)
    upsertThreadInList(converted)
    scopeState.updateThread(converted)
    if (converted.projectId === INBOX_PROJECT_ID) navigate('chats')
    else if (mode === 'chats') navigate('projects')
    workspaceState.openThread(converted, projects.find((p) => p.id === converted.projectId) ?? null)
  }

  loadData()
</script>

<svelte:document onpointerdowncapture={handleComposerPointerDown} />

<div class="flex h-full">
  <!-- Shared sidebar   shows Projects or Chats depending on the shell mode -->
  <WorkspaceSidebar
    bind:scroller={sidebarScroller}
    {mode}
    {navigate}
    {projects}
    {visibleProjects}
    {projectIcons}
    {loading}
    activeThreadId={activeThreadRowId(selectedThread)}
    {threadsByProject}
    {pinnedThreads}
    {pinnedProjects}
    {regularProjects}
    {pinnedInboxThreads}
    {standaloneThreads}
    {pinnedTimelineThreads}
    {unpinnedTimelineThreads}
    {hasMoreHistory}
    {historyLoading}
    {projectPageLoading}
    {sidebar}
    {projectDialogs}
    {scopeActions}
    {projectHasMoreInDb}
    onLoadProjectThreadsPage={loadProjectThreadsPage}
    onLoadHistoryPage={loadHistoryPage}
    onSetProjects={(next) => (projects = next)}
    onOpenThread={openThread}
    onRename={handleRename}
    onTogglePin={togglePin}
    onDelete={handleDelete}
    onFork={forkThread}
    onThreadMove={handleThreadMove}
    onPinnedThreadMove={handlePinnedThreadMove}
    onTimelinePinnedMove={handleTimelinePinnedMove}
    onProjectMove={handleProjectMove}
    onCreateThread={createThreadInProject}
    onOpenScopedThread={openScopedThread}
    onSwitchScopedProject={switchScopedProject}
  />

  <!-- Main Content -->
  <section class="flex min-w-0 flex-1 overflow-hidden">
    <div
      class="grid h-full min-h-0 min-w-0 flex-1"
      style:grid-template-columns={contextPanelColumns}
      style:grid-template-rows={contextPanelRows}
    >
      <WorkspaceConversationPane
        {mode}
        {active}
        {selectedThread}
        {visibleProjects}
        {projectIcons}
        {threadsByProject}
        {config}
        {updateConfig}
        restoreKey={chatsComposerRestoreKey}
        onNavigate={navigate}
        onForked={handleForkedThread}
        onContinueInProject={handleContinuedInProject}
        onProjectCreated={handleChatProjectCreated}
        onOpenScopeView={(thread) => void openThreadScopeView(thread)}
        onSendChat={createStandaloneChat}
        onRequestAddProject={(kind) => {
          projectCreateTriggerKind = kind
          workspaceState.requestAddProject()
        }}
      />

      {#if sidebarVisible}
        {#snippet contextSidebarContent()}
          <WorkspaceContextPanelContent
            {gitPanelProjectId}
            {gitPanelScopeBucketId}
            {terminalFullscreenTabId}
            {browserFullscreenTabId}
            {activeProject}
            {projectIcons}
            {browser}
            {coordinator}
            onDismissCoordinator={() => {
              const tab = contextSidebarState.sidebarActiveTab
              if (tab?.kind === 'coordinator') closeContextTab(tab.id)
            }}
            onContinueInThread={handleContinueInThread}
            onOpenSubagent={openNestedSubagent}
          />
        {/snippet}
        <div
          class="min-h-0 min-w-0"
          style:grid-column="2"
          style:grid-row="1"
          in:fly={{ x: contextSidebarState.width, duration: motionDuration(200), easing: cubicOut }}
          out:fly={{
            x: contextSidebarState.width,
            duration: motionDuration(PANEL_EXIT_MS),
            easing: cubicOut
          }}
        >
          <ContextSidebar
            tabs={contextSidebarState.sidebarTabs}
            activeTabId={contextSidebarState.sidebarActiveTabId}
            width={contextSidebarState.width}
            height={contextSidebarState.terminalHeight}
            placement="right"
            content={contextSidebarContent}
            onSelect={(id) => contextSidebarState.focus(id)}
            onClose={closeContextTab}
            onFullscreenTab={openTabFullscreen}
            onMoveTab={(id, targetId, position) =>
              contextSidebarState.reorder(id, targetId, position)}
            onWidthChange={(width) => contextSidebarState.setWidth(width)}
            onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
            onTerminalPlacementChange={(placement) =>
              contextSidebarState.setTerminalPlacement(placement)}
            onNewTerminal={openNewTerminal}
            onNewBrowser={openNewBrowser}
          />
        </div>
      {/if}
      {#if terminalDockVisible}
        {#snippet terminalDockContent()}
          <WorkspaceTerminalDockContent {terminalFullscreenTabId} />
        {/snippet}
        <div
          class="min-h-0 min-w-0"
          style:grid-column="1 / -1"
          style:grid-row="2"
          in:fly={{
            y: contextSidebarState.terminalHeight,
            duration: motionDuration(200),
            easing: cubicOut
          }}
          out:fly={{
            y: contextSidebarState.terminalHeight,
            duration: motionDuration(PANEL_EXIT_MS),
            easing: cubicOut
          }}
        >
          <ContextSidebar
            tabs={contextSidebarState.terminalTabs}
            activeTabId={contextSidebarState.terminalActiveTabId}
            width={contextSidebarState.width}
            height={contextSidebarState.terminalHeight}
            placement="bottom"
            content={terminalDockContent}
            onSelect={(id) => contextSidebarState.focus(id)}
            onClose={closeContextTab}
            onFullscreenTab={openTabFullscreen}
            onMoveTab={(id, targetId, position) =>
              contextSidebarState.reorder(id, targetId, position)}
            onWidthChange={(width) => contextSidebarState.setWidth(width)}
            onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
            onTerminalPlacementChange={(placement) =>
              contextSidebarState.setTerminalPlacement(placement)}
            onTerminalDockToggle={() => contextSidebarState.toggleTerminalDock()}
            onNewTerminal={openNewTerminal}
          />
        </div>
      {/if}
    </div>
    {#if dockGroups.some((group) => group.length > 0)}
      <ContextDock groups={dockGroups} />
    {/if}
  </section>
</div>

{#snippet historyMenu()}
  <WorkspaceHistoryMenu onClose={() => (showHistoryMenu = false)} onSelect={jumpToHistoryMessage} />
{/snippet}

{#snippet browserMenu()}
  <WorkspaceBrowserMenu {browser} />
{/snippet}

<WorkspaceBrowserDataModal {browser} {projects} />

<WorkspaceBrowserDownloadsModal {browser} />

<WorkspaceRemoveProjectModals dialogs={projectDialogs} />

<WorkspaceEditProjectModal dialogs={projectDialogs} {projectIcons} />

<ThreadSwitcher
  threads={recentThreads}
  projects={visibleProjects}
  projectIconUrls={projectIcons}
  selectedThreadId={selectedThread?.id ?? null}
  onSelect={openThreadFromSwitcher}
/>

<WorkspaceFullscreenTerminal
  tabId={terminalFullscreenTab?.id ?? null}
  onTabIdChange={(id) => (terminalFullscreenTabId = id)}
  onNewTerminal={openNewTerminal}
  onCloseTab={(id) => closeFullscreenTab('terminal', id)}
/>
<WorkspaceFullscreenBrowser
  tabId={browserFullscreenTabId}
  onTabIdChange={(id) => (browserFullscreenTabId = id)}
  onNewBrowser={openNewBrowser}
  onCloseTab={(id) => closeFullscreenTab('browser', id)}
/>

<!-- Closing a files tab with unsaved changes -->
<WorkspaceUnsavedChangesDialog
  target={closeTabTarget}
  onCancel={() => (closeTabTarget = null)}
  onDiscard={discardCloseTab}
  onSave={saveAndCloseTab}
/>
