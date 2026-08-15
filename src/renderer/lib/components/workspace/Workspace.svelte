<script lang="ts">
  import { tick } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import {
    Plus,
    Folder,
    FolderOpen,
    Ellipsis,
    ExternalLink,
    Pin,
    PinOff,
    Trash2,
    X,
    MessageSquare,
    SquarePen,
    Pencil,
    Copy,
    FolderKanban,
    ArrowUpDown,
    Check,
    ChevronUp
  } from '@lucide/svelte'
  import { Dialog, DropdownMenu } from 'bits-ui'
  import ProjectSwitch from '../shared/ProjectSwitch.svelte'
  import ProjectIdentity from '../shared/ProjectIdentity.svelte'
  import CollapsibleSidebar from '../layout/CollapsibleSidebar.svelte'
  import ChatComposer from '../chats/ChatComposer.svelte'
  import FolderRow from './FolderRow.svelte'
  import SidebarSearchControl from './SidebarSearchControl.svelte'
  import PinnedSection from '../threads/PinnedSection.svelte'
  import ThreadRow from '../threads/ThreadRow.svelte'
  import ThreadSearchResultRow from '../shared/ThreadSearchResultRow.svelte'
  import ThreadSwitcher from '../threads/ThreadSwitcher.svelte'
  import ThreadView from '../threads/ThreadView.svelte'
  import SpecConversationSidebar from '../specs/SpecConversationSidebar.svelte'
  import TerminalPanel from '../terminal/TerminalPanel.svelte'
  import ProjectFilesPanel from '../files/ProjectFilesPanel.svelte'
  import DiffSidebarPanel from '../files/DiffSidebarPanel.svelte'
  import ContextSidebar from '../layout/ContextSidebar.svelte'
  import SubagentSessionView from '../threads/SubagentSessionView.svelte'
  import SourcesPanel from '../threads/SourcesPanel.svelte'
  import TemporaryChatView from '../chats/TemporaryChatView.svelte'
  import NotificationPanel from '../notifications/NotificationPanel.svelte'
  import MemoryPanel from '../memory/MemoryPanel.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import AppearancePicker from '../shared/AppearancePicker.svelte'
  import ScopeBadge from '../shared/ScopeBadge.svelte'
  import StatusBadge from '../shared/StatusBadge.svelte'
  import ProjectCreateControl from '../shared/ProjectCreateControl.svelte'
  import ThreadSearchControl from '../shared/ThreadSearchControl.svelte'
  import SidebarAccountControls from './SidebarAccountControls.svelte'
  import ScopeActionsMenu from '../shared/ScopeActionsMenu.svelte'
  import ScopeCreateControl from '../shared/ScopeCreateControl.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import { loadProjectIcons, getProjectIcon, projectIconOnError } from '$lib/project-icons'
  import { getIconSvgDataUrl, generateInitialsIconSvg } from '$lib/project-svg-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { hasProjectNameCollision } from '$lib/project-location'
  import { chatDraft } from '$lib/stores/chat-draft'
  import {
    threadSettings,
    chatSettings,
    chatEffectiveSettings
  } from '$lib/stores/thread-settings.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import {
    contextSidebarState,
    type ContextSidebarTab,
    type TemporaryChatContextTab
  } from '$lib/stores/context-sidebar.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import AgentDebugPanel from '$lib/components/debug/AgentDebugPanel.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { rendererRecovery, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { modelKey } from '$lib/model-keys'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import {
    threadSort,
    pinnedThreadSort,
    threadStatusSort,
    findEmptyNewThread,
    threadVisitKey
  } from '$lib/stores/workspace.svelte'
  import type { ThreadSortMode } from '$lib/stores/workspace.svelte'
  import { threadSortState } from '$lib/stores/thread-sort.svelte'
  import { scopeState, STAGE_LABELS, STAGE_COLORS, STAGE_ORDER } from '$lib/stores/scope.svelte'
  import {
    coordinatorHasActiveDelegates,
    INBOX_PROJECT_ID,
    DEFAULT_THREAD_TITLE,
    DEFAULT_SCOPE_BUCKET_ID,
    isThreadWorking,
    isOrchestrationChildThread
  } from '$shared/types'
  import { APP_NAME, APP_SLUG } from '$shared/brand'
  import type {
    AgentPart,
    AppConfig,
    AppConfigPatch,
    Project,
    PromptAttachment,
    ScopeBucket,
    Thread,
    ThreadSearchResult
  } from '$shared/types'

  interface Props {
    /** Which sidebar the shell shows — the main content stays mounted across modes. */
    mode: 'projects' | 'chats' | 'threads'
    /** Whether the shell is the on-screen view (hidden while in Settings/Scope). */
    active?: boolean
    navigate: (view: MainView) => void
    /** Global app config — drives the image-descriptor default + ask-again flag. */
    config?: AppConfig
    updateConfig?: (patch: AppConfigPatch) => Promise<void>
  }

  let { mode, active = true, navigate, config, updateConfig }: Props = $props()

  const INITIAL_THREAD_LIMIT = 100
  const HISTORY_PAGE_LIMIT = 50

  let projects = $state<Project[]>([])
  let allThreads = $state<Thread[]>([])
  let loading = $state(true)
  let historyOffset = $state(0)
  let historyLoading = $state(false)
  let hasMoreHistory = $state(true)
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
    // All three sidebar modes stay mounted (the inactive ones are `display:none`),
    // so the same thread id can match several rows. Only the rendered one can be
    // scrolled to — a hidden row has no layout box and scrollIntoView is a no-op
    // on it, which is why Projects mode never followed the selection while the
    // flat Threads list (earlier in the DOM) always matched first.
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
      expandedFolders.add(active.projectId)
      const folderThreads = threadsByProject.get(active.projectId) ?? []
      const threadIndex = folderThreads.findIndex((candidate) => candidate.id === threadId)
      if (threadIndex >= 0) {
        const needed = threadIndex + 1
        const current = threadShowCount.get(active.projectId) ?? THREADS_PER_PAGE
        if (needed > current) threadShowCount.set(active.projectId, needed)
      }
    }
    // Flush Svelte's DOM update (folder expansion / mode switch / re-sort), then
    // wait frames so the browser has final layout, then scroll. Retry over a few
    // frames because the folder's rows can mount a tick later than expected —
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
  // Intentional initial-value capture — the map is keyed by the mode prop.
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

  const THREADS_PER_PAGE = 5

  const threadShowCount = new SvelteMap<string, number>()

  function getVisibleCount(groupId: string, pageSize: number = THREADS_PER_PAGE): number {
    return threadShowCount.get(groupId) ?? pageSize
  }

  function showMoreThreads(
    groupId: string,
    total: number,
    pageSize: number = THREADS_PER_PAGE
  ): void {
    const current = threadShowCount.get(groupId) ?? pageSize
    threadShowCount.set(groupId, Math.min(current + pageSize, total))
  }

  function showLessThreads(groupId: string, pageSize: number = THREADS_PER_PAGE): void {
    threadShowCount.set(groupId, pageSize)
  }
  // Built-in Set/Map are not reactive in runes mode — mutations must go through SvelteSet/SvelteMap.
  const expandedFolders = new SvelteSet<string>()

  /** Initialise expandedFolders: start with all projects expanded, then fold
   *  any the user has previously collapsed. */
  function initExpandedFolders(visible: Project[]): void {
    expandedFolders.clear()
    for (const p of visible) expandedFolders.add(p.id)
    for (const id of rendererRecovery.collapsedFolders) expandedFolders.delete(id)
  }

  /** Selection + terminal state live in the shared store (drives the app header). */
  let selectedThread = $derived(workspaceState.selectedThread)
  let activeProject = $derived(workspaceState.activeProject)

  let selectedThreadHasDraft = $derived(
    selectedThread
      ? rendererRecovery.hasDraftContent(selectedThread.projectId, selectedThread.id)
      : false
  )
  /** Threads holding any unsent composer content stay pinned at the top of their list,
      even after the user navigates away, so they are easy to find mid-task. */
  let draftThreadKeys = $derived.by(() => {
    const keys = new SvelteSet<string>()
    for (const t of allThreads) {
      if (t.archived) continue
      if (rendererRecovery.hasDraftContent(t.projectId, t.id)) keys.add(threadVisitKey(t))
    }
    return keys
  })

  /** Provider catalog for the Chats tab — feeds the empty-state composer so the
      model picker is populated before the first message creates a thread. */
  let chatInboxId = $state<string | null>(null)
  let chatProviders = $derived(
    chatInboxId
      ? (providerCatalog.cached(chatInboxId) ?? providerCatalog.allCached())
      : providerCatalog.allCached()
  )
  /** Effective chat settings — the chat's own model when one has been picked,
   *  else the last project model so a fresh chat starts on the model in use. */
  let chatComposerSettings = $derived(chatEffectiveSettings())
  $effect(() => {
    if (mode !== 'chats') return
    let alive = true
    void (async () => {
      try {
        const inbox = await invoke('project:ensureInbox')
        if (!alive) return
        chatInboxId = inbox.id
      } catch {
        if (alive) chatInboxId = null
      }
    })()
    return () => {
      alive = false
    }
  })

  let projectCreateTrigger = $state(0)
  let prevCreateThreadCount = 0
  let prevAddProjectCount = 0
  let prevNewChatCount = 0
  let prevProjectFileOpenCount = 0
  let creatingThread = false

  // This view hosts the terminal panel — advertise it to the header.
  $effect(() => {
    workspaceState.terminalAvailable = true
    return () => {
      workspaceState.terminalAvailable = false
    }
  })

  /** React to Cmd/Ctrl+N → create thread in active project (optionally in a scope bucket). */
  $effect(() => {
    const current = workspaceState.requestCreateThreadCount
    if (
      current !== prevCreateThreadCount &&
      !creatingThread &&
      workspaceState.consumeCreateThreadRequest()
    ) {
      prevCreateThreadCount = current
      if (workspaceState.activeProject) {
        handleCreateThreadRequest(
          workspaceState.activeProject,
          workspaceState.pendingScopeBucketId ?? undefined
        )
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
        if (workspaceState.activeProject) {
          handleCreateThreadRequest(
            workspaceState.activeProject,
            workspaceState.pendingScopeBucketId ?? undefined
          )
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

  /** Reveal a file selected from the cross-project Ctrl+K search. */
  $effect(() => {
    const current = workspaceState.requestProjectFileOpenCount
    if (current !== prevProjectFileOpenCount && !loading) {
      prevProjectFileOpenCount = current
      const request = workspaceState.consumeProjectFileOpenRequest()
      if (request) void openProjectFileFromCommand(request.projectId, request.path)
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

  // Per-project thread search (activation + query)
  const projectSearchOpen = new SvelteSet<string>()
  const projectSearchQueries = new SvelteMap<string, string>()
  const projectSearchResults = new SvelteMap<string, ThreadSearchResult[]>()
  const projectSearching = new SvelteSet<string>()
  const projectSearchTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>()
  const projectSearchRequestIds = new SvelteMap<string, number>()
  let projectSearchBootstrap = false

  function clearProjectSearch(projectId: string): void {
    projectSearchOpen.delete(projectId)
    projectSearchQueries.delete(projectId)
    projectSearchResults.delete(projectId)
    projectSearching.delete(projectId)
    const timer = projectSearchTimers.get(projectId)
    if (timer) clearTimeout(timer)
    projectSearchTimers.delete(projectId)
  }

  function openProjectSearch(projectId: string): void {
    projectSearchOpen.add(projectId)
    // Keep the folder expanded so search results stay visible in the sidebar.
    expandedFolders.add(projectId)
    if (!projectSearchBootstrap) {
      projectSearchBootstrap = true
      setTimeout(() => {
        projectSearchBootstrap = false
        for (const projectId of projectSearchOpen) {
          runProjectSearch(projectId, projectSearchQueries.get(projectId) ?? '')
        }
      }, 0)
    }
  }

  function closeProjectSearch(projectId: string): void {
    clearProjectSearch(projectId)
  }

  function runProjectSearch(projectId: string, raw: string): void {
    const safeQuery = raw.trim()
    const timer = projectSearchTimers.get(projectId)
    if (timer) clearTimeout(timer)
    const requestId = (projectSearchRequestIds.get(projectId) ?? 0) + 1
    projectSearchRequestIds.set(projectId, requestId)
    if (!safeQuery) {
      projectSearchResults.delete(projectId)
      projectSearching.delete(projectId)
      return
    }
    projectSearching.add(projectId)
    projectSearchTimers.set(
      projectId,
      setTimeout(() => {
        void invoke('threads:search', safeQuery, { projectId, limit: 50 })
          .then((results) => {
            if (projectSearchRequestIds.get(projectId) !== requestId) return
            projectSearchResults.set(
              projectId,
              results.filter((r) => !isOrchestrationChildThread(r.thread))
            )
            projectSearching.delete(projectId)
          })
          .catch(() => {
            if (projectSearchRequestIds.get(projectId) !== requestId) return
            projectSearchResults.delete(projectId)
            projectSearching.delete(projectId)
          })
      }, 120)
    )
  }

  function filterThreadsByQuery(threads: Thread[], query: string): Thread[] {
    const q = query.trim().toLowerCase()
    if (!q) return threads
    return threads.filter((t) => t.title.toLowerCase().includes(q))
  }

  function threadHasVisibleWork(thread: Thread): boolean {
    return (
      isThreadWorking(thread) || coordinatorHasActiveDelegates(thread, scopeState.allScopeThreads)
    )
  }

  // Threads-view global search (activation + query), mirroring the per-project
  // search above: the popover only hosts the input, results render in the sidebar
  // and stay put until the search is explicitly dismissed (Escape / re-click / X).
  let threadsSearchOpen = $state(false)
  let threadsSearchQuery = $state('')
  let threadsSearchResults = $state<ThreadSearchResult[]>([])
  let threadsSearching = $state(false)
  let threadsSearchTimer: ReturnType<typeof setTimeout> | undefined
  let threadsSearchRequestId = 0

  function openThreadsSearch(): void {
    threadsSearchOpen = true
    if (threadsSearchQuery.trim()) runThreadsSearch(threadsSearchQuery)
  }

  function closeThreadsSearch(): void {
    threadsSearchOpen = false
    threadsSearchQuery = ''
    threadsSearchResults = []
    threadsSearching = false
    threadsSearchRequestId++
    if (threadsSearchTimer) clearTimeout(threadsSearchTimer)
    threadsSearchTimer = undefined
  }

  function runThreadsSearch(raw: string): void {
    threadsSearchQuery = raw
    const safeQuery = raw.trim()
    if (threadsSearchTimer) clearTimeout(threadsSearchTimer)
    const requestId = ++threadsSearchRequestId
    if (!safeQuery) {
      threadsSearchResults = []
      threadsSearching = false
      return
    }
    threadsSearching = true
    threadsSearchTimer = setTimeout(() => {
      void invoke('threads:search', safeQuery, { limit: 50 })
        .then((results) => {
          if (requestId !== threadsSearchRequestId) return
          threadsSearchResults = results.filter(
            (r) =>
              !isOrchestrationChildThread(r.thread) &&
              r.thread.projectId !== INBOX_PROJECT_ID &&
              !r.thread.archived
          )
          threadsSearching = false
        })
        .catch(() => {
          if (requestId !== threadsSearchRequestId) return
          threadsSearchResults = []
          threadsSearching = false
        })
    }, 120)
  }

  /** Project icon data URLs keyed by project id. */
  const projectIcons = new SvelteMap<string, string>()

  // Folder ellipsis menu
  let openProjectMenuId = $state<string | null>(null)
  // Remove-project confirmation
  let showRemoveModal = $state(false)
  let removeTarget = $state<Project | null>(null)

  // Edit-project modal
  let showEditModal = $state(false)
  let editProject = $state<Project | null>(null)
  let editProjectName = $state('')
  let editProjectColor = $state<string | undefined>()
  let editProjectIconType = $state<string | undefined>()
  let editProjectPendingIcon = $state<{ path: string; dataUrl: string } | undefined>()

  // Edit-scope modal
  let editBucketTarget = $state<ScopeBucket | null>(null)
  let editBucketName = $state('')
  let editBucketColor = $state<string | undefined>()
  let editBucketIconType = $state<string | undefined>()

  // Delete-scope confirmation
  let deleteBucketTarget = $state<ScopeBucket | null>(null)
  let deleteThreads = $state(false)

  async function openFiles(): Promise<void> {
    if (!selectedThread || activeProject?.source !== 'local' || !activeProject.path) return
    await projectFilesWorkspace.loadDirectory(selectedThread.projectId, '')
    contextSidebarState.openFiles(selectedThread.projectId, selectedThread.id)
  }

  function openDiff(): void {
    if (!selectedThread || activeProject?.source !== 'local' || !activeProject.path) return
    contextSidebarState.openDiff(selectedThread.projectId, selectedThread.id)
  }

  function openNewTerminal(): void {
    if (!selectedThread) return
    contextSidebarState.openNewTerminal(selectedThread.projectId, selectedThread.id)
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

  function openCloudDeploymentsTab(): void {
    if (!selectedThread) return
    contextSidebarState.openCloudDeployments(selectedThread.projectId, selectedThread.id)
  }

  let sidebarActions = $derived.by(() => {
    if (!selectedThread) return []
    const actions = [
      {
        id: 'sources',
        label: 'Sources',
        description: 'View sources attached to this conversation',
        onSelect: openSourcesTab
      },
      ...(activeProject?.source === 'local' && activeProject.path
        ? [
            {
              id: 'files',
              label: 'Files',
              description: 'Browse and edit project files',
              onSelect: () => void openFiles()
            },
            {
              id: 'diff',
              label: 'Changes',
              description: 'Review changes from completed runs',
              onSelect: openDiff
            }
          ]
        : []),
      {
        id: 'cloud-deployments',
        label: 'Cloud Deployments',
        description: 'Monitor your cloud deployments',
        onSelect: openCloudDeploymentsTab
      },
      {
        id: 'terminal',
        label: 'Terminal',
        description: 'Open a shell',
        onSelect: openNewTerminal
      }
    ]
    if (import.meta.env.DEV) {
      actions.push({
        id: 'debugger',
        label: 'Debugger',
        description: 'Inspect agent requests',
        onSelect: openDebugger
      })
    }
    return actions
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

  /** Actions offered inside the bottom terminal dock — only new shells belong there. */
  let terminalDockActions = $derived.by(() => {
    if (!selectedThread) return []
    return [
      {
        id: 'terminal',
        label: 'Terminal',
        description: 'Open a shell',
        onSelect: openNewTerminal
      }
    ]
  })

  let terminalFullscreenTabId = $state<string | null>(null)
  let sidebarVisible = $derived(contextSidebarState.sidebarVisible)
  let terminalDockVisible = $derived(contextSidebarState.terminalDockVisible)
  let terminalDockCollapsed = $derived(contextSidebarState.terminalDockCollapsed)
  let contextPanelColumns = $derived(
    sidebarVisible
      ? `minmax(360px, 1fr) minmax(0, min(${contextSidebarState.width}px, calc(100% - 360px)))`
      : 'minmax(0, 1fr)'
  )
  let contextPanelRows = $derived(
    terminalDockVisible
      ? `minmax(240px, 1fr) minmax(0, min(${contextSidebarState.terminalHeight}px, calc(100% - 240px)))`
      : 'minmax(0, 1fr)'
  )

  function openTabFullscreen(tabId: string): void {
    terminalFullscreenTabId = tabId
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

  /** User-facing projects only — hidden ones (e.g. the chats inbox) stay out of the tree. */
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

  /** Threads mode: all active threads sorted by the selected mode, persisted pins first. */
  let allThreadsFlat = $derived.by(() => {
    const list = allThreads.filter((t) => !t.archived && t.projectId !== INBOX_PROJECT_ID)
    // Pinned threads keep one shared pin-time order regardless of the sort mode;
    // the chosen mode only applies to unpinned threads.
    const pinned = list
      .filter((t) => t.pinned)
      .sort((a, b) => pinnedThreadSort(a, b, draftThreadKeys))
    const unpinned = list.filter((t) => !t.pinned)
    if (threadSortState.mode === 'status') {
      unpinned.sort((a, b) => threadStatusSort(a, b, draftThreadKeys))
    } else {
      unpinned.sort((a, b) => b.lastActivity - a.lastActivity)
    }
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

  async function migrateTimelinePins(): Promise<void> {
    const key = `${APP_SLUG}.timelinePins.v1`
    const raw = window.localStorage.getItem(key)
    if (!raw) return
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        window.localStorage.removeItem(key)
        return
      }
      const ids = new Set(parsed.filter((id): id is string => typeof id === 'string'))
      const persistedThreads = await invoke('thread:listAll')
      for (const thread of persistedThreads) {
        if (!ids.has(thread.id) || thread.pinned || thread.archived) continue
        const updated = await invoke('thread:setPinned', thread.projectId, thread.id, true)
        upsertThreadInList(updated)
        scopeState.updateThread(updated)
        if (workspaceState.selectedThread?.id === updated.id) workspaceState.updateThread(updated)
      }
      window.localStorage.removeItem(key)
    } catch {
      // Keep the legacy IDs so a transient IPC/storage failure cannot remove
      // cleanup protection before the persisted-pin migration succeeds.
    }
  }

  function getThreadIcon(thread: Thread): string | null {
    const project = projects.find((p) => p.id === thread.projectId)
    if (!project) return null
    return getProjectIcon(project, projectIcons.get(project.id))
  }

  const THREAD_SORT_OPTIONS: { id: ThreadSortMode; label: string }[] = [
    { id: 'default', label: 'Default' },
    { id: 'status', label: 'Status' },
    { id: 'time', label: 'Time' }
  ]

  const threadSortLabel = $derived(
    threadSortState.mode === 'status'
      ? 'Sort by status'
      : threadSortState.mode === 'time'
        ? 'Sort by time'
        : 'Default order'
  )

  function setThreadSortMode(id: ThreadSortMode): void {
    threadSortState.setMode(id)
  }

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
   *  or history — or one the harness just started working on — must be added
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
  // beyond the bounded recent hydration list — otherwise its row never appears
  // and its live status transitions are lost.
  $effect(() => {
    const selected = workspaceState.selectedThread
    if (selected && !isOrchestrationChildThread(selected)) upsertThreadInList(selected)
  })

  // Live thread updates pushed from the main process (status/read changes
  // during agent runs) — keeps the sidebar indicators in sync without polling.
  // Updates are applied immediately so a finished turn flips the status badge
  // to done/unread the moment the harness reports it, never after a debounce.
  $effect(() => {
    return subscribe('thread:updated', (...args: unknown[]) => {
      const updated = args[0] as Thread
      scopeState.updateThread(updated)
      if (isOrchestrationChildThread(updated)) return
      upsertThreadInList(updated)
      if (workspaceState.selectedThread?.id === updated.id) {
        workspaceState.updateThread(updated)
        if (!updated.read) {
          void invoke('thread:markRead', updated.projectId, updated.id)
        }
      }
    })
  })

  $effect(() => {
    return subscribe('thread:deleted', (_projectId, threadId) => {
      allThreads = allThreads.filter((thread) => thread.id !== threadId)
      scopeState.removeThread(threadId)
      if (workspaceState.selectedThread?.id === threadId) workspaceState.clearThread()
    })
  })

  /** The last (thread, draft-state) pair the draft→todo nudge ran for, so the
   *  effect below only fires when the draft state actually transitions — never
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
    // for the thread the sidebar is currently showing — but only when the draft
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

  // The scope-state sidebar board reads its data from the active project's board
  // and thread list (`scopeState.board` / `currentProjectThreads`, keyed off
  // `activeProjectId`). The sidebar context is set with a fire-and-forget
  // `activateProject`, so `sidebarContext.projectId` and `activeProjectId` can be
  // out of sync on first entry — which would render stale/empty stage slices until
  // a project switch realigned them. Keep them aligned reactively so the board
  // hydrates immediately (mirrors ScopeView's own activeProjectId reload effect).
  $effect(() => {
    const context = scopeState.sidebarContext
    if (context && context.projectId !== scopeState.activeProjectId) {
      void scopeState.activateProject(context.projectId)
    }
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
        expandedFolders.add(thread.projectId)
        // Ensure the folder shows enough rows for the focused thread so its
        // row is actually rendered, then reveal it once the rows mount.
        const folderThreads = threadsByProject.get(thread.projectId) ?? []
        const threadIndex = folderThreads.findIndex((candidate) => candidate.id === thread.id)
        if (threadIndex >= 0) {
          const needed = threadIndex + 1
          const current = threadShowCount.get(thread.projectId) ?? THREADS_PER_PAGE
          if (needed > current) threadShowCount.set(thread.projectId, needed)
        }
        if (!sidebarRevealSuppressed) {
          void tick().then(() => revealThreadInSidebar(thread.id))
        }
      } else if (!sidebarRevealSuppressed) {
        // Standalone chats (inbox) have no folder to expand — reveal directly
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
    const project = projects.find((p) => p.id === projectId)
    if (project) {
      editProject = project
      editProjectName = project.name
      editProjectColor = project.color
      editProjectIconType = project.iconType
      editProjectPendingIcon = undefined
      showEditModal = true
    }
    workspaceState.closeProjectEdit()
  })

  // Sync allThreads when a thread is moved to a different project via the composer pill.
  $effect(() => {
    const count = workspaceState.moveThreadCount
    const oldId = workspaceState.pendingMoveThreadId
    const newThread = workspaceState.pendingMoveThread
    if (count && oldId && newThread) {
      allThreads = allThreads.filter((t) => t.id !== oldId)
      upsertThreadInList(newThread)
    }
  })

  async function loadData(): Promise<void> {
    try {
      const [projectList, threadList] = await Promise.all([
        invoke('project:list'),
        invoke('thread:listRecent', {
          projectId: rendererRecovery.selectedProjectId ?? undefined,
          limit: INITIAL_THREAD_LIMIT
        })
      ])
      projects = projectList
      const uniqueThreads = uniqueThreadList(threadList)
      allThreads = uniqueThreads.filter((t) => !isOrchestrationChildThread(t))
      historyOffset = threadList.length
      hasMoreHistory = threadList.length === INITIAL_THREAD_LIMIT
      await migrateTimelinePins()
      notificationPanelState.hydrateFromThreads(uniqueThreads)
      projectIcons.clear()
      for (const [projectId, iconUrl] of await loadProjectIcons(projectList)) {
        projectIcons.set(projectId, iconUrl)
      }
      scopeState.setScopesFromProjects(projectList, projectIcons)
      scopeState.setThreads(uniqueThreads)
      initExpandedFolders(projectList.filter((p) => !p.hidden))
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
      // App-start git check: async — the store ensures the GitHub connection
      // before the PR indicator check runs, with or without a restored thread.
      gitState.notifyAppStarted(workspaceState.activeProject)
    } catch {
      projects = []
      allThreads = []
    } finally {
      loading = false
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
        invoke('thread:listRecent', {
          projectId: workspaceState.activeProject?.id ?? undefined,
          limit: INITIAL_THREAD_LIMIT
        })
      ])
      projects = projectList
      const uniqueThreads = uniqueThreadList(threadList)
      allThreads = uniqueThreads.filter((t) => !isOrchestrationChildThread(t))
      historyOffset = threadList.length
      hasMoreHistory = threadList.length === INITIAL_THREAD_LIMIT
      notificationPanelState.hydrateFromThreads(uniqueThreads)
      projectIcons.clear()
      for (const [projectId, iconUrl] of await loadProjectIcons(projectList)) {
        projectIcons.set(projectId, iconUrl)
      }
      scopeState.setScopesFromProjects(projectList, projectIcons)
      scopeState.setThreads(uniqueThreads)
    } catch {
      // Non-fatal — keep the current lists on failure.
    }
  }

  let wasActive: boolean | null = null
  $effect(() => {
    const nowActive = active
    if (wasActive !== null && nowActive && !wasActive) {
      void refreshListData()
    }
    wasActive = nowActive
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

  // ─── Folder interactions ─────────────────────────────────────────────────

  function toggleFolder(projectId: string): void {
    if (expandedFolders.has(projectId)) {
      expandedFolders.delete(projectId)
      rendererRecovery.toggleCollapsedFolder(projectId)
    } else {
      expandedFolders.add(projectId)
      rendererRecovery.toggleCollapsedFolder(projectId)
    }
  }

  // ─── Project actions ─────────────────────────────────────────────────────

  async function handleProjectCreated(project: Project): Promise<void> {
    projects = [project, ...projects]
    expandedFolders.add(project.id)
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
    expandedFolders.add(project.id)
  }

  async function deleteProject(projectId: string): Promise<void> {
    await invoke('project:delete', projectId)
    projects = projects.filter((p) => p.id !== projectId)
    allThreads = allThreads.filter((t) => t.projectId !== projectId)
    projectIcons.delete(projectId)
    if (selectedThread?.projectId === projectId) workspaceState.clearThread()
  }

  // ─── Folder ellipsis menu actions ────────────────────────────────────────

  async function copyProjectPath(projectId: string): Promise<void> {
    const project = projects.find((p) => p.id === projectId)
    if (!project?.path) return
    try {
      await copyText(project.path)
    } catch {
      // Clipboard not available
    }
  }

  async function openInEditor(projectId: string): Promise<void> {
    await invoke('project:openInEditor', projectId)
  }

  async function toggleProjectPin(projectId: string): Promise<void> {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    const updated = await invoke('project:setPinned', projectId, !project.pinned)
    projects = projects.map((p) => (p.id === updated.id ? updated : p))
  }

  async function revealProjectInFinder(projectId: string): Promise<void> {
    const project = projects.find((p) => p.id === projectId)
    if (!project || !project.path) return
    await invoke('shell:revealPath', project.path)
  }

  function askEditProject(projectId: string): void {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    editProject = project
    editProjectName = project.name
    editProjectColor = project.color
    editProjectIconType = project.iconType
    editProjectPendingIcon = undefined
    showEditModal = true
  }

  async function confirmEditProject(e?: SubmitEvent): Promise<void> {
    e?.preventDefault()
    if (!editProject || !editProjectName.trim()) return

    let updated: Project

    if (editProjectPendingIcon) {
      // User uploaded a new custom image — persist it now
      updated = await invoke('project:setIcon', editProject.id, editProjectPendingIcon.path)
    } else {
      const hadCustomIcon = !!editProject.icon
      // Only clear a custom image when switching to an SVG icon type.
      const switchingToSvgIcon =
        editProjectIconType !== editProject.iconType && editProjectIconType !== undefined

      if (hadCustomIcon && switchingToSvgIcon) {
        await invoke('project:clearIcon', editProject.id)
      }

      updated = await invoke('project:update', editProject.id, {
        name: editProjectName.trim(),
        color: editProjectColor,
        iconType: editProjectIconType
      })
    }

    projects = projects.map((p) => (p.id === updated.id ? updated : p))

    // Refresh icon cache
    if (updated.icon) {
      const url = await invoke('project:getIcon', updated.id)
      if (url) projectIcons.set(updated.id, url)
      else projectIcons.delete(updated.id)
    } else {
      projectIcons.delete(updated.id)
    }

    // Sync the workspace store's active project so the header icon updates immediately
    if (workspaceState.activeProject?.id === updated.id) {
      workspaceState.activeProject = updated
    }

    // Sync the scope store so scope tabs and scope-sidebar project info refresh
    scopeState.projectRecords = scopeState.projectRecords.map((p) =>
      p.id === updated.id ? updated : p
    )
    const storedIcon = projectIcons.get(updated.id)
    scopeState.projects = scopeState.projects.map((p) =>
      p.id === updated.id
        ? {
            id: updated.id,
            name: updated.name,
            path: updated.path,
            source: updated.source,
            host: updated.host,
            color: updated.color,
            iconUrl: getProjectIcon(updated, storedIcon)
          }
        : p
    )

    showEditModal = false
    editProject = null
    editProjectPendingIcon = undefined
  }

  async function changeEditProjectIcon(): Promise<void> {
    if (!editProject) return
    const imagePath = await invoke('dialog:pickImage')
    if (!imagePath) return
    // Read the file as a data URL for local preview only — never persist here
    const dataUrl = await invoke('file:readAsDataUrl', imagePath)
    if (!dataUrl) return
    editProjectPendingIcon = { path: imagePath, dataUrl }
    // Clear any local colour/icon selection since a custom image takes precedence
    editProjectColor = undefined
    editProjectIconType = undefined
  }

  function askRemoveProject(projectId: string): void {
    removeTarget = projects.find((p) => p.id === projectId) ?? null
    if (removeTarget) showRemoveModal = true
  }

  async function confirmRemoveProject(): Promise<void> {
    if (!removeTarget) return
    await deleteProject(removeTarget.id)
    showRemoveModal = false
    removeTarget = null
  }

  // ─── Scope bucket actions ──────────────────────────────────────────────────

  function askEditBucket(bucket: ScopeBucket): void {
    editBucketTarget = bucket
    editBucketName = bucket.name
    editBucketColor = bucket.color
    editBucketIconType = bucket.iconType
  }

  async function confirmEditBucket(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!editBucketTarget || !editBucketName.trim()) return
    try {
      await scopeState.editBucket(editBucketTarget.id, {
        name: editBucketName,
        color: editBucketColor,
        iconType: editBucketIconType
      })
      editBucketTarget = null
    } catch {
      // Silently fail — revert is handled by the store
    }
  }

  async function confirmDeleteBucket(): Promise<void> {
    const target = deleteBucketTarget
    if (!target || target.id === DEFAULT_SCOPE_BUCKET_ID) return
    try {
      const affectedThreads = scopeState.currentProjectThreads.filter(
        (thread) => scopeState.bucketForThread(thread) === target.id
      )
      if (deleteThreads) {
        await Promise.all(
          affectedThreads.map((thread) => invoke('thread:delete', thread.projectId, thread.id))
        )
        for (const thread of affectedThreads) {
          allThreads = allThreads.filter((candidate) => candidate.id !== thread.id)
          scopeState.removeThread(thread.id)
          if (selectedThread?.id === thread.id) workspaceState.clearThread()
        }
      } else {
        const reassigned = await Promise.all(
          affectedThreads.map((thread) =>
            invoke('thread:update', thread.projectId, thread.id, {
              scopeBucketId: DEFAULT_SCOPE_BUCKET_ID
            })
          )
        )
        for (const thread of reassigned) {
          scopeState.updateThread(thread)
          workspaceState.updateThread(thread)
        }
      }
      await scopeState.removeBucket(target.id)
      deleteBucketTarget = null
      deleteThreads = false
    } catch {
      // Silently fail — revert is handled by the store
    }
  }

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
   * Manual reorder of a project's pinned threads. Rewrites pinned_at so the
   * first thread is most-recently pinned (top), applied optimistically so the
   * section reorders the moment the user drops. This is the only thing that
   * changes pin order.
   */
  async function handlePinnedThreadMove(
    projectId: string,
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    const pinnedIds = pinnedThreads.filter((t) => t.projectId === projectId).map((t) => t.id)
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
      const index = t.pinned && t.projectId === projectId ? pinnedIds.indexOf(t.id) : -1
      return index !== -1 ? { ...t, pinnedAt: base - index } : t
    })

    const updated = await invoke('thread:reorderPinned', projectId, pinnedIds)
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

  /** Create a project task using the user's last mode; fresh installs default to engineering. */
  async function createThreadInProject(project: Project, scopeBucketId?: string): Promise<void> {
    const existing = findEmptyNewThread(allThreads, project.id, scopeBucketId)
    if (existing) {
      if (workspaceState.selectedThread?.id === existing.id) {
        workspaceState.requestFocusComposer()
      } else {
        workspaceState.openThread(existing, project)
        if (scopeBucketId) {
          scopeState.showSidebarForThread(existing, scopeBucketId)
        }
      }
      return
    }
    const thread = await invoke('thread:create', {
      projectId: project.id,
      providerId: 'opencode',
      title: DEFAULT_THREAD_TITLE,
      workingDirectory: project.path,
      settings: { ...threadSettings.lastUsed },
      ...(scopeBucketId ? { scopeBucketId } : {})
    })
    upsertThreadInList(thread)
    expandedFolders.add(project.id)
    if (scopeBucketId) {
      scopeState.updateThread(thread)
      scopeState.showSidebarForThread(thread, scopeBucketId)
    }
    workspaceState.openThread(thread, project)
  }

  /** Start a fresh standalone chat — shows the composer immediately. */
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
        providerId: 'opencode',
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

  async function openThread(thread: Thread): Promise<void> {
    workspaceState.openThread(thread, projects.find((p) => p.id === thread.projectId) ?? null)
    void scopeState.ensureBoardLoaded(thread.projectId)
    // Reveal immediately (guaranteed even if the markRead round-trip is slow),
    // and again once the list re-sorts from the updated activity.
    revealThreadInSidebar(thread.id)
    const updated = await invoke('thread:markRead', thread.projectId, thread.id)
    upsertThreadInList(updated)
    workspaceState.updateThread(updated)
    scopeState.updateThread(updated)
    revealThreadInSidebar(thread.id)
  }

  async function openThreadFromSwitcher(thread: Thread): Promise<void> {
    if (thread.projectId === INBOX_PROJECT_ID) navigate('chats')
    else if (mode === 'chats') navigate('projects')
    await openThread(thread)
    // A Ctrl+Tab selection is a deliberate jump to a specific thread. When it
    // crosses modes (e.g. Chats → Projects) the mode switch opens a suppression
    // window and restores the incoming mode's saved scroll, which would keep the
    // chosen thread out of view. Cancel that suppression and reveal the row once
    // the restore + folder expansion have settled.
    sidebarRevealSuppressed = false
    clearTimeout(sidebarRevealSuppressTimer)
    if (thread.projectId !== INBOX_PROJECT_ID) expandedFolders.add(thread.projectId)
    void tick().then(() => revealThreadInSidebar(thread.id))
  }

  async function openProjectFileFromCommand(projectId: string, path: string): Promise<void> {
    const project = projects.find((candidate) => candidate.id === projectId)
    if (!project || project.source !== 'local' || !project.path) return

    navigate('projects')
    const projectThread =
      selectedThread?.projectId === projectId
        ? selectedThread
        : allThreads
            .filter((thread) => thread.projectId === projectId && !thread.archived)
            .sort((a, b) => b.lastActivity - a.lastActivity)[0]

    if (projectThread) {
      await openThread(projectThread)
    } else {
      workspaceState.clearThread()
      workspaceState.activeProject = project
      workspaceState.activeProjectIconUrl = getProjectIcon(project, projectIcons.get(project.id))
      rendererRecovery.setSelectedProject(project.id)
      contextSidebarState.activateThread(project.id, '')
    }

    await projectFilesWorkspace.loadDirectory(project.id, '')
    contextSidebarState.openFiles(project.id, projectThread?.id ?? '')
    await projectFilesWorkspace.openFile(project.id, path)
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
    await invoke('thread:delete', thread.projectId, thread.id)
    allThreads = allThreads.filter((t) => t.id !== thread.id)
    scopeState.removeThread(thread.id)
    if (selectedThread?.id === thread.id) workspaceState.clearThread()
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

  /** A message-level fork succeeded inside the thread view — surface and open it. */
  function handleForkedThread(forked: Thread): void {
    upsertThreadInList(forked)
    workspaceState.openThread(forked, projects.find((p) => p.id === forked.projectId) ?? null)
  }

  /** A chat was continued into a project — register the thread and open it there. */
  function handleContinuedInProject(forked: Thread): void {
    upsertThreadInList(forked)
    scopeState.updateThread(forked)
    if (forked.projectId === INBOX_PROJECT_ID) navigate('chats')
    else if (mode === 'chats') navigate('projects')
    workspaceState.openThread(forked, projects.find((p) => p.id === forked.projectId) ?? null)
  }

  /** Register a freshly added project without landing in a new thread — used by
   *  the continue-chat-in-project flow which creates its own thread. */
  async function handleChatProjectCreated(project: Project): Promise<void> {
    projects = [project, ...projects]
    expandedFolders.add(project.id)
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

<div class="flex h-full">
  <!-- Shared sidebar — shows Projects or Chats depending on the shell mode -->
  {#if !workspaceState.specStudioOpen || workspaceState.specAgentSidebarOpen}
    <CollapsibleSidebar
      title={workspaceState.specStudioOpen
        ? 'Spec conversation'
        : mode === 'projects'
          ? 'Projects'
          : mode === 'threads'
            ? 'Threads'
            : 'Chats'}
      hideHeader={mode === 'projects' &&
        Boolean(scopeState.sidebarContext) &&
        !workspaceState.specStudioOpen}
      bind:scroller={sidebarScroller}
    >
      {#snippet header()}
        {#if workspaceState.specStudioOpen}
          <span class="text-[10px] tabular-nums text-dimmed">
            {workspaceState.specAgentResponses.length}
          </span>
        {:else if mode === 'chats'}
          <div class="flex items-center gap-0.5">
            <button
              class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="New chat"
              title="New chat"
              onclick={startNewChat}
            >
              <SquarePen size={14} />
            </button>
            <ThreadSearchControl
              threads={allThreads.filter((t) => t.projectId === INBOX_PROJECT_ID)}
              contextLabel="chats"
              title="Search chats"
              onOpen={openThread}
              fts={{ projectId: INBOX_PROJECT_ID }}
            />
          </div>
        {:else if mode === 'threads'}
          <div class="flex items-center gap-0.5">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-elevated hover:text-foreground {threadSortState.mode ===
                'default'
                  ? 'text-muted'
                  : 'text-primary'}"
                aria-label="Sort threads"
                title="Sort threads — {threadSortLabel}"
              >
                <ArrowUpDown size={14} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  collisionPadding={8}
                  class="z-50 w-44 overflow-hidden rounded-md border bg-surface p-1 shadow-lg"
                >
                  {#each THREAD_SORT_OPTIONS as option (option.id)}
                    {@const isSelected = threadSortState.mode === option.id}
                    <DropdownMenu.Item
                      class={[
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors',
                        isSelected
                          ? 'text-foreground'
                          : 'text-muted hover:bg-elevated focus:bg-elevated'
                      ]}
                      onSelect={() => setThreadSortMode(option.id)}
                    >
                      <span class="flex-1 truncate">{option.label}</span>
                      {#if isSelected}
                        <Check size={14} class="text-primary" />
                      {/if}
                    </DropdownMenu.Item>
                  {/each}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            {#if activeProject}
              <button
                class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
                aria-label="New thread in {activeProject.name}"
                title="New thread in {activeProject.name}"
                onclick={() => createThreadInProject(activeProject)}
              >
                <Plus size={14} />
              </button>
            {/if}
            <SidebarSearchControl
              open={threadsSearchOpen}
              query={threadsSearchQuery}
              onOpenChange={(open) => {
                if (open) openThreadsSearch()
                else closeThreadsSearch()
              }}
              onQueryChange={runThreadsSearch}
              ariaLabel="Search threads"
              title="Search threads"
              placeholder="Search threads…"
              size="md"
            />
          </div>
        {:else}
          <div class="flex items-center gap-0.5">
            <ThreadSearchControl
              threads={allThreads}
              contextLabel="threads"
              title="Search threads"
              onOpen={openThread}
              fts={{}}
            />
            <ProjectCreateControl
              {projects}
              onProjectCreated={handleProjectCreated}
              onExisting={handleExistingProject}
              triggerAddProject={projectCreateTrigger}
            />
          </div>
        {/if}
      {/snippet}

      {#snippet footer()}
        {#if !workspaceState.specStudioOpen}
          <SidebarAccountControls {active} {navigate} />
        {/if}
      {/snippet}

      {#if workspaceState.specStudioOpen}
        <SpecConversationSidebar />
      {:else if mode === 'projects' && scopeState.sidebarContext}
        {@const scopeContext = scopeState.sidebarContext}
        {@const scopeProject = projects.find((project) => project.id === scopeContext.projectId)}
        {@const scopeBucket = scopeState.buckets.find(
          (bucket) => bucket.id === scopeContext.bucketId
        )}
        {@const otherBuckets = scopeState.buckets.filter(
          (bucket) => bucket.id !== scopeContext.bucketId
        )}
        {@const scopeThreads = STAGE_ORDER.flatMap((stage) =>
          scopeState.threadsFor(scopeContext.bucketId, stage)
        )}
        <div class="flex h-full flex-col">
          <div
            class="flex shrink-0 items-center justify-center gap-2 border-b px-3 py-2"
            style:background-color={scopeProject?.color
              ? `color-mix(in srgb, ${scopeProject.color} 10%, var(--color-surface))`
              : undefined}
          >
            {#if scopeProject && getProjectIcon(scopeProject, projectIcons.get(scopeProject.id))}
              <img
                src={getProjectIcon(scopeProject, projectIcons.get(scopeProject.id))!}
                alt=""
                class="h-4 w-4 shrink-0 object-contain"
                onerror={projectIconOnError(scopeProject)}
              />
            {:else}
              <Folder size={14} class="shrink-0 text-muted" />
            {/if}
            {#if scopeProject}
              <ProjectIdentity
                project={scopeProject}
                class="min-w-0 flex-1"
                nameClass="text-xs font-semibold text-foreground"
                locationClass="text-[9px] text-dimmed"
                showLocation={hasProjectNameCollision(scopeProject, visibleProjects)}
              />
            {:else}
              <span class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                Project
              </span>
            {/if}
            <ProjectSwitch
              activeProjectId={scopeProject?.id ?? null}
              class="ml-auto h-5 w-5 text-dimmed hover:text-foreground"
              onSwitch={switchScopedProject}
            >
              <FolderKanban size={12} />
            </ProjectSwitch>
          </div>

          <div class="shrink-0 border-b px-3 py-3">
            <div class="flex justify-center">
              {#if scopeBucket}
                <ScopeBadge bucket={scopeBucket} size="sm" />
              {/if}
            </div>
            <div class="mt-2 flex items-center justify-center gap-1">
              <button
                class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="New thread in {scopeBucket?.name ?? 'Default'}"
                title="New thread in {scopeBucket?.name ?? 'Default'}"
                disabled={!scopeProject}
                onclick={() => {
                  if (scopeProject) {
                    void createThreadInProject(scopeProject, scopeContext.bucketId)
                  }
                }}
              >
                <Plus size={14} />
              </button>
              <ThreadSearchControl
                threads={scopeThreads}
                contextLabel="threads in this scope"
                title="Search threads in this scope"
                onOpen={openScopedThread}
                fts={{
                  filter: (t) =>
                    !t.archived &&
                    (t.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID) ===
                      (scopeContext.bucketId ?? DEFAULT_SCOPE_BUCKET_ID) &&
                    t.projectId === scopeContext.projectId
                }}
              />
              <button
                class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
                aria-label="Clear scope view"
                title="Return to regular project threads"
                onclick={() => scopeState.clearSidebarContext()}
              >
                <X size={14} />
              </button>
              <ScopeCreateControl title="New scope" />
            </div>
          </div>

          {#if otherBuckets.length > 0}
            <div class="shrink-0 border-b px-3 py-2">
              <div
                class="grid gap-1.5"
                class:grid-cols-1={otherBuckets.length === 1}
                class:grid-cols-2={otherBuckets.length > 1}
              >
                {#each otherBuckets as bucket (bucket.id)}
                  {@const pinnedCount = scopeState.threadsFor(bucket.id, 'pinned').length}
                  {@const todoCount = scopeState.threadsFor(bucket.id, 'todo').length}
                  {@const workingCount = scopeState.threadsFor(bucket.id, 'working').length}
                  {@const issueCount = scopeState.threadsFor(bucket.id, 'issue').length}
                  {@const unreadCount = scopeState.threadsFor(bucket.id, 'unread').length}
                  <div
                    class="group flex items-center gap-1 border-l-2 pl-2 pr-2.5 py-1.5 transition-colors hover:bg-elevated"
                    style:border-color={bucket.color ?? pickColorForSeed(bucket.id)}
                  >
                    <button
                      class="relative flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-muted"
                      title={bucket.name}
                      onclick={() => scopeState.setSidebarBucket(bucket.id)}
                    >
                      <div class="absolute -top-1 left-0 flex gap-0.5">
                        {#if pinnedCount > 0}
                          <StatusBadge stage="pinned" title="Pinned threads" />
                        {/if}
                        {#if todoCount > 0}
                          <StatusBadge stage="todo" title="Todo threads" />
                        {/if}
                        {#if workingCount > 0}
                          <StatusBadge stage="working" title="Working threads" />
                        {/if}
                        {#if issueCount > 0}
                          <StatusBadge stage="issue" title="Issue threads" />
                        {/if}
                        {#if unreadCount > 0}
                          <StatusBadge stage="unread" title="Unread threads" />
                        {/if}
                      </div>
                      {#if bucket.iconType}
                        <img
                          src={getIconSvgDataUrl(
                            bucket.iconType,
                            bucket.color ?? pickColorForSeed(bucket.id)
                          )}
                          alt=""
                          class="h-3.5 w-3.5 shrink-0 object-contain"
                          draggable="false"
                        />
                      {:else if bucket.color}
                        <img
                          src={generateInitialsIconSvg(bucket.name, bucket.color)}
                          alt=""
                          class="h-3.5 w-3.5 shrink-0 object-contain"
                          draggable="false"
                        />
                      {/if}
                      <span class="truncate">{bucket.name}</span>
                    </button>
                    <div class="opacity-0 transition-opacity group-hover:opacity-100">
                      <ScopeActionsMenu
                        {bucket}
                        onEdit={() => askEditBucket(bucket)}
                        onDelete={() => (deleteBucketTarget = bucket)}
                      />
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          {#key scopeContext.bucketId}
            <div class="flex flex-1 min-h-0">
              <div class="flex shrink-0 flex-col items-stretch border-r py-2 gap-1.5 w-11">
                {#each STAGE_ORDER as stage (stage)}
                  {@const stageCount = scopeState.threadsFor(scopeContext.bucketId, stage).length}
                  {@const isActive = scopeContext.stage === stage}
                  {@const bgOpacity = isActive ? '35%' : '8%'}
                  <button
                    class="flex items-center justify-center rounded-md transition-all text-xs font-medium h-24"
                    style="background-color: color-mix(in srgb, {STAGE_COLORS[
                      stage
                    ]} {bgOpacity}, transparent); color: {isActive
                      ? 'var(--color-foreground)'
                      : 'var(--color-muted)'}"
                    onclick={() => scopeState.selectSidebarStage(stage)}
                  >
                    <span class="-rotate-90 flex flex-row items-center gap-3">
                      {#if stageCount > 0}
                        <span class="font-bold">{stageCount}</span>
                      {/if}
                      <span>{STAGE_LABELS[stage]}</span>
                    </span>
                  </button>
                {/each}
              </div>

              <div class="flex flex-1 flex-col min-w-0">
                <div class="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
                  <StatusBadge stage={scopeContext.stage} size="md" />
                  <span class="text-xs font-semibold">{STAGE_LABELS[scopeContext.stage]}</span>
                  {#if scopeState.threadsFor(scopeContext.bucketId, scopeContext.stage).length > 0}
                    <span class="tabular-nums text-[10px] text-dimmed"
                      >{scopeState.threadsFor(scopeContext.bucketId, scopeContext.stage)
                        .length}</span
                    >
                  {/if}
                </div>
                <div class="flex-1 overflow-y-auto">
                  {#each scopeState.threadsFor(scopeContext.bucketId, scopeContext.stage) as thread (thread.id)}
                    <ThreadRow
                      {thread}
                      selected={selectedThread?.id === thread.id}
                      compact
                      hideScope
                      onOpen={openScopedThread}
                      onRename={handleRename}
                      onTogglePin={togglePin}
                      onDelete={handleDelete}
                      onFork={forkThread}
                    />
                  {:else}
                    <p class="px-4 py-8 text-center text-xs text-dimmed">
                      No threads in this slice
                    </p>
                  {/each}
                </div>
              </div>
            </div>
          {/key}
        </div>
      {:else if loading}
        <p class="px-2 py-4 text-sm text-dimmed">Loading...</p>
      {:else}
        <!-- All three lists stay mounted so switching modes never tears down
             the projects sidebar or loses its scroll position. -->
        <div class={mode === 'chats' ? '' : 'hidden'}>
          {#if pinnedInboxThreads.length > 0}
            <div class="mb-3">
              <p
                class="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-dimmed"
              >
                Pinned
              </p>
              <div class="space-y-px" role="list">
                {#each pinnedInboxThreads as thread (thread.id)}
                  <ThreadRow
                    {thread}
                    selected={selectedThread?.id === thread.id}
                    onOpen={openThread}
                    onRename={handleRename}
                    onTogglePin={togglePin}
                    onDelete={handleDelete}
                    onFork={forkThread}
                    onMoveThread={(draggedId, targetId, pos) =>
                      handleThreadMove(thread.projectId, draggedId, targetId, pos)}
                  />
                {/each}
              </div>
            </div>
          {/if}

          {#if standaloneThreads.length > 0}
            <div class="space-y-px" role="list">
              {#each standaloneThreads.slice(0, 50) as thread (thread.id)}
                <ThreadRow
                  {thread}
                  selected={selectedThread?.id === thread.id}
                  onOpen={openThread}
                  onRename={handleRename}
                  onTogglePin={togglePin}
                  onDelete={handleDelete}
                  onFork={forkThread}
                  onMoveThread={(draggedId, targetId, pos) =>
                    handleThreadMove(thread.projectId, draggedId, targetId, pos)}
                />
              {/each}
            </div>
          {:else if pinnedInboxThreads.length === 0}
            <div class="flex flex-col items-center gap-2 px-2 py-10 text-center">
              <MessageSquare size={20} class="text-dimmed" />
              <p class="text-xs text-muted">No chats yet</p>
              <p class="text-xs text-dimmed">Start a new chat to get going</p>
            </div>
          {/if}
        </div>
        <div class={mode === 'threads' ? '' : 'hidden'}>
          {#if threadsSearchOpen && threadsSearchQuery.trim()}
            <!-- Threads search: results render inline in the sidebar so the user
                 can open several results without the search dismissing. -->
            {#if threadsSearching && threadsSearchResults.length === 0}
              <p class="px-2 py-6 text-center text-xs text-dimmed">Searching…</p>
            {:else if threadsSearchResults.length === 0}
              <p class="px-2 py-6 text-center text-xs text-dimmed">No matching threads</p>
            {:else}
              <div class="space-y-px" role="list">
                {#each threadsSearchResults as result (result.thread.id)}
                  <ThreadSearchResultRow
                    {result}
                    selected={selectedThread?.id === result.thread.id}
                    onOpen={openThread}
                  />
                {/each}
              </div>
            {/if}
          {:else}
            <!-- Threads mode: pinned section then flat list -->
            {#if pinnedTimelineThreads.length > 0}
              <div class="mb-3 pb-3 border-b">
                <div class="flex items-center gap-1.5 px-2 py-1.5">
                  <span class="text-[10px] font-semibold uppercase tracking-wide text-dimmed"
                    >Pinned</span
                  >
                </div>
                <div class="space-y-px" role="list">
                  {#each pinnedTimelineThreads as thread (thread.id)}
                    <ThreadRow
                      {thread}
                      compact
                      projectIconUrl={getThreadIcon(thread)}
                      selected={selectedThread?.id === thread.id}
                      onOpen={openThread}
                      onRename={handleRename}
                      onTogglePin={togglePin}
                      onDelete={handleDelete}
                      onFork={forkThread}
                      onMoveThread={(draggedId, targetId, pos) =>
                        handleTimelinePinnedMove(draggedId, targetId, pos)}
                    />
                  {/each}
                </div>
              </div>
            {/if}
            <div class="space-y-px" role="list">
              {#each unpinnedTimelineThreads as thread (thread.id)}
                <ThreadRow
                  {thread}
                  projectIconUrl={getThreadIcon(thread)}
                  selected={selectedThread?.id === thread.id}
                  onOpen={openThread}
                  onRename={handleRename}
                  onTogglePin={togglePin}
                  onDelete={handleDelete}
                  onFork={forkThread}
                />
              {:else}
                <div class="flex flex-col items-center gap-2 px-2 py-10 text-center">
                  <p class="text-xs text-muted">No threads yet</p>
                </div>
              {/each}
            </div>
            {#if hasMoreHistory}
              <button
                class="mt-2 flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[11px] text-dimmed transition-colors hover:text-foreground disabled:cursor-wait"
                disabled={historyLoading}
                onclick={() => void loadHistoryPage()}
              >
                {historyLoading ? 'Loading history…' : 'Load older threads'}
              </button>
            {/if}
          {/if}
        </div>
        <div class={mode === 'projects' ? '' : 'hidden'}>
          <!-- Pinned threads above everything -->
          <PinnedSection
            threads={pinnedThreads}
            projects={visibleProjects}
            selectedThreadId={selectedThread?.id ?? null}
            onOpen={openThread}
            onRename={handleRename}
            onTogglePin={togglePin}
            onDelete={handleDelete}
            onFork={forkThread}
            onMovePinnedThread={(projectId, draggedId, targetId, pos) =>
              handlePinnedThreadMove(projectId, draggedId, targetId, pos)}
          />

          <!-- Pinned projects -->
          {#if pinnedProjects.length > 0}
            <div class="mb-1 pb-2 border-b">
              <p
                class="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-dimmed"
              >
                Pinned
              </p>
              <div class="space-y-px" role="list">
                {#each pinnedProjects as project (project.id)}
                  {@const folderThreads = threadsByProject.get(project.id) ?? []}
                  {@const expanded =
                    expandedFolders.has(project.id) || projectSearchOpen.has(project.id)}
                  {@const working = folderThreads.some((thread) => threadHasVisibleWork(thread))}
                  <DropdownMenu.Root
                    open={openProjectMenuId === project.id}
                    onOpenChange={(o) => {
                      openProjectMenuId = o ? project.id : null
                    }}
                  >
                    <div>
                      <FolderRow
                        {project}
                        iconUrl={projectIcons.get(project.id) ?? null}
                        {expanded}
                        {working}
                        showLocation={hasProjectNameCollision(project, visibleProjects)}
                        onToggle={() => toggleFolder(project.id)}
                        onMoveProject={(draggedId, targetId, pos) =>
                          handleProjectMove(draggedId, targetId, pos)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          openProjectMenuId = project.id
                        }}
                      >
                        {#snippet actions()}
                          <span class="flex shrink-0 items-center gap-0.5">
                            <SidebarSearchControl
                              open={projectSearchOpen.has(project.id)}
                              query={projectSearchQueries.get(project.id) ?? ''}
                              onOpenChange={(open) => {
                                if (open) openProjectSearch(project.id)
                                else closeProjectSearch(project.id)
                              }}
                              onQueryChange={(value) => {
                                projectSearchQueries.set(project.id, value)
                                runProjectSearch(project.id, value)
                              }}
                              ariaLabel="Search threads in {project.name}"
                              title="Search threads"
                              placeholder="Search threads in {project.name}…"
                            />
                            <button
                              class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
                              aria-label="New thread in {project.name}"
                              title="New thread"
                              onclick={() => createThreadInProject(project)}
                            >
                              <Plus size={12} />
                            </button>
                            <DropdownMenu.Trigger
                              class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
                              aria-label="Options for {project.name}"
                              title="Project options"
                              oncontextmenu={(e: MouseEvent) => e.preventDefault()}
                            >
                              <Ellipsis size={12} />
                            </DropdownMenu.Trigger>
                          </span>
                        {/snippet}
                      </FolderRow>
                      {#if expanded}
                        {@const searchQ = projectSearchQueries.get(project.id) ?? ''}
                        {@const isSearching = Boolean(searchQ.trim())}
                        {@const searchResults = projectSearchResults.get(project.id) ?? []}
                        {@const filteredThreads = isSearching
                          ? []
                          : filterThreadsByQuery(folderThreads, '')}
                        <div class="ml-2">
                          {#if isSearching && projectSearching.has(project.id) && searchResults.length === 0}
                            <p class="px-2 py-1.5 text-[11px] text-dimmed">Searching…</p>
                          {:else if (isSearching ? searchResults.length : filteredThreads.length) === 0}
                            <p class="px-2 py-1.5 text-[11px] text-dimmed">
                              {searchQ.trim() ? 'No matching threads' : 'No threads yet'}
                            </p>
                          {:else if isSearching}
                            <div
                              class="max-h-80 space-y-px overflow-y-auto overscroll-contain py-0.5"
                              role="list"
                            >
                              {#each searchResults as result (result.thread.id)}
                                <ThreadSearchResultRow
                                  {result}
                                  selected={selectedThread?.id === result.thread.id}
                                  onOpen={openThread}
                                />
                              {/each}
                            </div>
                          {:else}
                            <div class="space-y-px py-0.5" role="list">
                              {#each filteredThreads.slice(0, getVisibleCount(project.id)) as thread (thread.id)}
                                <ThreadRow
                                  {thread}
                                  selected={selectedThread?.id === thread.id}
                                  onOpen={openThread}
                                  onRename={handleRename}
                                  onTogglePin={togglePin}
                                  onDelete={handleDelete}
                                  onFork={forkThread}
                                  onMoveThread={(draggedId, targetId, pos) =>
                                    handleThreadMove(project.id, draggedId, targetId, pos)}
                                />
                              {/each}
                            </div>
                            {#if filteredThreads.length > getVisibleCount(project.id)}
                              <button
                                class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[11px] text-dimmed transition-colors hover:text-foreground"
                                onclick={() => showMoreThreads(project.id, filteredThreads.length)}
                              >
                                Show {filteredThreads.length - getVisibleCount(project.id)} more
                              </button>
                            {/if}
                            {#if getVisibleCount(project.id) > THREADS_PER_PAGE}
                              <button
                                class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[11px] text-dimmed transition-colors hover:text-foreground"
                                onclick={() => showLessThreads(project.id)}
                              >
                                Show less
                              </button>
                            {/if}
                          {/if}
                        </div>
                      {/if}
                    </div>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        side="bottom"
                        align="end"
                        sideOffset={4}
                        collisionPadding={8}
                        class="z-50 w-48 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
                      >
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                          onSelect={() => askEditProject(project.id)}
                        >
                          <Pencil size={14} class="text-muted" />
                          Edit Project
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                          onSelect={() => openInEditor(project.id)}
                        >
                          <ExternalLink size={14} class="text-muted" />
                          Open in Editor
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                          onSelect={() => copyProjectPath(project.id)}
                        >
                          <Copy size={14} class="text-muted" />
                          Copy Path
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                          onSelect={() => revealProjectInFinder(project.id)}
                        >
                          <FolderOpen size={14} class="text-muted" />
                          {navigator.platform.toUpperCase().indexOf('MAC') >= 0
                            ? 'Reveal in Finder'
                            : 'Show in Explorer'}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                          onSelect={() => toggleProjectPin(project.id)}
                        >
                          {#if project.pinned}
                            <PinOff size={14} class="text-muted" />
                            Unpin Project
                          {:else}
                            <Pin size={14} class="text-muted" />
                            Pin Project
                          {/if}
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
                          onSelect={() => askRemoveProject(project.id)}
                        >
                          <Trash2 size={14} />
                          Remove Project
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Folder tree -->
          {#if regularProjects.length === 0 && pinnedProjects.length === 0}
            <div class="flex flex-col items-center gap-2 px-2 py-10 text-center">
              <FolderOpen size={20} class="text-dimmed" />
              <p class="text-xs text-muted">No projects yet</p>
              <p class="text-xs text-dimmed">Add a folder to get started</p>
            </div>
          {:else if regularProjects.length > 0}
            <div class="space-y-0.5" role="list">
              {#each regularProjects as project (project.id)}
                {@const folderThreads = threadsByProject.get(project.id) ?? []}
                {@const expanded =
                  expandedFolders.has(project.id) || projectSearchOpen.has(project.id)}
                {@const working = folderThreads.some((thread) => threadHasVisibleWork(thread))}
                <DropdownMenu.Root
                  open={openProjectMenuId === project.id}
                  onOpenChange={(o) => {
                    openProjectMenuId = o ? project.id : null
                  }}
                >
                  <div>
                    <FolderRow
                      {project}
                      iconUrl={projectIcons.get(project.id) ?? null}
                      {expanded}
                      {working}
                      showLocation={hasProjectNameCollision(project, visibleProjects)}
                      onToggle={() => toggleFolder(project.id)}
                      onMoveProject={(draggedId, targetId, pos) =>
                        handleProjectMove(draggedId, targetId, pos)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        openProjectMenuId = project.id
                      }}
                    >
                      {#snippet actions()}
                        <span class="flex shrink-0 items-center gap-0.5">
                          <SidebarSearchControl
                            open={projectSearchOpen.has(project.id)}
                            query={projectSearchQueries.get(project.id) ?? ''}
                            onOpenChange={(open) => {
                              if (open) openProjectSearch(project.id)
                              else closeProjectSearch(project.id)
                            }}
                            onQueryChange={(value) => {
                              projectSearchQueries.set(project.id, value)
                              runProjectSearch(project.id, value)
                            }}
                            ariaLabel="Search threads in {project.name}"
                            title="Search threads"
                            placeholder="Search threads in {project.name}…"
                          />
                          <button
                            class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
                            aria-label="New thread in {project.name}"
                            title="New thread"
                            onclick={() => createThreadInProject(project)}
                          >
                            <Plus size={12} />
                          </button>
                          <DropdownMenu.Trigger
                            class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
                            aria-label="Options for {project.name}"
                            title="Project options"
                            oncontextmenu={(e: MouseEvent) => e.preventDefault()}
                          >
                            <Ellipsis size={12} />
                          </DropdownMenu.Trigger>
                        </span>
                      {/snippet}
                    </FolderRow>

                    <!-- Threads under folder -->
                    {#if expanded}
                      {@const searchQ = projectSearchQueries.get(project.id) ?? ''}
                      {@const isSearching = Boolean(searchQ.trim())}
                      {@const searchResults = projectSearchResults.get(project.id) ?? []}
                      {@const filteredThreads = isSearching
                        ? []
                        : filterThreadsByQuery(folderThreads, '')}
                      <div class="ml-2">
                        {#if isSearching && projectSearching.has(project.id) && searchResults.length === 0}
                          <p class="px-2 py-1.5 text-[11px] text-dimmed">Searching…</p>
                        {:else if (isSearching ? searchResults.length : filteredThreads.length) === 0}
                          <p class="px-2 py-1.5 text-[11px] text-dimmed">
                            {searchQ.trim() ? 'No matching threads' : 'No threads yet'}
                          </p>
                        {:else if isSearching}
                          <div
                            class="max-h-80 space-y-px overflow-y-auto overscroll-contain py-0.5"
                            role="list"
                          >
                            {#each searchResults as result (result.thread.id)}
                              <ThreadSearchResultRow
                                {result}
                                selected={selectedThread?.id === result.thread.id}
                                onOpen={openThread}
                              />
                            {/each}
                          </div>
                        {:else}
                          <div class="space-y-px py-0.5" role="list">
                            {#each filteredThreads.slice(0, getVisibleCount(project.id)) as thread (thread.id)}
                              <ThreadRow
                                {thread}
                                selected={selectedThread?.id === thread.id}
                                onOpen={openThread}
                                onRename={handleRename}
                                onTogglePin={togglePin}
                                onDelete={handleDelete}
                                onFork={forkThread}
                                onMoveThread={(draggedId, targetId, pos) =>
                                  handleThreadMove(project.id, draggedId, targetId, pos)}
                              />
                            {/each}
                          </div>
                          {#if filteredThreads.length > getVisibleCount(project.id)}
                            <button
                              class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[11px] text-dimmed transition-colors hover:text-foreground"
                              onclick={() => showMoreThreads(project.id, filteredThreads.length)}
                            >
                              Show {filteredThreads.length - getVisibleCount(project.id)} more
                            </button>
                          {/if}
                          {#if getVisibleCount(project.id) > THREADS_PER_PAGE}
                            <button
                              class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[11px] text-dimmed transition-colors hover:text-foreground"
                              onclick={() => showLessThreads(project.id)}
                            >
                              Show less
                            </button>
                          {/if}
                        {/if}
                      </div>
                    {/if}
                  </div>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="bottom"
                      align="end"
                      sideOffset={4}
                      collisionPadding={8}
                      class="z-50 w-48 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
                    >
                      <DropdownMenu.Item
                        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                        onSelect={() => askEditProject(project.id)}
                      >
                        <Pencil size={14} class="text-muted" />
                        Edit Project
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                        onSelect={() => openInEditor(project.id)}
                      >
                        <ExternalLink size={14} class="text-muted" />
                        Open in Editor
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                        onSelect={() => copyProjectPath(project.id)}
                      >
                        <Copy size={14} class="text-muted" />
                        Copy Path
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                        onSelect={() => revealProjectInFinder(project.id)}
                      >
                        <FolderOpen size={14} class="text-muted" />
                        {navigator.platform.toUpperCase().indexOf('MAC') >= 0
                          ? 'Reveal in Finder'
                          : 'Show in Explorer'}
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                        onSelect={() => toggleProjectPin(project.id)}
                      >
                        {#if project.pinned}
                          <PinOff size={14} class="text-muted" />
                          Unpin Project
                        {:else}
                          <Pin size={14} class="text-muted" />
                          Pin Project
                        {/if}
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
                      <DropdownMenu.Item
                        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
                        onSelect={() => askRemoveProject(project.id)}
                      >
                        <Trash2 size={14} />
                        Remove Project
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </CollapsibleSidebar>
  {/if}

  <!-- Main Content -->
  <section class="relative min-w-0 flex-1 overflow-hidden">
    <div
      class="grid h-full min-h-0 min-w-0"
      style:grid-template-columns={contextPanelColumns}
      style:grid-template-rows={contextPanelRows}
    >
      <div class="min-h-0 min-w-0 overflow-hidden" style:grid-column="1" style:grid-row="1">
        {#if selectedThread}
          <div class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
            {#key selectedThread.id}
              <ThreadView
                thread={selectedThread}
                chatMode={mode === 'chats'}
                onForked={handleForkedThread}
                projects={visibleProjects}
                {projectIcons}
                onContinueInProject={handleContinuedInProject}
                onProjectCreated={handleChatProjectCreated}
              />
            {/key}
          </div>
        {:else if mode === 'chats'}
          <!-- Empty state — greeting centered, composer anchored at the bottom -->
          <div class="flex h-full flex-col">
            <div class="flex flex-1 items-center justify-center px-6">
              <div class="text-center">
                <MessageSquare size={32} class="mx-auto mb-3 text-dimmed" />
                <h1 class="text-lg font-semibold tracking-tight">Start a new chat</h1>
                <p class="mt-1 text-sm text-dimmed">Send a message to begin — no project needed</p>
              </div>
            </div>
            <div class="shrink-0 px-6 pb-6">
              <div class="mx-auto w-full max-w-2xl">
                {#key chatsComposerRestoreKey}
                  <ChatComposer
                    placeholder="What do you want to work on?"
                    autofocus
                    showEngineeringMode={false}
                    showChatModes
                    hidePermissionSelector
                    settings={chatComposerSettings}
                    onSettingsChange={(settings) => chatSettings.commit(settings)}
                    providers={chatProviders}
                    projectId={chatInboxId}
                    attachmentStorage={{
                      kind: 'chat',
                      projectId: INBOX_PROJECT_ID,
                      threadId: 'new-chat'
                    }}
                    harnessId={chatComposerSettings.harnessId}
                    favoriteModels={rendererRecovery.chatFavoriteModels}
                    onToggleFavorite={(providerId, modelId, harnessId) =>
                      rendererRecovery.toggleChatFavorite(modelKey(harnessId, providerId, modelId))}
                    onReorderFavorite={(draggedKey, targetKey, position) =>
                      rendererRecovery.reorderChatFavorite(draggedKey, targetKey, position)}
                    recentModels={rendererRecovery.chatRecentModels}
                    onModelUsed={(modelKey) => rendererRecovery.addChatRecentModel(modelKey)}
                    imageDescriptorDefault={config?.agentDefaults.imageDescriptor}
                    imageDescriptorAskAgain={config?.imageDescriptorAskAgain === true}
                    onImageDescriptorDefaultChange={(selection) =>
                      void updateConfig?.({
                        agentDefaults: {
                          ...(config?.agentDefaults ?? { syncFromThreadChanges: false }),
                          imageDescriptor: selection
                        }
                      })}
                    onImageDescriptorAskAgainChange={(value) =>
                      void updateConfig?.({ imageDescriptorAskAgain: value })}
                    initialValue={rendererRecovery.draftFor(INBOX_PROJECT_ID, 'new-chat')}
                    onValueChange={(value) =>
                      rendererRecovery.setDraft(INBOX_PROJECT_ID, 'new-chat', value)}
                    initialAttachments={rendererRecovery.attachmentsFor(
                      INBOX_PROJECT_ID,
                      'new-chat'
                    )}
                    onAttachmentsChange={(files) =>
                      rendererRecovery.setDraft(
                        INBOX_PROJECT_ID,
                        'new-chat',
                        rendererRecovery.draftFor(INBOX_PROJECT_ID, 'new-chat'),
                        files
                      )}
                    onSend={(msg, files) => void createStandaloneChat(msg, files)}
                  />
                {/key}
              </div>
            </div>
          </div>
        {:else}
          <div class="flex h-full items-center justify-center">
            <div class="text-center">
              <MessageSquare size={28} class="mx-auto mb-2 text-dimmed" />
              <p class="text-sm text-dimmed">Select a thread or create one to get started</p>
            </div>
          </div>
        {/if}
      </div>

      {#if sidebarVisible}
        {#snippet contextSidebarContent()}
          {@const activeContextTab = contextSidebarState.sidebarActiveTab}
          {#if activeContextTab}
            {#key activeContextTab.id}
              {#if activeContextTab.kind === 'files'}
                <ProjectFilesPanel
                  projectId={activeContextTab.projectId}
                  projectName={activeProject?.name ?? 'Project files'}
                  projectIconUrl={activeProject
                    ? getProjectIcon(activeProject, projectIcons.get(activeProject.id))
                    : null}
                />
              {:else if activeContextTab.kind === 'diff'}
                <DiffSidebarPanel
                  projectId={activeContextTab.projectId}
                  threadId={activeContextTab.threadId}
                  checkpointId={activeContextTab.checkpointId}
                  revealPath={activeContextTab.revealPath}
                  revealNonce={activeContextTab.revealNonce}
                />
              {:else if activeContextTab.kind === 'terminal'}
                {#if terminalFullscreenTabId === activeContextTab.id}
                  <div class="flex h-full items-center justify-center text-xs text-muted">
                    Terminal is open in fullscreen
                  </div>
                {:else}
                  <TerminalPanel
                    terminalId={activeContextTab.terminalId}
                    projectId={activeContextTab.projectId}
                  />
                {/if}
              {:else if activeContextTab.kind === 'debugger'}
                <AgentDebugPanel />
              {:else if activeContextTab.kind === 'sources'}
                <SourcesPanel
                  sources={workspaceState.sources}
                  projectId={activeContextTab.projectId}
                  threadId={activeContextTab.threadId}
                />
              {:else if activeContextTab.kind === 'git'}
                {#await import('../git/GitStatusPanel.svelte') then { default: GitStatusPanel }}
                  <GitStatusPanel
                    projectId={activeContextTab.projectId}
                    threadId={activeContextTab.threadId}
                  />
                {/await}
              {:else if activeContextTab.kind === 'cloud-deployment'}
                {#await import('../cloud/CloudDeploymentPanel.svelte') then { default: CloudDeploymentPanel }}
                  <CloudDeploymentPanel
                    projectId={activeContextTab.projectId}
                    threadId={activeContextTab.threadId}
                  />
                {/await}
              {:else if activeContextTab.kind === 'temporary-chat'}
                <TemporaryChatView
                  tab={activeContextTab}
                  onContinueInThread={handleContinueInThread}
                />
              {:else if activeContextTab.kind === 'notifications'}
                <NotificationPanel />
              {:else if activeContextTab.kind === 'memory'}
                <MemoryPanel
                  variant="sidebar"
                  projectId={activeContextTab.projectId}
                  threadId={activeContextTab.threadId}
                  bind:activeSection={activeContextTab.memorySection}
                />
              {:else}
                <SubagentSessionView tab={activeContextTab} onOpenSubagent={openNestedSubagent} />
              {/if}
            {/key}
          {/if}
        {/snippet}
        <div class="min-h-0 min-w-0" style:grid-column="2" style:grid-row="1">
          <ContextSidebar
            tabs={contextSidebarState.sidebarTabs}
            activeTabId={contextSidebarState.sidebarActiveTabId}
            width={contextSidebarState.width}
            height={contextSidebarState.terminalHeight}
            placement="right"
            content={contextSidebarContent}
            actions={sidebarActions}
            hideAddButton={mode === 'chats'}
            onSelect={(id) => contextSidebarState.focus(id)}
            onClose={closeContextTab}
            onFullscreenTab={openTabFullscreen}
            onMoveTab={(id, targetId, position) =>
              contextSidebarState.reorder(id, targetId, position)}
            onWidthChange={(width) => contextSidebarState.setWidth(width)}
            onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
            onTerminalPlacementChange={(placement) =>
              contextSidebarState.setTerminalPlacement(placement)}
          />
        </div>
      {/if}
      {#if terminalDockVisible}
        {#snippet terminalDockContent()}
          {@const activeDockTab = contextSidebarState.terminalActiveTab}
          {#if activeDockTab}
            {#key activeDockTab.id}
              <TerminalPanel
                terminalId={activeDockTab.terminalId}
                projectId={activeDockTab.projectId}
              />
            {/key}
          {/if}
        {/snippet}
        <div class="min-h-0 min-w-0" style:grid-column="1 / -1" style:grid-row="2">
          <ContextSidebar
            tabs={contextSidebarState.terminalTabs}
            activeTabId={contextSidebarState.terminalActiveTabId}
            width={contextSidebarState.width}
            height={contextSidebarState.terminalHeight}
            placement="bottom"
            content={terminalDockContent}
            actions={terminalDockActions}
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
          />
        </div>
      {/if}
      {#if terminalDockCollapsed}
        <button
          type="button"
          class="absolute inset-x-0 bottom-0 z-30 flex h-8 w-full shrink-0 items-center justify-center border-t border-border bg-surface text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Expand terminal"
          aria-label="Expand terminal"
          onclick={() => contextSidebarState.toggleTerminalDock()}
        >
          <ChevronUp size={14} />
        </button>
      {/if}
    </div>
  </section>
</div>

<!-- Remove Project Confirmation -->
<Modal open={showRemoveModal} title="Remove Project" onClose={() => (showRemoveModal = false)}>
  <p class="text-sm leading-relaxed text-muted">
    This will remove
    <span class="font-medium text-foreground">{removeTarget?.name}</span>
    and all of its threads from {APP_NAME}. The folder itself will remain on your device.
  </p>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Cancel"
      onclick={() => (showRemoveModal = false)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90"
      title="Remove this project and its threads from {APP_NAME}"
      onclick={() => void confirmRemoveProject()}
    >
      Remove
    </button>
  {/snippet}
</Modal>

<!-- Edit Project Modal -->
<Modal open={showEditModal} title="Edit Project" onClose={() => (showEditModal = false)}>
  {#if editProject}
    <form
      id="edit-project-form"
      class="space-y-4"
      onsubmit={(e: SubmitEvent) => void confirmEditProject(e)}
    >
      <AppearancePicker
        name={editProjectName}
        color={editProjectColor}
        iconType={editProjectIconType}
        fallbackIconUrl={editProjectPendingIcon?.dataUrl ??
          (editProject.icon ? (projectIcons.get(editProject.id) ?? null) : null)}
        onColorChange={(color) => (editProjectColor = color)}
        onIconTypeChange={(iconType) => (editProjectIconType = iconType)}
        onReset={() => {
          editProjectColor = editProject?.color
          editProjectIconType = editProject?.iconType
          editProjectPendingIcon = undefined
        }}
      />

      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Upload a custom image as the project icon"
        onclick={() => void changeEditProjectIcon()}
      >
        <FolderOpen size={12} />
        Upload Image
      </button>

      <!-- Project name -->
      <div>
        <label class="mb-1 block text-xs font-medium text-muted" for="edit-project-name">
          Project Name
        </label>
        <input
          id="edit-project-name"
          type="text"
          class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
          bind:value={editProjectName}
        />
      </div>

      <!-- Project path -->
      <div>
        <label class="mb-1 block text-xs font-medium text-muted" for="edit-project-path">
          Project Path
        </label>
        <input
          id="edit-project-path"
          type="text"
          class="w-full rounded-lg border bg-raised px-3 py-2 text-sm text-dimmed"
          value={editProject.path}
          readonly
        />
      </div>
    </form>
  {/if}

  {#snippet footer()}
    {#if editProject}
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
        title="Cancel"
        onclick={() => (showEditModal = false)}
      >
        Cancel
      </button>
      <button
        type="submit"
        form="edit-project-form"
        class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
        disabled={!editProjectName.trim()}
        title="Save project settings"
      >
        Save
      </button>
    {/if}
  {/snippet}
</Modal>

<!-- Edit Scope Modal -->
<Modal
  open={editBucketTarget !== null}
  title="Edit Scope"
  onClose={() => (editBucketTarget = null)}
>
  {#if editBucketTarget}
    <form
      id="edit-scope-form"
      class="space-y-4"
      onsubmit={(e: SubmitEvent) => void confirmEditBucket(e)}
    >
      <AppearancePicker
        name={editBucketName}
        color={editBucketColor}
        iconType={editBucketIconType}
        onColorChange={(color) => (editBucketColor = color)}
        onIconTypeChange={(iconType) => (editBucketIconType = iconType)}
        onReset={() => {
          editBucketColor = editBucketTarget?.color
          editBucketIconType = editBucketTarget?.iconType
        }}
      />

      <div>
        <label class="mb-1 block text-xs font-medium text-muted" for="edit-scope-name">
          Scope Name
        </label>
        <input
          id="edit-scope-name"
          type="text"
          class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
          bind:value={editBucketName}
        />
      </div>
    </form>
  {/if}

  {#snippet footer()}
    {#if editBucketTarget}
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
        title="Cancel"
        onclick={() => (editBucketTarget = null)}
      >
        Cancel
      </button>
      <button
        type="submit"
        form="edit-scope-form"
        class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
        disabled={!editBucketName.trim()}
        title="Save scope settings"
      >
        Save
      </button>
    {/if}
  {/snippet}
</Modal>

<!-- Delete Scope Confirmation -->
<Modal
  open={deleteBucketTarget !== null}
  title="Delete Scope"
  onClose={() => (deleteBucketTarget = null)}
>
  {#if deleteBucketTarget}
    <p class="text-sm text-muted">
      Are you sure you want to delete the scope <strong class="text-foreground"
        >{deleteBucketTarget.name}</strong
      >? {deleteThreads
        ? 'All threads in this scope will be permanently deleted.'
        : 'All threads in this scope will be moved back to the Default scope.'}
    </p>

    <div
      class="mt-4 flex items-center justify-between rounded-lg border bg-elevated/50 px-3 py-2.5"
    >
      <div class="min-w-0">
        <p class="text-sm font-medium text-foreground">Delete associated threads</p>
        <p class="text-xs text-muted">Also permanently delete every thread in this scope.</p>
      </div>
      <Switch
        checked={deleteThreads}
        onchange={(checked) => (deleteThreads = checked)}
        activeClass="bg-danger"
        aria-label="Delete associated threads"
      />
    </div>
  {/if}

  {#snippet footer()}
    {#if deleteBucketTarget}
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
        title="Cancel"
        onclick={() => (deleteBucketTarget = null)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90"
        title="Delete scope"
        onclick={() => void confirmDeleteBucket()}
      >
        Delete
      </button>
    {/if}
  {/snippet}
</Modal>

<ThreadSwitcher
  threads={recentThreads}
  projects={visibleProjects}
  projectIconUrls={projectIcons}
  selectedThreadId={selectedThread?.id ?? null}
  onSelect={openThreadFromSwitcher}
/>

<!-- Terminal fullscreen dialog -->
{#if terminalFullscreenTabId}
  {@const terminalTab = contextSidebarState.tabs.find((t) => t.id === terminalFullscreenTabId)}
  {#if terminalTab?.kind === 'terminal'}
    <Dialog.Root
      open={true}
      onOpenChange={(open) => {
        if (!open) terminalFullscreenTabId = null
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm" />
        <Dialog.Content
          class="fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-app shadow-xl"
          onEscapeKeydown={(e) => e.preventDefault()}
        >
          <div
            class="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3"
            style={trafficLightInsetStyle()}
          >
            <Dialog.Title class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
              {terminalTab.title}
            </Dialog.Title>
            <Dialog.Description class="sr-only">Fullscreen terminal</Dialog.Description>
            <Dialog.Close
              class="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="Close fullscreen terminal"
              title="Close fullscreen terminal"
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          <TerminalPanel terminalId={terminalTab.terminalId} projectId={terminalTab.projectId} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  {/if}
{/if}

<!-- Closing a files tab with unsaved changes -->
<Dialog.Root bind:open={() => closeTabTarget !== null, (open) => !open && (closeTabTarget = null)}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <Dialog.Title class="text-sm font-semibold text-foreground">Unsaved changes</Dialog.Title>
      <Dialog.Description class="mt-2 text-xs leading-5 text-muted">
        <span class="font-mono text-foreground">{closeTabTarget?.path}</span> has unsaved changes. Save
        them before closing the tab?
      </Dialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <Dialog.Close
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </Dialog.Close>
        <button
          type="button"
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          title="Close the tab and discard unsaved changes"
          onclick={discardCloseTab}
        >
          Discard changes
        </button>
        <button
          type="button"
          class="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover"
          title="Save the file and close the tab"
          onclick={() => void saveAndCloseTab()}
        >
          Save &amp; close
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
