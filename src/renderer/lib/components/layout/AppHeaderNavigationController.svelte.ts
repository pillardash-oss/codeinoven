import { CONTENT_FAMILY_ICONS } from '$lib/content-view-icons'
import { contentThreadFamily, type ContentThreadFamily } from '$lib/content-view-threads'
import { invoke } from '$lib/ipc.svelte'
import { keymapState } from '$lib/keymap/keymap-state.svelte'
import { isSettingsView, type MainView } from '$lib/stores/renderer-recovery.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { sidebarState } from '$lib/stores/sidebar.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { threadVisitKey, workspaceState } from '$lib/stores/workspace.svelte'
import { type Project, type Thread } from '$shared/types'
import { FolderKanban, Globe, Kanban, Microscope, Timeline } from '@lucide/svelte'
import { type Component } from 'svelte'
import { SvelteSet } from 'svelte/reactivity'

export type HeaderViewOptionId =
  'projects' | 'threads' | 'scoped-threads' | 'scope-board' | 'chats' | 'assistant' | 'browser'

/**
 * The view a return to the project family lands on.
 *
 * `scoped` is the projects view carrying the scope sidebar; `scope` is the
 * Scope page, which follows the open thread's project. The two differ from the
 * rail option ids because they are what a navigation can land on, not what the
 * rail paints.
 */
export type ProjectFamilyLanding = 'projects' | 'threads' | 'scoped' | 'scope'

/** The four views that share the project family's single activity badge. */
const PROJECT_FAMILY_VIEW_OPTIONS: readonly HeaderViewOptionId[] = [
  'projects',
  'threads',
  'scoped-threads',
  'scope-board'
]

export interface HeaderViewOption {
  id: HeaderViewOptionId
  label: string
  icon: Component
  keys: readonly string[]
  select: () => void
}

type PrimaryView = 'projects' | 'chats' | 'threads' | 'assistant'

export interface AppHeaderNavigationOptions {
  /** The view the shell currently shows; read per call so the controller follows navigation. */
  getActiveView: () => MainView
  navigate: (view: MainView) => void
}

/** Return the most recently visited thread of one content-view family. */
function recentThreadOfFamily(family: ContentThreadFamily): Thread | null {
  for (const visit of workspaceState.recentThreadVisits) {
    const candidate = scopeState.allScopeThreads.find((thread) => threadVisitKey(thread) === visit)
    if (!candidate || candidate.archived) continue
    if (contentThreadFamily(candidate) === family) return candidate
  }
  return null
}

/**
 * Owns the app header's primary navigation: the view switcher dropdown, the
 * Cmd/Ctrl view shortcuts, and the thread restore/preload choreography they
 * share, so `AppHeader.svelte` keeps only the rendering of the header bar.
 */
export class AppHeaderNavigationController {
  private readonly getActiveView: () => MainView
  private readonly navigate: (view: MainView) => void

  /** Track the primary view (Projects/Threads/Chats) the user was on before
   *  entering the scope view, so the header Scope Board button can toggle
   *  between scope view and whatever came last. All other views (settings and
   *  the other takeover pages) keep the previous primary view. */
  lastViewBeforeScope: PrimaryView = $state('projects')

  /** The project-family view (Projects, Threads, Scoped threads, Scope Board)
   *  the user last had selected. The project family's activity badge rides this
   *  option while a view that owns threads of another family   Chat and
   *  Assistant   or no threads at all   the Browser   is on screen, so the badge
   *  never lands on a rail item that cannot show project threads. */
  lastProjectViewOption: HeaderViewOptionId = $state('projects')

  constructor(options: AppHeaderNavigationOptions) {
    this.getActiveView = options.getActiveView
    this.navigate = options.navigate

    $effect(() => {
      const activeView = this.getActiveView()
      if (
        activeView === 'projects' ||
        activeView === 'projects-scope' ||
        activeView === 'threads' ||
        activeView === 'chats' ||
        activeView === 'assistant'
      ) {
        this.lastViewBeforeScope = activeView === 'projects-scope' ? 'projects' : activeView
      }
    })

    // Remember every project view the user selects so the badge has a home to
    // return to once a view that is not a project view takes over.
    $effect(() => {
      const shown = this.shownHeaderViewOption
      if (shown && PROJECT_FAMILY_VIEW_OPTIONS.includes(shown)) {
        this.lastProjectViewOption = shown
      }
    })
  }

  /** Warm every plausible restore target before a nav click or shortcut lands. */
  preloadNavigationThreads(target: 'chats' | 'projects'): void {
    const family: ContentThreadFamily = target === 'chats' ? 'chats' : 'projects'
    const targetIds = [
      workspaceState.contentViewThreadRef(family)?.threadId,
      family === 'chats' ? scopeState.stashedChatThreadId : scopeState.stashedProjectThreadId,
      recentThreadOfFamily(family)?.id,
      workspaceState.selectedThread && contentThreadFamily(workspaceState.selectedThread) === family
        ? workspaceState.selectedThread.id
        : null
    ]
    const seen = new SvelteSet<string>()
    for (const threadId of targetIds) {
      if (!threadId || seen.has(threadId)) continue
      seen.add(threadId)
      const thread = scopeState.allScopeThreads.find((candidate) => candidate.id === threadId)
      if (thread && !thread.archived) void threadMessages.preload(thread.projectId, thread.id)
    }
  }

  /** Find a thread by ID across all projects and open it, restoring the
   *  project context.  No-op if the thread no longer exists. */
  async restoreThread(threadId: string): Promise<void> {
    // Cache-first: restoring from the in-memory scope lists keeps openThread on
    // the same synchronous tick as the navigation, so the target view never
    // paints its empty state for a frame or two while IPC round-trips resolve.
    const cached = scopeState.allScopeThreads.find((candidate) => candidate.id === threadId)
    if (cached) {
      const cachedProject =
        scopeState.projectRecords.find((candidate) => candidate.id === cached.projectId) ?? null
      workspaceState.openThread(cached, cachedProject)
      void scopeState.ensureBoardLoaded(cached.projectId)
      return
    }
    const allThreads: Thread[] = await invoke('thread:listAll')
    const thread = allThreads.find((t) => t.id === threadId)
    if (!thread) return
    const projects: Project[] = await invoke('project:list')
    const project = projects.find((p) => p.id === thread.projectId) ?? null
    workspaceState.openThread(thread, project)
    void scopeState.ensureBoardLoaded(thread.projectId)
  }

  /** Navigate to a primary view without any sidebar toggling   used by the
   *  Cmd/Ctrl+0-9 view shortcuts so they always land on the requested view. */
  async navigateToView(
    view: 'projects' | 'chats' | 'scope' | 'threads' | 'assistant' | 'browser'
  ): Promise<void> {
    const activeView = this.getActiveView()
    if (view === 'browser') {
      // The browser is its own workspace with no scope state to reconcile.
      this.navigate('browser')
      return
    }
    if (view === 'chats') this.preloadNavigationThreads('chats')
    else if (view === 'projects') this.preloadNavigationThreads('projects')
    if (view === 'threads') {
      scopeState.clearSidebarContext()
    } else if (view === 'assistant') {
      scopeState.clearSidebarContext()
    } else if (view === 'chats') {
      // Remember the project-family thread before switching to chats so the
      // scope state can restore it; an assistant task is never a project thread.
      // Which thread the chats view itself shows is the shell's decision, from
      // the chats family's own remembered thread.
      const selected = workspaceState.selectedThread
      scopeState.stashedProjectThreadId =
        selected && contentThreadFamily(selected) === 'projects' ? selected.id : null
      if (scopeState.sidebarContext) {
        scopeState.stashSidebarContext()
      }
    } else if (view === 'projects' && activeView === 'chats') {
      // Remember the chat thread so returning to chats can preload it; the
      // shell restores the project thread from the projects family's memory.
      const selected = workspaceState.selectedThread
      scopeState.stashedChatThreadId =
        selected && contentThreadFamily(selected) === 'chats' ? selected.id : null
    } else if (view === 'projects' && activeView === 'scope') {
      scopeState.clearSidebarContext()
    }
    if (view === 'scope') {
      const projectId = workspaceState.selectedThread?.projectId ?? workspaceState.activeProject?.id
      if (projectId) await scopeState.activateProject(projectId)
      scopeState.clearSidebarContext()
      this.navigate('scope')
    } else {
      this.navigate(view)
    }
  }

  async onPrimaryNavClick(
    view: 'projects' | 'chats' | 'scope' | 'threads' | 'assistant' | 'browser'
  ): Promise<void> {
    const activeView = this.getActiveView()
    // Scope Board keeps its toggle behaviour: already open → last view.
    if (view === 'scope' && view === activeView) {
      await this.navigateToView(this.lastViewBeforeScope)
      return
    }
    // Selecting the view already open from the dropdown toggles the shared left
    // sidebar (scoped threads → projects must simply close the board (the
    // caller clears it) without hiding the sidebar). The browser's left sidebar
    // is its tab strip, so re-selecting Browser folds that instead of the
    // thread sidebar, which is how the user gets an uninterrupted page.
    if (view === activeView) {
      sidebarState.toggle()
      return
    }
    await this.navigateToView(view)
  }

  async toggleScopedThreads(): Promise<void> {
    const activeView = this.getActiveView()
    if (
      activeView === 'projects-scope' ||
      (activeView === 'projects' && scopeState.sidebarContext)
    ) {
      // Off: land on the plain projects view   navigate() closes the sidebar.
      await this.navigateToView('projects')
      return
    }
    await this.openProjectWithScopeState()
  }

  headerViewOptions(): HeaderViewOption[] {
    return [
      {
        id: 'projects',
        label: 'Project',
        icon: FolderKanban,
        keys: keymapState.keysFor('nav-projects'),
        select: () => {
          if (scopeState.sidebarContext) scopeState.clearSidebarContext()
          void this.onPrimaryNavClick('projects')
        }
      },
      {
        id: 'threads',
        label: 'Thread',
        icon: Timeline,
        keys: keymapState.keysFor('nav-threads'),
        select: () => void this.onPrimaryNavClick('threads')
      },
      {
        id: 'scoped-threads',
        label: 'Scoped',
        icon: Microscope,
        keys: keymapState.keysFor('nav-projects-with-scope'),
        select: () => void this.toggleScopedThreads()
      },
      {
        id: 'scope-board',
        label: 'Board',
        icon: Kanban,
        keys: keymapState.keysFor('nav-scope'),
        select: () => void this.onPrimaryNavClick('scope')
      },
      {
        id: 'chats',
        label: 'Chat',
        icon: CONTENT_FAMILY_ICONS.chats,
        keys: keymapState.keysFor('nav-chats'),
        select: () => void this.onPrimaryNavClick('chats')
      },
      {
        id: 'assistant',
        label: 'Assistant',
        icon: CONTENT_FAMILY_ICONS.assistant,
        keys: keymapState.keysFor('nav-assistant'),
        select: () => void this.onPrimaryNavClick('assistant')
      },
      {
        id: 'browser',
        label: 'Browser',
        icon: Globe,
        keys: keymapState.keysFor('nav-browser'),
        select: () => void this.onPrimaryNavClick('browser')
      }
    ]
  }

  /** The currently active option is shown with brighter text in the menu. */
  activeHeaderViewOption = $derived.by((): HeaderViewOptionId => {
    const activeView = this.getActiveView()
    if (activeView === 'scope') return 'scope-board'
    if (
      activeView === 'projects-scope' ||
      (activeView === 'projects' && scopeState.sidebarContext)
    ) {
      return 'scoped-threads'
    }
    if (activeView === 'threads') return 'threads'
    if (activeView === 'chats') return 'chats'
    if (activeView === 'assistant') return 'assistant'
    if (activeView === 'browser') return 'browser'
    return 'projects'
  })

  /** Views whose header maps to a real view-switcher option. Settings and the
   *  other takeover views must not, or the trigger would flash "Projects". */
  showsPrimaryOption = $derived.by(() => {
    const activeView = this.getActiveView()
    return (
      activeView === 'projects' ||
      activeView === 'projects-scope' ||
      activeView === 'threads' ||
      activeView === 'chats' ||
      activeView === 'assistant' ||
      activeView === 'browser' ||
      activeView === 'scope'
    )
  })

  /** The option the rail marks current: live on primary views, and none at all
   *  on takeover pages (Settings and friends) so the utility controls own the
   *  active state there instead of a stale view. */
  shownHeaderViewOption = $derived<HeaderViewOptionId | null>(
    this.showsPrimaryOption ? this.activeHeaderViewOption : null
  )

  /**
   * The view a return to the project family lands on: the option the user last
   * selected for the family, which is also the one the rail's project badge
   * rides while another family (or none, in the browser) is on screen.
   *
   * The Ctrl+Tab switcher asks for this when it brings the project family
   * forward from the browser, Settings, Chats or Assistant: the jump lands on
   * the project view the user left instead of resetting to the default
   * Projects view.
   */
  projectFamilyLanding(): ProjectFamilyLanding {
    switch (this.lastProjectViewOption) {
      case 'threads':
        return 'threads'
      case 'scoped-threads':
        return 'scoped'
      case 'scope-board':
        return 'scope'
      default:
        return 'projects'
    }
  }

  /** The rail option that carries the project family's activity badge: the live
   *  project view when one is shown, otherwise the last project view the user
   *  was on. Chat, Assistant and Browser are on screen with a family of their
   *  own (or none at all), so they never take the project badge   without this
   *  fallback a working project thread would have no rail item to report on and
   *  the activity would vanish from the rail entirely. Settings and other
   *  takeover pages keep the badge on the last project view too. Declared after
   *  `shownHeaderViewOption` because a class field initializer cannot read a
   *  later field. */
  projectBadgeOption = $derived<HeaderViewOptionId | null>(
    this.shownHeaderViewOption !== null &&
      PROJECT_FAMILY_VIEW_OPTIONS.includes(this.shownHeaderViewOption)
      ? this.shownHeaderViewOption
      : this.lastProjectViewOption
  )

  /** Name of the view the rail has selected, shown in the app header between
   *  the nav buttons and the view's own action buttons. Settings is the one
   *  takeover page with a rail selection of its own, so it names itself; every
   *  other takeover page has no view to name. */
  activeHeaderViewLabel = $derived.by((): string | null => {
    if (this.showsPrimaryOption) {
      const option = this.headerViewOptions().find(
        (candidate) => candidate.id === this.activeHeaderViewOption
      )
      return option?.label ?? 'Projects'
    }
    return isSettingsView(this.getActiveView()) ? 'Settings' : null
  })

  /** Cmd/Ctrl+3   Projects view with the scope sidebar active for the current
   *  thread (or project). Idempotent: never turns scope state off.
   *
   *  From any other view this lands straight on `projects-scope`, the scoped
   *  projects view, as soon as the docked scope is known. Routing through the
   *  plain projects view first painted the rail's Project item and only rebuilt
   *  the scope state an IPC round trip later, so the current-item surface slid
   *  over to Project and back to Scoped on every switch into this view. */
  async openProjectWithScopeState(): Promise<void> {
    const activeView = this.getActiveView()
    if (activeView !== 'projects' && activeView !== 'projects-scope') {
      // Warm the family's thread messages, exactly as a plain projects
      // navigation would, and keep the chats bookkeeping that navigation owns.
      this.preloadNavigationThreads('projects')
      if (activeView === 'chats') {
        const selected = workspaceState.selectedThread
        scopeState.stashedChatThreadId =
          selected && contentThreadFamily(selected) === 'chats' ? selected.id : null
      }
      // A scope the user stashed on the way out comes back exactly as it was.
      if (scopeState.stashedSidebarContext) {
        scopeState.restoreStashedSidebarContext()
        this.navigate('projects-scope')
        if (scopeState.stashedProjectThreadId) {
          void this.restoreThread(scopeState.stashedProjectThreadId)
        }
        return
      }
      // A scope still docked (Settings and the browser never undock it) is
      // already the destination: just return to the view that shows it.
      if (scopeState.sidebarContext) {
        this.navigate('projects-scope')
        return
      }
      // Nothing to dock anywhere (a fresh app with no project thread): land on
      // the plain projects view instead of a scoped view with no scope to show.
      if (!this.scopedProjectId()) {
        await this.navigateToView('projects')
        return
      }
      // Land on the scoped view first, so the rail moves once and the docked
      // scope is built underneath it, rather than the rail painting Project
      // while `thread:listAll` and `activateProject` resolve. A remembered
      // thread whose project no longer exists resolves to nothing, and the
      // plain projects view is then the honest landing.
      this.navigate('projects-scope')
      if (!(await this.dockScopeForOpenThread())) this.navigate('projects')
      return
    }
    if (scopeState.sidebarContext) return

    // Already on a projects view, so the shell is in place: only the docked
    // scope has to be built.
    await this.dockScopeForOpenThread()
  }

  /**
   * The project the scoped view docks for the shell's current state: the open
   * project thread's own project, else the project family's remembered (then
   * most recently visited) thread, which is what landing on the scoped view
   * reconciles to when another family's thread   a chat, say   is open. Null
   * when the app holds no project thread at all.
   */
  private scopedProjectId(): string | null {
    const selected = workspaceState.selectedThread
    if (selected && contentThreadFamily(selected) === 'projects') return selected.projectId
    const remembered = workspaceState.contentViewThreadRef('projects')
    if (remembered) return remembered.projectId
    return recentThreadOfFamily('projects')?.projectId ?? null
  }

  /**
   * Dock the scope sidebar for the open thread (or the active project) on the
   * projects view the shell already shows, so the rail marks Scoped and the
   * sidebar shows that scope. Returns false when the app has no project to dock.
   */
  private async dockScopeForOpenThread(): Promise<boolean> {
    const thread = workspaceState.selectedThread
    const projectThread = thread && contentThreadFamily(thread) === 'projects' ? thread : null
    const targetProjectId =
      projectThread?.projectId ?? workspaceState.activeProject?.id ?? this.scopedProjectId()
    // The hidden containers (Chats, Assistant, the browser) are not projects the
    // scope sidebar can dock; `projectRecords` already lists the visible ones.
    if (!targetProjectId) return false
    if (!scopeState.projectRecords.some((project) => project.id === targetProjectId)) return false

    const allThreads: Thread[] = await invoke('thread:listAll')
    scopeState.setThreads(allThreads)
    await scopeState.activateProject(targetProjectId)

    if (projectThread) {
      scopeState.showSidebarForThread(projectThread)
    } else {
      scopeState.showSidebarForProject(targetProjectId)
    }
    return true
  }
}
