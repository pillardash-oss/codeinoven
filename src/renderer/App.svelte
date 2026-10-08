<script lang="ts">
  import { onMount } from 'svelte'
  import { FileSearch, FolderKanban, MessagesSquare } from '@lucide/svelte'
  import type { CommandPaletteProps } from '$lib/components/actions/CommandPalette.svelte'
  import AppHeader from '$lib/components/layout/AppHeader.svelte'
  import GlobalContextSidebar from '$lib/components/layout/GlobalContextSidebar.svelte'
  import InstanceRoleNotice from '$lib/components/layout/InstanceRoleNotice.svelte'
  import AppViewRail from '$lib/components/layout/AppViewRail.svelte'
  import {
    AppHeaderNavigationController,
    type HeaderViewOptionId
  } from '$lib/components/layout/AppHeaderNavigationController.svelte'
  import Workspace from '$lib/components/workspace/Workspace.svelte'
  import { fly } from 'svelte/transition'
  import { pageReveal } from '$lib/components/layout/page-reveal'
  import Toaster from '$lib/components/ui/Toaster.svelte'
  import TooltipHost from '$lib/components/ui/TooltipHost.svelte'
  import TextSelectionContextMenu from '$lib/components/shared/TextSelectionContextMenu.svelte'
  import { toast } from 'svelte-sonner'
  import { invoke, subscribeGuarded } from '$lib/ipc.svelte'
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
    contentViewForThread,
    decideContentViewThread,
    viewShowsThread,
    type ContentThreadFamily
  } from '$lib/content-view-threads'
  import {
    viewShowsProject,
    viewShowsScopedSidebar,
    viewShowsWorkspaceShell
  } from '$lib/content-view-projects'
  import {
    navigationHistoryState,
    type NavigationLocation
  } from '$lib/stores/navigation-history.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { settingsRouteState } from '$lib/stores/settings-route.svelte'
  import {
    browserStore,
    isBrowserLoaded,
    loadBrowser,
    withBrowser
  } from '$lib/stores/browser-access.svelte'
  import { trackBrowserOcclusion } from '$lib/stores/browser-visibility.svelte'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { schemeState } from '$lib/stores/scheme.svelte'
  import { publishBrowserScrollbarTheme } from '$lib/browser-page-scrollbar'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { browserKeyboardFocus } from '$lib/stores/browser-keyboard-focus'
  import { browserFindState } from '$lib/stores/browser-find.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { threadProjectFilterState } from '$lib/stores/thread-project-filter.svelte'
  import { temporaryChatUnread } from '$lib/stores/temporary-chat-unread.svelte'
  import { pipState } from '$lib/stores/pip.svelte'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { installBrowserShortcutPublishing } from '$lib/keymap/browser-shortcuts'
  import { appQuitState } from '$lib/stores/app-quit.svelte'
  import { visionModels } from '$lib/stores/vision-models.svelte'
  import { isTerminalFocused } from '$lib/terminal/focus'
  import { COMPOSER_DRAFT_SELECTOR } from '$lib/components/chats/chat-composer-draft-surface'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
  import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
  import { scopeConfirmations } from '$lib/stores/scope-confirmations.svelte'
  import { cioCleanupStore } from '$lib/stores/cio-cleanup.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerConnectFlow } from '$lib/stores/provider-connect-flow.svelte'
  import { harnessLifecycleStore } from '$lib/stores/harness-lifecycle.svelte'
  import { ovenSetupStore } from '$lib/stores/oven-setup.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { prBatchJobs } from '$lib/stores/pr-batch-jobs.svelte'
  import { gitSyncJobs } from '$lib/stores/git-sync-jobs.svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import { loadProjectIcons } from '$lib/project-icons'
  import { preloadScopeChunk, preloadSettingsChunk } from '$lib/page-preload'
  import { scheduleDeferredWork } from '$lib/deferred-work'
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
    type InstanceRole,
    type Project,
    type ThemePreference,
    type Thread
  } from '$shared/types'
  import type { CloseConfirmationPayload, CloseConfirmationProject } from '$shared/ipc-contract'
  import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
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
  import {
    workspaceTourViewFor,
    type WorkspaceTourView
  } from '$lib/components/onboarding/onboarding-tour-steps'

  type View = MainView

  let config = $state<AppConfig>(defaultConfig)
  let settingsReady = $state(false)
  let settingsError = $state<string>()
  let systemDark = $state(false)
  let activeView = $state<View>(rendererRecovery.activeView)
  let commandPaletteOpen = $state(false)
  let closeConfirmation = $state<CloseConfirmationPayload | null>(null)
  let instanceRole = $state<InstanceRole | null>(null)
  /** The one-time start-at-login offer, raised once after the first routine how-to. */
  let startAtLoginOfferOpen = $state(false)
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
  /** A content view's own tour, running on its own step counter. */
  let viewTourView = $state<WorkspaceTourView | null>(null)
  let viewTourStep = $state(0)
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
    // Read every flag before deciding. A `$derived` only stays subscribed to
    // the signals it read on its last run, so a short-circuit that skips a
    // flag drops that flag from the dependency set: a later change to it no
    // longer dirties the derived, and the screen it controls never re-renders.
    // That is what made the spotlight refuse to reopen after a screen hop.
    const files = fileSearch.paletteOpen
    const threads = threadSearch.paletteOpen
    const projects = projectSwitch.paletteOpen
    const actions = commandPaletteOpen
    if (files) return 'files'
    if (threads) return 'threads'
    if (projects) return 'projects'
    if (actions) return 'actions'
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

  /** True while the workspace shell renders the view (Projects, Chats, Threads
   *  and Assistant); the takeover pages (Scope, Settings) layer on top of it.
   *  Shared with the link pipeline, which routes by the same surface. */
  let showsContentView = $derived(viewShowsWorkspaceShell(activeView))

  /** The view the user was on before opening Settings   the Settings back button returns here. */
  let lastViewBeforeSettings = $derived(rendererRecovery.lastViewBeforeSettings)

  let effectiveTheme = $derived(
    config.theme === 'system' ? (systemDark ? 'dark' : 'light') : config.theme
  )

  function applyTheme(): void {
    document.documentElement.classList.toggle('dark', effectiveTheme === 'dark')
    schemeState.sync(effectiveTheme)
    // A browser tab's page is a native view, so its default scrollbar cannot be
    // reached by the stylesheet: hand the app's colours to main instead. Nothing
    // about the browser belongs on a launch that never reaches it, so the push
    // waits until there is a browser to theme - the runtime makes the first one
    // when it comes up, and this covers every theme change after that.
    if (isBrowserLoaded()) publishBrowserScrollbarTheme()
  }

  /** Welcome screen (and other surfaces) can request the getting-started tour. */
  $effect(() => {
    if (workspaceState.consumeOnboardingRequest()) {
      onboardingStep = 0
      onboardingOpen = true
    }
  })

  /** A view's empty state, or the palette, can request that view's own tour. */
  $effect(() => {
    const view = workspaceState.consumeViewTourRequest()
    if (!view) return
    viewTourView = view
    viewTourStep = 0
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

  /**
   * Answer the one-time start-at-login offer. The choice and the flag that keeps
   * the question from ever being raised again are saved together, so no later
   * routine setup asks a second time however this one is answered.
   */
  function answerStartAtLoginOffer(startAtLogin: boolean): void {
    startAtLoginOfferOpen = false
    void updateConfig({ launchAtLogin: startAtLogin, launchAtLoginPrompted: true })
  }

  function setPreference(pref: ThemePreference): void {
    void updateConfig({ theme: pref })
  }

  /** The app's current location, for history capture. */
  function currentLocation(): NavigationLocation {
    const thread = workspaceState.selectedThread
    return {
      view: activeView,
      thread: thread ? { projectId: thread.projectId, threadId: thread.id } : null,
      utilities: activeView === 'settings-utilities' ? settingsRouteState.utilities : null
    }
  }

  function navigate(view: View): void {
    // Entering another section starts its Utilities page fresh; history
    // restores a recorded Utilities page after this navigation.
    if (view !== activeView) settingsRouteState.resetUtilities()
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
    // Reaching the browser view is the moment its code and its runtime are both
    // needed: the view itself is a dynamic import, and this warms the chunks and
    // builds the stores before it renders. The view asks too, for the session
    // that restores straight onto it without ever navigating here.
    if (view === 'browser') void loadBrowser()
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

  /** Primary-view navigation is owned here, so the header and the left view rail
   *  share one controller (one `lastViewBeforeScope`/`shownHeaderViewOption`). */
  const navigation = new AppHeaderNavigationController({
    getActiveView: () => activeView,
    navigate: (view) => navigate(view)
  })

  /** Warm the target view's threads (and lazy chunk) before a rail hover lands. */
  function handleViewOptionHover(id: HeaderViewOptionId): void {
    if (id === 'scope-board' || id === 'scoped-threads') preloadScopeChunk()
    // Pointing at the browser is the moment we know the user is going there, so
    // its chunks and its runtime are both warmed here rather than at boot.
    if (id === 'browser') void loadBrowser()
    if (id === 'chats') navigation.preloadNavigationThreads('chats')
    else if (id === 'scoped-threads') navigation.preloadScopedThreads()
    else navigation.preloadNavigationThreads('projects')
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
      restoreUtilitiesFromHistory(entry)
      await restoreThreadFromHistory(entry)
    } finally {
      navigationHistoryState.endTraversal()
    }
  }

  /** Re-show the Utilities page captured in a history entry. */
  function restoreUtilitiesFromHistory(entry: NavigationLocation): void {
    if (entry.utilities) settingsRouteState.showUtilities(entry.utilities)
  }

  /** Navigate to the location the user backed away from, if any. */
  async function goForward(): Promise<void> {
    const entry = navigationHistoryState.forward(currentLocation())
    if (!entry) return
    navigationHistoryState.beginTraversal()
    try {
      navigate(entry.view)
      restoreUtilitiesFromHistory(entry)
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
    workspaceState.navigateToBrowser = () => navigate('browser')
    workspaceState.openThreadFromNotification = (thread, project, temporaryChatId) =>
      openThreadFromNotification(thread, project, temporaryChatId)
    // A thread created or found outside the shell's own navigation (a repeated
    // conversation, a spun-off passage, a process's thread) has to be shown by
    // the view that owns its family; only the shell may move the view.
    workspaceState.navigateToThreadView = (thread) => {
      if (!viewShowsThread(activeView, thread)) navigate(contentViewForThread(thread))
    }
    return () => {
      workspaceState.navigateToSettings = null
      workspaceState.navigateToContent = null
      workspaceState.navigateToBrowser = null
      workspaceState.openThreadFromNotification = null
      workspaceState.navigateToThreadView = null
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
    if (scopedContext && viewShowsScopedSidebar(activeView, true)) {
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
      case 'app:tour-view': {
        const view = workspaceTourViewFor(activeView)
        if (view) workspaceState.requestViewTour(view)
        return
      }
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
   * A view that already shows the picked project keeps it: the scoped state
   * stays docked on the project (it is that project's own thread list), the
   * Threads timeline keeps the pick while its project filter lets the project
   * through, and the Scope board follows the project it is already showing. The
   * picked project becomes the view's project and its most recent thread opens
   * in place, so nothing the current view can already show is taken away from
   * it.
   *
   * Every other case lands on the Projects view with the project's most recent
   * thread open, matching how focusing a project already works elsewhere (OS
   * hand-off, existing-project spotlight, header tabs): that is what a project
   * the current view cannot show gets, one filtered out of the Threads timeline
   * or one picked from a view with no project threads of its own (Chats, the
   * Assistant, the browser, the takeover pages).
   */
  function focusProjectFromSpotlight(project: Project): void {
    const iconUrl =
      scopeState.projects.find((candidate) => candidate.id === project.id)?.iconUrl ?? null
    const keepsProject = viewShowsProject(activeView, project.id, {
      scopedProjectId: scopeState.sidebarContext?.projectId ?? null,
      threadsViewShowsProject: threadProjectFilterState.matches(project.id),
      boardProjectId: scopeState.activeProjectId
    })

    // Navigate before selecting the thread so the shell's content-view reconcile
    // never paints the Projects family's remembered thread for a frame.
    if (!keepsProject) navigate('projects')
    void scopeState.activateProject(project.id)

    // Picking the project that is already focused keeps the conversation the user
    // is reading instead of jumping to its latest thread.
    if (keepsProject && workspaceState.selectedThread?.projectId === project.id) return

    const thread =
      scopeState.allScopeThreads
        .filter(
          (candidate) =>
            candidate.projectId === project.id &&
            !candidate.archived &&
            !isOrchestrationChildThread(candidate)
        )
        .sort((left, right) => right.lastActivity - left.lastActivity)[0] ?? null
    // Only a kept view can still be docked in the scoped state   leaving for the
    // Projects view above closes the sidebar with the scope state itself. There
    // the scope sidebar is the picked project's own thread list, so it follows
    // the thread the pick opened (its bucket and stage), exactly as the scope
    // sidebar's own project switcher does.
    if (thread) {
      workspaceState.openThread(thread, project, iconUrl)
      if (scopeState.sidebarContext) scopeState.showSidebarForThread(thread)
    } else {
      workspaceState.clearThread()
      workspaceState.activeProject = project
      workspaceState.activeProjectIconUrl = iconUrl
      rendererRecovery.setSelectedProject(project.id)
      if (scopeState.sidebarContext) scopeState.showSidebarForProject(project.id)
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
      viewShowsScopedSidebar(activeView, scopeState.sidebarContext !== null)

    if (thread.projectId === GLOBAL_BROWSER_PROJECT_ID) {
      // A browser tab's conversation has no workspace thread and is deliberately
      // in no thread list, so the browser view is the only thing that can show
      // it. Handing it to `workspaceState.openThread` below would select a thread
      // no view owns, which is the dead button this branch exists to avoid.
      navigate('browser')
      await withBrowser((store) => store.revealAssistantChat(thread.id))
      return
    }

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

  /** True when the pending close is a park (background mode), not a quit. */
  function closeIsPark(): boolean {
    return closeConfirmation?.park === true
  }

  /** The user approved parking the window; main keeps the backend alive. */
  async function parkWindow(): Promise<void> {
    await invoke('app:parkWindow')
  }

  /** The user approved the force close   tell main to park or to quit. */
  async function confirmForceClose(): Promise<void> {
    await (closeIsPark() ? invoke('app:parkWindow') : invoke('app:confirmClose'))
  }

  /**
   * While the close-confirmation modal is open, watch the threads it listed as
   * still working. As each one leaves that state (completed, failed, or
   * otherwise no longer executing/planning) it drops off the list. Once none
   * remain   and no unsaved files are pending   the close the user already
   * asked for proceeds automatically instead of waiting on a second click.
   *
   * A listed download deliberately does not hold that up: closing pauses it and
   * keeps its bytes for a later resume, so it never needs an answer of its own.
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
      const park = current.park === true
      closeConfirmation = null
      void (park ? parkWindow() : confirmForceClose())
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
      await (closeIsPark() ? invoke('app:parkWindow') : invoke('app:confirmClose'))
    } else {
      toast.error('Some files could not be saved', {
        description: 'The application stayed open so you can review them.'
      })
    }
  }

  /** Clean up renderer resources when the main process signals shutdown. */
  function installShutdownSubscription(): () => void {
    // Guarded like the App installer's own subscriptions: a channel this
    // window's preload does not expose yet must cost this one subscription, not
    // the rest of the mount that follows it.
    return subscribeGuarded('window:beforeQuit', () => {
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
   * Follow a config change this window did not make.
   *
   * The design board changes the work folders from its own panel, and a settings
   * page still showing the replaced folder would be describing a file that is no
   * longer on disk. Main broadcasts the saved config, so every surface agrees on
   * what was written. The window that made the change receives its own broadcast
   * too, which is the same value it already holds.
   */
  function installConfigSubscription(): () => void {
    // Guarded for the same reason as the shutdown subscription above.
    return subscribeGuarded('config:changed', (next) => {
      config = next
      appConfigState.sync(next)
      applyTheme()
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
    const browserTabId = browserKeyboardFocus.tabId
    if (browserTabId) {
      browserFindState.open(browserTabId)
      return
    }
    if (activeView === 'browser') {
      void withBrowser((store) => {
        if (store.activeTab) browserFindState.open(store.activeTab.id)
      })
      return
    }
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
    if (keymapState.matches('app-quit-direct', e)) {
      // Quit for real, bypassing background mode's park to the menu bar. Main
      // runs the shutdown pipeline, so a turn still running settles as a
      // deliberate close on the next launch instead of a crash.
      e.preventDefault()
      if (e.repeat) return
      void invoke('app:quitDirect')
      return
    }
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
    // DOM focus in browser chrome must answer the same bindings as the native
    // page. This also covers the interval before its main-process claim lands.
    const browserTabId = browserKeyboardFocus.tabId
    if (browserTabId || activeView === 'browser') {
      if (keymapState.matches('browser-find', e)) {
        e.preventDefault()
        if (!e.repeat) handleFind()
        return
      }
      const previous = keymapState.matches('browser-find-previous', e)
      if (previous || keymapState.matches('browser-find-next', e)) {
        e.preventDefault()
        if (!e.repeat) {
          if (browserTabId) browserFindState.step(browserTabId, previous ? 'previous' : 'next')
          else
            void withBrowser((store) => {
              if (store.activeTab)
                browserFindState.step(store.activeTab.id, previous ? 'previous' : 'next')
            })
        }
        return
      }
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
      // The browser view's right rail is its own (per-tab notes), so it answers
      // the same chord directly instead of forwarding a thread-sidebar request.
      if (activeView === 'browser') {
        e.preventDefault()
        if (e.repeat) return
        void withBrowser((store) => store.toggleContextSidebar())
        return
      }
      const rightSidebarViews = ['projects', 'projects-scope', 'chats', 'threads', 'assistant']
      if (!rightSidebarViews.includes(activeView)) return
      e.preventDefault()
      if (e.repeat) return
      workspaceState.requestToggleContextSidebar()
      return
    }
    if (keymapState.matches('nav-toggle-left-sidebar', e)) {
      // The browser view's left sidebar is the app's own sidebar (its chrome and
      // tab strip), so the chord folds it the same way it folds the workspace
      // one. Page save is unbound by default, so the chord reaches this handler
      // instead of the browser.
      if (activeView === 'browser') {
        e.preventDefault()
        if (e.repeat) return
        sidebarState.toggle()
        return
      }
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

      // The browser view owns it for a new tab, which is what a browser does.
      if (activeView === 'browser') {
        void withBrowser((store) => store.openNewTabAddress())
        return
      }

      requestThreadForCurrentView()
      return
    }
    if (keymapState.matches('browser-reopen-tab', e)) {
      // The browser's own page is a native view, so this normally never fires:
      // main claims the chord in the page and forwards the same action to the
      // view that owns the strip. It is the fallback for the one state where no
      // page holds the keyboard   the Browser view with every tab closed   so a
      // mistaken last close can still be undone.
      if (activeView !== 'browser') return
      e.preventDefault()
      if (e.repeat) return
      void withBrowser((store) => store.reopenLastClosedTab())
    }
  }

  settingsRouteState.onUtilitiesChange = observeNavigationLocation
  navigationHistoryState.init({
    view: rendererRecovery.activeView,
    thread: rendererRecovery.selectedThread,
    utilities:
      rendererRecovery.activeView === 'settings-utilities' ? settingsRouteState.utilities : null
  })

  /** Windows/Linux may report both an app command and a renderer mouse event.
   *  macOS can report a raw mouse event or a native swipe. Collapse duplicate
   *  same-direction reports from one physical press. */
  let lastMouseHistoryNavigation: { direction: 'back' | 'forward'; at: number } | null = null

  /** Route a mouse history button to the focused browser page first, then the
   *  app's location history when focus is elsewhere. */
  async function handleMouseHistoryNavigation(direction: 'back' | 'forward'): Promise<void> {
    const now = Date.now()
    const previous = lastMouseHistoryNavigation
    if (previous && previous.direction === direction && now - previous.at < 150) return
    lastMouseHistoryNavigation = { direction, at: now }

    const handledByBrowser = await invoke('browser:mouseHistoryNavigation', direction).catch(
      () => false
    )
    if (handledByBrowser) return
    if (direction === 'back') void goBack()
    else void goForward()
  }

  /** Mouse back/forward buttons (button 3 = back, 4 = forward). */
  function onMouseHistoryButton(e: MouseEvent): void {
    if (e.button !== 3 && e.button !== 4) return
    e.preventDefault()
    void handleMouseHistoryNavigation(e.button === 3 ? 'back' : 'forward')
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
      parkWindow,
      setInstanceRole: (role) => (instanceRole = role),
      settleCloseConfirmationThread,
      showStartAtLoginOffer: () => (startAtLoginOfferOpen = true),
      handleCloseShortcut,
      handleNewTerminalShortcut,
      goBack: () => handleMouseHistoryNavigation('back'),
      goForward: () => handleMouseHistoryNavigation('forward'),
      handleOpenedPaths: (paths) => handleOpenedPaths(paths, osHandoffDeps)
    })
    // Hydrate the instance role: the push fires before this renderer mounts, so
    // this read is what shows the "running in another instance" notice on load.
    void invoke('app:instanceRole')
      .then((role) => (instanceRole = role))
      .catch(() => undefined)
    const unsubscribeShutdown = installShutdownSubscription()
    const unsubscribeConfig = installConfigSubscription()
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
    // The keymap pushes the browser's chords whenever the config loads, but main's
    // window-bound browser handlers are registered after the first paint, so that
    // push can land before they exist and be dropped. The browser would then claim
    // none of its own keys (Cmd/Ctrl+T, Cmd/Ctrl+W, find) until the next keymap
    // change. This publishes now and again on every `app:featuresReady`, which
    // main sends once those handlers are up.
    installBrowserShortcutPublishing(keymapState)
    // Every launch leaves the browser alone: no chunk fetched, no store built,
    // no stored tab list read, no listener registered. The one exception is a
    // session that restores straight onto the browser view, where the page the
    // user was reading is what they came back to, so its runtime is asked for at
    // boot instead of on the first reach.
    if (activeView === 'browser') void loadBrowser()
    // Fire-and-forget: the app's own record of models reported as
    // vision-capable, consulted before any vision-capability gate.
    void visionModels.load().catch(() => {})
    // Fire-and-forget: probes opted-in harnesses and docks quiet auto-updates.
    // Nothing on the first frame reads it (the update badges live in Settings and
    // in the rail's control), so it waits for the renderer to go idle rather than
    // starting its harness probes while the thread list is still hydrating.
    scheduleDeferredWork(
      'harness:autoUpdate',
      () => void harnessLifecycleStore.autoUpdateOnStartup()
    )
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
      unsubscribeConfig()
      workspaceState.openThread = originalOpenThread
      workspaceState.clearThread = originalClearThread
    }
  })
</script>

<div class="flex h-screen flex-col bg-app">
  <AppHeader {activeView} {goBack} {goForward} {navigation} />

  <div class="flex min-h-0 flex-1">
    <AppViewRail
      options={navigation.headerViewOptions()}
      shownOption={navigation.shownHeaderViewOption}
      projectBadgeOption={navigation.projectBadgeOption}
      {activeView}
      {navigate}
      onOptionHover={handleViewOptionHover}
    />

    <!-- `overflow-clip`, not `overflow-hidden`: the arriving view slides up on
         its reveal transition, and a scroll container here would let that
         offset scroll the shell before it clamps back. Clip keeps this frame
         fixed. -->
    <main class="relative min-w-0 flex-1 overflow-clip">
      <!-- One shell for all views   the workspace (and the open thread) stays
         mounted across Settings/Scope so returning never reloads the thread
         list or reconnects the harness. It fades out rather than going
         `display: none`, so the swap cross-fades with the page arriving on top
         while keeping it out of the tab order and the accessibility tree.

         Visibility is transitioned on the way OUT only, and the arriving shell
         takes `transition-property: opacity` without it. A transitioned
         visibility computes `hidden` for the instant a switch starts   the
         after-change value of an interpolated visibility is `visible` only
         once the transition has actually begun, and that first frame is
         exactly when a return to the conversation asks its composer to take
         the caret. Measured in this app: with visibility transitioned in both
         directions, no element inside the arriving shell accepts focus until a
         later frame, so the composer silently refused the caret; with the
         incoming direction untransitioned the same focus request lands on the
         frame it is made. The outgoing direction keeps the transition, which is
         what holds the fading shell on screen instead of blanking it the moment
         the other page arrives. -->
      <div
        class="h-full duration-200 ease-out motion-reduce:transition-none {showsContentView
          ? 'visible opacity-100 transition-[opacity]'
          : 'invisible pointer-events-none opacity-0 transition-[opacity,visibility]'}"
      >
        <Workspace
          mode={lastContentView}
          active={showsContentView}
          scopeViewActive={activeView === 'scope'}
          setupTourOpen={onboardingOpen}
          {navigate}
          lastProjectViewLanding={() => navigation.projectFamilyLanding()}
          {config}
          {updateConfig}
        />
      </div>
      {#if activeView === 'scope'}
        {#await import('$lib/components/scope/ScopeView.svelte') then { default: ScopeView }}
          <div class="absolute inset-0" transition:fly={pageReveal()}>
            <ScopeView {navigateToScopedThreads} />
          </div>
        {/await}
      {:else if isSettingsView(activeView)}
        <!-- Each settings section is its own dedicated page in the navigation model.
           The view stays mounted and SettingsView swaps its content on the section
           prop   a keyed remount here would flash the screen on every tab switch. -->
        {#await import('$lib/components/settings/SettingsView.svelte') then { default: SettingsView }}
          <div class="absolute inset-0" transition:fly={pageReveal()}>
            <SettingsView
              {config}
              {settingsReady}
              error={settingsError}
              {setPreference}
              {updateConfig}
              section={settingsSectionForView(activeView) ?? 'general'}
              onNavigateSection={(section) => navigate(settingsViewForSection(section))}
              onBack={() => navigate(lastViewBeforeSettings)}
              onHistoryBack={() => void goBack()}
            />
          </div>
        {/await}
      {:else if activeView === 'browser'}
        <!-- The global browser is its own workspace   the app header above it is
             the only shared chrome. It is pinned to the stage instead of left in
             normal flow, because the workspace shell behind it stays mounted as a
             full-height sibling: in flow the browser sits below the fold and only
             enters view once focus scrolls the stage. -->
        {#await import('$lib/components/browser/BrowserView.svelte') then { default: BrowserView }}
          <div class="absolute inset-0">
            <BrowserView />
          </div>
        {/await}
      {:else if !showsContentView}
        <div
          class="absolute inset-0 flex items-center justify-center"
          transition:fly={pageReveal()}
        >
          <p class="text-sm text-dimmed">Coming soon</p>
        </div>
      {/if}
      {#if activeView === 'scope' || isSettingsView(activeView)}
        <GlobalContextSidebar />
      {/if}
      {#if browserStore()?.peekTab}
        {#key browserStore()?.peekTab?.id}
          {#await import('$lib/components/browser/BrowserPeekWindow.svelte') then { default: BrowserPeekWindow }}
            <BrowserPeekWindow />
          {/await}
        {/key}
      {/if}
    </main>
  </div>

  <!-- The instance-role notice sits at the very bottom as a status bar: it is a
       standing condition, so it reads as chrome rather than as content above
       the workspace. It moves here so it never pushes the workspace down. -->
  {#if instanceRole?.role === 'secondary'}
    <InstanceRoleNotice
      ownerPid={instanceRole.ownerPid}
      onOpenOwner={() => void invoke('app:openInstanceOwner')}
      onTakeOver={() => void invoke('app:transferInstanceControl')}
      onQuit={() => void invoke('app:confirmClose')}
    />
  {/if}
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
  {#if viewTourView}
    <!-- A view's own tour: the same spotlight presentation as the setup tour,
         over that view's steps. Remounted per step so each target is measured
         once it is on screen. -->
    {#key viewTourStep}
      {#await import('$lib/components/onboarding/OnboardingTour.svelte') then { default: OnboardingTour }}
        <OnboardingTour
          tour={viewTourView}
          step={viewTourStep}
          onStepChange={(step) => (viewTourStep = step)}
          onFinish={() => (viewTourView = null)}
        />
      {/await}
    {/key}
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
  {#if startAtLoginOfferOpen}
    <!-- The one-time start-at-login offer. Raised right after a routine is given
         its first how-to, so the question is about the runs the user has just
         set up, and floated above every view because that save happens in the
         thread the routine belongs to. -->
    {#await import('$lib/components/layout/StartAtLoginPrompt.svelte') then { default: StartAtLoginPrompt }}
      <StartAtLoginPrompt open onChoose={answerStartAtLoginOffer} />
    {/await}
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
  {#if standaloneFiles.open && standaloneFiles.presentation === 'docked'}
    <!-- Files opened through the operating system: docked as a floating panel by
         default so the workspace and its threads stay usable, minimizable to a
         screen-edge chip. Editable text saved straight back to the file, and
         deliberately project-less (no file tree, no tree operations, nothing
         indexed). -->
    {#await import('$lib/components/files/StandaloneFileDock.svelte') then { default: StandaloneFileDock }}
      <StandaloneFileDock />
    {/await}
  {:else if standaloneFiles.open}
    <!-- The explicit full screen mode of the same files, one action away from
         the docked panel. -->
    {#await import('$lib/components/files/StandaloneFileViewer.svelte') then { default: StandaloneFileViewer }}
      <StandaloneFileViewer />
    {/await}
  {/if}
  {#if standaloneFiles.pendingClose}
    <!-- One unsaved-changes confirmation served to both the docked panel and the
         fullscreen reader. -->
    {#await import('$lib/components/files/StandaloneFileCloseDialog.svelte') then { default: StandaloneFileCloseDialog }}
      <StandaloneFileCloseDialog />
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

  {#if githubSignIn.open}
    <!-- The GitHub device-flow sign-in, docked so the user can authorize in a
         browser   including the app's own   while the panel keeps polling. It
         floats above every view because the flow outlives the panel it was
         opened from: the Git sidebar is behind the browser view when it lands. -->
    {#await import('$lib/components/git/GitHubSignInDock.svelte') then { default: GitHubSignInDock }}
      <GitHubSignInDock />
    {/await}
  {/if}

  {#if ovenSetupStore.initialized}
    {#await import('$lib/components/settings/OvenSetupModal.svelte') then { default: OvenSetupModal }}
      <OvenSetupModal
        open={ovenSetupStore.open}
        initialOvenId={ovenSetupStore.ovenId}
        onComplete={(ovenId) => ovenSetupStore.markComplete(ovenId)}
        onClose={() => ovenSetupStore.close()}
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

  {#if cioCleanupStore.jobs.length}
    <!-- Floats above every view so a manual cleanup keeps reporting while the user works. -->
    {#await import('$lib/components/cio/CioCleanupDockHost.svelte') then { default: CioCleanupDockHost }}
      <CioCleanupDockHost />
    {/await}
  {/if}

  <!-- Scope and Settings render notifications as a floating panel because they
       have no shared right sidebar of their own. The Browser view does: its rail
       hosts the notifications panel beside its note, agent and downloads tools,
       so it must not also get this second, invented rail. -->
  {#if (activeView === 'scope' || isSettingsView(activeView)) && contextSidebarState.sidebarVisible && contextSidebarState.sidebarActiveTab?.kind === 'notifications'}
    <div
      class="fixed bottom-0 right-0 top-12 z-40 w-[480px] border-l border-border bg-surface shadow-xl"
      {@attach trackBrowserOcclusion}
    >
      {#await import('$lib/components/notifications/NotificationPanel.svelte') then { default: NotificationPanel }}
        <NotificationPanel />
      {/await}
    </div>
  {/if}
</div>
