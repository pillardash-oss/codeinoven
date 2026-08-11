<script lang="ts">
  import { onMount } from 'svelte'
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
  import { scopeState } from '$lib/stores/scope.svelte'
  import { clearDraftLabelCookie } from '$lib/stores/draft-label'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { harnessLifecycleStore } from '$lib/stores/harness-lifecycle.svelte'
  import { loadProjectIcons } from '$lib/project-icons'
  import { APP_NAME } from '$shared/brand'
  import type { ActionDefinition, ActionSelection, ActionSource } from '$lib/actions'
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
    type AppConfig,
    type AppConfigPatch,
    type Project,
    type ThemePreference,
    type Thread
  } from '$shared/types'
  import type {
    AgentNotificationPayload,
    CloseConfirmationPayload,
    ThreadClickedPayload
  } from '$shared/ipc-contract'

  type View = MainView

  const defaultConfig: AppConfig = {
    theme: 'system',
    threadLimit: 70,
    questionTimeoutMs: 300_000,
    keybindings: {},
    slashCommandMode: 'app',
    preferredEditor: 'system',
    memory: { enabled: true, chatEnabled: true, entries: [] },
    agentDefaults: { syncFromThreadChanges: false },
    autoDownloadUpdates: true,
    autoInstallUpdates: true,
    updateChannel: 'stable',
    keepAwakeWhileWorking: false,
    imageDescriptorAskAgain: false,
    autoRetryAfterReset: true,
    resumeWorkOnRestart: true
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
  let paletteFocusBookmark: ElementSelectionBookmark | null = null

  interface FileSearchTarget {
    projectId: string
    path: string
  }

  const fileSearchTargets = new SvelteMap<ActionDefinition['id'], FileSearchTarget>()

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
      keywords: ['workspace', 'threads']
    },
    {
      id: 'app:chats',
      title: 'Open chats',
      description: 'Browse standalone conversations',
      category: 'navigation',
      source: applicationSource,
      keywords: ['conversations', 'messages']
    },
    {
      id: 'app:scope',
      title: 'Open scope',
      description: 'Review work across projects',
      category: 'navigation',
      source: applicationSource,
      keywords: ['board', 'overview']
    },
    {
      id: 'app:threads',
      title: 'Open threads',
      description: 'Browse threads across all projects',
      category: 'navigation',
      source: applicationSource,
      keywords: ['timeline', 'all']
    }
  ] satisfies ActionDefinition[]

  const settingsTabs: Array<{
    id: SettingsSection
    label: string
    keywords: string[]
  }> = [
    { id: 'general', label: 'General', keywords: ['appearance', 'theme', 'preferences'] },
    { id: 'memory', label: 'Memory', keywords: ['instructions', 'knowledge'] },
    {
      id: 'audits',
      label: 'Agents',
      keywords: ['senior engineer', 'worker', 'auditor', 'achievement', 'review']
    },
    { id: 'harnesses', label: 'Harnesses', keywords: ['models', 'providers', 'harnesses'] },
    {
      id: 'utilities',
      label: 'Utilities',
      keywords: ['mcp', 'skills', 'capabilities', 'computer use', 'tools']
    },
    { id: 'remote', label: 'Remote', keywords: ['ssh', 'host'] },
    { id: 'profile', label: 'Profile', keywords: ['account', 'usage', 'activity', 'cloud'] },
    {
      id: 'about',
      label: 'About',
      keywords: ['version', 'updates', 'storage', 'data', 'diagnostics', 'logs', 'debug']
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
    keywords: ['settings', 'preferences', ...tab.keywords],
    ...(tab.id === 'general' ? { shortcut: ['Ctrl', ','] } : {})
  }))

  let paletteContextActions = $derived.by((): ActionDefinition[] => {
    const workspaceVisible =
      activeView === 'projects' || activeView === 'chats' || activeView === 'threads'
    const actions: ActionDefinition[] = [
      {
        id: 'app:new-project',
        title: 'Create new project',
        description: 'Add a local or remote project',
        category: 'command',
        source: applicationSource,
        keywords: ['add', 'folder', 'repository']
      },
      {
        id: 'app:notifications',
        title: 'Toggle notifications',
        description: 'Open or close the notifications sidebar',
        category: 'navigation',
        source: applicationSource,
        keywords: ['alerts', 'completed', 'attention']
      }
    ]

    if (
      scopeState.projectRecords.some(
        (project) => !project.hidden && project.source === 'local' && project.path
      )
    ) {
      actions.push({
        id: 'app:file-search',
        title: 'Search files across projects',
        description: 'Find and open a file from any local project',
        category: 'file',
        source: applicationSource,
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
        shortcut: ['Ctrl', 'N'],
        keywords: ['task', 'conversation', 'project']
      })
    }

    const thread = workspaceVisible ? workspaceState.selectedThread : null
    if (thread) {
      actions.push(
        {
          id: 'app:memory',
          title: 'Toggle memory sidebar',
          description: 'View the memory context available to this thread',
          category: 'navigation',
          source: applicationSource,
          keywords: ['prompt', 'instructions', 'context']
        },
        {
          id: 'app:sources',
          title: 'Toggle sources sidebar',
          description: 'View sources attached to this conversation',
          category: 'navigation',
          source: applicationSource,
          keywords: ['citations', 'references', 'attachments']
        }
      )
    }

    return actions
  })

  let paletteActions = $derived([
    ...paletteContextActions,
    ...navigationActions,
    ...settingsActions,
    ...actionContext.actions
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
      applyTheme()
      settingsError = undefined
    } catch {
      settingsError = 'Settings could not be loaded. Defaults are being used.'
    } finally {
      settingsReady = true
    }
  }

  async function updateConfig(patch: AppConfigPatch): Promise<void> {
    const previous = config
    config = { ...config, ...patch }
    applyTheme()
    try {
      config = await invoke('config:update', patch)
      applyTheme()
      settingsError = undefined
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
        navigate('projects')
        workspaceState.requestAddProject()
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
      case 'app:notifications':
        contextSidebarState.toggleNotifications()
        return
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
          const entries = await invoke('projectFiles:search', project.id, query, 'all')
          return {
            project,
            entries: entries.filter((entry) => entry.kind === 'file').slice(0, 12)
          }
        } catch {
          return { project, entries: [] }
        }
      })
    )
    if (request !== fileSearchRequest || !fileSearchPaletteOpen) return

    const targets = new SvelteMap<ActionDefinition['id'], FileSearchTarget>()
    const actions: ActionDefinition[] = []
    for (const { project, entries } of projectResults) {
      for (const entry of entries) {
        const id = actionId(`file:${project.id}:${entry.path}`)
        targets.set(id, { projectId: project.id, path: entry.path })
        actions.push({
          id,
          title: entry.name,
          description: `${project.name} · ${entry.path}`,
          category: 'file',
          source: {
            id: `project:${project.id}`,
            label: project.name,
            kind: 'app'
          },
          keywords: [project.name, entry.path]
        })
      }
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
    navigate('projects')
    workspaceState.requestProjectFileOpen(target.projectId, target.path)
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
      notificationPanelState.hydrateFromThreads(visibleThreads)

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
          if (scopeState.activeProjectId) {
            void providerCatalog.refresh(scopeState.activeProjectId, true)
          }
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
  async function openThreadFromNotification(thread: Thread, project: Project): Promise<void> {
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

    if (payload.kind === 'completed') {
      toast.success(payload.title, options)
    } else if (payload.kind === 'attention') {
      toast.warning(payload.title, options)
    } else {
      toast.error(payload.title, options)
    }
  }

  /** The user approved the force close — tell main to proceed with quitting. */
  async function confirmForceClose(): Promise<void> {
    await invoke('app:confirmClose')
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
    })
    const unsubscribeThreadDeleted = subscribe('thread:deleted', (projectId, threadId) => {
      scopeState.removeThread(threadId)
      notificationPanelState.dismissForThread(projectId, threadId)
      if (workspaceState.selectedThread?.id === threadId) workspaceState.clearThread()
    })
    const unsubscribeCloseShortcut = subscribe('window:closeShortcut', () => {
      handleCloseShortcut()
    })
    updaterState.init()
    // The PiP overlay subscribes to `computerUse:pipFrame`/`pipState` events;
    // initialise the store here so the overlay's dynamic import can be gated on
    // `pipState.active` without ever missing a frame.
    pipState.init()
    return () => {
      unsubscribeClick()
      unsubscribeShow()
      unsubscribeConfirmClose()
      unsubscribeThreadUpdated()
      unsubscribeThreadDeleted()
      unsubscribeCloseShortcut()
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
   * or the open thread. Only when nothing is active does it close the window
   * (through the working-threads confirmation gate in the main process).
   */
  function handleCloseShortcut(): void {
    // App-managed palettes first — they float above every view.
    if (fileSearchPaletteOpen) {
      fileSearchPaletteOpen = false
      resetFileSearch()
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
    // An open thread: deselect it back to the thread list.
    if (
      (activeView === 'projects' || activeView === 'chats' || activeView === 'threads') &&
      workspaceState.selectedThread
    ) {
      workspaceState.clearThread()
      return
    }
    // Nothing active — close the window through the confirmation gate.
    void invoke('app:requestClose')
  }

  function handleFind(): void {
    const active = document.activeElement instanceof Element ? document.activeElement : null
    if (active?.closest('[data-region="file-tree"]')) {
      findNavState.focusFileTreeFilter++
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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
      // Primary path is the main process `before-input-event` → the
      // `window:closeShortcut` event. This is a fallback for platforms where
      // the key still reaches the renderer (the main process preventDefaults
      // the page keydown, so this normally never fires twice).
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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      if (e.repeat) return

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
    const hydrationTimer = window.setTimeout(() => {
      void loadScopeData().finally(() => {
        // Signal the main process that the renderer finished its initial
        // hydration so it can timestamp the final startup phases.
        void invoke('app:rendererReady').catch(() => undefined)
      })
    }, 0)

    return () => {
      mq.removeEventListener('change', onColorSchemeChange)
      window.removeEventListener('keydown', onKeydown)
      restoreWorkspaceCallbacks()
      unsubscribeIpc()
      unsubscribeShutdown()
      window.clearTimeout(hydrationTimer)
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
        placeholder="Search models, modes, skills, MCP, and commands…"
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
        onQueryChange={handleFileSearchQuery}
        onSelect={handleFileSearchSelection}
        onClose={() => {
          fileSearchPaletteOpen = false
          resetFileSearch()
        }}
      />
    {/await}
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
