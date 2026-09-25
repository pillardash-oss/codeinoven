<script lang="ts">
  import { onMount } from 'svelte'
  import { FileSearch, FolderKanban, MessagesSquare } from '@lucide/svelte'
  import type { CommandPaletteProps } from '$lib/components/actions/CommandPalette.svelte'
  import AppHeader from '$lib/components/layout/AppHeader.svelte'
  import Workspace from '$lib/components/workspace/Workspace.svelte'
  import Toaster from '$lib/components/ui/Toaster.svelte'
  import TooltipHost from '$lib/components/ui/TooltipHost.svelte'
  import TextSelectionContextMenu from '$lib/components/shared/TextSelectionContextMenu.svelte'
  import { toast } from 'svelte-sonner'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { closeTopVisibleDialog, requestCloseTopOverlay } from '$lib/overlay-close.svelte'
  import { activateTopModalPrimaryAction } from '$lib/modal-primary-action.svelte'
  import { initComposerFocusShortcut } from '$lib/focus/composer-focus-shortcut'
  import {
    rendererRecovery,
    flushAllDraftCommits,
    isSettingsSection,
    isSettingsView,
    settingsSectionForView,
    settingsViewForSection,
    type MainView
  } from '$lib/stores/renderer-recovery.svelte'
  import { workspaceState, threadVisitKey } from '$lib/stores/workspace.svelte'
  import {
    contentThreadFamily,
    decideContentViewThread,
    type ContentThreadFamily
  } from '$lib/content-view-threads'
  import {
    navigationHistoryState,
    type NavigationLocation
  } from '$lib/stores/navigation-history.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { schemeState } from '$lib/stores/scheme.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { temporaryChatUnread } from '$lib/stores/temporary-chat-unread.svelte'
  import { pipState } from '$lib/stores/pip.svelte'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { appQuitState } from '$lib/stores/app-quit.svelte'
  import { visionModels } from '$lib/stores/vision-models.svelte'
  import { isTerminalFocused } from '$lib/terminal/focus'
  import { COMPOSER_DRAFT_SELECTOR } from '$lib/components/chats/chat-composer-draft-surface'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
  import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
  import { scopeConfirmations } from '$lib/stores/scope-confirmations.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerConnectFlow } from '$lib/stores/provider-connect-flow.svelte'
  import { harnessLifecycleStore } from '$lib/stores/harness-lifecycle.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { prBatchJobs } from '$lib/stores/pr-batch-jobs.svelte'
  import { gitSyncJobs } from '$lib/stores/git-sync-jobs.svelte'
  import { loadProjectIcons } from '$lib/project-icons'
  import { preloadScopeChunk, preloadSettingsChunk } from '$lib/page-preload'
  import type { ActionSelection } from '$lib/actions'
  import { actionContext } from '$lib/stores/action-context.svelte'
  import {
    captureElementSelection,
    restoreElementSelection,
    type ElementSelectionBookmark
  } from '$lib/selection-bookmark'
  import {
    DEFAULT_SCOPE_BUCKET_ID,
    INBOX_PROJECT_ID,
    isOrchestrationChildThread,
    isThreadWorking,
    threadTracksReadStatus,
    type AppConfig,
    type AppConfigPatch,
    type Project,
    type ThemePreference,
    type Thread
  } from '$shared/types'
  import type { CloseConfirmationPayload, CloseConfirmationProject } from '$shared/ipc-contract'
  import { initVoiceShortcutListener } from '$lib/speech/voice-shortcut'
  import {
    actionId,
    buildPaletteContextActions,
    navigationActions,
    settingsActions,
    settingsTabs
  } from './app-palette-actions'
  import { defaultConfig } from './app-defaults'
  import { FileSearchPaletteController } from './app-file-search.svelte'
  import { ThreadSearchPaletteController } from './app-thread-search.svelte'
  import { ProjectSwitchPaletteController } from './app-project-switch.svelte'
  import { handleOpenedPaths, type OsHandoffDeps } from './app-os-handoff'
  import { installAppIpcSubscriptions } from './app-ipc-subscriptions'

  type View = MainView

  let config = $state<AppConfig>(defaultConfig)
  let settingsReady = $state(false)
  let settingsError = $state<string>()
  let systemDark = $state(false)
  let activeView = $state<View>(rendererRecovery.activeView)
  let commandPaletteOpen = $state(false)
  let closeConfirmation = $state<CloseConfirmationPayload | null>(null)
  const fileSearch = new FileSearchPaletteController()
  const threadSearch = new ThreadSearchPaletteController({
    openThread: (thread) => void openThreadFromSearch(thread)
  })
  const projectSwitch = new ProjectSwitchPaletteController({
    focusProject: (project) => focusProjectFromSpotlight(project)
  })

  const osHandoffDeps: OsHandoffDeps = {
    navigate: (view) => navigate(view),
    onProjectCreated: (project) => handleProjectCreated(project)
  }

  let newProjectSpotlightOpen = $state(false)
  let onboardingOpen = $state(false)
  let onboardingStep = $state(0)
  let onboardingInitialized = false
  let onboardingProjectPickerActive = false
  let paletteFocusBookmark: ElementSelectionBookmark | null = null

  let paletteContextActions = $derived(
    buildPaletteContextActions({
      activeView,
      projectRecords: scopeState.projectRecords,
      activeProjectId: scopeState.activeProjectId,
      sidebarContext: scopeState.sidebarContext,
      activeProject: workspaceState.activeProject,
      selectedThread: workspaceState.selectedThread
    })
  )

  let paletteActions = $derived([
    ...paletteContextActions,
    ...navigationActions,
    ...settingsActions,
    // Harness-bound actions (model pickers, slash commands) belong to the inline
    // menus   the global Cmd+K surface keeps app-level and cross-harness actions.
    ...actionContext.actions.filter((action) => action.source.kind !== 'harness')
  ])

  /** The spotlight is one surface, not four. `actions` is its home screen; the
   *  other three open from it and only ever show inside the same shell. */
  type SpotlightScreenId = 'actions' | 'files' | 'threads' | 'projects'

  /** The screen on top. A nested screen outranks the actions list, because
   *  picking one closes the actions list in the same flush. */
  function resolveSpotlightScreen(): SpotlightScreenId | null {
    if (fileSearch.paletteOpen) return 'files'
    if (threadSearch.paletteOpen) return 'threads'
    if (projectSwitch.paletteOpen) return 'projects'
    if (commandPaletteOpen) return 'actions'
    return null
  }

  let spotlightScreenId = $derived(resolveSpotlightScreen())

  /**
   * The props for the single mounted palette, for whichever screen is on top.
   *
   * Swapping the screen must not tear the shell down: unmounting one palette and
   * mounting the next threw the scrim, the panel, the scroll lock and the focus
   * away and built them again, which is what made the surface flash on every hop
   * between the home screen and a nested one. One instance with `screenKey`
   * swapped instead keeps the panel and leaves the query input focused.
   */
  let spotlightPalette = $derived.by((): CommandPaletteProps => {
    /** What every spotlight screen shares; each screen adds its own list. */
    const shell: Omit<CommandPaletteProps, 'actions' | 'onSelect'> = {
      open: true,
      screenKey: spotlightScreenId ?? 'actions',
      onClose: closeSpotlight,
      onRestoreFocus: restorePaletteFocus
    }

    switch (spotlightScreenId) {
      case 'files':
        return {
          ...shell,
          actions: fileSearch.actions,
          title: 'Search files across projects',
          placeholder: 'Type at least two characters…',
          emptyLabel: fileSearch.loading ? 'Searching project files…' : 'No matching files',
          headerIcon: FileSearch,
          headerIconBadge: true,
          headerIconBadgeClass: 'border-warning/25 bg-warning/10 text-warning',
          serverFiltered: true,
          projects: scopeState.projects,
          selectedProjectIds: fileSearch.projectIds,
          onSelectedProjectsChange: (projectIds) => fileSearch.setScope(projectIds),
          onBack: backToSpotlightHome,
          onQueryChange: (query) => fileSearch.handleQuery(query),
          onSelect: (selection) => fileSearch.select(selection),
          closeOnSelect: false
        }
      case 'threads':
        return {
          ...shell,
          actions: threadSearch.actions,
          title: 'Search threads across projects',
          placeholder: 'Search thread titles and messages across all projects…',
          emptyLabel: threadSearch.loading
            ? 'Searching threads…'
            : 'Type at least two characters to search all projects',
          headerIcon: MessagesSquare,
          headerIconBadge: true,
          headerIconBadgeClass: 'border-info/25 bg-info/10 text-info',
          serverFiltered: true,
          projects: scopeState.projects,
          selectedProjectIds: threadSearch.projectIds,
          onSelectedProjectsChange: (projectIds) => threadSearch.setScope(projectIds),
          onBack: backToSpotlightHome,
          onQueryChange: (query) => threadSearch.handleQuery(query),
          onSelect: (selection) => threadSearch.select(selection),
          closeOnSelect: false
        }
      case 'projects':
        return {
          ...shell,
          actions: projectSwitch.actions,
          title: 'Switch project',
          placeholder: 'Search projects…',
          emptyLabel: 'No matching projects',
          headerIcon: FolderKanban,
          headerIconBadge: true,
          headerIconBadgeClass: 'border-success/25 bg-success/10 text-success',
          onBack: backToSpotlightHome,
          onSelect: (selection) => projectSwitch.select(selection),
          closeOnSelect: false
        }
      default:
        return {
          ...shell,
          actions: paletteActions,
          title: 'Search actions',
          placeholder: 'Search actions, threads, and files…',
          emptyLabel: 'No matching actions',
          onSelect: handlePaletteSelection,
          shortcutLabel: 'Ctrl K'
        }
    }
  })

  /** Content view to return to when leaving Settings or Scope   persisted in the
   *  recovery snapshot so a restart made while on a Settings page or the Scope
   *  view still returns to the previous content view instead of resetting to Projects. */
  let lastContentView = $derived(rendererRecovery.lastContentView)

  /** The view the user was on before opening Settings   the Settings back button returns here. */
  let lastViewBeforeSettings = $derived(rendererRecovery.lastViewBeforeSettings)

  let effectiveTheme = $derived(
    config.theme === 'system' ? (systemDark ? 'dark' : 'light') : config.theme
  )

  function applyTheme(): void {
    document.documentElement.classList.toggle('dark', effectiveTheme === 'dark')
    schemeState.sync(effectiveTheme)
  }

  /** Welcome screen (and other surfaces) can request the getting-started tour. */
  $effect(() => {
    if (workspaceState.consumeOnboardingRequest()) {
      onboardingStep = 0
      onboardingOpen = true
    }
  })

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
    // Warm the lazy page chunks so the view swap resolves instantly   the
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
    } else if (view === 'assistant') {
      scopeState.clearSidebarContext()
    } else if (view === 'projects') {
      // Leaving the registered scoped view (or any scoped state) for the plain
      // projects view: the sidebar is what defines the scoped state, so close
      // it   the sidebar context itself is stashed for later restore.
      scopeState.clearSidebarContext()
    }
    activeView = view
    // Persists the view and tracks the last content / non-settings views, so
    // returning from Settings (even across a restart) lands back where the user
    // was instead of resetting to Projects.
    rendererRecovery.setActiveView(view)
    reconcileThreadForContentView(view)
    observeNavigationLocation()
  }

  function observeNavigationLocation(): void {
    navigationHistoryState.observe(currentLocation())
  }

  /** The most recently visited thread of one content-view family that still exists. */
  function lastThreadOfFamily(family: ContentThreadFamily): Thread | null {
    for (const key of workspaceState.recentThreadVisits) {
      const thread = scopeState.allScopeThreads.find(
        (candidate) => threadVisitKey(candidate) === key
      )
      if (!thread || thread.archived) continue
      if (contentThreadFamily(thread) === family) return thread
    }
    return null
  }

  /** The thread a content-view family was last showing, resolved against the live list. */
  function rememberedThreadOfFamily(family: ContentThreadFamily): Thread | null {
    const ref = workspaceState.contentViewThreadRef(family)
    if (!ref) return null
    const thread = scopeState.allScopeThreads.find(
      (candidate) => candidate.id === ref.threadId && candidate.projectId === ref.projectId
    )
    return thread && !thread.archived ? thread : null
  }

  /**
   * Keep the open thread in step with the content view the shell switched to.
   *
   * Each content-view family (Projects, Chats, Assistant) remembers the thread
   * it was last showing, so moving between them restores that family's own
   * thread instead of one global selection that the last visited view wins.
   * Covers every navigation path (nav buttons, command palette, programmatic
   * navigation like "continue in a project", notifications), not just the
   * header buttons.
   */
  function reconcileThreadForContentView(view: View): void {
    const decision = decideContentViewThread(view, workspaceState.selectedThread, {
      remembered: rememberedThreadOfFamily,
      recentOfFamily: lastThreadOfFamily
    })
    if (decision.kind === 'keep') return
    if (decision.kind === 'clear') {
      workspaceState.clearThread()
      return
    }
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === decision.thread.projectId) ??
      null
    workspaceState.openThread(decision.thread, project)
    void scopeState.ensureBoardLoaded(decision.thread.projectId)
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
    workspaceState.openThreadFromNotification = (thread, project, temporaryChatId) =>
      openThreadFromNotification(thread, project, temporaryChatId)
    return () => {
      workspaceState.navigateToSettings = null
      workspaceState.navigateToContent = null
      workspaceState.openThreadFromNotification = null
    }
  }

  /**
   * Start the "new thread" flow for whatever the shell is showing. Shared by
   * the Cmd/Ctrl+N chord and the palette's "New thread" action so both always
   * agree.
   *
   * The scoped threads view is the state with the scope sidebar docked. The
   * shell reports it either as its own `projects-scope` view or as `projects`
   * with a live sidebar context, so both spellings are handled here   the same
   * test the header switcher, the sidebar and the notification router use. It
   * targets the docked scope's project and bucket directly, exactly like the
   * sidebar's own new-thread button, which also makes it work from the empty
   * state where no thread (and therefore no active project) is open.
   */
  function requestThreadForCurrentView(): void {
    if (activeView === 'scope') {
      if (!scopeState.activeProjectId) return
      scopeState.requestCreateScopedThread(
        scopeState.sidebarContext?.bucketId ?? scopeState.buckets[0]?.id ?? DEFAULT_SCOPE_BUCKET_ID
      )
      return
    }

    const scopedContext = scopeState.sidebarContext
    if ((activeView === 'projects' || activeView === 'projects-scope') && scopedContext) {
      // Docked scoped-threads sidebar: create in the docked scope's project and
      // bucket, never in whatever thread happens to be open.
      workspaceState.requestCreateThread(scopedContext.bucketId)
      return
    }

    if (activeView === 'chats') {
      workspaceState.requestNewChat()
      return
    }
    if (activeView !== 'projects' && activeView !== 'threads') return
    if (workspaceState.activeProject && workspaceState.activeProject.id !== INBOX_PROJECT_ID) {
      // Same-scope inheritance: the new thread inherits the open thread's scope
      // bucket (no stale sidebar bucket, no view switch).
      workspaceState.requestCreateThread()
      return
    }
    workspaceState.requestAddProject()
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
      case 'app:switch-project':
        projectSwitch.openPalette()
        return
      case 'app:new-chat':
        navigate('chats')
        workspaceState.requestNewChat()
        return
      case 'app:new-thread':
        requestThreadForCurrentView()
        return
      case 'app:file-search':
        fileSearch.openPalette()
        return
      case 'app:thread-search':
        threadSearch.openPalette()
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
          contextSidebarState.openMemory(thread.projectId, thread.id, undefined, thread.routineId)
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
      case 'app:chats': {
        // Only a project-family thread is a restorable project thread; an
        // assistant task stashed here would later be restored into the scope
        // sidebar as if it were one.
        const selected = workspaceState.selectedThread
        if (activeView !== 'chats' && selected && contentThreadFamily(selected) === 'projects') {
          scopeState.stashedProjectThreadId = selected.id
        }
        navigate('chats')
        return
      }
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
      !active.matches(COMPOSER_DRAFT_SELECTOR)
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
    // A nested screen steps back to the actions list; the actions list closes.
    if (spotlightScreenId === 'actions') {
      closeSpotlight()
      return
    }
    if (spotlightScreenId) {
      backToSpotlightHome()
      return
    }
    capturePaletteFocus()
    commandPaletteOpen = true
  }

  /** Close the whole spotlight, whichever screen is on top. */
  function closeSpotlight(): void {
    commandPaletteOpen = false
    if (fileSearch.paletteOpen) fileSearch.close()
    if (threadSearch.paletteOpen) threadSearch.close()
    if (projectSwitch.paletteOpen) projectSwitch.close()
  }

  /** Step back to the actions list from a nested spotlight screen. */
  function backToSpotlightHome(): void {
    closeSpotlight()
    commandPaletteOpen = true
  }

  /** Preserve the current content view / project sidebar state when opening a
   *  searched thread   never force the Projects view. Reuses the notification
   *  open logic, which handles scope state, the threads view and chats. */
  async function openThreadFromSearch(thread: Thread): Promise<void> {
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
    await openThreadFromNotification(thread, project)
  }

  async function loadScopeData(preferredProjectId?: string): Promise<void> {
    try {
      // 1. Projects first   the header and project list render immediately
      //    without waiting for the (larger) thread payload.
      const projectList = await invoke('project:list')
      const icons = await loadProjectIcons(projectList)
      scopeState.setScopesFromProjects(projectList, icons, preferredProjectId)

      // 2. Tasks   recent rows only, via the bounded per-project hydration
      //    query. Each project contributes its own recent slice (inbox gets its
      //    configured bucket size), so one busy project can never evict other
      //    projects' threads from the initial paint. Older rows page in on
      //    demand through the workspace/scope views.
      const threadList = await invoke('thread:listRecentPerProject')
      const visibleThreads = threadList.filter((thread) => !thread.archived)
      scopeState.setThreads(visibleThreads)
      notificationPanelState.hydrateFromThreads(visibleThreads, projectList)

      // 3. The selected project's scope board is the visible surface   load it
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
          // Seed model pickers from local snapshots, then kick off a background
          // harness probe automatically (after first paint) so the picker always
          // has live data ready instead of fetching lazily on open.
          void providerCatalog.init(targets, { refresh: true })
          // Canonical-ordered harness list (registry order)   the model picker's
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

  function navigateToScopedThreads(): void {
    navigate('projects-scope')
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

  /** Spotlight flow: a picked folder already exists as a project   focus it. */
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

  /**
   * Focus a project picked from the Switch project spotlight.
   *
   * The scoped threads view keeps its docked sidebar: the picked project becomes
   * the docked scope and the conversation is cleared, so the sidebar shows the
   * new project's scoped threads. Every other view lands on the Projects view
   * with the project's most recent thread open, matching how focusing a project
   * already works elsewhere (OS hand-off, existing-project spotlight, header tabs).
   */
  function focusProjectFromSpotlight(project: Project): void {
    const scopedThreadsActive =
      (activeView === 'projects' || activeView === 'projects-scope') &&
      scopeState.sidebarContext !== null
    const iconUrl =
      scopeState.projects.find((candidate) => candidate.id === project.id)?.iconUrl ?? null

    if (scopedThreadsActive) {
      void scopeState.activateProject(project.id)
      workspaceState.clearThread()
      workspaceState.activeProject = project
      workspaceState.activeProjectIconUrl = iconUrl
      rendererRecovery.setSelectedProject(project.id)
      scopeState.showSidebarForProject(project.id)
      return
    }

    // Navigate before selecting the thread so the shell's content-view reconcile
    // never paints the Projects family's remembered thread for a frame.
    const wasOnProjectsView = activeView === 'projects' || activeView === 'projects-scope'
    if (!wasOnProjectsView) navigate('projects')
    void scopeState.activateProject(project.id)

    // Picking the project that is already focused keeps the conversation the user
    // is reading instead of jumping to its latest thread.
    if (wasOnProjectsView && workspaceState.selectedThread?.projectId === project.id) return

    const thread =
      scopeState.allScopeThreads
        .filter(
          (candidate) =>
            candidate.projectId === project.id &&
            !candidate.archived &&
            !isOrchestrationChildThread(candidate)
        )
        .sort((left, right) => right.lastActivity - left.lastActivity)[0] ?? null
    if (thread) {
      workspaceState.openThread(thread, project, iconUrl)
    } else {
      workspaceState.clearThread()
      workspaceState.activeProject = project
      workspaceState.activeProjectIconUrl = iconUrl
      rendererRecovery.setSelectedProject(project.id)
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

  /**
   * Open a thread from a notification while preserving the current view.
   *
   * The target view follows the thread's own family, so a deep link can never
   * select a thread in a content view that does not own it:
   * - Chat thread → switch to the chats view.
   * - Assistant task → switch to the assistant view.
   * - Regular project view → stay there (no scope sidebar).
   * - Scope state / scope view → stay there and reveal the thread in the sidebar.
   * - Threads view → stay there (no scope sidebar), the project family's own timeline.
   * - Settings or any other view → return to Projects for the thread.
   */
  async function openThreadFromNotification(
    thread: Thread,
    project: Project | null,
    temporaryChatId?: string
  ): Promise<void> {
    const family = contentThreadFamily(thread)
    const inScopeState =
      activeView === 'scope' ||
      activeView === 'projects-scope' ||
      (activeView === 'projects' && Boolean(scopeState.sidebarContext))

    if (family === 'chats') {
      // A chat is only ever shown by the chats view.
      navigate('chats')
    } else if (family === 'assistant') {
      // An assistant task is only ever shown by the assistant view.
      navigate('assistant')
    } else if (inScopeState) {
      // Stay in the scope state: reveal the thread in the scope sidebar.
      if (activeView !== 'projects') navigate('projects')
      scopeState.showSidebarForThread(thread)
      void scopeState.ensureBoardLoaded(thread.projectId)
    } else if (activeView === 'threads') {
      // Stay in the threads view without entering the scope state.
      scopeState.clearSidebarContext()
    } else {
      // A project thread belongs in Projects, so return to it from Settings, the
      // chats view, the assistant view, or any other out-of-family view rather
      // than leaving it selected somewhere that cannot own it.
      if (activeView !== 'projects') navigate('projects')
      scopeState.clearSidebarContext()
    }

    workspaceState.openThread(thread, project)
    if (threadTracksReadStatus(thread)) {
      const updated = await invoke('thread:markRead', thread.projectId, thread.id)
      scopeState.updateThread(updated)
      workspaceState.updateThread(updated)
    }

    if (temporaryChatId) {
      // A temporary (side) chat notification: opening the parent thread alone
      // is not enough   reveal the sidebar and focus the side chat that has
      // the unread response. When its tab no longer exists the badge would
      // never clear, so drop it here instead.
      if (!contextSidebarState.focusTemporaryChat(thread.projectId, thread.id, temporaryChatId)) {
        temporaryChatUnread.clear(thread.projectId, thread.id, temporaryChatId)
      }
    }
  }

  /** The user approved the force close   tell main to proceed with quitting. */
  async function confirmForceClose(): Promise<void> {
    await invoke('app:confirmClose')
  }

  /**
   * While the close-confirmation modal is open, watch the threads it listed as
   * still working. As each one leaves that state (completed, failed, or
   * otherwise no longer executing/planning) it drops off the list. Once none
   * remain   and no unsaved files are pending   the close the user already
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
    const savedProjectFiles = await projectFilesWorkspace.saveAllUnsaved()
    // Standalone files are saved too: they are opened outside any project, so
    // nothing else would ever write their drafts.
    const savedStandaloneFiles = await standaloneFiles.saveAllUnsaved()
    if (savedProjectFiles && savedStandaloneFiles) {
      await invoke('app:confirmClose')
    } else {
      toast.error('Some files could not be saved', {
        description: 'The application stayed open so you can review them.'
      })
    }
  }

  /** Clean up renderer resources when the main process signals shutdown. */
  function installShutdownSubscription(): () => void {
    return subscribe('window:beforeQuit', () => {
      // Renderer should release event subscriptions   the main process
      // will dispose services and flush logs 500ms after this signal.
      // The window itself only closes at the end of that pipeline, so latch the
      // quit signal here: repeating background reads check it and stop instead
      // of polling into the already-closed database. One-shot user-intent work
      // is not gated. Push any debounced DB draft commits now: the main process
      // closes the database later in its shutdown pipeline, and these invokes
      // must land while the grace period is still open.
      appQuitState.markQuitting()
      flushAllDraftCommits()
    })
  }

  /**
   * Cmd/Ctrl+W closes the active surface: the topmost modal, the Settings page,
   * a sidebar panel, or the open thread. When nothing is active the shortcut is
   * intentionally a no-op; application shutdown is reserved for explicit quit
   * actions and the native window close control.
   */
  function handleCloseShortcut(): void {
    // The spotlight is one surface: the close chord closes it whole, whichever
    // screen is on top. Escape is the key that steps back between screens.
    if (spotlightScreenId) {
      closeSpotlight()
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
    // Focus inside the context sidebar: close the active tab of the surface that
    // holds it (through Workspace's unsaved-changes confirmation) instead of
    // clearing the thread. A terminal docked at the bottom is its own surface,
    // so the placement of the focused region decides which tab the chord closes.
    const active = document.activeElement instanceof Element ? document.activeElement : null
    const sidebarRegion = active?.closest<HTMLElement>('[data-region="context-sidebar"]')
    if (sidebarRegion) {
      contextSidebarState.requestCloseActiveTab(
        sidebarRegion.dataset.placement === 'bottom' ? 'dock' : 'sidebar'
      )
      return
    }
    // The context rail is the sidebar's own chrome: a rail icon opens or hides a
    // panel but leaves the focus on the rail button, so the panel the user just
    // revealed (a quick chat above all) must still be what the chord closes.
    // With nothing on screen the rail owns no tab, and the chord falls through
    // to the thread below instead of silently doing nothing.
    if (
      active?.closest('[data-region="context-dock"]') &&
      contextSidebarState.requestCloseActiveTab(contextSidebarState.visible ? 'sidebar' : 'dock')
    ) {
      return
    }
    // An open thread: deselect it back to the thread list.
    if (
      (activeView === 'projects' ||
        activeView === 'chats' ||
        activeView === 'threads' ||
        activeView === 'assistant') &&
      workspaceState.selectedThread
    ) {
      workspaceState.clearThread()
      return
    }
    // Nothing active   keep the application open.
  }

  /**
   * Cmd/Ctrl+T while a terminal is focused opens a new terminal tab in the
   * terminal panel (right sidebar or bottom dock). The main process only emits
   * this event when it intercepted the key with a terminal focused, but the
   * renderer's own focus flag is the source of truth   re-check it defensively.
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
    if (active?.closest('[data-region="editor"]')) {
      findNavState.openEditorFind()
      return
    }
    // The sidebar keeps GitStatusPanel mounted but display:none for every
    // context tab, so only treat the git panel as the target when it is
    // actually visible (offsetParent is null while hidden).
    const visibleGitPanel = Array.from(document.querySelectorAll('[data-region="git-panel"]')).some(
      (el) => (el instanceof HTMLElement ? el.offsetParent : null) !== null
    )
    if (
      active?.closest('[data-region="git-panel"]') ||
      (active?.closest('[data-region="context-sidebar"]') && visibleGitPanel)
    ) {
      findNavState.openGitFind()
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
      (activeView === 'projects' ||
        activeView === 'chats' ||
        activeView === 'threads' ||
        activeView === 'assistant') &&
      document.querySelector('[data-region="conversation"]')
    ) {
      findNavState.openConversationFind()
      return
    }
  }

  /** Global application shortcuts. */
  function onKeydown(e: KeyboardEvent): void {
    const isMac = window.api?.windowInfo?.platform === 'darwin'
    if (keymapState.matches('ui-modal-primary-action', e)) {
      // ⌘/Ctrl+Enter runs the topmost open modal's primary action. The shared
      // LIFO registry (modal-primary-action.svelte.ts) resolves which modal is
      // in focus; when no modal claims the chord, composers (chat send, git
      // commit, PR sheet) keep their existing focused-element behavior.
      //
      // Held chords fire auto-repeat keydowns; without this guard a repeat
      // that lands after a PR sheet's success screen rendered would re-claim
      // the chord and click "View PR", closing the modal the user just got.
      if (e.repeat) return
      if (activateTopModalPrimaryAction()) {
        e.preventDefault()
        return
      }
    }
    if (keymapState.matches('nav-close-surface', e)) {
      // Primary path is the main process `before-input-event` → the
      // `window:closeShortcut` event. This is a fallback for platforms where
      // the key still reaches the renderer (the main process preventDefaults
      // the page keydown, so this normally never fires twice).
      //
      // On non-mac platforms Ctrl+W is the shell's delete-word binding while a
      // terminal is focused   leave it alone so it reaches the shell.
      if (!isMac && isTerminalFocused()) return
      e.preventDefault()
      if (e.repeat) return
      handleCloseShortcut()
      return
    }
    if (keymapState.matches('nav-find', e)) {
      e.preventDefault()
      if (e.repeat) return
      handleFind()
      return
    }
    if (keymapState.matches('nav-toggle-right-sidebar', e)) {
      // Cmd/Ctrl+Shift+S toggles the right sidebar. Which panel it shows is
      // decided inside Workspace, which owns what the on-screen thread actually
      // offers (file tree, git, terminal, sources...), so the chord only
      // forwards the request. Only the workspace views own that sidebar.
      const rightSidebarViews = ['projects', 'projects-scope', 'chats', 'threads', 'assistant']
      if (!rightSidebarViews.includes(activeView)) return
      e.preventDefault()
      if (e.repeat) return
      workspaceState.requestToggleContextSidebar()
      return
    }
    if (keymapState.matches('nav-toggle-left-sidebar', e)) {
      // On the plain workspace (no studio, no conflict being resolved, no dirty
      // file tab, no edited file opened from the OS) the Cmd/Ctrl+S save chord
      // is otherwise unused, so it folds/unfolds the left sidebar. Anywhere a
      // save binding owns the chord (a Spec/Assignment/Brainstorm studio, the
      // conflict resolution editor, a project file tab with unsaved changes, or
      // an edited standalone file) it keeps priority: we return without
      // preventDefault so that handler saves instead of toggling.
      // Shift is excluded so Cmd/Ctrl+Shift+S reaches the right-sidebar toggle
      // above, which used to fall through to this branch and fold the left
      // sidebar instead.
      if (e.repeat) return
      const leftSidebarViews = ['projects', 'chats', 'threads', 'assistant']
      const studioOpen = Boolean(document.querySelector('[data-region="spec-studio"]'))
      // The conflict editor holds resolved progress that its Save draft owns, so
      // the chord belongs to it even while no plain file tab is dirty.
      const conflictOpen = Boolean(document.querySelector('[data-region="conflict-editor"]'))
      const dirtyFiles = projectFilesWorkspace.getUnsavedFiles().length > 0
      if (!leftSidebarViews.includes(activeView) || studioOpen || conflictOpen || dirtyFiles) {
        return
      }
      if (standaloneFiles.activeHasUnsavedChanges) return
      e.preventDefault()
      sidebarState.toggle()
      return
    }
    if (keymapState.matches('nav-command-palette', e)) {
      e.preventDefault()
      if (e.repeat) return
      toggleCommandPalette()
      return
    }
    if (keymapState.matches('nav-settings', e)) {
      e.preventDefault()
      navigate('settings')
    }
    // Keyboard fallback for back/forward: Cmd+[ / Cmd+] is the convention
    // third-party mouse utilities (Logi Options+, SteerMouse, Mac Mouse Fix)
    // remap side buttons to on macOS, since there's no native OS-level
    // back/forward gesture API for non-Apple mice. Alt+Left/Alt+Right mirrors
    // the same convention on Windows/Linux.
    if (
      keymapState.matches('nav-history-back', e) ||
      keymapState.matches('nav-history-forward', e)
    ) {
      e.preventDefault()
      if (e.repeat) return
      if (keymapState.matches('nav-history-back', e)) void goBack()
      else void goForward()
    }
    if (
      keymapState.matches('nav-new-project', e) ||
      keymapState.matches('assistant-new-routine', e)
    ) {
      e.preventDefault()
      if (e.repeat) return
      // The Assistant view owns Cmd/Ctrl+Shift+N for a new routine.
      if (activeView === 'assistant') {
        if (spotlightScreenId) closeSpotlight()
        workspaceState.requestAssistantRoutine()
        return
      }
      // Cmd/Ctrl+Shift+N → new-project spotlight from any view except chats (inbox).
      if (activeView === 'chats') return
      if (spotlightScreenId) closeSpotlight()
      openNewProjectSpotlight()
      return
    }
    if (keymapState.matches('nav-new-thread', e) || keymapState.matches('assistant-new-task', e)) {
      e.preventDefault()
      if (e.repeat) return

      // When the file tree has focus, Cmd/Ctrl+N creates a new file there
      // instead of starting a new thread. The tree's own handler manages it.
      const active = document.activeElement instanceof Element ? document.activeElement : null
      if (active?.closest('[data-region="file-tree"]')) return

      // The Assistant view owns Cmd/Ctrl+N for a new task: inside the routine
      // the user is currently in when there is one, routine-less otherwise.
      if (activeView === 'assistant') {
        workspaceState.requestAssistantTask()
        return
      }

      requestThreadForCurrentView()
    }
  }

  navigationHistoryState.init(rendererRecovery.activeView, rendererRecovery.selectedThread)

  /**
   * Timestamp of the last mouse side-button navigation. Windows/Linux deliver
   * a side press both as an app command (forwarded over IPC) and   through
   * Chromium   as a renderer mouse event; macOS only delivers the raw event.
   * A short dedupe window keeps one physical press from navigating twice.
   */
  let lastMouseHistoryNavAt = 0

  /** Mouse back/forward buttons (button 3 = back, 4 = forward)   macOS path. */
  function onMouseHistoryButton(e: MouseEvent): void {
    if (e.button !== 3 && e.button !== 4) return
    const now = Date.now()
    if (now - lastMouseHistoryNavAt < 150) return
    lastMouseHistoryNavAt = now
    e.preventDefault()
    if (e.button === 3) void goBack()
    else void goForward()
  }

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
    window.addEventListener('mousedown', onMouseHistoryButton)
    window.addEventListener('auxclick', onMouseHistoryButton)
    const uninstallVoiceShortcut = initVoiceShortcutListener()
    const uninstallComposerFocusShortcut = initComposerFocusShortcut()

    const restoreWorkspaceCallbacks = installWorkspaceCallbacks()
    const unsubscribeIpc = installAppIpcSubscriptions({
      openThreadFromNotification,
      setCloseConfirmation: (payload) => (closeConfirmation = payload),
      confirmForceClose,
      settleCloseConfirmationThread,
      handleCloseShortcut,
      handleNewTerminalShortcut,
      goBack,
      goForward,
      handleOpenedPaths: (paths) => handleOpenedPaths(paths, osHandoffDeps)
    })
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
    // Fire-and-forget: the app's own record of models reported as
    // vision-capable, consulted before any vision-capability gate.
    void visionModels.load().catch(() => {})
    // Fire-and-forget: probes opted-in harnesses and docks quiet auto-updates.
    void harnessLifecycleStore.autoUpdateOnStartup()
    // Workspace owns the initial project/thread hydration. Keeping this signal
    // there prevents App and Workspace from issuing the same startup queries.

    return () => {
      mq.removeEventListener('change', onColorSchemeChange)
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('mousedown', onMouseHistoryButton)
      window.removeEventListener('auxclick', onMouseHistoryButton)
      uninstallVoiceShortcut()
      uninstallComposerFocusShortcut()
      restoreWorkspaceCallbacks()
      unsubscribeIpc()
      unsubscribeShutdown()
      workspaceState.openThread = originalOpenThread
      workspaceState.clearThread = originalClearThread
    }
  })
</script>

<div class="flex h-screen flex-col bg-app">
  <AppHeader {activeView} {navigate} {goBack} {goForward} />

  <main class="flex-1 overflow-hidden">
    <!-- One shell for all views   the workspace (and the open thread) stays
         mounted across Settings/Scope so returning never reloads the thread
         list or reconnects the harness; it's simply hidden while away. -->
    <div
      class={activeView === 'projects' ||
      activeView === 'projects-scope' ||
      activeView === 'chats' ||
      activeView === 'threads' ||
      activeView === 'assistant'
        ? 'h-full'
        : 'hidden'}
    >
      <Workspace
        mode={lastContentView}
        active={activeView === 'projects' ||
          activeView === 'projects-scope' ||
          activeView === 'chats' ||
          activeView === 'threads' ||
          activeView === 'assistant'}
        scopeViewActive={activeView === 'scope'}
        {navigate}
        {config}
        {updateConfig}
      />
    </div>
    {#if activeView === 'scope'}
      {#await import('$lib/components/scope/ScopeView.svelte') then { default: ScopeView }}
        <ScopeView {navigateToScopedThreads} />
      {/await}
    {:else if isSettingsView(activeView)}
      <!-- Each settings section is its own dedicated page in the navigation model.
           The view stays mounted and SettingsView swaps its content on the section
           prop   a keyed remount here would flash the screen on every tab switch. -->
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
    {:else if !(activeView === 'projects' || activeView === 'chats' || activeView === 'threads' || activeView === 'assistant')}
      <div class="flex h-full items-center justify-center">
        <p class="text-sm text-dimmed">Coming soon</p>
      </div>
    {/if}
  </main>
  {#if spotlightScreenId}
    {#await import('$lib/components/actions/CommandPalette.svelte') then { default: CommandPalette }}
      <CommandPalette {...spotlightPalette} />
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
  <TextSelectionContextMenu />
  <TooltipHost />
  {#if scopeConfirmations.current}
    <!-- An agent's destructive scope action is parked in main until this dialog
         is answered, so it floats above every view until the user decides. -->
    {#await import('$lib/components/scope/ScopeAgentConfirmDialog.svelte') then { default: ScopeAgentConfirmDialog }}
      <ScopeAgentConfirmDialog />
    {/await}
  {/if}
  {#if pipState.active && pipState.frameDataUrl !== null}
    {#await import('$lib/components/pip/PipOverlay.svelte') then { default: PipOverlay }}
      <PipOverlay />
    {/await}
  {/if}
  {#if standaloneFiles.open}
    <!-- Files opened through the operating system: editable text (saved straight
         back to the file) and deliberately project-less (no file tree, no tree
         operations, nothing indexed). -->
    {#await import('$lib/components/files/StandaloneFileViewer.svelte') then { default: StandaloneFileViewer }}
      <StandaloneFileViewer />
    {/await}
  {/if}

  {#if providerConnectFlow.request}
    <!-- The provider connect flow floats above every view: a surface with no AI
         account connected (the first-run setup card, the empty model picker)
         opens the harness's provider list without navigating away. -->
    {#await import('$lib/components/providers/ProviderConnectHost.svelte') then { default: ProviderConnectHost }}
      <ProviderConnectHost />
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
    <!-- Floats above every view   survives navigation while tasks keep running. -->
    {#await import('$lib/components/providers/HarnessRunModal.svelte') then { default: HarnessRunModal }}
      <HarnessRunModal />
    {/await}
  {/if}

  {#if prLifecycleStore.drafts.length}
    <!-- Floats above every view   survives thread/project/view and sidebar visibility. -->
    {#await import('$lib/components/git/PrDockHost.svelte') then { default: PrDockHost }}
      <PrDockHost />
    {/await}
  {/if}

  {#if scopeJobs.jobs.length}
    <!-- Floats above every view so a worktree run keeps reporting while the user works. -->
    {#await import('$lib/components/scope/ScopeJobDockHost.svelte') then { default: ScopeJobDockHost }}
      <ScopeJobDockHost />
    {/await}
  {/if}

  {#if prBatchJobs.jobs.length}
    <!-- Floats above every view so a confirmed batch keeps closing pull requests while the user works. -->
    {#await import('$lib/components/git/PrBatchDockHost.svelte') then { default: PrBatchDockHost }}
      <PrBatchDockHost />
    {/await}
  {/if}

  {#if gitSyncJobs.jobs.length}
    <!-- Floats above every view so a sync between two checkouts reports itself, and its outcome is never a dialog. -->
    {#await import('$lib/components/git/GitSyncDockHost.svelte') then { default: GitSyncDockHost }}
      <GitSyncDockHost />
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
