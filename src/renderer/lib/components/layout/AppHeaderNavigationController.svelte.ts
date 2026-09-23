import { type Component } from 'svelte'
import { invoke } from '$lib/ipc.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { sidebarState } from '$lib/stores/sidebar.svelte'
import { threadVisitKey, workspaceState } from '$lib/stores/workspace.svelte'
import { type MainView } from '$lib/stores/renderer-recovery.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { INBOX_PROJECT_ID, type Project, type Thread } from '$shared/types'
import { SvelteSet } from 'svelte/reactivity'
import { BotMessageSquare, FolderKanban, Kanban, MessageSquare, SquareDashedKanban, Timeline } from '@lucide/svelte'

export type HeaderViewOptionId =
  | 'projects'
  | 'threads'
  | 'scoped-threads'
  | 'scope-board'
  | 'chats'
  | 'assistant'

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

/** Return the most recently visited thread of one navigation family. */
function recentThreadForKind(isChat: boolean): Thread | null {
  for (const visit of workspaceState.recentThreadVisits) {
    const candidate = scopeState.allScopeThreads.find((thread) => threadVisitKey(thread) === visit)
    if (!candidate || candidate.archived) continue
    if ((candidate.projectId === INBOX_PROJECT_ID) === isChat) return candidate
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

  /** Last option shown while a primary view was active. */
  lastPrimaryHeaderViewOption = $state<HeaderViewOptionId>('projects')

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

    $effect(() => {
      if (this.showsPrimaryOption) this.lastPrimaryHeaderViewOption = this.activeHeaderViewOption
    })
  }

  /** Warm every plausible restore target before a nav click or shortcut lands. */
  preloadNavigationThreads(target: 'chats' | 'projects'): void {
    const isChat = target === 'chats'
    const targetIds = [
      isChat ? scopeState.stashedChatThreadId : scopeState.stashedProjectThreadId,
      recentThreadForKind(isChat)?.id,
      workspaceState.selectedThread &&
      (workspaceState.selectedThread.projectId === INBOX_PROJECT_ID) === isChat
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
   *  Cmd/Ctrl+0-4 view shortcuts so they always land on the requested view. */
  async navigateToView(view: 'projects' | 'chats' | 'scope' | 'threads' | 'assistant'): Promise<void> {
    const activeView = this.getActiveView()
    if (view === 'chats') this.preloadNavigationThreads('chats')
    else if (view === 'projects') this.preloadNavigationThreads('projects')
    if (view === 'threads') {
      scopeState.clearSidebarContext()
    } else if (view === 'assistant') {
      scopeState.clearSidebarContext()
    } else if (view === 'chats') {
      // Remember the current project thread before switching to chats
      scopeState.stashedProjectThreadId = workspaceState.selectedThread?.id ?? null
      if (scopeState.sidebarContext) {
        scopeState.stashSidebarContext()
      }
      // Restore the last chat thread, or clear selection so the composer shows
      if (scopeState.stashedChatThreadId) {
        void this.restoreThread(scopeState.stashedChatThreadId)
      } else {
        workspaceState.clearThread()
      }
    } else if (view === 'projects' && activeView === 'chats') {
      // Coming from chats   remember the chat thread and restore the project thread
      scopeState.stashedChatThreadId = workspaceState.selectedThread?.id ?? null
      if (scopeState.stashedProjectThreadId) {
        void this.restoreThread(scopeState.stashedProjectThreadId)
      }
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

  async onPrimaryNavClick(view: 'projects' | 'chats' | 'scope' | 'threads' | 'assistant'): Promise<void> {
    const activeView = this.getActiveView()
    // Scope Board keeps its toggle behaviour: already open → last view.
    if (view === 'scope' && view === activeView) {
      await this.navigateToView(this.lastViewBeforeScope)
      return
    }
    // Selecting the view already open from the dropdown toggles the left
    // sidebar (scoped threads → projects must simply close the board (the
    // caller clears it) without hiding the sidebar).
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
        label: 'Projects',
        icon: FolderKanban,
        keys: ['mod', '1'],
        select: () => {
          if (scopeState.sidebarContext) scopeState.clearSidebarContext()
          void this.onPrimaryNavClick('projects')
        }
      },
      {
        id: 'threads',
        label: 'Threads',
        icon: Timeline,
        keys: ['mod', '2'],
        select: () => void this.onPrimaryNavClick('threads')
      },
      {
        id: 'scoped-threads',
        label: 'Scoped threads',
        icon: SquareDashedKanban,
        keys: ['mod', '3'],
        select: () => void this.toggleScopedThreads()
      },
      {
        id: 'scope-board',
        label: 'Scope Board',
        icon: Kanban,
        keys: ['mod', '4'],
        select: () => void this.onPrimaryNavClick('scope')
      },
      {
        id: 'chats',
        label: 'Chats',
        icon: MessageSquare,
        keys: ['mod', '0'],
        select: () => void this.onPrimaryNavClick('chats')
      },
      {
        id: 'assistant',
        label: 'Assistant',
        icon: BotMessageSquare,
        keys: ['mod', '5'],
        select: () => void this.onPrimaryNavClick('assistant')
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
      activeView === 'scope'
    )
  })

  /** The option the trigger and menu reflect: live on primary views, the last
   *  primary option while a takeover page owns the header. */
  shownHeaderViewOption = $derived(
    this.showsPrimaryOption ? this.activeHeaderViewOption : this.lastPrimaryHeaderViewOption
  )

  activeHeaderViewLabel = $derived.by(() => {
    const option = this.headerViewOptions().find(
      (candidate) => candidate.id === this.shownHeaderViewOption
    )
    return option?.label ?? 'Projects'
  })

  activeHeaderViewIcon = $derived(
    this.headerViewOptions().find((candidate) => candidate.id === this.shownHeaderViewOption)
      ?.icon ?? FolderKanban
  )

  /** Cmd/Ctrl+3   Projects view with the scope sidebar active for the current
   *  thread (or project). Idempotent: never turns scope state off. */
  async openProjectWithScopeState(): Promise<void> {
    const activeView = this.getActiveView()
    if (activeView !== 'projects' && activeView !== 'projects-scope') {
      await this.navigateToView('projects')
      // Coming back from another view   restore a stashed scope context first.
      if (scopeState.stashedSidebarContext) {
        scopeState.restoreStashedSidebarContext()
        if (scopeState.stashedProjectThreadId) {
          void this.restoreThread(scopeState.stashedProjectThreadId)
        }
        return
      }
    }
    if (scopeState.sidebarContext) return

    const project = workspaceState.activeProject
    if (!project) return

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
}
