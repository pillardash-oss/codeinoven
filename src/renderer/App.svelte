<script lang="ts">
  import AppHeader from '$lib/components/layout/AppHeader.svelte'
  import Workspace from '$lib/components/workspace/Workspace.svelte'
  import ScopeView from '$lib/components/scope/ScopeView.svelte'
  import SettingsView from '$lib/components/settings/SettingsView.svelte'
  import NotificationPanel from '$lib/components/notifications/NotificationPanel.svelte'
  import PipOverlay from '$lib/components/pip/PipOverlay.svelte'
  import HarnessRunModal from '$lib/components/providers/HarnessRunModal.svelte'
  import CloseConfirmationModal from '$lib/components/layout/CloseConfirmationModal.svelte'
  import { CommandPalette } from '$lib/components/actions'
  import Toaster from '$lib/components/ui/Toaster.svelte'
  import TooltipHost from '$lib/components/ui/TooltipHost.svelte'
  import { toast } from 'svelte-sonner'
  import { SvelteMap } from 'svelte/reactivity'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import {
    rendererRecovery,
    isSettingsSection,
    isSettingsView,
    settingsSectionForView,
    settingsViewForSection,
    type MainView,
    type SettingsSection
  } from '$lib/stores/renderer-recovery.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import {
    navigationHistoryState,
    type NavigationLocation
  } from '$lib/stores/navigation-history.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { updaterState } from '$lib/stores/updater.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
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
    keepAwakeWhileWorking: false
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

  /** Content view to return to when leaving Settings or Scope. */
  let lastContentView = $state<'projects' | 'chats' | 'threads'>(
    rendererRecovery.activeView === 'chats'
      ? 'chats'
      : rendererRecovery.activeView === 'threads'
        ? 'threads'
        : 'projects'
  )

  /** The view the user was on before opening Settings — the Settings back button returns here. */
  let lastViewBeforeSettings = $state<View>(
    isSettingsView(rendererRecovery.activeView) ? 'projects' : rendererRecovery.activeView
  )

  let effectiveTheme = $derived(
    config.theme === 'system' ? (systemDark ? 'dark' : 'light') : config.theme
  )

  $effect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    systemDark = mq.matches
    const onChange = (e: MediaQueryListEvent): void => {
      systemDark = e.matches
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  })

  $effect(() => {
    document.documentElement.classList.toggle('dark', effectiveTheme === 'dark')
  })

  async function loadConfig(): Promise<void> {
    try {
      config = await invoke('config:get')
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
    try {
      config = await invoke('config:update', patch)
      settingsError = undefined
    } catch {
      config = previous
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
    if (view === 'projects' || view === 'chats' || view === 'threads') {
      lastContentView = view
    }
    // Remember the last non-settings view so the Settings back button can return to it.
    if (!isSettingsView(view)) {
      lastViewBeforeSettings = view
    }
    activeView = view
    rendererRecovery.setActiveView(view)
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
    const allThreads: Thread[] = await invoke('thread:listAll')
    const thread = allThreads.find((candidate) => candidate.id === entry.thread?.threadId)
    if (!thread) return
    const projects: Project[] = await invoke('project:list')
    const project = projects.find((candidate) => candidate.id === thread.projectId) ?? null
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

  $effect(() => {
    workspaceState.navigateToSettings = (tab?: string) => {
      navigate(isSettingsSection(tab) ? settingsViewForSection(tab) : 'settings')
    }
    workspaceState.navigateToContent = () => navigate(lastContentView)
    workspaceState.openThreadFromNotification = (thread, project) =>
      openThreadFromNotification(thread, project)
  })

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
      const [projectList, threadList] = await Promise.all([
        invoke('project:list'),
        invoke('thread:listAll')
      ])
      const icons = await loadProjectIcons(projectList)
      scopeState.setScopesFromProjects(projectList, icons, preferredProjectId)
      scopeState.setThreads(threadList)
      notificationPanelState.hydrateFromThreads(threadList)
      await scopeState.loadBoard()
      // Seed model pickers from persisted snapshots. Harness discovery remains
      // lazy and never starts project runtimes during application startup.
      void providerCatalog.init([...projectList.map((project) => project.id), INBOX_PROJECT_ID])
      // Canonical-ordered harness list (registry order) — the model picker's
      // harness filter sorts against this so its chip order never depends on
      // catalog insertion order.
      void providerStore.init()
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

  /** Notification click navigates to the thread. */
  $effect(() => {
    const unsubscribeClick = subscribe('notification:threadClicked', (payload) => {
      void openNotificationThread(payload)
    })
    const unsubscribeShow = subscribe('notification:show', showAgentNotification)
    const unsubscribeConfirmClose = subscribe('window:confirmClose', (payload) => {
      closeConfirmation = payload
    })
    const unsubscribeThreadUpdated = subscribe('thread:updated', (...args: unknown[]) => {
      const thread = args[0] as Thread
      if (thread.read) {
        notificationPanelState.dismissForThread(thread.projectId, thread.id)
      }
    })
    updaterState.init()
    return () => {
      unsubscribeClick()
      unsubscribeShow()
      unsubscribeConfirmClose()
      unsubscribeThreadUpdated()
      updaterState.destroy()
    }
  })

  /** Clean up renderer resources when the main process signals shutdown. */
  $effect(() => {
    const unsubscribe = subscribe('window:beforeQuit', () => {
      // Renderer should release event subscriptions — the main process
      // will dispose services and flush logs 500ms after this signal.
      // The component tree unmounts naturally as the window closes.
    })
    return unsubscribe
  })

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
    if (active?.closest('[data-region="conversation"]')) {
      findNavState.openConversationFind()
      return
    }

    // Toolbar focus still belongs to the visible regular/fullscreen file surface.
    if (document.querySelector('[data-region="editor"][data-find-active="true"]')) {
      findNavState.openEditorFind()
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
  $effect(() => {
    const onKeydown = (e: KeyboardEvent): void => {
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
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  })

  void loadConfig()
  void loadScopeData()

  navigationHistoryState.init(rendererRecovery.activeView, rendererRecovery.selectedThread)

  /** Record every view/thread location change in the global navigation history. */
  $effect(() => {
    navigationHistoryState.observe(currentLocation())
  })
</script>

<div class="flex h-screen flex-col bg-app">
  <AppHeader
    {activeView}
    {navigate}
    {goBack}
    {goForward}
    onCommandPaletteOpen={toggleCommandPalette}
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
      />
    </div>
    {#if activeView === 'scope'}
      <ScopeView {navigateToProjects} />
    {:else if isSettingsView(activeView)}
      <!-- Each settings section is its own dedicated page. -->
      {#key activeView}
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
      {/key}
    {:else if !(activeView === 'projects' || activeView === 'chats' || activeView === 'threads')}
      <div class="flex h-full items-center justify-center">
        <p class="text-sm text-dimmed">Coming soon</p>
      </div>
    {/if}
  </main>
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
  <CommandPalette
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
  <Toaster />
  <TooltipHost />
  <PipOverlay />

  <CloseConfirmationModal
    payload={closeConfirmation}
    onDismiss={() => (closeConfirmation = null)}
    onConfirm={confirmForceClose}
  />

  {#if harnessLifecycleStore.runs.length}
    <!-- Floats above every view — survives navigation while tasks keep running. -->
    <HarnessRunModal />
  {/if}

  {#if (activeView === 'scope' || isSettingsView(activeView)) && contextSidebarState.sidebarVisible && contextSidebarState.sidebarActiveTab?.kind === 'notifications'}
    <div
      class="fixed bottom-0 right-0 top-12 z-40 w-[480px] border-l border-border bg-surface shadow-xl"
    >
      <NotificationPanel />
    </div>
  {/if}
</div>
