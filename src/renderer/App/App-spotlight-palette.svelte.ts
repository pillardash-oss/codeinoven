import CioBrowser from '@pdslng/cio-icon/CioBrowser.svelte'
import CioFind from '@pdslng/cio-icon/CioFind.svelte'
import CioProjects from '@pdslng/cio-icon/CioProjects.svelte'
import CioThreads from '@pdslng/cio-icon/CioThreads.svelte'
import type {
  CommandPaletteProps,
  PaletteFooterFilter
} from '$lib/components/actions/CommandPalette.svelte'
import { CONTENT_FAMILY_ICONS } from '$lib/content-view-icons'
import { invoke, waitForFeatures } from '$lib/ipc.svelte'
import { focusVisibleComposer } from '$lib/focus/composer-focus-registry'
import { rendererRecovery, settingsViewForSection } from '$lib/stores/renderer-recovery.svelte'
import { workspaceState, threadVisitKey } from '$lib/stores/workspace.svelte'
import {
  contentThreadFamily,
  decideContentViewThread,
  type ContentThreadFamily
} from '$lib/content-view-threads'
import { viewShowsProject } from '$lib/content-view-projects'
import {
  navigationHistoryState,
  type NavigationLocation
} from '$lib/stores/navigation-history.svelte'
import { settingsRouteState } from '$lib/stores/settings-route.svelte'
import { browserStore, withBrowser } from '$lib/stores/browser-access.svelte'
import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
import { threadProjectFilterState } from '$lib/stores/thread-project-filter.svelte'
import { COMPOSER_DRAFT_SELECTOR } from '$lib/components/chats/chat-composer-draft-surface'
import { scopeState } from '$lib/stores/scope.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import { getAssistantIcon } from '$lib/assistant-icons'
import { providerStore } from '$lib/stores/providers.svelte'
import { harnessAccountCache } from '$lib/stores/harness-accounts'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
import { providerConnectFlow } from '$lib/stores/provider-connect-flow.svelte'
import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
import { loadProjectIcons } from '$lib/project-icons'
import { actionContext } from '$lib/stores/action-context.svelte'
import {
  captureElementSelection,
  restoreElementSelection,
  type ElementSelectionBookmark
} from '$lib/selection-bookmark'
import {
  INBOX_PROJECT_ID,
  isOrchestrationChildThread,
  type Project,
  type Thread,
  type ThreadSearchResult
} from '$shared/types'
import {
  buildPaletteContextActions,
  navigationActions,
  settingsActions
} from '../app-palette-actions'
import { ThreadSearchPaletteController } from '../app-thread-search.svelte'
import { BrowserTabPaletteController } from '../app-browser-tab-search.svelte'
import { ProjectSwitchPaletteController } from '../app-project-switch.svelte'
import { type OsHandoffDeps } from '../app-os-handoff'
import { warmIntentSearch } from '../app-search-warm'
import { type GuideActionKind } from '$lib/guide/guide-stops'
import { guideState } from '$lib/guide/guide-state.svelte'
import type { View, SpotlightScreenId } from './App-types'
import type { App } from './App-board.svelte'
import { SvelteMap } from 'svelte/reactivity'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the App board. */
export class AppSpotlightPalette extends BoardUnit<App> {
  constructor(root: App) {
    super(root)
  }
  commandPaletteOpen = $state(false)

  chatSearch = new ThreadSearchPaletteController(
    { openThread: (thread) => void this.openThreadFromSearch(thread) },
    'chats'
  )

  browserTabSearch = new BrowserTabPaletteController({
    openTab: (tabId) => this.openBrowserTabFromSearch(tabId)
  })

  projectSwitch = new ProjectSwitchPaletteController({
    focusProject: (project) => this.focusProjectFromSpotlight(project)
  })

  osHandoffDeps: OsHandoffDeps = {
    navigate: (view) => this.root.onKeydown.navigate(view),
    onProjectCreated: (project) => this.handleProjectCreated(project)
  }

  newProjectSpotlightOpen = $state(false)

  paletteFocusBookmark: ElementSelectionBookmark | null = $state(null)

  paletteContextActions = $derived(
    buildPaletteContextActions({
      activeView: this.root.onKeydown.activeView,
      projectRecords: scopeState.projectRecords,
      activeProjectId: scopeState.activeProjectId,
      sidebarContext: scopeState.sidebarContext,
      activeProject: workspaceState.activeProject,
      selectedThread: workspaceState.selectedThread
    })
  )

  paletteActions = $derived([
    ...this.paletteContextActions,
    ...navigationActions,
    ...settingsActions,
    // Harness-bound actions (model pickers, slash commands) belong to the inline
    // menus   the global Cmd+K surface keeps app-level and cross-harness actions.
    ...actionContext.actions.filter((action) => action.source.kind !== 'harness')
  ])

  /** The screen on top. A nested screen outranks the actions list, because
   *  picking one closes the actions list in the same flush. */
  resolveSpotlightScreen(): SpotlightScreenId | null {
    // Read every flag before deciding. A `$derived` only stays subscribed to
    // the signals it read on its last run, so a short-circuit that skips a
    // flag drops that flag from the dependency set: a later change to it no
    // longer dirties the derived, and the screen it controls never re-renders.
    // That is what made the spotlight refuse to reopen after a screen hop.
    const files = this.root.onKeydown.fileSearch.paletteOpen
    const threads = this.root.onKeydown.threadSearch.paletteOpen
    const chats = this.chatSearch.paletteOpen
    const assistants = this.root.onKeydown.assistantSearch.paletteOpen
    const browser = this.browserTabSearch.paletteOpen
    const projects = this.projectSwitch.paletteOpen
    const actions = this.commandPaletteOpen
    if (files) return 'files'
    if (threads) return 'threads'
    if (chats) return 'chats'
    if (assistants) return 'assistants'
    if (browser) return 'browser'
    if (projects) return 'projects'
    if (actions) return 'actions'
    return null
  }

  spotlightScreenId = $derived(this.resolveSpotlightScreen())

  /** The footer filter for a project-scoped search: the local projects, driving
   *  the same multi-select picker the assistant and browser-group screens use. */
  projectFooterFilter(
    selectedIds: readonly string[],
    onChange: (ids: string[]) => void
  ): PaletteFooterFilter {
    return {
      options: scopeState.projects.map((project) => ({
        id: project.id,
        label: project.name,
        ...(project.color ? { color: project.color } : {}),
        iconUrl: project.iconUrl ?? null
      })),
      selectedIds,
      onChange,
      allLabel: 'All Projects',
      ariaLabel: 'Scope search to projects',
      searchPlaceholder: 'Search projects…',
      emptyMessage: 'No matching projects'
    }
  }

  /** The footer filter for assistant search: one row per assistant. */
  assistantFooterFilter(
    selectedIds: readonly string[],
    onChange: (ids: string[]) => void
  ): PaletteFooterFilter {
    return {
      options: assistants.assistants.map((assistant) => ({
        id: assistant.id,
        label: assistant.name,
        ...(assistant.color ? { color: assistant.color } : {}),
        iconUrl: getAssistantIcon(assistant, assistants.iconUrls.get(assistant.id) ?? null)
      })),
      selectedIds,
      onChange,
      allLabel: 'All Assistants',
      ariaLabel: 'Scope search to assistants',
      searchPlaceholder: 'Search assistants…',
      emptyMessage: 'No matching assistants'
    }
  }

  /** The footer filter for browser tab search: one row per tab group. */
  groupFooterFilter(
    selectedIds: readonly string[],
    onChange: (ids: string[]) => void
  ): PaletteFooterFilter {
    const store = browserStore()
    return {
      options: (store?.groups ?? []).map((group) => ({
        id: group.id,
        label: group.name,
        ...(group.color ? { color: group.color } : {}),
        iconUrl: store?.groupIconUrls.get(group.id) ?? null
      })),
      selectedIds,
      onChange,
      allLabel: 'All Groups',
      ariaLabel: 'Scope search to browser groups',
      searchPlaceholder: 'Search groups…',
      emptyMessage: 'No matching groups'
    }
  }

  /**
   * The props for the single mounted palette, for whichever screen is on top.
   *
   * Swapping the screen must not tear the shell down: unmounting one palette and
   * mounting the next threw the scrim, the panel, the scroll lock and the focus
   * away and built them again, which is what made the surface flash on every hop
   * between the home screen and a nested one. One instance with `screenKey`
   * swapped instead keeps the panel and leaves the query input focused.
   */
  spotlightPalette = $derived.by((): CommandPaletteProps => {
    /** What every spotlight screen shares; each screen adds its own list. */
    const shell: Omit<CommandPaletteProps, 'actions' | 'onSelect'> = {
      open: true,
      screenKey: this.spotlightScreenId ?? 'actions',
      onClose: this.root.onKeydown.closeSpotlight,
      onRestoreFocus: this.restorePaletteFocus
    }

    switch (this.spotlightScreenId) {
      case 'files':
        return {
          ...shell,
          actions: this.root.onKeydown.fileSearch.actions,
          title: 'Search files across projects',
          placeholder: 'Type at least two characters…',
          emptyLabel: this.root.onKeydown.fileSearch.loading
            ? 'Searching project files…'
            : 'No matching files',
          headerIcon: CioFind,
          headerIconBadge: true,
          headerIconBadgeClass: 'border-warning/25 bg-warning/10 text-warning',
          serverFiltered: true,
          filter: this.projectFooterFilter(this.root.onKeydown.fileSearch.projectIds, (ids) =>
            this.root.onKeydown.fileSearch.setScope(ids)
          ),
          onBack: this.backToSpotlightHome,
          onQueryChange: (query) => this.root.onKeydown.fileSearch.handleQuery(query),
          onSelect: (selection) => this.root.onKeydown.fileSearch.select(selection),
          closeOnSelect: false
        }
      case 'threads':
        return {
          ...shell,
          actions: this.root.onKeydown.threadSearch.actions,
          title: 'Search threads across projects',
          placeholder: 'Search thread titles and messages across all projects…',
          emptyLabel: this.root.onKeydown.threadSearch.loading
            ? 'Searching threads…'
            : 'Type at least two characters to search all projects',
          // The Threads view's own mark, so the screen wears the glyph the rail,
          // the overview and the palette home row already use for this family.
          headerIcon: CioThreads,
          headerIconBadge: true,
          headerIconBadgeClass: 'border-info/25 bg-info/10 text-info',
          serverFiltered: true,
          filter: this.projectFooterFilter(this.root.onKeydown.threadSearch.scopeIds, (ids) =>
            this.root.onKeydown.threadSearch.setScope(ids)
          ),
          onBack: this.backToSpotlightHome,
          onQueryChange: (query) => this.root.onKeydown.threadSearch.handleQuery(query),
          onSelect: (selection) => this.root.onKeydown.threadSearch.select(selection),
          closeOnSelect: false
        }
      case 'chats':
        return {
          ...shell,
          actions: this.chatSearch.actions,
          title: 'Search chats',
          placeholder: 'Search chat titles and messages…',
          emptyLabel: this.chatSearch.loading
            ? 'Searching chats…'
            : 'Type at least two characters to search chats',
          headerIcon: CONTENT_FAMILY_ICONS.chats,
          headerIconBadge: true,
          headerIconBadgeClass: 'border-info/25 bg-info/10 text-info',
          serverFiltered: true,
          onBack: this.backToSpotlightHome,
          onQueryChange: (query) => this.chatSearch.handleQuery(query),
          onSelect: (selection) => this.chatSearch.select(selection),
          closeOnSelect: false
        }
      case 'assistants':
        return {
          ...shell,
          actions: this.root.onKeydown.assistantSearch.actions,
          title: 'Search assistant tasks',
          placeholder: 'Search assistants, tasks, and messages…',
          emptyLabel: this.root.onKeydown.assistantSearch.loading
            ? 'Searching assistant tasks…'
            : 'Type at least two characters to search assistant tasks and assistants',
          headerIcon: CONTENT_FAMILY_ICONS.assistant,
          headerIconBadge: true,
          headerIconBadgeClass: 'border-warning/25 bg-warning/10 text-warning',
          serverFiltered: true,
          filter: this.assistantFooterFilter(this.root.onKeydown.assistantSearch.scopeIds, (ids) =>
            this.root.onKeydown.assistantSearch.setScope(ids)
          ),
          onBack: this.backToSpotlightHome,
          onQueryChange: (query) => this.root.onKeydown.assistantSearch.handleQuery(query),
          onSelect: (selection) => this.root.onKeydown.assistantSearch.select(selection),
          closeOnSelect: false
        }
      case 'browser':
        return {
          ...shell,
          actions: this.browserTabSearch.actions,
          title: 'Search browser tabs',
          placeholder: 'Search open tabs by title, address, or group…',
          emptyLabel: browserStore() ? 'No matching tabs' : 'Opening the browser…',
          headerIcon: CioBrowser,
          headerIconBadge: true,
          headerIconBadgeClass: 'border-primary/25 bg-primary/10 text-primary',
          serverFiltered: true,
          filter: this.groupFooterFilter(this.browserTabSearch.groupIds, (ids) =>
            this.browserTabSearch.setScope(ids)
          ),
          onBack: this.backToSpotlightHome,
          onQueryChange: (query) => this.browserTabSearch.handleQuery(query),
          onSelect: (selection) => this.browserTabSearch.select(selection),
          closeOnSelect: false
        }
      case 'projects':
        return {
          ...shell,
          actions: this.projectSwitch.actions,
          title: 'Switch project',
          placeholder: 'Search projects…',
          emptyLabel: 'No matching projects',
          headerIcon: CioProjects,
          headerIconBadge: true,
          headerIconBadgeClass: 'border-success/25 bg-success/10 text-success',
          onBack: this.backToSpotlightHome,
          onSelect: (selection) => this.projectSwitch.select(selection),
          closeOnSelect: false
        }
      default:
        return {
          ...shell,
          actions: this.paletteActions,
          title: 'Search actions',
          placeholder: 'Search actions, threads, and files…',
          emptyLabel: 'No matching actions',
          onSelect: this.root.onKeydown.handlePaletteSelection,
          shortcutLabel: 'Ctrl K'
        }
    }
  })

  /**
   * A guide only says what the next step is. The app performs it, because the
   * app is the only thing that knows how to add a project, connect an agent,
   * open a settings page, or put the caret in the composer.
   *
   * Reports whether the step is actually done. A step that has to hand the user
   * somewhere to finish (an installer for an agent that is not on this machine)
   * answers false, and the guide stays on it rather than walking on as if the
   * agent were connected.
   */
  async runGuideAction(run: GuideActionKind): Promise<boolean> {
    if (run.kind === 'add-project') {
      this.openNewProjectSpotlight()
      return true
    }
    if (run.kind === 'focus-composer') {
      focusVisibleComposer()
      return true
    }
    if (run.kind === 'open-harness') {
      const harness = providerStore.providers.find((entry) => entry.id === run.harnessId)
      // Pi ships inside the app, so it can take credentials whether or not this
      // machine has a copy of its own: every other harness has to be installed
      // and driven before its provider list means anything.
      const usable =
        harness !== undefined && (run.harnessId === 'pi' || providerStore.canAddProvider(harness))
      if (usable) {
        // Installed and driven: the account it answers with is managed right
        // here, over the view, by the same flow the settings page opens. Its
        // accounts are re-read on connect, because the badge that says how many
        // this harness has, and the gate below, both hang off that number.
        providerConnectFlow.open(run.harnessId, {
          onConnected: () => {
            void providerStore.checkOne(run.harnessId)
            void harnessAccountCache.list(run.harnessId, true).catch(() => [])
          }
        })
        return true
      }
      // Not on this machine yet: its own page in settings installs it. The guide
      // holds its place while the user is away and comes back on this step, so
      // the Next they were waiting for is still there when they return.
      guideState.holdForUser()
      this.root.onKeydown.navigate(settingsViewForSection('harnesses'))
      return false
    }
    if (run.kind === 'restart-guide') {
      const view = guideState.view
      if (view) guideState.start(view)
      return false
    }
    if (run.kind === 'open-view-guide') {
      // The hand-off is the whole reason the stop that offers it exists: this
      // guide is finished with the user, and the view they picked walks them
      // through itself instead.
      guideState.close()
      this.root.onKeydown.navigate(run.view)
      workspaceState.requestViewTour(run.view)
      return false
    }
    if (run.kind === 'connect-github') {
      githubSignIn.start()
      return false
    }
    return false
  }

  /** The app's current location, for history capture. */
  currentLocation(): NavigationLocation {
    const thread = workspaceState.selectedThread
    return {
      view: this.root.onKeydown.activeView,
      thread: thread ? { projectId: thread.projectId, threadId: thread.id } : null,
      utilities:
        this.root.onKeydown.activeView === 'settings-utilities'
          ? settingsRouteState.utilities
          : null
    }
  }

  /** The most recently visited thread of one content-view family that still exists. */
  lastThreadOfFamily(family: ContentThreadFamily): Thread | null {
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
  rememberedThreadOfFamily(family: ContentThreadFamily): Thread | null {
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
  reconcileThreadForContentView(view: View): void {
    const decision = decideContentViewThread(view, workspaceState.selectedThread, {
      isEmpty: (family) => workspaceState.contentViewIsEmpty(family),
      remembered: this.rememberedThreadOfFamily,
      recentOfFamily: this.lastThreadOfFamily
    })
    if (decision.kind === 'keep') return
    if (decision.kind === 'clear') {
      workspaceState.clearThread(false)
      return
    }
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === decision.thread.projectId) ??
      null
    workspaceState.openThread(decision.thread, project)
    void scopeState.ensureBoardLoaded(decision.thread.projectId)
  }

  /** Re-open the thread captured in a history entry, if it still exists. */
  async restoreThreadFromHistory(entry: NavigationLocation): Promise<void> {
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
  async goBack(): Promise<void> {
    const entry = navigationHistoryState.back(this.currentLocation())
    if (!entry) return
    navigationHistoryState.beginTraversal()
    try {
      this.root.onKeydown.navigate(entry.view)
      this.root.openAssistantFromSearch.restoreUtilitiesFromHistory(entry)
      await this.restoreThreadFromHistory(entry)
    } finally {
      navigationHistoryState.endTraversal()
    }
  }

  capturePaletteFocus(): void {
    const active = document.activeElement
    if (
      !(active instanceof HTMLElement) ||
      !active.isContentEditable ||
      !active.matches(COMPOSER_DRAFT_SELECTOR)
    ) {
      this.paletteFocusBookmark = null
      return
    }

    this.paletteFocusBookmark = captureElementSelection(active)
  }

  restorePaletteFocus(): boolean {
    const bookmark = this.paletteFocusBookmark
    this.paletteFocusBookmark = null
    return bookmark ? restoreElementSelection(bookmark) : false
  }

  toggleCommandPalette(): void {
    // A nested screen steps back to the actions list; the actions list closes.
    if (this.spotlightScreenId === 'actions') {
      this.root.onKeydown.closeSpotlight()
      return
    }
    if (this.spotlightScreenId) {
      this.backToSpotlightHome()
      return
    }
    this.capturePaletteFocus()
    this.commandPaletteOpen = true
    // The spotlight is where the semantic ranking lives; its thread search is
    // one hop away. Start the embedding model boot behind the keystroke (main
    // no-ops it unless intent search is enabled).
    warmIntentSearch()
  }

  /** Step back to the actions list from a nested spotlight screen. */
  backToSpotlightHome(): void {
    this.root.onKeydown.closeSpotlight()
    this.commandPaletteOpen = true
  }

  /** Preserve the current content view / project sidebar state when opening a
   *  searched thread   never force the Projects view. Reuses the notification
   *  open logic, which handles scope state, the threads view and chats. */
  async openThreadFromSearch(thread: Thread): Promise<void> {
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
    await this.root.onKeydown.openThreadFromNotification(thread, project)
  }

  /**
   * Hand the semantic half of a spotlight thread search to the screen that asked.
   *
   * Only one spotlight screen is on top at a time, so the open one owns the
   * payload; its controller drops a request or query the user has moved past.
   */
  applyThreadSearchIntent(payload: {
    query: string
    requestId: number
    results: ThreadSearchResult[]
  }): void {
    if (this.root.onKeydown.threadSearch.paletteOpen)
      this.root.onKeydown.threadSearch.applyIntentResults(payload)
    else if (this.chatSearch.paletteOpen) this.chatSearch.applyIntentResults(payload)
    else if (this.root.onKeydown.assistantSearch.paletteOpen)
      this.root.onKeydown.assistantSearch.applyIntentResults(payload)
  }

  /** Focus a tab picked in browser search: land on the Browser view and switch
   *  its strip to that tab. */
  openBrowserTabFromSearch(tabId: string): void {
    this.root.onKeydown.navigate('browser')
    void withBrowser((store) => store.switchTo(tabId))
  }

  async loadScopeData(preferredProjectId?: string): Promise<void> {
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
      void waitForFeatures()
        .then(() => {
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
        // A feature graph that failed to start is already reported once by
        // `waitForFeatures`; warming catalogs against it is pointless.
        .catch(() => undefined)
    } catch {
      scopeState.setScopesFromProjects([], new SvelteMap())
      scopeState.clearThreads()
      notificationPanelState.hydrateFromThreads([])
    }
  }

  async handleProjectCreated(project: Project): Promise<void> {
    await this.loadScopeData(project.id)
    workspaceState.pendingAddedProject = project
  }

  openNewProjectSpotlight(): void {
    this.newProjectSpotlightOpen = true
  }

  /** Spotlight flow: land on the new project (Projects view) with its fresh thread focused. */
  async handleSpotlightProjectCreated(project: Project): Promise<void> {
    this.newProjectSpotlightOpen = false
    this.root.onKeydown.navigate('projects')
    await this.handleProjectCreated(project)
  }

  /** Spotlight flow: a picked folder already exists as a project   focus it. */
  handleSpotlightExistingProject(project: Project): void {
    this.newProjectSpotlightOpen = false
    this.root.onKeydown.navigate('projects')
    const thread = scopeState.allScopeThreads
      .filter((candidate) => candidate.projectId === project.id && !candidate.archived)
      .sort((left, right) => right.lastActivity - left.lastActivity)[0]
    if (thread) {
      workspaceState.openThread(thread, project)
    } else {
      workspaceState.clearThread()
      workspaceState.activeProject = project
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
  focusProjectFromSpotlight(project: Project): void {
    const iconUrl =
      scopeState.projects.find((candidate) => candidate.id === project.id)?.iconUrl ?? null
    const keepsProject = viewShowsProject(this.root.onKeydown.activeView, project.id, {
      scopedProjectId: scopeState.sidebarContext?.projectId ?? null,
      threadsViewShowsProject: threadProjectFilterState.matches(project.id),
      boardProjectId: scopeState.activeProjectId
    })

    // Navigate before selecting the thread so the shell's content-view reconcile
    // never paints the Projects family's remembered thread for a frame.
    if (!keepsProject) this.root.onKeydown.navigate('projects')
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

  closeNewProjectSpotlight(): void {
    this.newProjectSpotlightOpen = false
  }
}
