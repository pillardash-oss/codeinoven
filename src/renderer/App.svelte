<script lang="ts">
  import { onMount } from 'svelte'
  import type { Component } from 'svelte'
  import {
    Bell,
    Blocks,
    BookOpen,
    Brain,
    FileSearch,
    FolderOpen,
    FolderPlus,
    GitBranch,
    GraduationCap,
    Info,
    Keyboard,
    LayoutDashboard,
    ListTree,
    MessageSquarePlus,
    MessagesSquare,
    Server,
    SlidersHorizontal,
    SquarePen,
    Terminal,
    ChartColumn,
    Users,
    Wrench
  } from '@lucide/svelte'
  import AppHeader from '$lib/components/layout/AppHeader.svelte'
  import Workspace from '$lib/components/workspace/Workspace.svelte'
  import Toaster from '$lib/components/ui/Toaster.svelte'
  import TooltipHost from '$lib/components/ui/TooltipHost.svelte'
  import { toast } from 'svelte-sonner'
  import { SvelteMap } from 'svelte/reactivity'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { closeTopVisibleDialog, requestCloseTopOverlay } from '$lib/overlay-close.svelte'
  import {
    rendererRecovery,
    isSettingsSection,
    isSettingsView,
    settingsSectionForView,
    settingsViewForSection,
    type MainView,
    type SettingsSection
  } from '$lib/stores/renderer-recovery.svelte'
  import { workspaceState, threadVisitKey } from '$lib/stores/workspace.svelte'
  import {
    navigationHistoryState,
    type NavigationLocation
  } from '$lib/stores/navigation-history.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { pipState } from '$lib/stores/pip.svelte'
  import { updaterState } from '$lib/stores/updater.svelte'
  import { threadNotesState } from '$lib/stores/thread-notes.svelte'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { isTerminalFocused } from '$lib/terminal/focus'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { clearDraftLabelCookie } from '$lib/stores/draft-label'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { harnessLifecycleStore } from '$lib/stores/harness-lifecycle.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { loadProjectIcons } from '$lib/project-icons'
  import { preloadScopeChunk, preloadSettingsChunk } from '$lib/page-preload'
  import { APP_NAME } from '$shared/brand'
  import type { ActionDefinition, ActionSelection, ActionSource } from '$lib/actions'
  import {
    getInlineFileTypeIconDataUri,
    getInlineFolderTypeIconDataUri
  } from '$lib/components/files/file-type-icons'
  import { actionContext } from '$lib/stores/action-context.svelte'
  import {
    captureElementSelection,
    restoreElementSelection,
    type ElementSelectionBookmark
  } from '$lib/selection-bookmark'
  import {
    DEFAULT_SCOPE_BUCKET_ID,
    DEFAULT_THREAD_TITLE,
    INBOX_PROJECT_ID,
    isOrchestrationChildThread,
    isThreadWorking,
    type AppConfig,
    type AppConfigPatch,
    type Project,
    type ThemePreference,
    type Thread,
    type ThreadSearchResult
  } from '$shared/types'
  import { DEFAULT_AGENT_BEHAVIOR_PROMPT } from '$shared/agent-behavior'
  import { DEFAULT_SPEECH_SETTINGS } from '$shared/speech/types'
  import type {
    AgentNotificationPayload,
    CloseConfirmationPayload,
    CloseConfirmationProject,
    ThreadClickedPayload
  } from '$shared/ipc-contract'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { initVoiceShortcutListener } from '$lib/speech/voice-shortcut'
  import { statusBadgeForThread } from '$lib/thread-status-badge'

  type View = MainView

  const defaultConfig: AppConfig = {
    theme: 'system',
    onboardingCompleted: false,
    threadLimit: 70,
    questionTimeoutMs: 300_000,
    keybindings: {},
    slashCommandMode: 'app',
    preferredEditor: 'system',
    memory: { enabled: true, chatEnabled: true, entries: [] },
    agentDefaults: { syncFromThreadChanges: false },
    agentBehaviorPrompt: DEFAULT_AGENT_BEHAVIOR_PROMPT,
    autoDownloadUpdates: true,
    autoInstallUpdates: true,
    updateChannel: 'stable',
    keepAwakeWhileWorking: false,
    keepAwakeWhileRemoteConnected: true,
    imageDescriptorAskAgain: false,
    autoRetryAfterReset: true,
    resumeWorkOnRestart: true,
    defaultMergeMethod: 'squash',
    defaultPullStrategy: 'ask',
    maxDiffLines: 100,
    openLocalhostInCioBrowser: true,
    sound: structuredClone(DEFAULT_SPEECH_SETTINGS)
  }

  let config = $state<AppConfig>(defaultConfig)
  let settingsReady = $state(false)
  let settingsError = $state<string>()
  let systemDark = $state(false)
  let activeView = $state<View>(rendererRecovery.activeView)
  let commandPaletteOpen = $state(false)
  let closeConfirmation = $state<CloseConfirmationPayload | null>(null)
  let fileSearchPaletteOpen = $state(false)
  let fileSearchActions = $state<ActionDefinition[]>([])
  let fileSearchLoading = $state(false)
  let fileSearchTimer: number | null = null
  let fileSearchRequest = 0
  let threadSearchPaletteOpen = $state(false)
  let threadSearchActions = $state<ActionDefinition[]>([])
  let threadSearchLoading = $state(false)
  let threadSearchTimer: number | null = null
  let threadSearchRequest = 0
  let newProjectSpotlightOpen = $state(false)
  let onboardingOpen = $state(false)
  let onboardingStep = $state(0)
  let onboardingInitialized = false
  let onboardingProjectPickerActive = false
  let paletteFocusBookmark: ElementSelectionBookmark | null = null

  interface FileSearchTarget {
    projectId: string
    path: string
    kind: 'file' | 'directory'
  }

  interface ThreadSearchTarget {
    thread: Thread
  }

  const fileSearchTargets = new SvelteMap<ActionDefinition['id'], FileSearchTarget>()
  const threadSearchTargets = new SvelteMap<ActionDefinition['id'], ThreadSearchTarget>()

  const applicationSource = {
    id: 'application',
    label: APP_NAME,
    kind: 'app'
  } satisfies ActionSource

  const navigationActions = [
    {
      id: 'app:projects',
      title: 'Open projects',
      description: 'Browse projects and engineering threads',
      category: 'navigation',
      source: applicationSource,
      icon: FolderOpen,
      keywords: ['workspace', 'threads']
    },
    {
      id: 'app:chats',
      title: 'Open chats',
      description: 'Browse standalone conversations',
      category: 'navigation',
      source: applicationSource,
      icon: MessagesSquare,
      keywords: ['conversations', 'messages']
    },
    {
      id: 'app:scope',
      title: 'Open scope',
      description: 'Review work across projects',
      category: 'navigation',
      source: applicationSource,
      icon: LayoutDashboard,
      keywords: ['board', 'overview']
    },
    {
      id: 'app:threads',
      title: 'Open threads',
      description: 'Browse threads across all projects',
      category: 'navigation',
      source: applicationSource,
      icon: ListTree,
      keywords: ['timeline', 'all']
    }
  ] satisfies ActionDefinition[]

  const settingsTabs: Array<{
    id: SettingsSection
    label: string
    keywords: string[]
    icon: Component
  }> = [
    {
      id: 'general',
      label: 'General',
      keywords: ['appearance', 'theme', 'preferences'],
      icon: SlidersHorizontal
    },
    {
      id: 'memory',
      label: 'Memory',
      keywords: ['instructions', 'knowledge'],
      icon: Brain
    },
    {
      id: 'audits',
      label: 'Agents',
      keywords: ['senior engineer', 'worker', 'auditor', 'achievement', 'review'],
      icon: Users
    },
    {
      id: 'harnesses',
      label: 'Harnesses',
      keywords: ['models', 'providers', 'harnesses'],
      icon: Blocks
    },
    {
      id: 'utilities',
      label: 'Utilities',
      keywords: ['mcp', 'skills', 'capabilities', 'computer use', 'tools'],
      icon: Wrench
    },
    {
      id: 'keymap',
      label: 'Keymap',
      keywords: ['shortcuts', 'keyboard', 'keys', 'hotkeys', 'bindings'],
      icon: Keyboard
    },
    { id: 'remote', label: 'Remote', keywords: ['ssh', 'host'], icon: Server },
    {
      id: 'profile',
      label: 'Usage',
      keywords: ['account', 'usage', 'activity', 'tokens', 'cost', 'cloud'],
      icon: ChartColumn
    },
    {
      id: 'about',
      label: 'About',
      keywords: ['version', 'updates', 'storage', 'data', 'diagnostics', 'logs', 'debug'],
      icon: Info
    }
  ]

  function actionId(value: string): ActionDefinition['id'] {
    return value as ActionDefinition['id']
  }

  const settingsActions = settingsTabs.map((tab): ActionDefinition => ({
    id: actionId(`settings:${tab.id}`),
    title: `Settings: ${tab.label}`,
    description: `Open the ${tab.label} settings tab`,
    category: 'navigation',
    source: applicationSource,
    icon: tab.icon,
    keywords: ['settings', 'preferences', ...tab.keywords],
    ...(tab.id === 'general' ? { shortcut: ['Ctrl', ','] } : {})
  }))

  let paletteContextActions = $derived.by((): ActionDefinition[] => {
    const workspaceVisible =
      activeView === 'projects' || activeView === 'chats' || activeView === 'threads'
    const hasLocalProjects = scopeState.projectRecords.some(
      (project) => !project.hidden && project.source === 'local' && project.path
    )
    const actions: ActionDefinition[] = [
      {
        id: 'app:new-project',
        title: 'Create new project',
        description: 'Choose how to add a project — local folder or SSH',
        category: 'command',
        source: applicationSource,
        icon: FolderPlus,
        shortcut: ['Ctrl', 'Shift', 'N'],
        keywords: ['add', 'folder', 'repository', 'ssh', 'remote']
      },
      {
        id: 'app:notifications',
        title: 'Toggle notifications',
        description: 'Open or close the notifications sidebar',
        category: 'navigation',
        source: applicationSource,
        icon: Bell,
        keywords: ['alerts', 'completed', 'attention']
      },
      {
        id: 'app:getting-started',
        title: 'Open getting started guide',
        description: 'Tour the workspace and set up a project and coding agent',
        category: 'navigation',
        source: applicationSource,
        icon: GraduationCap,
        keywords: ['onboarding', 'tour', 'help', 'setup', 'pi']
      }
    ]

    if (hasLocalProjects) {
      actions.push({
        id: 'app:file-search',
        title: 'Search files across projects',
        description: 'Find and open a file from any local project',
        category: 'file',
        source: applicationSource,
        icon: FileSearch,
        keywords: ['quick open', 'find', 'workspace']
      })
    }

    if (activeView === 'chats') {
      actions.unshift({
        id: 'app:new-chat',
        title: 'New chat',
        description: 'Start a standalone conversation',
        category: 'command',
        source: applicationSource,
        icon: MessageSquarePlus,
        shortcut: ['Ctrl', 'N'],
        keywords: ['conversation', 'message']
      })
    } else if (activeView === 'scope' && scopeState.activeProjectId) {
      const project = scopeState.projectRecords.find(
        (candidate) => candidate.id === scopeState.activeProjectId
      )
      actions.unshift({
        id: 'app:new-thread',
        title: 'New thread',
        description: project ? `Create a thread in ${project.name}` : 'Create a project thread',
        category: 'command',
        source: applicationSource,
        icon: SquarePen,
        shortcut: ['Ctrl', 'N'],
        keywords: ['task', 'conversation', 'project']
      })
    } else if (
      (activeView === 'projects' || activeView === 'threads') &&
      workspaceState.activeProject &&
      workspaceState.activeProject.id !== INBOX_PROJECT_ID
    ) {
      actions.unshift({
        id: 'app:new-thread',
        title: 'New thread',
        description: `Create a thread in ${workspaceState.activeProject.name}`,
        category: 'command',
        source: applicationSource,
        icon: SquarePen,
        shortcut: ['Ctrl', 'N'],
        keywords: ['task', 'conversation', 'project']
      })
    }

    const thread = workspaceVisible ? workspaceState.selectedThread : null
    if (thread) {
      const threadProject = scopeState.projectRecords.find(
        (candidate) => candidate.id === thread.projectId
      )
      actions.push(
        {
          id: 'app:terminal',
          title: 'Open terminal',
          description: 'Open a terminal for this thread',
          category: 'navigation',
          source: applicationSource,
          icon: Terminal,
          keywords: ['shell', 'console', 'command line', 'run']
        },
        {
          id: 'app:git',
          title: 'Open git panel',
          description: 'View changes, commits and branches for this project',
          category: 'navigation',
          source: applicationSource,
          icon: GitBranch,
          keywords: ['changes', 'commits', 'branches', 'status', 'diff'],
          ...(threadProject?.changeTrackingMode !== 'git'
            ? { disabledReason: 'This project does not use Git tracking' }
            : {})
        },
        {
          id: 'app:memory',
          title: 'Toggle memory sidebar',
          description: 'View the memory context available to this thread',
          category: 'navigation',
          source: applicationSource,
          icon: Brain,
          keywords: ['prompt', 'instructions', 'context']
        },
        {
          id: 'app:sources',
          title: 'Toggle sources sidebar',
          description: 'View sources attached to this conversation',
          category: 'navigation',
          source: applicationSource,
          icon: BookOpen,
          keywords: ['citations', 'references', 'attachments']
        }
      )
    }

    if (hasLocalProjects) {
      // Unshifted last so it always lands first in the palette.
      actions.unshift({
        id: 'app:thread-search',
        title: 'Search threads across projects',
        description: 'Find a conversation by title or message content in any project',
        category: 'thread',
        source: applicationSource,
        icon: MessagesSquare,
        keywords: ['quick open', 'find', 'conversation', 'messages', 'timeline']
      })
    }

    return actions
  })

  let paletteActions = $derived([
    ...paletteContextActions,
    ...navigationActions,
    ...settingsActions,
    // Harness-bound actions (model pickers, slash commands) belong to the inline
    // menus — the global Cmd+K surface keeps app-level and cross-harness actions.
    ...actionContext.actions.filter((action) => action.source.kind !== 'harness')
  ])

  /** Content view to return to when leaving Settings or Scope — persisted in the
   *  recovery snapshot so a restart made while on a Settings page or the Scope
   *  view still returns to the previous content view instead of resetting to Projects. */
  let lastContentView = $derived(rendererRecovery.lastContentView)

  /** The view the user was on before opening Settings — the Settings back button returns here. */
  let lastViewBeforeSettings = $derived(rendererRecovery.lastViewBeforeSettings)

  let effectiveTheme = $derived(
    config.theme === 'system' ? (systemDark ? 'dark' : 'light') : config.theme
  )

  function applyTheme(): void {
    document.documentElement.classList.toggle('dark', effectiveTheme === 'dark')
  }

  async function loadConfig(): Promise<void> {
    try {
      config = await invoke('config:get')
      appConfigState.sync(config)
      applyTheme()
      settingsError = undefined
      if (!onboardingInitialized) {
        onboardingOpen = !config.onboardingCompleted
        onboardingInitialized = true
      }
    } catch {
      settingsError = 'Settings could not be loaded. Defaults are being used.'
      if (!onboardingInitialized) {
        onboardingOpen = true
        onboardingInitialized = true
      }
    } finally {
      settingsReady = true
    }
  }

  async function updateConfig(patch: AppConfigPatch): Promise<void> {
    const previous = config
    config = { ...config, ...patch }
    applyTheme()
    if (patch.sound) {
      window.dispatchEvent(
        new CustomEvent('cio:soundChanged', { detail: { ...config.sound, ...patch.sound } })
      )
    }
    try {
      config = await invoke('config:update', patch)
      appConfigState.sync(config)
      applyTheme()
      settingsError = undefined
      if (patch.sound) {
        window.dispatchEvent(new CustomEvent('cio:soundChanged', { detail: config.sound }))
      }
    } catch {
      config = previous
      applyTheme()
      settingsError = 'Your settings change could not be saved.'
    }
  }

  function setPreference(pref: ThemePreference): void {
    void updateConfig({ theme: pref })
  }

  /** The app's current location, for history capture. */
  function currentLocation(): NavigationLocation {
    const thread = workspaceState.selectedThread
    return {
      view: activeView,
      thread: thread ? { projectId: thread.projectId, threadId: thread.id } : null
    }
  }

  function navigate(view: View): void {
    // Warm the lazy page chunks so the view swap resolves instantly — the
    // sidebar/header hover preloads cover the mouse path; this covers every
    // other entry point (shortcuts, palette, programmatic navigation). The
    // imports are memoized, so repeated calls are no-ops.
    if (view === 'scope') {
      preloadScopeChunk()
    } else if (isSettingsView(view)) {
      preloadSettingsChunk()
    }
    if (view === 'scope') {
      const projectId = workspaceState.selectedThread?.projectId ?? workspaceState.activeProject?.id
      if (projectId) void scopeState.activateProject(projectId)
      scopeState.clearSidebarContext()
    } else if (view === 'chats') {
      scopeState.stashSidebarContext()
    } else if (view === 'threads') {
      scopeState.clearSidebarContext()
    }
    const previousContentView = rendererRecovery.lastContentView
    activeView = view
    // Persists the view and tracks the last content / non-settings views, so
    // returning from Settings (even across a restart) lands back where the user
    // was instead of resetting to Projects.
    rendererRecovery.setActiveView(view)
    reconcileThreadForContentView(view, previousContentView)
    observeNavigationLocation()
  }

  function observeNavigationLocation(): void {
    navigationHistoryState.observe(currentLocation())
  }

  /** The most recently opened thread of the given kind that still exists. */
  function lastThreadOfKind(isChat: boolean): Thread | null {
    for (const key of workspaceState.recentThreadVisits) {
      const thread = scopeState.allScopeThreads.find(
        (candidate) => threadVisitKey(candidate) === key
      )
      if (!thread || thread.archived) continue
      if ((thread.projectId === INBOX_PROJECT_ID) === isChat) return thread
    }
    return null
  }

  /**
   * Switching between Chats and the project views must never leave a thread of
   * the wrong kind selected (a chat shown as a project thread, or vice versa).
   * Restores the last opened thread of the target view, or falls back to the
   * empty state when nothing of that kind exists. Covers every navigation path
   * (nav buttons, command palette, programmatic navigation like "continue in a
   * project"), not just the header buttons.
   */
  function reconcileThreadForContentView(
    view: View,
    previousContentView: 'projects' | 'chats' | 'threads'
  ): void {
    if (view !== 'chats' && view !== 'projects' && view !== 'threads') return
    if (view === previousContentView) return
    const goingToChats = view === 'chats'
    const leavingChats = previousContentView === 'chats'
    if (goingToChats === leavingChats) return

    const thread = workspaceState.selectedThread
    const threadIsChat = thread ? thread.projectId === INBOX_PROJECT_ID : false

    if (goingToChats) {
      // Entering chats: keep a chat selected, otherwise restore the last chat.
      if (thread && threadIsChat) return
      const lastChat = lastThreadOfKind(true)
      if (!lastChat) return
      const project =
        scopeState.projectRecords.find((candidate) => candidate.id === lastChat.projectId) ?? null
      workspaceState.openThread(lastChat, project)
      return
    }

    // Leaving chats for a project view: never keep the chat selected.
    if (!thread || !threadIsChat) return
    const lastProjectThread = lastThreadOfKind(false)
    if (!lastProjectThread) {
      workspaceState.clearThread()
      return
    }
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === lastProjectThread.projectId) ??
      null
    workspaceState.openThread(lastProjectThread, project)
  }

  /** Re-open the thread captured in a history entry, if it still exists. */
  async function restoreThreadFromHistory(entry: NavigationLocation): Promise<void> {
    if (!entry.thread) return
    const cached = scopeState.allScopeThreads.find(
      (candidate) => candidate.id === entry.thread?.threadId
    )
    if (cached) {
      const cachedProject =
        scopeState.projectRecords.find((candidate) => candidate.id === cached.projectId) ?? null
      workspaceState.openThread(cached, cachedProject)
      void scopeState.ensureBoardLoaded(cached.projectId)
      return
    }
    const [thread, project] = await Promise.all([
      invoke('thread:get', entry.thread.projectId, entry.thread.threadId),
      invoke('project:get', entry.thread.projectId)
    ])
    if (!thread) return
    workspaceState.openThread(thread, project)
    void scopeState.ensureBoardLoaded(thread.projectId)
  }

  /** Navigate to the previously visited location, if any. */
  async function goBack(): Promise<void> {
    const entry = navigationHistoryState.back(currentLocation())
    if (!entry) return
    navigationHistoryState.beginTraversal()
    try {
      navigate(entry.view)
      await restoreThreadFromHistory(entry)
    } finally {
      navigationHistoryState.endTraversal()
    }
  }

  /** Navigate to the location the user backed away from, if any. */
  async function goForward(): Promise<void> {
    const entry = navigationHistoryState.forward(currentLocation())
    if (!entry) return
    navigationHistoryState.beginTraversal()
    try {
      navigate(entry.view)
      await restoreThreadFromHistory(entry)
    } finally {
      navigationHistoryState.endTraversal()
    }
  }

  function installWorkspaceCallbacks(): () => void {
    workspaceState.navigateToSettings = (tab?: string) => {
      navigate(isSettingsSection(tab) ? settingsViewForSection(tab) : 'settings')
    }
    workspaceState.navigateToContent = () => navigate(lastContentView)
    workspaceState.openThreadFromNotification = (thread, project) =>
      openThreadFromNotification(thread, project)
    return () => {
      workspaceState.navigateToSettings = null
      workspaceState.navigateToContent = null
      workspaceState.openThreadFromNotification = null
    }
  }

  async function handlePaletteSelection(selection: ActionSelection): Promise<void> {
    const settingsTab = settingsTabs.find(
      (tab) => actionId(`settings:${tab.id}`) === selection.action.id
    )
    if (settingsTab) {
      navigate(settingsViewForSection(settingsTab.id))
      return
    }

    switch (selection.action.id) {
      case 'app:new-project':
        openNewProjectSpotlight()
        return
      case 'app:new-chat':
        navigate('chats')
        workspaceState.requestNewChat()
        return
      case 'app:new-thread':
        if (activeView === 'scope') {
          const bucketId =
            scopeState.sidebarContext?.bucketId ??
            scopeState.buckets[0]?.id ??
            DEFAULT_SCOPE_BUCKET_ID
          scopeState.requestCreateScopedThread(bucketId)
        } else {
          workspaceState.requestCreateThread(scopeState.sidebarContext?.bucketId)
        }
        return
      case 'app:file-search':
        openFileSearchPalette()
        return
      case 'app:thread-search':
        openThreadSearchPalette()
        return
      case 'app:notifications':
        contextSidebarState.toggleNotifications()
        return
      case 'app:getting-started':
        onboardingStep = 0
        onboardingOpen = true
        return
      case 'app:terminal': {
        const thread = workspaceState.selectedThread
        if (!thread) return
        contextSidebarState.openPrimaryTerminal(thread.projectId, thread.id)
        return
      }
      case 'app:git': {
        const thread = workspaceState.selectedThread
        if (!thread) return
        contextSidebarState.openGit(thread.projectId, thread.id)
        return
      }
      case 'app:memory': {
        const thread = workspaceState.selectedThread
        if (!thread) return
        if (
          contextSidebarState.sidebarVisible &&
          contextSidebarState.sidebarActiveTab?.kind === 'memory'
        ) {
          contextSidebarState.hide()
        } else {
          contextSidebarState.openMemory(thread.projectId, thread.id)
        }
        return
      }
      case 'app:sources': {
        const thread = workspaceState.selectedThread
        if (!thread) return
        if (
          contextSidebarState.sidebarVisible &&
          contextSidebarState.sidebarActiveTab?.kind === 'sources'
        ) {
          contextSidebarState.hide()
        } else {
          contextSidebarState.openSources(thread.projectId, thread.id)
        }
        return
      }
      case 'app:projects':
        navigate('projects')
        return
      case 'app:chats':
        if (activeView !== 'chats' && workspaceState.selectedThread) {
          scopeState.stashedProjectThreadId = workspaceState.selectedThread.id
        }
        navigate('chats')
        return
      case 'app:scope':
        navigate('scope')
        return
      case 'app:threads':
        navigate('threads')
        return
      case 'app:settings':
        navigate('settings')
        return
      default:
        await actionContext.current?.onSelect(selection)
    }
  }

  function capturePaletteFocus(): void {
    const active = document.activeElement
    if (
      !(active instanceof HTMLElement) ||
      !active.isContentEditable ||
      !active.classList.contains('rich-markdown-editor') ||
      !active.id.startsWith('chat-composer-')
    ) {
      paletteFocusBookmark = null
      return
    }

    paletteFocusBookmark = captureElementSelection(active)
  }

  function restorePaletteFocus(): boolean {
    const bookmark = paletteFocusBookmark
    paletteFocusBookmark = null
    return bookmark ? restoreElementSelection(bookmark) : false
  }

  function toggleCommandPalette(): void {
    if (fileSearchPaletteOpen) {
      fileSearchPaletteOpen = false
      resetFileSearch()
    }
    if (threadSearchPaletteOpen) {
      threadSearchPaletteOpen = false
      resetThreadSearch()
    }
    if (commandPaletteOpen) {
      commandPaletteOpen = false
      return
    }
    capturePaletteFocus()
    commandPaletteOpen = true
  }

  function resetFileSearch(): void {
    if (fileSearchTimer !== null) {
      window.clearTimeout(fileSearchTimer)
      fileSearchTimer = null
    }
    fileSearchRequest++
    fileSearchLoading = false
    fileSearchActions = []
    fileSearchTargets.clear()
  }

  function openFileSearchPalette(): void {
    resetFileSearch()
    fileSearchPaletteOpen = true
  }

  async function searchFilesAcrossProjects(query: string, request: number): Promise<void> {
    const projects = scopeState.projectRecords.filter(
      (project) => !project.hidden && project.source === 'local' && project.path
    )
    const projectResults = await Promise.all(
      projects.map(async (project) => {
        try {
          const entries = await invoke(
            'projectFiles:search',
            project.id,
            query,
            'all',
            workspaceState.activeScopeBucketIdFor(project.id)
          )
          return { project, entries: entries.slice(0, 12) }
        } catch {
          return { project, entries: [] }
        }
      })
    )
    if (request !== fileSearchRequest || !fileSearchPaletteOpen) return

    const resolved = await Promise.all(
      projectResults.flatMap(({ project, entries }) =>
        entries.map(async (entry) => ({
          project,
          entry,
          iconUri:
            entry.kind === 'directory'
              ? await getInlineFolderTypeIconDataUri(entry.name)
              : await getInlineFileTypeIconDataUri(entry.path)
        }))
      )
    )
    if (request !== fileSearchRequest || !fileSearchPaletteOpen) return

    const targets = new SvelteMap<ActionDefinition['id'], FileSearchTarget>()
    const actions: ActionDefinition[] = []
    for (const { project, entry, iconUri } of resolved) {
      const id = actionId(`file:${project.id}:${entry.path}`)
      targets.set(id, { projectId: project.id, path: entry.path, kind: entry.kind })
      actions.push({
        id,
        title: entry.name,
        description: `${project.name} · ${entry.path}`,
        category: 'file',
        source: {
          id: `project:${project.id}`,
          label: project.name,
          kind: 'app',
          ...(project.color ? { color: project.color } : {})
        },
        iconUri,
        keywords: [project.name, entry.path, entry.name]
      })
    }
    fileSearchTargets.clear()
    for (const [id, target] of targets) fileSearchTargets.set(id, target)
    fileSearchActions = actions.slice(0, 60)
    fileSearchLoading = false
  }

  function handleFileSearchQuery(query: string): void {
    if (fileSearchTimer !== null) window.clearTimeout(fileSearchTimer)
    const request = ++fileSearchRequest
    const normalized = query.trim()
    if (normalized.length < 2) {
      fileSearchLoading = false
      fileSearchActions = []
      fileSearchTargets.clear()
      return
    }

    fileSearchLoading = true
    fileSearchTimer = window.setTimeout(() => {
      fileSearchTimer = null
      void searchFilesAcrossProjects(normalized, request)
    }, 160)
  }

  function handleFileSearchSelection(selection: ActionSelection): void {
    const target = fileSearchTargets.get(selection.action.id)
    if (!target) return
    fileSearchPaletteOpen = false
    resetFileSearch()
    workspaceState.requestProjectFileOpen(target.projectId, target.path, target.kind)
  }

  function backToCommandPaletteFromFileSearch(): void {
    fileSearchPaletteOpen = false
    resetFileSearch()
    commandPaletteOpen = true
  }

  function resetThreadSearch(): void {
    if (threadSearchTimer !== null) {
      window.clearTimeout(threadSearchTimer)
      threadSearchTimer = null
    }
    threadSearchRequest++
    threadSearchLoading = false
    threadSearchActions = []
    threadSearchTargets.clear()
  }

  function openThreadSearchPalette(): void {
    resetThreadSearch()
    threadSearchPaletteOpen = true
  }

  function relativeThreadTime(timestamp: number): string {
    const minutes = Math.floor((Date.now() - timestamp) / 60_000)
    if (minutes < 1) return 'Now'
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d`
    const weeks = Math.floor(days / 7)
    if (weeks < 5) return `${weeks}w`
    const months = Math.floor(days / 30)
    if (months < 12) return `${months}mo`
    return `${Math.floor(days / 365)}y`
  }

  async function searchThreadsAcrossProjects(query: string, request: number): Promise<void> {
    let results: ThreadSearchResult[]
    try {
      results = await invoke('threads:search', query, { limit: 50 })
    } catch {
      results = []
    }
    if (request !== threadSearchRequest || !threadSearchPaletteOpen) return

    const targets = new SvelteMap<ActionDefinition['id'], ThreadSearchTarget>()
    const actions: ActionDefinition[] = []
    for (const result of results) {
      const thread = result.thread
      if (thread.archived || isOrchestrationChildThread(thread)) continue
      const project = scopeState.projectRecords.find(
        (candidate) => candidate.id === thread.projectId
      )
      const id = actionId(`thread:${thread.projectId}:${thread.id}`)
      targets.set(id, { thread })
      const snippet = result.kind === 'message' && result.snippet ? result.snippet : undefined
      // Threads carry their project's icon and color, not a generic thread icon.
      // Resolve the icon from the scope state so it stays in sync with whatever
      // hydration owns the project/icon cache (Workspace on startup, App when a
      // new project is created). App's own projectIconUrls was never populated on
      // startup, so it always fell back to the generic monochrome thread icon.
      const projectIconUri = scopeState.projects.find(
        (candidate) => candidate.id === thread.projectId
      )?.iconUrl
      const isLiveWorking = agentRuns.hasSettled(thread.projectId, thread.id)
        ? agentRuns.isBusy(thread.projectId, thread.id)
        : Boolean(thread.sessionId) && isThreadWorking(thread)
      const status = statusBadgeForThread(thread, isLiveWorking)
      // Model/harness metadata for the result row: while the thread is working
      // the current provider + model is shown, otherwise the thread's harnesses
      // and provider appear as icons — mirroring the sidebar thread row.
      const harnessIds = Array.from(
        new Set([
          ...(thread.usedHarnessIds ?? []),
          ...(thread.settings?.harnessId ? [thread.settings.harnessId] : [])
        ])
      )
      const providerId = thread.settings?.providerId ?? thread.providerId
      const providers = providerCatalog.cached(thread.projectId) ?? providerCatalog.allCached()
      const providerName = providerId
        ? (providers.find((provider) => provider.id === providerId)?.name ?? null)
        : null
      const projectLabel = project?.name ?? thread.projectId
      const createdLabel = relativeThreadTime(thread.createdAt)
      actions.push({
        id,
        title: thread.title,
        description: snippet
          ? `${projectLabel} · ${createdLabel} · ${snippet}`
          : `${projectLabel} · ${createdLabel}`,
        category: 'thread',
        source: {
          id: `project:${thread.projectId}`,
          label: projectLabel,
          kind: 'app',
          ...(project?.color ? { color: project.color } : {})
        },
        showSourceBadge: false,
        ...(projectIconUri ? { iconUri: projectIconUri } : { icon: MessagesSquare }),
        ...(status ? { status } : {}),
        threadMeta: {
          working: isLiveWorking,
          harnessIds,
          providerName,
          providerId,
          modelId: thread.settings?.modelId ?? null
        },
        keywords: [project?.name ?? thread.projectId, thread.title, ...(snippet ? [snippet] : [])]
      })
    }
    threadSearchTargets.clear()
    for (const [id, target] of targets) threadSearchTargets.set(id, target)
    threadSearchActions = actions.slice(0, 60)
    threadSearchLoading = false
  }

  function handleThreadSearchQuery(query: string): void {
    if (threadSearchTimer !== null) window.clearTimeout(threadSearchTimer)
    const request = ++threadSearchRequest
    const normalized = query.trim()
    if (normalized.length < 2) {
      threadSearchLoading = false
      threadSearchActions = []
      threadSearchTargets.clear()
      return
    }

    threadSearchLoading = true
    threadSearchTimer = window.setTimeout(() => {
      threadSearchTimer = null
      void searchThreadsAcrossProjects(normalized, request)
    }, 160)
  }

  /** Preserve the current content view / project sidebar state when opening a
   *  searched thread — never force the Projects view. Reuses the notification
   *  open logic, which handles scope state, the threads view and chats. */
  async function openThreadFromSearch(thread: Thread): Promise<void> {
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
    await openThreadFromNotification(thread, project)
  }

  function handleThreadSearchSelection(selection: ActionSelection): void {
    const target = threadSearchTargets.get(selection.action.id)
    if (!target) return
    threadSearchPaletteOpen = false
    resetThreadSearch()
    void openThreadFromSearch(target.thread)
  }

  function backToCommandPaletteFromThreadSearch(): void {
    threadSearchPaletteOpen = false
    resetThreadSearch()
    commandPaletteOpen = true
  }

  async function loadScopeData(preferredProjectId?: string): Promise<void> {
    try {
      // 1. Projects first — the header and project list render immediately
      //    without waiting for the (larger) thread payload.
      const projectList = await invoke('project:list')
      const icons = await loadProjectIcons(projectList)
      scopeState.setScopesFromProjects(projectList, icons, preferredProjectId)

      // 2. Tasks — recent rows only, via the bounded hydration query. The full
      //    task history never crosses IPC at startup; older rows page in on
      //    demand through the workspace/scope views. The selected project is
      //    ordered first so its visible threads render immediately.
      const threadList = await invoke('thread:listRecent', {
        projectId: scopeState.activeProjectId ?? undefined,
        limit: 200
      })
      const visibleThreads = threadList.filter((thread) => !thread.archived)
      scopeState.setThreads(visibleThreads)
      notificationPanelState.hydrateFromThreads(visibleThreads, projectList)

      // 3. The selected project's scope board is the visible surface — load it
      //    before warming any provider data.
      if (scopeState.activeProjectId) {
        scopeState.ensureBoardLoaded(scopeState.activeProjectId)
      }

      // 4. Warm only the selected project's provider catalog (plus inbox for
      //    chats), after the post-paint feature IPC contract is available.
      //    `app:waitForFeatures` is sticky, so this remains safe when the
      //    feature-ready event arrived before the renderer mounted.
      void invoke('app:waitForFeatures').then(() => {
        window.requestAnimationFrame(() => {
          const targets = scopeState.activeProjectId
            ? [scopeState.activeProjectId, INBOX_PROJECT_ID]
            : [INBOX_PROJECT_ID]
          // Seed model pickers from local snapshots without triggering harness probes.
          // Live discovery is deferred until the model picker opens or the user
          // explicitly refreshes, so startup can focus on first paint.
          void providerCatalog.init(targets, { refresh: false })
          // Canonical-ordered harness list (registry order) — the model picker's
          // harness filter sorts against this so its chip order never depends on
          // catalog insertion order.
          void providerStore.init()
        })
      })
    } catch {
      scopeState.setScopesFromProjects([], new Map())
      scopeState.setThreads([])
      notificationPanelState.hydrateFromThreads([])
    }
  }

  function navigateToProjects(): void {
    navigate('projects')
  }

  async function handleProjectCreated(project: Project): Promise<void> {
    await loadScopeData(project.id)
    workspaceState.pendingAddedProject = project
  }

  function openNewProjectSpotlight(): void {
    newProjectSpotlightOpen = true
  }

  /** Spotlight flow: land on the new project (Projects view) with its fresh thread focused. */
  async function handleSpotlightProjectCreated(project: Project): Promise<void> {
    newProjectSpotlightOpen = false
    navigate('projects')
    await handleProjectCreated(project)
    if (onboardingProjectPickerActive) {
      onboardingProjectPickerActive = false
      onboardingStep = 7
      onboardingOpen = true
    }
  }

  /** Spotlight flow: a picked folder already exists as a project — focus it. */
  function handleSpotlightExistingProject(project: Project): void {
    newProjectSpotlightOpen = false
    navigate('projects')
    const thread = scopeState.allScopeThreads
      .filter((candidate) => candidate.projectId === project.id && !candidate.archived)
      .sort((left, right) => right.lastActivity - left.lastActivity)[0]
    if (thread) {
      workspaceState.openThread(thread, project)
    } else {
      workspaceState.clearThread()
      workspaceState.activeProject = project
    }
    if (onboardingProjectPickerActive) {
      onboardingProjectPickerActive = false
      onboardingStep = 7
      onboardingOpen = true
    }
  }

  function updateOnboardingStep(step: number): void {
    if (step === 4) navigate('chats')
    onboardingStep = step
  }

  function chooseOnboardingProject(): void {
    onboardingOpen = false
    onboardingProjectPickerActive = true
    newProjectSpotlightOpen = true
  }

  function closeNewProjectSpotlight(): void {
    newProjectSpotlightOpen = false
    if (onboardingProjectPickerActive) {
      onboardingProjectPickerActive = false
      onboardingOpen = true
    }
  }

  function finishOnboarding(): void {
    onboardingOpen = false
    onboardingProjectPickerActive = false
    void updateConfig({ onboardingCompleted: true })
  }

  function browseHarnessesFromOnboarding(): void {
    finishOnboarding()
    navigate('settings-harnesses')
  }

  async function openScopeThread(thread: Thread): Promise<void> {
    navigate('projects')
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
    workspaceState.openThread(thread, project)
    void scopeState.ensureBoardLoaded(thread.projectId)
    const updated = await invoke('thread:markRead', thread.projectId, thread.id)
    scopeState.updateThread(updated)
    workspaceState.updateThread(updated)
  }

  /**
   * Open a thread from a notification while preserving the current view:
   * - Regular project view → stay there (no scope sidebar).
   * - Scope state / scope view → stay there and reveal the thread in the sidebar.
   * - Threads view → stay there (no scope sidebar).
   * - Chat notification → switch to the chats view.
   */
  async function openThreadFromNotification(
    thread: Thread,
    project: Project | null
  ): Promise<void> {
    const isChat = thread.projectId === INBOX_PROJECT_ID
    const inScopeState =
      activeView === 'scope' || (activeView === 'projects' && Boolean(scopeState.sidebarContext))

    if (isChat) {
      // Chat notifications always land in the chats view.
      navigate('chats')
    } else if (inScopeState) {
      // Stay in the scope state: reveal the thread in the scope sidebar.
      if (activeView !== 'projects') navigate('projects')
      scopeState.showSidebarForThread(thread)
      void scopeState.ensureBoardLoaded(thread.projectId)
    } else if (activeView === 'threads') {
      // Stay in the threads view without entering the scope state.
      scopeState.clearSidebarContext()
    } else {
      // Regular project view or a non-content view (chats or a settings page):
      // stay or return to the last content view, never entering the scope state.
      const target =
        activeView === 'projects' || lastContentView === 'chats' ? 'projects' : lastContentView
      if (target !== activeView) navigate(target)
      scopeState.clearSidebarContext()
    }

    workspaceState.openThread(thread, project)
    const updated = await invoke('thread:markRead', thread.projectId, thread.id)
    scopeState.updateThread(updated)
    workspaceState.updateThread(updated)
  }

  async function openNotificationThread({
    projectId,
    threadId
  }: ThreadClickedPayload): Promise<void> {
    notificationPanelState.dismissForThread(projectId, threadId)
    try {
      const [project, thread] = await Promise.all([
        invoke('project:get', projectId),
        invoke('thread:get', projectId, threadId)
      ])
      if (!project || !thread) return
      await openThreadFromNotification(thread, project)
    } catch {
      // The project or thread may have been deleted before the notification was clicked.
    }
  }

  function showAgentNotification(payload: AgentNotificationPayload): void {
    if (
      workspaceState.selectedThread?.id === payload.threadId &&
      workspaceState.selectedThread?.projectId === payload.projectId
    ) {
      return
    }
    notificationPanelState.add(payload)
    const id = payload.id
    const options = {
      id,
      description: payload.body,
      duration: 8_000,
      onDismiss: () => notificationPanelState.dismiss(id),
      action: {
        label: 'Open thread',
        onClick: (): void => {
          void openNotificationThread(payload)
        }
      }
    }

    const chatResponseToastStyle =
      '--success-bg: color-mix(in srgb, var(--color-chat-success) 12%, var(--color-surface));' +
      ' --success-border: var(--color-chat-success);' +
      ' --success-text: var(--color-chat-success);'

    if (payload.kind === 'completed') {
      toast.success(payload.title, options)
    } else if (payload.kind === 'chat-completed') {
      toast.success(payload.title, { ...options, style: chatResponseToastStyle })
    } else if (payload.kind === 'attention') {
      toast.warning(payload.title, options)
    } else if (payload.kind === 'spec') {
      toast.info(payload.title, options)
    } else {
      toast.error(payload.title, options)
    }
  }

  /** The user approved the force close — tell main to proceed with quitting. */
  async function confirmForceClose(): Promise<void> {
    await invoke('app:confirmClose')
  }

  /**
   * While the close-confirmation modal is open, watch the threads it listed as
   * still working. As each one leaves that state (completed, failed, or
   * otherwise no longer executing/planning) it drops off the list. Once none
   * remain — and no unsaved files are pending — the close the user already
   * asked for proceeds automatically instead of waiting on a second click.
   */
  function settleCloseConfirmationThread(thread: Thread): void {
    const current = closeConfirmation
    if (!current || isThreadWorking(thread)) return

    const projects: CloseConfirmationProject[] = []
    for (const project of current.projects) {
      const threads = project.threads.filter((entry) => entry.threadId !== thread.id)
      if (threads.length > 0) {
        projects.push({ ...project, threads, threadCount: threads.length })
      }
    }
    if (projects.length === current.projects.length) return

    if (projects.length === 0 && current.files.length === 0) {
      closeConfirmation = null
      void confirmForceClose()
      return
    }
    closeConfirmation = { ...current, projects }
  }

  /** Save every unsaved file, then close the app. Stays open if a save fails. */
  async function confirmForceCloseSaving(): Promise<void> {
    if (await projectFilesWorkspace.saveAllUnsaved()) {
      await invoke('app:confirmClose')
    } else {
      toast.error('Some files could not be saved', {
        description: 'The application stayed open so you can review them.'
      })
    }
  }

  function installIpcSubscriptions(): () => void {
    const unsubscribeClick = subscribe('notification:threadClicked', (payload) => {
      void openNotificationThread(payload)
    })
    const unsubscribeShow = subscribe('notification:show', showAgentNotification)
    const unsubscribeConfirmClose = subscribe('window:confirmClose', (payload) => {
      // The renderer owns the unsaved-file editor state, so it computes the
      // pending files here. With nothing pending the close proceeds right away.
      const files = projectFilesWorkspace.getUnsavedFiles()
      if (payload.projects.length === 0 && files.length === 0) {
        void confirmForceClose()
        return
      }
      closeConfirmation = { projects: payload.projects, files }
    })
    const unsubscribeThreadUpdated = subscribe('thread:updated', (...args: unknown[]) => {
      const thread = args[0] as Thread
      // Once a real title exists the draft-derived label is no longer needed.
      if (thread.title !== DEFAULT_THREAD_TITLE) {
        clearDraftLabelCookie(thread.id)
      }
      scopeState.updateThread(thread)
      if (workspaceState.selectedThread?.id === thread.id) {
        workspaceState.updateThread(thread)
      }
      if (thread.read) {
        notificationPanelState.dismissForThread(thread.projectId, thread.id)
      }
      settleCloseConfirmationThread(thread)
    })
    const unsubscribeThreadDeleted = subscribe('thread:deleted', (projectId, threadId) => {
      scopeState.removeThread(threadId)
      notificationPanelState.dismissForThread(projectId, threadId)
      if (workspaceState.selectedThread?.id === threadId) workspaceState.clearThread()
    })
    const unsubscribeCloseShortcut = subscribe('window:closeShortcut', () => {
      handleCloseShortcut()
    })
    const unsubscribeNewTerminalShortcut = subscribe('window:newTerminalShortcut', () => {
      handleNewTerminalShortcut()
    })
    updaterState.init()
    // The PiP overlay subscribes to `computerUse:pipFrame`/`pipState` events;
    // initialise the store here so the overlay's dynamic import can be gated on
    // `pipState.active` without ever missing a frame.
    pipState.init()
    // Load which threads carry a user note so sidebar rows and the right-dock
    // indicator can react; the store keeps itself in sync via `note:changed`.
    threadNotesState.init()
    return () => {
      unsubscribeClick()
      unsubscribeShow()
      unsubscribeConfirmClose()
      unsubscribeThreadUpdated()
      unsubscribeThreadDeleted()
      unsubscribeCloseShortcut()
      unsubscribeNewTerminalShortcut()
      updaterState.destroy()
    }
  }

  /** Clean up renderer resources when the main process signals shutdown. */
  function installShutdownSubscription(): () => void {
    return subscribe('window:beforeQuit', () => {
      // Renderer should release event subscriptions — the main process
      // will dispose services and flush logs 500ms after this signal.
      // The component tree unmounts naturally as the window closes.
    })
  }

  /**
   * Cmd/Ctrl+W closes the active surface: the topmost modal, the Settings page,
   * a sidebar panel, or the open thread. When nothing is active the shortcut is
   * intentionally a no-op; application shutdown is reserved for explicit quit
   * actions and the native window close control.
   */
  function handleCloseShortcut(): void {
    // App-managed palettes first — they float above every view.
    if (fileSearchPaletteOpen) {
      fileSearchPaletteOpen = false
      resetFileSearch()
      return
    }
    if (threadSearchPaletteOpen) {
      threadSearchPaletteOpen = false
      resetThreadSearch()
      return
    }
    if (commandPaletteOpen) {
      commandPaletteOpen = false
      return
    }
    // Reusable modals (Modal / DockableModal) register their close behavior.
    if (requestCloseTopOverlay()) return
    // Bits-ui dialogs and element-level overlay Escape handlers.
    if (closeTopVisibleDialog()) return
    // On a Settings page: leave back to the previous view.
    if (isSettingsView(activeView)) {
      navigate(lastViewBeforeSettings)
      return
    }
    // Focus inside the context sidebar: close its active tab (through Workspace's
    // unsaved-changes confirmation) instead of clearing the thread.
    const active = document.activeElement instanceof Element ? document.activeElement : null
    if (active?.closest('[data-region="context-sidebar"]')) {
      contextSidebarState.requestCloseActiveTab()
      return
    }
    // An open thread: deselect it back to the thread list.
    if (
      (activeView === 'projects' || activeView === 'chats' || activeView === 'threads') &&
      workspaceState.selectedThread
    ) {
      workspaceState.clearThread()
      return
    }
    // Nothing active — keep the application open.
  }

  /**
   * Cmd/Ctrl+T while a terminal is focused opens a new terminal tab in the
   * terminal panel (right sidebar or bottom dock). The main process only emits
   * this event when it intercepted the key with a terminal focused, but the
   * renderer's own focus flag is the source of truth — re-check it defensively.
   */
  function handleNewTerminalShortcut(): void {
    if (!isTerminalFocused()) return
    const thread = workspaceState.selectedThread
    if (!thread) return
    contextSidebarState.openNewTerminal(thread.projectId, thread.id)
  }

  function handleFind(): void {
    const active = document.activeElement instanceof Element ? document.activeElement : null
    if (active?.closest('[data-region="file-tree"]')) {
      findNavState.focusFileTreeFilter++
      return
    }
    if (
      active?.closest('[data-region="git-panel"]') ||
      (active?.closest('[data-region="context-sidebar"]') &&
        document.querySelector('[data-region="git-panel"]'))
    ) {
      findNavState.openGitFind()
      return
    }
    if (active?.closest('[data-region="editor"]')) {
      findNavState.openEditorFind()
      return
    }
    if (active?.closest('[data-region="spec-studio"]')) {
      findNavState.openStudioFind()
      return
    }
    if (active?.closest('[data-region="conversation"]')) {
      findNavState.openConversationFind()
      return
    }

    // Toolbar focus still belongs to the visible regular/fullscreen file surface.
    if (document.querySelector('[data-region="editor"][data-find-active="true"]')) {
      findNavState.openEditorFind()
      return
    }
    if (document.querySelector('[data-region="spec-studio"]')) {
      findNavState.openStudioFind()
      return
    }
    if (
      (activeView === 'projects' || activeView === 'chats' || activeView === 'threads') &&
      document.querySelector('[data-region="conversation"]')
    ) {
      findNavState.openConversationFind()
      return
    }
  }

  /** Global application shortcuts. */
  function onKeydown(e: KeyboardEvent): void {
    const isMac = window.api?.windowInfo?.platform === 'darwin'
    if (e.key.toLowerCase() === 'w' && (isMac ? e.metaKey : e.ctrlKey)) {
      // Primary path is the main process `before-input-event` → the
      // `window:closeShortcut` event. This is a fallback for platforms where
      // the key still reaches the renderer (the main process preventDefaults
      // the page keydown, so this normally never fires twice).
      //
      // On non-mac platforms Ctrl+W is the shell's delete-word binding while a
      // terminal is focused — leave it alone so it reaches the shell.
      if (!isMac && isTerminalFocused()) return
      e.preventDefault()
      if (e.repeat) return
      handleCloseShortcut()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      if (e.repeat) return
      handleFind()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      if (e.repeat) return
      toggleCommandPalette()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault()
      navigate('settings')
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      if (e.repeat) return
      // Cmd/Ctrl+Shift+N → new-project spotlight from any view except chats (inbox).
      if (activeView === 'chats') return
      if (commandPaletteOpen) commandPaletteOpen = false
      openNewProjectSpotlight()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      if (e.repeat) return

      // When the file tree has focus, Cmd/Ctrl+N creates a new file there
      // instead of starting a new thread. The tree's own handler manages it.
      const active = document.activeElement instanceof Element ? document.activeElement : null
      if (active?.closest('[data-region="file-tree"]')) return

      if (activeView === 'scope') {
        if (scopeState.activeProjectId) {
          const bucketId =
            scopeState.sidebarContext?.bucketId ??
            scopeState.buckets[0]?.id ??
            DEFAULT_SCOPE_BUCKET_ID
          scopeState.requestCreateScopedThread(bucketId)
        }
        return
      }

      if (activeView !== 'projects' && activeView !== 'chats' && activeView !== 'threads') return
      if (activeView === 'chats') {
        workspaceState.requestNewChat()
      } else if (
        workspaceState.activeProject &&
        workspaceState.activeProject.id !== INBOX_PROJECT_ID
      ) {
        const bucketId = scopeState.sidebarContext?.bucketId
        workspaceState.requestCreateThread(bucketId)
      } else {
        workspaceState.requestAddProject()
      }
    }
  }

  navigationHistoryState.init(rendererRecovery.activeView, rendererRecovery.selectedThread)

  onMount(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    systemDark = mq.matches
    applyTheme()
    const onColorSchemeChange = (event: MediaQueryListEvent): void => {
      systemDark = event.matches
      applyTheme()
    }
    mq.addEventListener('change', onColorSchemeChange)
    window.addEventListener('keydown', onKeydown)
    const uninstallVoiceShortcut = initVoiceShortcutListener()

    const restoreWorkspaceCallbacks = installWorkspaceCallbacks()
    const unsubscribeIpc = installIpcSubscriptions()
    const unsubscribeShutdown = installShutdownSubscription()
    const originalOpenThread = workspaceState.openThread.bind(workspaceState)
    const originalClearThread = workspaceState.clearThread.bind(workspaceState)
    workspaceState.openThread = (thread, project, iconUrl) => {
      originalOpenThread(thread, project, iconUrl)
      observeNavigationLocation()
    }
    workspaceState.clearThread = () => {
      originalClearThread()
      observeNavigationLocation()
    }
    observeNavigationLocation()
    void loadConfig()
    // Fire-and-forget: probes opted-in harnesses and docks quiet auto-updates.
    void harnessLifecycleStore.autoUpdateOnStartup()
    // Workspace owns the initial project/thread hydration. Keeping this signal
    // there prevents App and Workspace from issuing the same startup queries.

    return () => {
      mq.removeEventListener('change', onColorSchemeChange)
      window.removeEventListener('keydown', onKeydown)
      uninstallVoiceShortcut()
      restoreWorkspaceCallbacks()
      unsubscribeIpc()
      unsubscribeShutdown()
      workspaceState.openThread = originalOpenThread
      workspaceState.clearThread = originalClearThread
    }
  })
</script>

<div class="flex h-screen flex-col bg-app">
  <AppHeader
    {activeView}
    {navigate}
    {goBack}
    {goForward}
    onProjectCreated={handleProjectCreated}
    onScopeThreadOpen={openScopeThread}
  />

  <main class="flex-1 overflow-hidden">
    <!-- One shell for all views — the workspace (and the open thread) stays
         mounted across Settings/Scope so returning never reloads the thread
         list or reconnects the harness; it's simply hidden while away. -->
    <div
      class={activeView === 'projects' || activeView === 'chats' || activeView === 'threads'
        ? 'h-full'
        : 'hidden'}
    >
      <Workspace
        mode={lastContentView}
        active={activeView === 'projects' || activeView === 'chats' || activeView === 'threads'}
        scopeViewActive={activeView === 'scope'}
        {navigate}
        {config}
        {updateConfig}
      />
    </div>
    {#if activeView === 'scope'}
      {#await import('$lib/components/scope/ScopeView.svelte') then { default: ScopeView }}
        <ScopeView {navigateToProjects} />
      {/await}
    {:else if isSettingsView(activeView)}
      <!-- Each settings section is its own dedicated page in the navigation model.
           The view stays mounted and SettingsView swaps its content on the section
           prop — a keyed remount here would flash the screen on every tab switch. -->
      {#await import('$lib/components/settings/SettingsView.svelte') then { default: SettingsView }}
        <SettingsView
          {config}
          {settingsReady}
          error={settingsError}
          {setPreference}
          {updateConfig}
          section={settingsSectionForView(activeView) ?? 'general'}
          onNavigateSection={(section) => navigate(settingsViewForSection(section))}
          onBack={() => navigate(lastViewBeforeSettings)}
        />
      {/await}
    {:else if !(activeView === 'projects' || activeView === 'chats' || activeView === 'threads')}
      <div class="flex h-full items-center justify-center">
        <p class="text-sm text-dimmed">Coming soon</p>
      </div>
    {/if}
  </main>
  {#if commandPaletteOpen}
    {#await import('$lib/components/actions/CommandPalette.svelte') then { default: CommandPalette }}
      <CommandPalette
        open={commandPaletteOpen}
        actions={paletteActions}
        title="Search actions"
        placeholder="Search actions, threads, and files…"
        emptyLabel="No matching actions"
        onSelect={handlePaletteSelection}
        onClose={() => (commandPaletteOpen = false)}
        onRestoreFocus={restorePaletteFocus}
        shortcutLabel="Ctrl K"
      />
    {/await}
  {/if}
  {#if fileSearchPaletteOpen}
    {#await import('$lib/components/actions/CommandPalette.svelte') then { default: FileSearchPalette }}
      <FileSearchPalette
        open={fileSearchPaletteOpen}
        actions={fileSearchActions}
        title="Search files across projects"
        placeholder="Type at least two characters…"
        emptyLabel={fileSearchLoading ? 'Searching project files…' : 'No matching files'}
        headerIcon={FileSearch}
        headerIconBadge
        headerIconBadgeClass="border-warning/25 bg-warning/10 text-warning"
        serverFiltered
        onBack={backToCommandPaletteFromFileSearch}
        onQueryChange={handleFileSearchQuery}
        onSelect={handleFileSearchSelection}
        closeOnSelect={false}
        onClose={() => {
          fileSearchPaletteOpen = false
          resetFileSearch()
        }}
      />
    {/await}
  {/if}
  {#if threadSearchPaletteOpen}
    {#await import('$lib/components/actions/CommandPalette.svelte') then { default: ThreadSearchPalette }}
      <ThreadSearchPalette
        open={threadSearchPaletteOpen}
        actions={threadSearchActions}
        title="Search threads across projects"
        placeholder="Search thread titles and messages across all projects…"
        emptyLabel={threadSearchLoading
          ? 'Searching threads…'
          : 'Type at least two characters to search all projects'}
        headerIcon={MessagesSquare}
        headerIconBadge
        headerIconBadgeClass="border-info/25 bg-info/10 text-info"
        serverFiltered
        onBack={backToCommandPaletteFromThreadSearch}
        onQueryChange={handleThreadSearchQuery}
        onSelect={handleThreadSearchSelection}
        closeOnSelect={false}
        onClose={() => {
          threadSearchPaletteOpen = false
          resetThreadSearch()
        }}
      />
    {/await}
  {/if}
  {#if newProjectSpotlightOpen}
    {#await import('$lib/components/shared/ProjectCreateControl.svelte') then { default: ProjectCreateControl }}
      <ProjectCreateControl
        mode="spotlight"
        open={newProjectSpotlightOpen}
        onClose={closeNewProjectSpotlight}
        projects={scopeState.projectRecords}
        onProjectCreated={handleSpotlightProjectCreated}
        onExisting={handleSpotlightExistingProject}
      />
    {/await}
  {/if}
  {#if onboardingOpen}
    {#key onboardingStep}
      {#await import('$lib/components/onboarding/OnboardingTour.svelte') then { default: OnboardingTour }}
        <OnboardingTour
          step={onboardingStep}
          onStepChange={updateOnboardingStep}
          onChooseProject={chooseOnboardingProject}
          onBrowseHarnesses={browseHarnessesFromOnboarding}
          onFinish={finishOnboarding}
        />
      {/await}
    {/key}
  {/if}
  <Toaster />
  <TooltipHost />
  {#if pipState.active && pipState.frameDataUrl !== null}
    {#await import('$lib/components/pip/PipOverlay.svelte') then { default: PipOverlay }}
      <PipOverlay />
    {/await}
  {/if}

  {#if closeConfirmation}
    {#await import('$lib/components/layout/CloseConfirmationModal.svelte') then { default: CloseConfirmationModal }}
      <CloseConfirmationModal
        payload={closeConfirmation}
        projects={scopeState.projectRecords}
        onDismiss={() => (closeConfirmation = null)}
        onConfirm={confirmForceClose}
        onConfirmSave={confirmForceCloseSaving}
      />
    {/await}
  {/if}

  {#if harnessLifecycleStore.runs.length}
    <!-- Floats above every view — survives navigation while tasks keep running. -->
    {#await import('$lib/components/providers/HarnessRunModal.svelte') then { default: HarnessRunModal }}
      <HarnessRunModal />
    {/await}
  {/if}

  {#if prLifecycleStore.drafts.length}
    <!-- Floats above every view — survives thread/project/view and sidebar visibility. -->
    {#await import('$lib/components/git/PrDockHost.svelte') then { default: PrDockHost }}
      <PrDockHost />
    {/await}
  {/if}

  {#if (activeView === 'scope' || isSettingsView(activeView)) && contextSidebarState.sidebarVisible && contextSidebarState.sidebarActiveTab?.kind === 'notifications'}
    <div
      class="fixed bottom-0 right-0 top-12 z-40 w-[480px] border-l border-border bg-surface shadow-xl"
    >
      {#await import('$lib/components/notifications/NotificationPanel.svelte') then { default: NotificationPanel }}
        <NotificationPanel />
      {/await}
    </div>
  {/if}
</div>
