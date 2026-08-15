<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { toast } from 'svelte-sonner'
  import { projectIconOnError, getProjectIcon } from '$lib/project-icons'
  import { settingsUiState } from '$lib/stores/settings-ui.svelte'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { memoryProposalState } from '$lib/stores/memory-proposals.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { effectiveThreadTitle } from '$lib/stores/draft-label'
  import {
    rendererRecovery,
    isSettingsView,
    type MainView
  } from '$lib/stores/renderer-recovery.svelte'
  import ProjectCreateControl from '$lib/components/shared/ProjectCreateControl.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import ScopeCreateControl from '$lib/components/shared/ScopeCreateControl.svelte'
  import ThreadSearchControl from '$lib/components/shared/ThreadSearchControl.svelte'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import type { EditorId, Project, Thread } from '$shared/types'
  import {
    AppWindow,
    Archive,
    Bell,
    Bug,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    FileText,
    FolderKanban,
    GitBranch,
    GitFork,
    GitMergeConflict,
    GitPullRequest,
    History,
    Info,
    Kanban,
    MessageSquare,
    SquareDashedKanban,
    Loader2,
    Pencil,
    Pin,
    PinOff,
    PanelRight,
    SquareTerminal,
    Timeline,
    Trash2,
    X,
    BrainCircuit
  } from '@lucide/svelte'
  import ThreadDropdown from '$lib/components/shared/ThreadDropdown.svelte'
  import ChangeScopeModal from '$lib/components/threads/ChangeScopeModal.svelte'
  import ScopeBadge from '$lib/components/shared/ScopeBadge.svelte'
  import ProjectInfoDropdown from '$lib/components/shared/ProjectInfoDropdown.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import { DropdownMenu } from 'bits-ui'
  import { navigationHistoryState } from '$lib/stores/navigation-history.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import { hasProjectNameCollision, projectIdentityTitle } from '$lib/project-location'
  import {
    coordinatorHasActiveDelegates,
    DEFAULT_SCOPE_BUCKET_ID,
    INBOX_PROJECT_ID,
    isOrchestrationChildThread,
    isThreadWorking,
    type ScopeBucket
  } from '$shared/types'
  import { tick, type Component } from 'svelte'

  type View = MainView

  type ProjectViewMode = 'projects' | 'scope' | 'threads'

  interface Props {
    activeView: View
    navigate: (view: View) => void
    goBack: () => void
    goForward: () => void
    onProjectCreated?: (project: Project) => void | Promise<void>
    onScopeThreadOpen?: (thread: Thread) => void | Promise<void>
  }

  let {
    activeView,
    navigate,
    goBack,
    goForward,
    onProjectCreated = () => undefined,
    onScopeThreadOpen = () => undefined
  }: Props = $props()

  /** The three ways to view the project workspace — Projects, Scope, Threads. */
  const projectViewOptions: Array<{ id: ProjectViewMode; label: string; icon: Component }> = [
    { id: 'projects', label: 'Projects', icon: FolderKanban },
    { id: 'scope', label: 'Scope', icon: Kanban },
    { id: 'threads', label: 'Threads', icon: Timeline }
  ]

  /**
   * The project view the header's composite button represents: the active
   * view while the app is in one of the project views, otherwise the last
   * project view visited (so the button survives trips to Chats or Settings).
   */
  const projectViewMode = $derived(
    activeView === 'scope' || activeView === 'threads' || activeView === 'projects'
      ? activeView
      : navigationHistoryState.lastProjectView
  )

  /** True while the app is actually in the represented project view. */
  let projectViewActive = $derived(projectViewMode === activeView)

  /** True while any project thread is actively being worked on. */
  let anyProjectWorking = $derived(
    scopeState.allScopeThreads.some(
      (t) =>
        !t.archived &&
        t.projectId !== INBOX_PROJECT_ID &&
        (t.status === 'planning' || t.status === 'executing')
    )
  )

  /** True while any standalone chat is actively being worked on. */
  let anyChatWorking = $derived(
    scopeState.allScopeThreads.some(
      (t) =>
        !t.archived &&
        t.projectId === INBOX_PROJECT_ID &&
        (t.status === 'planning' || t.status === 'executing')
    )
  )

  let projectViewMenuOpen = $state(false)

  /** Switch the project view via the header dropdown. No-op when already there. */
  function selectProjectView(view: ProjectViewMode): void {
    projectViewMenuOpen = false
    if (view === 'projects') {
      if (activeView !== 'projects') void onPrimaryNavClick('projects')
    } else if (activeView !== view) {
      navigate(view)
    }
  }

  const viewLabels: Record<string, string> = {
    projects: 'Projects',
    chats: 'Chats',
    'settings-harnesses': 'Harnesses',
    'settings-profile': 'Profile',
    remote: 'Remote',
    settings: 'Settings',
    scope: 'Scope',
    threads: 'Threads'
  }

  /** Settings takes over the header — no thread title or thread controls. */
  let onSettings = $derived(isSettingsView(activeView))

  let onScope = $derived(activeView === 'scope')

  /** Chats must feel like chat — no editor, spec, or terminal controls. */
  let chatMode = $derived(activeView === 'chats')

  /** Git controls and polling exist only for local projects configured for Git tracking. */
  let gitAvailable = $derived.by(() => {
    const thread = workspaceState.selectedThread
    const project = workspaceState.activeProject
    return Boolean(
      thread &&
      project &&
      thread.projectId === project.id &&
      project.id !== INBOX_PROJECT_ID &&
      project.source === 'local' &&
      project.path.trim() &&
      project.changeTrackingMode === 'git'
    )
  })

  /** "Settings · <Section>" while a settings tab is on screen. */
  let settingsTitle = $derived(
    settingsUiState.activeTabLabel ? `Settings · ${settingsUiState.activeTabLabel}` : 'Settings'
  )

  async function switchProject(projectId: string): Promise<void> {
    const project = scopeState.projectRecords.find((p) => p.id === projectId) ?? null
    if (!project) return

    const scopeProject = scopeState.projects.find((p) => p.id === projectId)

    const allThreads: Thread[] = await invoke('thread:listAll')
    const projectThreads = allThreads
      .filter((t) => t.projectId === projectId && !t.archived)
      .filter((t) => !isOrchestrationChildThread(t))
      .sort((a, b) => b.lastActivity - a.lastActivity)

    const activeThread = projectThreads[0] ?? null

    if (activeThread) {
      workspaceState.openThread(activeThread, project, scopeProject?.iconUrl ?? null)
    } else {
      workspaceState.clearThread()
      workspaceState.activeProject = project
      workspaceState.activeProjectIconUrl = scopeProject?.iconUrl ?? null
      rendererRecovery.setSelectedProject(projectId)
    }

    scopeState.clearSidebarContext()
    await scopeState.activateProject(projectId)
  }

  /** Keep the header and project registry in sync after a pin toggle. */
  function handleProjectPinToggled(updated: Project): void {
    workspaceState.activeProject = updated
    scopeState.projectRecords = scopeState.projectRecords.map((record) =>
      record.id === updated.id ? updated : record
    )
  }

  /** Find a thread by ID across all projects and open it, restoring the
   *  project context.  No-op if the thread no longer exists. */
  async function restoreThread(threadId: string): Promise<void> {
    const allThreads: Thread[] = await invoke('thread:listAll')
    const thread = allThreads.find((t) => t.id === threadId)
    if (!thread) return
    const projects: Project[] = await invoke('project:list')
    const project = projects.find((p) => p.id === thread.projectId) ?? null
    workspaceState.openThread(thread, project)
    void scopeState.ensureBoardLoaded(thread.projectId)
  }

  async function onPrimaryNavClick(
    view: 'projects' | 'chats' | 'scope' | 'threads'
  ): Promise<void> {
    if (view === 'threads') {
      scopeState.clearSidebarContext()
    } else if (view === 'chats') {
      // Remember the current project thread before switching to chats
      scopeState.stashedProjectThreadId = workspaceState.selectedThread?.id ?? null
      if (scopeState.sidebarContext) {
        scopeState.stashSidebarContext()
      }
      // Restore the last chat thread, or clear selection so the composer shows
      if (scopeState.stashedChatThreadId) {
        void restoreThread(scopeState.stashedChatThreadId)
      } else {
        workspaceState.clearThread()
      }
    } else if (view === 'projects' && activeView === 'chats') {
      // Coming from chats — remember the chat thread and restore the project thread
      scopeState.stashedChatThreadId = workspaceState.selectedThread?.id ?? null
      if (scopeState.stashedProjectThreadId) {
        void restoreThread(scopeState.stashedProjectThreadId)
      }
    } else if (view === 'projects' && activeView === 'scope') {
      scopeState.clearSidebarContext()
    }
    if (view === 'scope') {
      if (activeView === 'scope') {
        navigate('projects')
      } else {
        const projectId =
          workspaceState.selectedThread?.projectId ?? workspaceState.activeProject?.id
        if (projectId) await scopeState.activateProject(projectId)
        scopeState.clearSidebarContext()
        navigate('scope')
      }
    } else if (view === activeView) {
      sidebarState.toggle()
    } else {
      navigate(view)
    }
  }

  function openScopeThread(thread: Thread): void {
    scopeState.showSidebarForThread(thread)
    void onScopeThreadOpen(thread)
  }

  async function toggleProjectScopeState(): Promise<void> {
    if (activeView !== 'projects') {
      // Coming back from another view — try restoring a stashed context first.
      if (scopeState.stashedSidebarContext) {
        // Remember the current chat thread before switching away
        scopeState.stashedChatThreadId = workspaceState.selectedThread?.id ?? null
        navigate('projects')
        scopeState.restoreStashedSidebarContext()
        // Restore the project thread we were on before switching to chats
        if (scopeState.stashedProjectThreadId) {
          void restoreThread(scopeState.stashedProjectThreadId)
        }
        return
      }
      if (activeView === 'scope') {
        scopeState.clearSidebarContext()
      }
      navigate('projects')
    }

    // If we came back from chats via the Projects nav and the scope sidebar
    // was stashed, restore it now instead of building a fresh context.
    if (scopeState.stashedSidebarContext) {
      scopeState.restoreStashedSidebarContext()
      if (scopeState.stashedProjectThreadId) {
        void restoreThread(scopeState.stashedProjectThreadId)
      }
      return
    }

    const project = workspaceState.activeProject
    if (!project) {
      if (scopeState.sidebarContext) scopeState.clearSidebarContext()
      return
    }

    if (scopeState.sidebarContext) {
      scopeState.clearSidebarContext()
      return
    }

    const thread = workspaceState.selectedThread
    const targetProjectId = thread?.projectId ?? project.id

    const allThreads: Thread[] = await invoke('thread:listAll')
    scopeState.setThreads(allThreads)
    await scopeState.activateProject(targetProjectId)

    if (thread) {
      scopeState.showSidebarForThread(thread)
    } else {
      scopeState.showSidebarForProject(targetProjectId)
    }
  }

  let showHistory = $state(false)

  function jumpTo(id: string): void {
    showHistory = false
    workspaceState.jumpToMessage?.(id)
  }

  function toggleMemory(): void {
    const thread = workspaceState.selectedThread
    if (!thread) return
    showHistory = false
    if (contextSidebarState.visible && contextSidebarState.sidebarActiveTab?.kind === 'memory') {
      contextSidebarState.hide()
      return
    }
    contextSidebarState.openMemory(thread.projectId, thread.id)
  }

  /** Toggle the Sources panel for the selected thread (chat mode header button). */
  function toggleSources(): void {
    const thread = workspaceState.selectedThread
    if (!thread) return
    showHistory = false
    if (contextSidebarState.visible && contextSidebarState.sidebarActiveTab?.kind === 'sources') {
      contextSidebarState.hide()
      return
    }
    contextSidebarState.openSources(thread.projectId, thread.id)
  }

  /** Toggle the agent debugger panel — dev-only. */
  function toggleDebugger(): void {
    if (!import.meta.env.DEV) return
    const thread = workspaceState.selectedThread
    if (!thread) return
    showHistory = false
    if (contextSidebarState.visible && contextSidebarState.sidebarActiveTab?.kind === 'debugger') {
      contextSidebarState.hide()
      return
    }
    contextSidebarState.openDebugger(thread.projectId, thread.id)
  }

  $effect(() => {
    memoryProposalState.setContext(workspaceState.selectedThread?.projectId ?? null)
  })

  // ─── Editor preference ───────────────────────────────────────────────

  let showEditorMenu = $state(false)

  /** Only editors actually installed on this machine are offered. */
  let availableEditors = $derived(editorPreference.availableEditors)

  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'System Default')

  let preferredIcon = $derived(editorPreference.preferredInfo?.iconDataUrl)

  async function openProjectInEditor(): Promise<void> {
    const project = workspaceState.activeProject
    if (project?.id) {
      await invoke('project:openInEditor', project.id)
    }
  }

  async function selectEditor(id: EditorId): Promise<void> {
    showEditorMenu = false
    if (id === editorPreference.preferredEditor) return
    await editorPreference.select(id)
    await openProjectInEditor()
  }

  void editorPreference.load()

  let contextSidebarOpen = $derived(
    Boolean(workspaceState.selectedThread && contextSidebarState.visible)
  )

  /** True while the sources panel is the active sidebar tab. */
  let sourcesOpen = $derived(
    Boolean(
      workspaceState.selectedThread &&
      contextSidebarState.visible &&
      contextSidebarState.sidebarActiveTab?.kind === 'sources'
    )
  )

  /** True while the agent debugger is the active sidebar tab. */
  let debuggerOpen = $derived(
    Boolean(
      import.meta.env.DEV &&
      workspaceState.selectedThread &&
      contextSidebarState.visible &&
      contextSidebarState.sidebarActiveTab?.kind === 'debugger'
    )
  )

  /** Whether the terminal area is currently visible (dock at the bottom, or a
   * focused terminal tab inside the sidebar when not docked). */
  let terminalOpen = $derived(
    contextSidebarState.terminalPlacement === 'bottom'
      ? contextSidebarState.terminalDockVisible
      : Boolean(contextSidebarState.visible && contextSidebarState.activeTab?.kind === 'terminal')
  )

  function openTerminal(): void {
    const thread = workspaceState.selectedThread
    if (!thread) return
    const tab = contextSidebarState.activeTab
    const terminalActive =
      tab?.kind === 'terminal' && tab.projectId === thread.projectId && tab.threadId === thread.id

    if (contextSidebarState.terminalPlacement === 'bottom') {
      // Terminal lives in its own bottom dock — the button toggles just the
      // dock; the right sidebar is never affected.
      if (terminalActive && contextSidebarState.terminalDockVisible) {
        contextSidebarState.toggleTerminalDock()
      } else {
        contextSidebarState.openPrimaryTerminal(thread.projectId, thread.id)
      }
      return
    }

    // Terminal lives in the sidebar — toggle the whole context panel.
    if (contextSidebarState.visible && terminalActive) {
      contextSidebarState.hide()
    } else {
      contextSidebarState.openPrimaryTerminal(thread.projectId, thread.id)
    }
  }

  function toggleContextSidebar(): void {
    if (!workspaceState.selectedThread) return
    contextSidebarState.toggle()
  }

  // ─── Git status chip ─────────────────────────────────────────────────────

  /** Refresh git status whenever the active thread's project changes. */
  $effect(() => {
    const thread = workspaceState.selectedThread
    if (!thread || !gitAvailable) {
      gitState.deactivate()
      return
    }
    // Activation + refresh are event-driven by the workspace store
    // (`notifyThreadOpened` on every thread open) — this effect only subscribes
    // to agent checkpoints for the active project.
    gitState.ensureProjectEvents(thread.projectId)
  })

  function openGitPanel(): void {
    const thread = workspaceState.selectedThread
    if (!thread || !gitAvailable) return
    if (contextSidebarState.visible && contextSidebarState.sidebarActiveTab?.kind === 'git') {
      contextSidebarState.hide()
    } else {
      contextSidebarState.openGit(thread.projectId, thread.id)
    }
  }

  // ─── Thread actions (ellipsis dropdown) ──────────────────────────────────

  let showThreadRename = $state(false)
  let threadRenameValue = $state('')

  let showThreadDeleteConfirm = $state(false)
  /** Delete button inside the confirm modal — focused on open so Enter deletes. */
  let deleteConfirmButton = $state<HTMLButtonElement>()

  $effect(() => {
    if (!showThreadDeleteConfirm) return
    void tick().then(() => deleteConfirmButton?.focus())
  })

  /** Cmd/Ctrl+D deletes the actively opened thread through the normal confirm
   *  flow; Escape cancels the confirm while it is open. */
  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && showThreadDeleteConfirm) {
      event.preventDefault()
      showThreadDeleteConfirm = false
      return
    }
    if (event.repeat || event.isComposing) return
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'd') return
    if (event.altKey || event.shiftKey) return
    if (!workspaceState.selectedThread) return
    event.preventDefault()
    showThreadDeleteConfirm = true
  }

  let showChangeScope = $state(false)

  /** Title shown in the header — real title once generated, else a draft label. */
  let headerThreadTitle = $derived(
    workspaceState.selectedThread ? effectiveThreadTitle(workspaceState.selectedThread) : ''
  )

  let scopeBucket = $derived.by((): ScopeBucket | null => {
    const thread = workspaceState.selectedThread
    if (!thread || chatMode) return null
    const bucketId = thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    return (
      scopeState.bucketFor(thread.projectId, bucketId) ??
      scopeState.bucketFor(thread.projectId, DEFAULT_SCOPE_BUCKET_ID) ?? {
        id: DEFAULT_SCOPE_BUCKET_ID,
        name: 'Default',
        sortOrder: 0,
        collapsed: false,
        collapsedSlices: []
      }
    )
  })

  /**
   * Always resolve the scope board for the open thread's project so the scope
   * badge renders on mount and on every thread change, regardless of whether
   * the scope sidebar or scope view was ever opened for that project.
   */
  $effect(() => {
    const thread = workspaceState.selectedThread
    if (!thread || chatMode || thread.projectId === INBOX_PROJECT_ID) return
    void scopeState.ensureBoardLoaded(thread.projectId)
  })

  async function toggleThreadPin(): Promise<void> {
    const thread = workspaceState.selectedThread
    if (!thread) return
    const updated = await invoke('thread:setPinned', thread.projectId, thread.id, !thread.pinned)
    workspaceState.updateThread(updated)
    if (scopeState.allScopeThreads.some((t) => t.id === updated.id)) {
      scopeState.updateThread(updated)
    }
  }

  async function forkThread(): Promise<void> {
    const thread = workspaceState.selectedThread
    if (!thread) return
    const project = workspaceState.activeProject
    const forked = await invoke(
      'thread:fork',
      thread.projectId,
      thread.id,
      `${thread.title} (fork)`
    )
    workspaceState.openThread(forked, project)
    scopeState.updateThread(forked)
  }

  async function confirmThreadRename(e?: SubmitEvent): Promise<void> {
    e?.preventDefault()
    const thread = workspaceState.selectedThread
    if (!thread || !threadRenameValue.trim()) return
    const updated = await invoke('thread:update', thread.projectId, thread.id, {
      title: threadRenameValue.trim(),
      titleSource: 'manual'
    })
    workspaceState.updateThread(updated)
    scopeState.updateThread(updated)
    showThreadRename = false
  }

  async function confirmThreadDelete(): Promise<void> {
    const thread = workspaceState.selectedThread
    if (!thread) return
    try {
      await invoke('thread:delete', thread.projectId, thread.id)
      workspaceState.clearThread()
      scopeState.removeThread(thread.id)
      showThreadDeleteConfirm = false
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete thread')
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<header
  class="app-header titlebar-drag relative z-40 flex h-12 items-center border-b bg-surface pr-4"
  style={trafficLightInsetStyle()}
>
  <nav class="titlebar-no-drag flex shrink-0 items-center gap-1" aria-label="Primary navigation">
    <!-- Global navigation: back / forward -->
    <div class="flex items-center gap-0.5">
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        aria-label="Go back"
        title="Go back"
        disabled={!navigationHistoryState.canGoBack}
        onclick={goBack}
      >
        <ChevronLeft size={16} strokeWidth={1.8} />
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        aria-label="Go forward"
        title="Go forward"
        disabled={!navigationHistoryState.canGoForward}
        onclick={goForward}
      >
        <ChevronRight size={16} strokeWidth={1.8} />
      </button>
    </div>

    <!-- Project view group: active project view button + view switcher dropdown -->
    <div class="relative">
      <div
        class="flex h-7 items-center overflow-hidden rounded-md transition-colors duration-150 {projectViewActive
          ? 'bg-foreground text-app'
          : ''} {projectViewActive && projectViewMode !== 'scope' && sidebarState.collapsed
          ? 'opacity-60'
          : ''}"
      >
        {#if projectViewMode === 'scope'}
          <button
            class="flex h-full items-center gap-1.5 px-2.5 transition-colors duration-150 {projectViewActive
              ? 'text-app'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-label={projectViewActive ? 'Exit scope view' : 'Open scope view'}
            title="Scope"
            onclick={() => void onPrimaryNavClick('scope')}
          >
            <Kanban size={14} strokeWidth={1.8} class={anyProjectWorking ? 'animate-pulse' : ''} />
            <span class="header-control-label text-[11px] font-medium">Scope</span>
          </button>
        {:else if projectViewMode === 'threads'}
          <button
            class="flex h-full items-center gap-1.5 px-2.5 transition-colors duration-150 {projectViewActive
              ? 'text-app'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-label={projectViewActive
              ? sidebarState.collapsed
                ? 'Show Threads sidebar'
                : 'Hide Threads sidebar'
              : 'Open Threads'}
            title="Threads"
            onclick={() => void onPrimaryNavClick('threads')}
          >
            <Timeline
              size={14}
              strokeWidth={1.8}
              class={anyProjectWorking ? 'animate-pulse' : ''}
            />
            <span class="header-control-label text-[11px] font-medium">Threads</span>
          </button>
        {:else}
          <button
            class="flex h-full items-center gap-1.5 px-2.5 transition-colors duration-150 {projectViewActive
              ? 'text-app'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-label={projectViewActive
              ? sidebarState.collapsed
                ? 'Show Projects sidebar'
                : 'Hide Projects sidebar'
              : 'Open Projects'}
            title="Projects"
            onclick={() => void onPrimaryNavClick('projects')}
          >
            <FolderKanban
              size={14}
              strokeWidth={1.8}
              class={anyProjectWorking ? 'animate-pulse' : ''}
            />
            <span class="header-control-label text-[11px] font-medium">Projects</span>
          </button>
          <div class="mx-0.5 h-4 w-px bg-border/40" aria-hidden="true"></div>
          <button
            class="flex h-full items-center px-1.5 transition-colors duration-150 {projectViewActive
              ? 'text-app'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-label={scopeState.sidebarContext ? 'Exit scope state' : 'Show scope state'}
            title="Scope state"
            onclick={() => void toggleProjectScopeState()}
          >
            <SquareDashedKanban size={14} strokeWidth={1.8} />
          </button>
        {/if}
        <div class="mx-0.5 h-4 w-px bg-border/40" aria-hidden="true"></div>
        <DropdownMenu.Root bind:open={projectViewMenuOpen}>
          <DropdownMenu.Trigger
            class="flex h-full items-center px-1 transition-colors duration-150 {projectViewActive
              ? 'text-app'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-label="Switch project view"
            title="Switch project view"
          >
            <ChevronDown size={13} strokeWidth={1.8} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="start"
              sideOffset={6}
              collisionPadding={8}
              class="z-50 w-44 overflow-hidden rounded-md border bg-surface p-1 shadow-lg"
            >
              {#each projectViewOptions as option (option.id)}
                {@const Icon = option.icon}
                {@const isSelected = projectViewMode === option.id}
                <DropdownMenu.Item
                  class={[
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors',
                    isSelected
                      ? 'text-foreground'
                      : 'text-muted hover:bg-elevated focus:bg-elevated'
                  ]}
                  onSelect={() => selectProjectView(option.id)}
                >
                  <Icon size={14} strokeWidth={1.8} class="shrink-0 text-muted" />
                  <span class="flex-1 truncate">{option.label}</span>
                  {#if isSelected}
                    <Check size={14} class="text-primary" />
                  {/if}
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>

    <!-- Chats — standalone group, distinct from the project views. -->
    <button
      class="flex h-7 items-center gap-1.5 rounded-md px-2.5 transition-colors duration-150 {activeView ===
      'chats'
        ? 'bg-foreground text-app'
        : 'text-muted hover:bg-elevated hover:text-foreground'} {activeView === 'chats' &&
      sidebarState.collapsed
        ? 'opacity-60'
        : ''}"
      aria-label={activeView === 'chats'
        ? sidebarState.collapsed
          ? 'Show Chats sidebar'
          : 'Hide Chats sidebar'
        : 'Open Chats'}
      title="Chats"
      onclick={() => void onPrimaryNavClick('chats')}
    >
      <MessageSquare size={14} strokeWidth={1.8} class={anyChatWorking ? 'animate-pulse' : ''} />
      <span class="header-control-label text-[11px] font-medium">Chats</span>
    </button>
  </nav>

  <!-- Scope view header area — separator, scrollable tabs, sticky tools -->
  {#if onScope}
    <div class="titlebar-no-drag flex min-w-0 flex-1 items-center self-stretch pl-3">
      <!-- Visual separator between nav buttons and scope tabs -->
      <div class="mr-2 h-5 w-px shrink-0 bg-border/50" aria-hidden="true"></div>

      <div
        class="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
        style="scrollbar-width: thin"
        role="tablist"
        aria-label="Project tabs"
        tabindex="0"
      >
        <div class="ml-auto flex h-full w-max items-center gap-0.5">
          {#each scopeState.projects as project (project.id)}
            <button
              class="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-3 py-1 text-xs transition-colors {scopeState.activeProjectId ===
              project.id
                ? 'bg-elevated font-medium text-foreground'
                : 'text-muted hover:bg-elevated hover:text-foreground'}"
              role="tab"
              aria-selected={scopeState.activeProjectId === project.id}
              title={projectIdentityTitle(project)}
              onclick={() => void switchProject(project.id)}
            >
              {#if project.color}
                <span class="h-2 w-2 rounded-full" style="background: {project.color}"></span>
              {/if}
              {#if project.iconUrl}
                <img
                  src={project.iconUrl}
                  alt=""
                  class="h-4 w-4 shrink-0 rounded object-contain"
                  onerror={projectIconOnError(project)}
                />
              {/if}
              <ProjectIdentity
                {project}
                class="max-w-36 text-left"
                nameClass="text-xs font-medium"
                locationClass="text-[9px] text-dimmed"
                showLocation={hasProjectNameCollision(project, scopeState.projects)}
              />
            </button>
          {/each}
        </div>
      </div>

      <div class="ml-2 flex shrink-0 items-center gap-0.5 bg-surface">
        <ProjectCreateControl
          projects={scopeState.projectRecords}
          {onProjectCreated}
          onExisting={(project) => switchProject(project.id)}
          title="Add project"
        />
        <ThreadSearchControl
          threads={scopeState.currentProjectThreads}
          contextLabel="threads in this project"
          title="Search threads in this project"
          onOpen={openScopeThread}
          fts={{ projectId: scopeState.activeProjectId ?? undefined }}
        />
        <ScopeCreateControl title="New scope" />
      </div>
    </div>
  {:else}
    <div class="flex min-w-0 flex-1 items-center justify-center px-2">
      {#if onSettings}
        <div class="pointer-events-none">
          <h1 class="text-[11px] font-semibold uppercase tracking-[0.16em] text-dimmed">
            {settingsTitle}
          </h1>
        </div>
      {:else if workspaceState.selectedThread}
        {@const thread = workspaceState.selectedThread}
        {@const isWorking =
          workspaceState.specStudioFormulating ||
          isThreadWorking(thread) ||
          coordinatorHasActiveDelegates(thread, scopeState.allScopeThreads)}
        <div class="titlebar-no-drag relative flex min-w-0 max-w-full items-center gap-2">
          {#if !chatMode && thread.projectId !== INBOX_PROJECT_ID}
            {@const headerProject =
              workspaceState.activeProject ??
              scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ??
              null}
            {#if headerProject}
              {@const resolvedProjectIcon = getProjectIcon(
                headerProject,
                workspaceState.activeProjectIconUrl ?? undefined
              )}
              {#if resolvedProjectIcon}
                <div class="pointer-events-auto shrink-0">
                  <ProjectInfoDropdown
                    project={headerProject}
                    iconUrl={resolvedProjectIcon}
                    branch={thread.branch ?? null}
                    class="group/icon relative h-5 w-5"
                    onPinToggled={handleProjectPinToggled}
                    onEdit={(projectId) => workspaceState.openProjectEdit(projectId)}
                    onError={(message) => toast.error(message)}
                  >
                    <img
                      src={resolvedProjectIcon}
                      alt=""
                      class="h-4 w-4 object-contain"
                      onerror={projectIconOnError(headerProject)}
                    />
                  </ProjectInfoDropdown>
                </div>
              {/if}
            {/if}
          {/if}
          <div class="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <h1
              class="truncate text-[13px] font-medium tracking-tight text-foreground"
              title={headerThreadTitle}
            >
              {headerThreadTitle}
            </h1>
            <ThreadDropdown
              items={[
                {
                  label: 'Rename',
                  icon: Pencil,
                  onClick: () => {
                    threadRenameValue = thread.title
                    showThreadRename = true
                  }
                },
                {
                  label: thread.pinned ? 'Unpin' : 'Pin',
                  icon: thread.pinned ? PinOff : Pin,
                  onClick: () => void toggleThreadPin()
                },
                {
                  label: 'Fork',
                  icon: GitFork,
                  onClick: () => void forkThread()
                },
                {
                  label: 'Change Scope',
                  icon: Kanban,
                  onClick: () => {
                    const thread = workspaceState.selectedThread
                    if (thread) void scopeState.ensureBoardLoaded(thread.projectId)
                    showChangeScope = true
                  }
                },
                { label: '', divider: true },
                {
                  label: 'Delete',
                  icon: Trash2,
                  onClick: () => {
                    showThreadDeleteConfirm = true
                  },
                  danger: true
                }
              ]}
              onOpen={() => {}}
            />
            {#if isWorking}
              <span
                class="flex shrink-0 items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[10px] text-info"
              >
                <Loader2 size={10} class="animate-spin" />
                <span class="header-status-label">
                  {workspaceState.specStudioFormulating ? 'Formulating…' : 'Working'}
                </span>
              </span>
            {/if}
          </div>
          {#if scopeBucket && !workspaceState.specStudioOpen}
            <div
              class="titlebar-no-drag absolute left-1/2 top-full mt-0.75 -translate-x-1/2 whitespace-nowrap"
            >
              <button
                class="cursor-pointer"
                title="Show scope view for {scopeBucket.name}"
                aria-label="Show scope view for {scopeBucket.name}"
                onclick={async () => {
                  if (activeView !== 'projects') {
                    navigate('projects')
                  }
                  const allThreads: Thread[] = await invoke('thread:listAll')
                  scopeState.setThreads(allThreads)
                  await scopeState.activateProject(thread.projectId)
                  scopeState.showSidebarForThread(thread)
                  const project =
                    scopeState.projectRecords.find(
                      (candidate) => candidate.id === thread.projectId
                    ) ?? null
                  workspaceState.openThread(thread, project)
                  void scopeState.ensureBoardLoaded(thread.projectId)
                }}
              >
                <ScopeBadge bucket={scopeBucket} size="xs" />
              </button>
            </div>
          {/if}
        </div>
      {:else}
        <div class="pointer-events-none">
          <h1 class="text-[11px] font-semibold uppercase tracking-[0.16em] text-dimmed">
            {viewLabels[activeView]}
          </h1>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Thread Rename Modal -->
  {#if showThreadRename}
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <button
        class="absolute inset-0 bg-black/13"
        aria-label="Close"
        onclick={() => (showThreadRename = false)}
      ></button>
      <div class="relative w-full max-w-md border bg-surface p-6 shadow-xl">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold">Rename Thread</h2>
          <button
            class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Close"
            title="Close"
            onclick={() => (showThreadRename = false)}
          >
            <X size={16} />
          </button>
        </div>
        <form class="space-y-4" onsubmit={(e: SubmitEvent) => void confirmThreadRename(e)}>
          <div>
            <label class="mb-1 block text-xs font-medium text-muted" for="rename-input">Title</label
            >
            <input
              id="rename-input"
              type="text"
              class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
              bind:value={threadRenameValue}
            />
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button
              type="button"
              class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
              title="Cancel"
              onclick={() => (showThreadRename = false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
              disabled={!threadRenameValue.trim()}
              title="Save the new title"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}

  <!-- Thread Delete Confirmation -->
  {#if showThreadDeleteConfirm}
    {@const thread = workspaceState.selectedThread}
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <button
        class="absolute inset-0 bg-black/13"
        aria-label="Close"
        onclick={() => (showThreadDeleteConfirm = false)}
      ></button>
      <div class="relative w-full max-w-md border bg-surface p-6 shadow-xl">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold">Delete Thread</h2>
          <button
            class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Close"
            title="Close"
            onclick={() => (showThreadDeleteConfirm = false)}
          >
            <X size={16} />
          </button>
        </div>
        <p class="text-sm leading-relaxed text-muted">
          This will permanently delete
          <span class="font-medium text-foreground">{thread?.title}</span>
          and all of its history. This action cannot be undone.
        </p>
        <div class="flex justify-end gap-2 pt-4">
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
            title="Cancel"
            onclick={() => (showThreadDeleteConfirm = false)}
          >
            Cancel
          </button>
          <button
            bind:this={deleteConfirmButton}
            type="button"
            class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90"
            title="Permanently delete this thread"
            onclick={() => void confirmThreadDelete()}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Change Scope Modal -->
  {#if showChangeScope}
    {@const thread = workspaceState.selectedThread}
    {@const currentBucketId = thread?.scopeBucketId ?? 'default'}
    <ChangeScopeModal
      open={showChangeScope}
      onClose={() => (showChangeScope = false)}
      threadId={thread?.id ?? ''}
      projectId={thread?.projectId ?? ''}
      {currentBucketId}
    />
  {/if}

  <div class="titlebar-no-drag ml-auto flex shrink-0 items-center gap-1">
    <!-- History — user-message count and jump menu. -->
    {#if !onSettings && !onScope && workspaceState.selectedThread && workspaceState.messageCount > 0}
      <div class="relative">
        <button
          class="flex h-8 items-center gap-1.5 px-2 text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
          aria-label={`Message history (${workspaceState.messageCount} messages you sent)`}
          aria-haspopup="menu"
          aria-expanded={showHistory}
          title="Message history"
          onclick={() => (showHistory = !showHistory)}
        >
          <History size={15} />
          <span class="header-control-label text-[11px] font-medium tabular-nums"
            >{workspaceState.messageCount}</span
          >
        </button>

        {#if showHistory}
          <button
            class="fixed inset-0 z-30 cursor-default"
            aria-label="Close history"
            title="Close history"
            onclick={() => (showHistory = false)}
          ></button>
          <div
            class="absolute right-0 top-9 z-40 w-72 overflow-hidden border bg-surface shadow-lg"
            role="menu"
            aria-label="Jump to message"
          >
            <p
              class="border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-dimmed"
            >
              Your messages
            </p>
            <div class="max-h-72 overflow-y-auto p-1">
              {#each workspaceState.userMessages as message, index (message.id)}
                <button
                  class="block w-full truncate px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
                  role="menuitem"
                  title={message.content}
                  onclick={() => jumpTo(message.id)}
                >
                  {index + 1}. {message.content}
                </button>
              {:else}
                <p class="px-2.5 py-2 text-xs text-dimmed">No messages yet</p>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Memory — always available and toggles its thread-scoped sidebar tab. -->
    {#if !onSettings && !onScope && workspaceState.selectedThread}
      <button
        class="relative flex h-8 items-center gap-1.5 px-2 text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
        aria-label={`Toggle memory (${memoryProposalState.pendingCount} pending proposals)`}
        title="Toggle memory"
        onclick={toggleMemory}
      >
        <BrainCircuit size={15} />
        {#if memoryProposalState.hasPending}
          <div class="absolute -top-0.5 -right-0.5 flex items-start">
            <StatusBadge kind="attention" title="Memory proposals needing attention" />
          </div>
        {/if}
      </button>
    {/if}

    <!-- Editor preference — hidden in chat mode, scope view, and when no project is selected -->
    {#if !chatMode && !onScope && workspaceState.activeProject}
      <div class="relative flex items-center">
        <button
          class="flex h-8 w-8 items-center justify-center text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
          aria-label="Open in {preferredName}"
          title="Open in {preferredName}"
          onclick={() => void openProjectInEditor()}
        >
          {#if preferredIcon}
            <img src={preferredIcon} alt="" class="h-4 w-4" />
          {:else}
            <AppWindow size={16} />
          {/if}
        </button>
        <button
          class="flex h-8 items-center px-1 text-dimmed transition-colors duration-150 hover:bg-elevated hover:text-foreground"
          aria-label="Select preferred editor"
          aria-haspopup="menu"
          aria-expanded={showEditorMenu}
          title="Select preferred editor"
          onclick={() => (showEditorMenu = !showEditorMenu)}
        >
          <ChevronDown size={12} />
        </button>

        {#if showEditorMenu}
          <button
            class="fixed inset-0 z-30 cursor-default"
            aria-label="Close menu"
            onclick={() => (showEditorMenu = false)}
          ></button>
          <div
            class="absolute right-0 top-9 z-40 w-48 overflow-hidden border bg-surface p-1 shadow-lg"
            role="menu"
            aria-label="Select default editor"
          >
            <p
              class="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-dimmed"
            >
              Open projects in
            </p>
            {#each availableEditors as editor (editor.id)}
              <button
                class="flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-elevated"
                role="menuitemradio"
                aria-checked={editorPreference.preferredEditor === editor.id}
                title="Open projects in {editor.name}"
                onclick={() => void selectEditor(editor.id)}
              >
                {#if editor.iconDataUrl}
                  <img src={editor.iconDataUrl} alt="" class="h-4.5 w-4.5 shrink-0" />
                {:else}
                  <AppWindow size={16} class="shrink-0 text-muted" />
                {/if}
                <span class="flex-1 truncate">{editor.name}</span>
                {#if editorPreference.preferredEditor === editor.id}
                  <Check size={14} class="text-primary" />
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Spec studio — only for engineering-mode threads, never in chat mode -->
    {#if !chatMode && !onScope && !onSettings && workspaceState.selectedThread && workspaceState.specStudioAvailable}
      <button
        class="flex h-8 items-center gap-1.5 px-2 transition-colors duration-150 {workspaceState.specStudioOpen
          ? 'bg-elevated text-foreground'
          : workspaceState.specStudioError
            ? 'text-danger hover:bg-danger/10'
            : 'text-muted hover:bg-elevated hover:text-foreground'} disabled:opacity-50"
        disabled={workspaceState.specStudioBusy}
        aria-label={workspaceState.specStudioBusy
          ? 'Formulating specification'
          : workspaceState.specStudioOpen
            ? 'Close spec studio'
            : workspaceState.specStudioError
              ? 'Retry specification generation'
              : 'Open spec studio'}
        title={workspaceState.specStudioFormulating
          ? 'Formulating specification'
          : workspaceState.specStudioError ||
            (workspaceState.specStudioOpen ? 'Close spec studio' : 'Open spec studio')}
        onclick={() => workspaceState.toggleSpecStudio?.()}
      >
        {#if workspaceState.specStudioBusy}
          <Loader2 size={15} class="animate-spin" />
        {:else}
          <FileText size={15} />
        {/if}
        <span class="header-control-label text-[11px] font-medium">
          {workspaceState.specStudioBusy
            ? workspaceState.specStudioFormulating
              ? 'Formulating…'
              : 'Preparing…'
            : workspaceState.specStudioError
              ? 'Retry spec'
              : 'Spec'}
        </span>
      </button>
    {/if}

    <!-- Git status chip — only when a thread is open in a project view -->
    {#if !chatMode && !onScope && !onSettings && workspaceState.selectedThread && gitAvailable}
      <button
        class={[
          'relative flex h-8 max-w-40 items-center gap-1.5 rounded-lg px-2 transition-colors duration-150',
          gitState.activePrConflictCount > 0
            ? 'text-danger hover:bg-danger/10'
            : gitState.conflicted.length > 0
              ? 'text-warning hover:bg-warning/10'
              : gitState.clean
                ? 'text-dimmed hover:bg-elevated hover:text-foreground'
                : 'text-muted hover:bg-elevated hover:text-foreground'
        ]}
        aria-label="Open Git panel"
        title={gitState.activePrConflictCount > 0
          ? `${gitState.activePrConflictCount} open pull request${gitState.activePrConflictCount === 1 ? '' : 's'} need${gitState.activePrConflictCount === 1 ? 's' : ''} conflict resolution — open Git panel`
          : 'Open Git panel'}
        onclick={openGitPanel}
      >
        {#if gitState.activePrConflictCount > 0}
          <GitMergeConflict size={13} class="shrink-0" />
        {:else}
          <GitBranch size={13} class="shrink-0" />
        {/if}
        {#if gitState.branch}
          <span class="min-w-0 flex-1 truncate font-mono text-[10px] font-medium">
            {gitState.branch}
          </span>
        {/if}
        {#if gitState.conflicted.length > 0}
          <span
            class="shrink-0 rounded-full bg-warning px-1.5 text-[9px] font-semibold tabular-nums text-on-primary"
          >
            {gitState.conflicted.length}
          </span>
        {:else if gitState.status && !gitState.clean}
          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"></span>
        {/if}
        {#if gitState.activePrConflictCount > 0}
          <span
            class="flex shrink-0 items-center gap-0.5 rounded-full bg-danger/15 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-danger"
            title={`${gitState.activePrConflictCount} open pull request${gitState.activePrConflictCount === 1 ? '' : 's'} need${gitState.activePrConflictCount === 1 ? 's' : ''} conflict resolution`}
          >
            <GitPullRequest size={9} class="shrink-0" />
            {gitState.activePrConflictCount}
          </span>
        {/if}
        {#if gitState.stashes.length > 0}
          <span
            class="absolute -bottom-1.5 left-2 flex items-center gap-0.5 rounded-full bg-info/15 px-1.5 py-0.5 text-[8px] font-semibold tabular-nums text-info ring-1 ring-info/30"
            title={`${gitState.stashes.length} stashed change${gitState.stashes.length === 1 ? '' : 's'}`}
          >
            <Archive size={8} class="shrink-0" />
            {gitState.stashes.length}
          </span>
        {/if}
      </button>
    {/if}

    <!-- Terminal — only when a thread is open in a terminal-hosting view, never in chat mode or scope view -->
    {#if !chatMode && !onScope && !onSettings && workspaceState.selectedThread && workspaceState.terminalAvailable}
      <button
        class="flex h-8 w-8 items-center justify-center transition-colors duration-150 {terminalOpen
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:bg-elevated hover:text-foreground'}"
        aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
        title={terminalOpen ? 'Hide terminal' : 'Show terminal'}
        onclick={openTerminal}
      >
        <SquareTerminal size={16} />
      </button>
    {/if}

    {#if chatMode}
      {#if workspaceState.selectedThread}
        <!-- Sources — chat mode surfaces the sources panel on the header -->
        <button
          class="relative flex h-8 items-center gap-1.5 px-2 transition-colors duration-150 {sourcesOpen
            ? 'bg-elevated text-foreground'
            : 'text-muted hover:bg-elevated hover:text-foreground'}"
          aria-label={sourcesOpen ? 'Close sources' : 'Open sources'}
          title={sourcesOpen ? 'Close sources' : 'Show sources for this chat'}
          onclick={toggleSources}
        >
          <Info size={15} />
          <span class="header-control-label text-[11px] font-medium">Sources</span>
          {#if workspaceState.sources.length > 0}
            <span class="header-control-label text-[11px] font-medium tabular-nums text-dimmed"
              >{workspaceState.sources.length}</span
            >
          {/if}
        </button>
        {#if import.meta.env.DEV}
          <button
            class="relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-150 {debuggerOpen
              ? 'bg-elevated text-foreground'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-label={debuggerOpen ? 'Hide debugger' : 'Show debugger'}
            title={debuggerOpen ? 'Hide debugger' : 'Show debugger'}
            onclick={toggleDebugger}
          >
            <Bug size={16} />
          </button>
        {/if}
      {/if}
    {/if}

    <!-- Notification bell — available in all views -->
    <button
      class="relative flex h-8 w-8 items-center justify-center text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
      aria-label={`Open notifications (${notificationPanelState.totalCount})`}
      title="Open notifications"
      onclick={() => contextSidebarState.toggleNotifications()}
    >
      <Bell size={16} />
      {#if notificationPanelState.totalCount > 0}
        <div class="absolute -top-0.5 -right-0.5 flex items-start gap-px">
          {#if notificationPanelState.hasCompleted}
            <StatusBadge kind="completed" title="Completed notifications" />
          {/if}
          {#if notificationPanelState.hasAttention}
            <StatusBadge kind="attention" title="Notifications needing attention" />
          {/if}
          {#if notificationPanelState.hasError}
            <StatusBadge kind="error" title="Error notifications" />
          {/if}
        </div>
      {/if}
    </button>

    {#if !chatMode && !onSettings && !onScope && workspaceState.selectedThread}
      <button
        class="flex h-8 w-8 items-center justify-center transition-colors duration-150 {contextSidebarOpen
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:bg-elevated hover:text-foreground'}"
        aria-label={contextSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        title={contextSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        onclick={toggleContextSidebar}
      >
        <PanelRight size={16} />
      </button>
    {/if}
  </div>
</header>

<style>
  .app-header {
    container-type: inline-size;
  }

  @container (max-width: 1100px) {
    .header-control-label {
      display: none;
    }
  }

  @container (max-width: 760px) {
    .header-status-label {
      display: none;
    }
  }
</style>
