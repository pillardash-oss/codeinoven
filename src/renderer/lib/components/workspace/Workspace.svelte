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
    Settings,
    SquarePen,
    Pencil,
    Copy,
    FolderKanban,
    ArrowUpDown,
    Check
  } from '@lucide/svelte'
  import { Dialog, DropdownMenu } from 'bits-ui'
  import ProjectSwitch from '../shared/ProjectSwitch.svelte'
  import ProjectIdentity from '../shared/ProjectIdentity.svelte'
  import CollapsibleSidebar from '../layout/CollapsibleSidebar.svelte'
  import ChatComposer from '../chats/ChatComposer.svelte'
  import FolderRow from './FolderRow.svelte'
  import ProjectSearchDropdown from './ProjectSearchDropdown.svelte'
  import PinnedSection from '../threads/PinnedSection.svelte'
  import ThreadRow from '../threads/ThreadRow.svelte'
  import ThreadSearchResultRow from '../shared/ThreadSearchResultRow.svelte'
  import ThreadSwitcher from '../threads/ThreadSwitcher.svelte'
  import ThreadView from '../threads/ThreadView.svelte'
  import SpecConversationSidebar from '../specs/SpecConversationSidebar.svelte'
  import TerminalPanel from '../terminal/TerminalPanel.svelte'
  import ProjectFilesPanel from '../files/ProjectFilesPanel.svelte'
  import DiffSidebarPanel from '../files/DiffSidebarPanel.svelte'
  import GitStatusPanel from '../git/GitStatusPanel.svelte'
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
  import ScopeActionsMenu from '../shared/ScopeActionsMenu.svelte'
  import ScopeCreateControl from '../shared/ScopeCreateControl.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
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
  import {
    contextSidebarState,
    type TemporaryChatContextTab
  } from '$lib/stores/context-sidebar.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import AgentDebugPanel from '$lib/components/debug/AgentDebugPanel.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { rendererRecovery, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import {
    threadSort,
    threadStatusSort,
    findEmptyNewThread,
    threadVisitKey
  } from '$lib/stores/workspace.svelte'
  import type { ThreadSortMode } from '$lib/stores/workspace.svelte'
  import { threadSortState } from '$lib/stores/thread-sort.svelte'
  import { scopeState, STAGE_LABELS, STAGE_COLORS, STAGE_ORDER } from '$lib/stores/scope.svelte'
  import { timelinePins } from '$lib/stores/timeline-pins.svelte'
  import { INBOX_PROJECT_ID, DEFAULT_THREAD_TITLE, DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
  import { APP_NAME } from '$shared/brand'
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
  import { updaterState } from '$lib/stores/updater.svelte'
  import { Download, CheckCircle2, Loader2, Clock, RefreshCw, AlertCircle } from '@lucide/svelte'

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

  let projects = $state<Project[]>([])
  let allThreads = $state<Thread[]>([])
  let loading = $state(true)
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
    return root.querySelector<HTMLElement>(`[data-thread-row="${threadId}"]`)
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

  function revealThreadInSidebar(threadId: string): void {
    const row = findThreadRow(threadId)
    row?.scrollIntoView({ block: 'nearest' })
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
  let sidebarRevealSuppressed = false
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
            projectSearchResults.set(projectId, results)
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

  function closeContextTab(id: string): void {
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === id)
    contextSidebarState.close(id)
    if (tab?.kind === 'temporary-chat') {
      void invoke('agent:closeTemporaryChat', tab.temporaryChatId)
    }
  }

  // ─── Derived ─────────────────────────────────────────────────────────────

  let pinnedThreads = $derived(
    allThreads
      .filter((t) => t.pinned && !t.archived && t.projectId !== INBOX_PROJECT_ID)
      .sort((a, b) => threadSort(a, b, draftThreadKeys))
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

  /** Pinned standalone chats (inbox project), sorted by activity. */
  let pinnedInboxThreads = $derived(
    allThreads
      .filter((t) => t.projectId === INBOX_PROJECT_ID && !t.archived && t.pinned)
      .sort((a, b) => threadSort(a, b, draftThreadKeys))
  )

  /** Non-pinned standalone chats (inbox project), working first then by activity. */
  let standaloneThreads = $derived(
    allThreads
      .filter((t) => t.projectId === INBOX_PROJECT_ID && !t.archived && !t.pinned)
      .sort((a, b) => threadSort(a, b, draftThreadKeys))
  )

  /** Threads mode: all non-archived threads sorted by the active sort mode, timeline-pinned first by default. */
  let allThreadsFlat = $derived.by(() => {
    const list = allThreads.filter((t) => !t.archived && t.projectId !== INBOX_PROJECT_ID)
    if (threadSortState.mode === 'status') {
      return list.sort((a, b) => threadStatusSort(a, b, draftThreadKeys))
    }
    return list.sort((a, b) => {
      if (threadSortState.mode === 'default') {
        const aPinned = timelinePins.isPinned(a.id)
        const bPinned = timelinePins.isPinned(b.id)
        if (aPinned !== bPinned) return aPinned ? -1 : 1
      }
      return b.lastActivity - a.lastActivity
    })
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
    const projectIds = [
      ...new Set(
        recentThreads
          .filter((thread) => thread.projectId !== INBOX_PROJECT_ID)
          .map((thread) => thread.projectId)
      )
    ]
    void ensureRecentScopeBoards(projectIds)
  })

  let pinnedTimelineThreads = $derived(allThreadsFlat.filter((t) => timelinePins.isPinned(t.id)))
  let unpinnedTimelineThreads = $derived(allThreadsFlat.filter((t) => !timelinePins.isPinned(t.id)))

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

  // Live thread updates pushed from the main process (status/read changes
  // during agent runs) — keeps the sidebar indicators in sync without polling.
  // Updates are applied immediately so a finished turn flips the status badge
  // to done/unread the moment the harness reports it, never after a debounce.
  $effect(() => {
    return subscribe('thread:updated', (...args: unknown[]) => {
      const updated = args[0] as Thread
      if (!allThreads.some((t) => t.id === updated.id)) return
      allThreads = allThreads.map((t) => (t.id === updated.id ? updated : t))
      scopeState.updateThread(updated)
      if (workspaceState.selectedThread?.id === updated.id) {
        workspaceState.updateThread(updated)
        if (!updated.read) {
          void invoke('thread:markRead', updated.projectId, updated.id)
        }
      }
    })
  })

  // Sync the selected thread's draft state to scope so draft-aware slicing works.
  // This MUST run before the pending-updates effect so scope's draftThreadId is
  // always current when stageForThread is evaluated.
  $effect(() => {
    const id = selectedThread?.id ?? null
    const hasDraft = selectedThreadHasDraft
    scopeState.setSelectedThreadDraftState(id, hasDraft)
    // Immediately switch the scope sidebar to 'todo' when draft promotion kicks in
    // for the thread the sidebar is currently showing.
    if (
      id &&
      hasDraft &&
      scopeState.sidebarContext?.threadId === id &&
      scopeState.sidebarContext.stage !== 'todo'
    ) {
      scopeState.sidebarContext = { ...scopeState.sidebarContext, stage: 'todo' }
    }
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

  // While a thread is selected, keep its row (and project) in focus in the
  // sidebar. Selection changes expand the owning folder and reset any scroll
  // suppression; list changes re-reveal the row if background activity pushed
  // it out of view.
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
      }
    }
    if (sidebarFocusSuppressed || sidebarRevealSuppressed) return
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
    const working = projectThreads.filter(
      (t) => t.status === 'planning' || t.status === 'executing'
    ).length
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
      allThreads = [newThread, ...allThreads]
    }
  })

  async function loadData(): Promise<void> {
    try {
      const [projectList, threadList] = await Promise.all([
        invoke('project:list'),
        invoke('thread:listAll')
      ])
      projects = projectList
      allThreads = threadList
      notificationPanelState.hydrateFromThreads(threadList)
      projectIcons.clear()
      for (const [projectId, iconUrl] of await loadProjectIcons(projectList)) {
        projectIcons.set(projectId, iconUrl)
      }
      scopeState.setScopesFromProjects(projectList, projectIcons)
      scopeState.setThreads(threadList)
      initExpandedFolders(projectList.filter((p) => !p.hidden))
      const saved = rendererRecovery.selectedThread
      const restoredThread = saved
        ? threadList.find(
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
        rendererRecovery.clearSelectedThread()
      }

      // Restore the last active project even without a thread
      if (rendererRecovery.selectedProjectId && !workspaceState.activeProject) {
        const project = projectList.find((p) => p.id === rendererRecovery.selectedProjectId) ?? null
        if (project) {
          workspaceState.activeProject = project
          workspaceState.activeProjectIconUrl = projectIcons.get(project.id) ?? null
        }
      }
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
        invoke('thread:listAll')
      ])
      projects = projectList
      allThreads = threadList
      notificationPanelState.hydrateFromThreads(threadList)
      projectIcons.clear()
      for (const [projectId, iconUrl] of await loadProjectIcons(projectList)) {
        projectIcons.set(projectId, iconUrl)
      }
      scopeState.setScopesFromProjects(projectList, projectIcons)
      scopeState.setThreads(threadList)
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
      await navigator.clipboard.writeText(project.path)
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
    const orderedIds = projects.filter((p) => !p.hidden).map((p) => p.id)
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
      .map((t) => t.id)
    const fromIdx = projectThreads.indexOf(draggedId)
    const toIdx = projectThreads.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) return

    projectThreads.splice(fromIdx, 1)
    const adjustedTo = projectThreads.indexOf(targetId)
    if (adjustedTo === -1) return
    projectThreads.splice(position === 'before' ? adjustedTo : adjustedTo + 1, 0, draggedId)

    const updated = await invoke('thread:reorder', projectId, projectThreads)
    for (const t of updated) {
      allThreads = allThreads.map((th) => (th.id === t.id ? t : th))
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
    allThreads = [thread, ...allThreads]
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
      allThreads = [thread, ...allThreads]
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
    const updated = await invoke('thread:markRead', thread.projectId, thread.id)
    allThreads = allThreads.map((t) => (t.id === updated.id ? updated : t))
    workspaceState.updateThread(updated)
    scopeState.updateThread(updated)
  }

  async function openThreadFromSwitcher(thread: Thread): Promise<void> {
    if (thread.projectId === INBOX_PROJECT_ID) navigate('chats')
    else if (mode === 'chats') navigate('projects')
    await openThread(thread)
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
    allThreads = allThreads.map((t) => (t.id === updated.id ? updated : t))
    workspaceState.updateThread(updated)
  }

  async function togglePin(thread: Thread): Promise<void> {
    const updated = await invoke('thread:setPinned', thread.projectId, thread.id, !thread.pinned)
    allThreads = allThreads.map((t) => (t.id === updated.id ? updated : t))
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
    allThreads = [forked, ...allThreads]
    scopeState.updateThread(forked)
    if (scopeState.sidebarContext?.projectId === forked.projectId) {
      scopeState.showSidebarForThread(forked, scopeState.sidebarContext.bucketId)
    }
    workspaceState.openThread(forked, projects.find((p) => p.id === forked.projectId) ?? null)
  }

  /** A message-level fork succeeded inside the thread view — surface and open it. */
  function handleForkedThread(forked: Thread): void {
    allThreads = [forked, ...allThreads]
    workspaceState.openThread(forked, projects.find((p) => p.id === forked.projectId) ?? null)
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
    allThreads = [converted, ...allThreads]
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
            <ThreadSearchControl
              threads={allThreads.filter((t) => t.projectId !== INBOX_PROJECT_ID)}
              contextLabel="threads"
              title="Search threads"
              onOpen={openThread}
              fts={{ filter: (t) => t.projectId !== INBOX_PROJECT_ID && !t.archived }}
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
          <div class="flex items-center gap-1 px-2 py-1.5">
            <button
              class="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="Open settings (⌘,)"
              onclick={() => navigate('settings')}
            >
              <Settings size={14} />
              Settings
            </button>

            <!-- Update indicator pill -->
            {#if updaterState.status.canAutoUpdate}
              {#if updaterState.status.state === 'checking'}
                <button
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-dimmed"
                  disabled
                  title="Checking for updates"
                >
                  <Loader2 size={12} class="animate-spin" />
                </button>
              {:else if updaterState.status.state === 'available'}
                <button
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-primary transition-colors hover:bg-elevated"
                  title="Update {updaterState.status
                    .availableVersion} available — click to download"
                  onclick={() => void updaterState.downloadUpdate()}
                >
                  <Download size={12} />
                </button>
              {:else if updaterState.status.state === 'downloading'}
                <button
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted"
                  disabled
                  title="Downloading… {updaterState.status.downloadProgress}%"
                >
                  <Loader2 size={12} class="animate-spin" />
                  <span class="tabular-nums">{updaterState.status.downloadProgress}%</span>
                </button>
              {:else if updaterState.status.state === 'downloaded'}
                <button
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-primary transition-colors hover:bg-elevated"
                  title="Update ready — click to restart and install"
                  onclick={() => void updaterState.installUpdate()}
                >
                  <RefreshCw size={12} />
                </button>
              {:else if updaterState.status.state === 'waiting'}
                <button
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-accent"
                  disabled
                  title="Waiting for {updaterState.waitingForThreads} active thread{updaterState.waitingForThreads !==
                  1
                    ? 's'
                    : ''} to finish"
                >
                  <Clock size={12} />
                </button>
              {:else if updaterState.status.state === 'error'}
                <button
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-danger"
                  title="Update error: {updaterState.status.errorMessage}"
                  onclick={() => navigate('settings')}
                >
                  <AlertCircle size={12} />
                </button>
              {:else}
                <button
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-dimmed"
                  title="Up to date"
                  onclick={() => navigate('settings')}
                >
                  <CheckCircle2 size={12} />
                </button>
              {/if}
            {/if}
          </div>
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
                    pinnedOverride={true}
                    onOpen={openThread}
                    onRename={handleRename}
                    onTogglePin={() => timelinePins.toggle(thread.id)}
                    onDelete={handleDelete}
                    onFork={forkThread}
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
                pinnedOverride={timelinePins.isPinned(thread.id)}
                onOpen={openThread}
                onRename={handleRename}
                onTogglePin={() => timelinePins.toggle(thread.id)}
                onDelete={handleDelete}
                onFork={forkThread}
              />
            {:else}
              <div class="flex flex-col items-center gap-2 px-2 py-10 text-center">
                <p class="text-xs text-muted">No threads yet</p>
              </div>
            {/each}
          </div>
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
              handleThreadMove(projectId, draggedId, targetId, pos, true)}
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
                  {@const working = folderThreads.some(
                    (t) => t.status === 'planning' || t.status === 'executing'
                  )}
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
                            <ProjectSearchDropdown
                              projectId={project.id}
                              projectName={project.name}
                              open={projectSearchOpen.has(project.id)}
                              query={projectSearchQueries.get(project.id) ?? ''}
                              onOpenChange={(open) => {
                                if (open) openProjectSearch(project.id)
                                else closeProjectSearch(project.id)
                              }}
                              onQueryChange={(id, value) => {
                                projectSearchQueries.set(id, value)
                                runProjectSearch(id, value)
                              }}
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
                {@const working = folderThreads.some(
                  (t) => t.status === 'planning' || t.status === 'executing'
                )}
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
                          <ProjectSearchDropdown
                            projectId={project.id}
                            projectName={project.name}
                            open={projectSearchOpen.has(project.id)}
                            query={projectSearchQueries.get(project.id) ?? ''}
                            onOpenChange={(open) => {
                              if (open) openProjectSearch(project.id)
                              else closeProjectSearch(project.id)
                            }}
                            onQueryChange={(id, value) => {
                              projectSearchQueries.set(id, value)
                              runProjectSearch(id, value)
                            }}
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
  <section class="min-w-0 flex-1 overflow-hidden">
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
                    harnessId={chatComposerSettings.harnessId}
                    favoriteModels={rendererRecovery.chatFavoriteModels}
                    onToggleFavorite={(providerId, modelId) =>
                      rendererRecovery.toggleChatFavorite(`${providerId}:${modelId}`)}
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
                <GitStatusPanel
                  projectId={activeContextTab.projectId}
                  threadId={activeContextTab.threadId}
                />
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
          />
        </div>
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
