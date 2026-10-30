import { invoke } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import type { Assistant, Thread } from '$shared/types'
import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
import { toast } from 'svelte-sonner'
import { SvelteSet } from 'svelte/reactivity'
import { ScopeActionsController } from '../../scope/ScopeActionsController.svelte'
import type { Workspace } from './Workspace-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the Workspace board. */
export class WorkspaceState extends BoardUnit<Workspace> {
  constructor(root: Workspace) {
    super(root)
  }

  /**
   * Capture the mode the surface opened on.
   *
   * It comes from the props, which only exist once the board is bound, so the
   * board asks for it right after construction.
   */
  bind(): void {
    this.previousMode = this.root.props.mode
  }
  lastFocusedThreadId: string | null = $state(null)

  /** The slot the active row sat in on the last run of the follow effect, so a
   *  row the thread moves by itself is followed even while the reader holds the
   *  scroll. */
  lastActiveRowSortKey: number | null = $state(null)

  // Intentional initial-value capture   the map is keyed by the mode prop.
  // svelte-ignore state_referenced_locally
  /** Set by `bind()`: the mode the surface was on when the board was built. */
  previousMode: Workspace['props']['mode'] = 'chats'

  projectCreateTrigger = $state(0)

  /** Which add-project flow the next trigger should start. */
  projectCreateTriggerKind = $state<'local' | 'git-clone'>('local')

  prevAddProjectCount = 0

  prevNewChatCount = 0

  prevAssistantTaskCount = 0

  prevAssistantCount = 0

  prevProjectFileOpenCount = 0

  prevToggleContextSidebarCount = 0

  // Scope actions (edit, pin, archive, worktree lifecycle, merge, delete) shared
  // with the scope board, so the sidebar scope and the board offer the same set.
  scopeActions = new ScopeActionsController({
    getProjectId: () => scopeState.sidebarContext?.projectId ?? scopeState.activeProjectId,
    onNavigateToScopedThreads: () => this.root.props.navigate('projects-scope')
  })

  browserTabs = $derived(contextSidebarState.sidebarTabs.filter((tab) => tab.kind === 'browser'))

  focusBrowser(): void {
    // Prefer the remembered active tab over the last one so a restart (or any
    // path that lost track of the active tab) reopens what the user last saw.
    const id = contextSidebarState.rememberedBrowserTabId
    if (id) contextSidebarState.focus(id)
  }

  /** Auditor threads are orchestration children: the bounded initial paint and
   *  scope hydration both skip them, so after a reload the scope store only
   *  knows about one if a live broadcast happened in this session. Fetch it
   *  once and merge it in, so the rail badge can never silently miss a
   *  persisted terminal state (failed, report ready). */
  auditorFetchRequested = new SvelteSet<string>()

  /** True while a terminal is on screen in whichever region hosts terminals. */
  terminalOpen = $derived(
    contextSidebarState.terminalPlacement === 'bottom'
      ? contextSidebarState.terminalDockVisible
      : Boolean(
          contextSidebarState.sidebarVisible && contextSidebarState.activeTab?.kind === 'terminal'
        )
  )

  terminalDockVisible = $derived(contextSidebarState.terminalDockVisible)

  /** Project the git sidebar panel is kept mounted for. The panel stays alive
   *  across sidebar tab switches AND thread switches within that project   its
   *  visibility is toggled via CSS only, and scope-bucket changes are swapped
   *  in place by GitStatusPanel itself, so switching threads never tears the
   *  panel down. Only changing projects remounts it. */
  gitPanelProjectId = $state<string | null>(null)

  gitPanelScopeBucketId = $state(DEFAULT_SCOPE_BUCKET_ID)

  sidebarWasVisible = false

  /** Whether the sidebar's own panel is the one hosting a window-sized surface,
   *  which has to outlive `sidebarVisible` going false (see above). */
  sidebarHostsFullscreenEditor = $derived(projectFilesWorkspace.fullscreenOpen)

  terminalWasVisible = false

  /** Assistant runs whose parent task is being fetched, so one selection never
   *  fires two reads for the same run. */
  pendingAssistantParentReads = new SvelteSet<string>()

  // Selecting a thread through any path must settle its unread badge. Sidebar
  // clicks route through openThread, but every programmatic selection calls
  // workspaceState.openThread directly and bypasses it: the view-switch
  // reconcile in App.svelte (entering Chats restores the last chat), history
  // restore, and the startup restore below. Without this net the thread the
  // user is looking at would stay unread until they click a different row.
  // Keyed on the thread id so re-renders of the same selection are no-ops,
  // while switching away and back re-marks (marking read is idempotent).
  readSettledThreadId: string | null = $state(null)

  /**
   * The page the conversation's thread browser is on, as last reported to main.
   *
   * Plain, not reactive: this is what the reporting effect compares against to
   * decide whether anything has to be sent, and making it reactive would have the
   * effect re-run on its own write.
   */
  reportedThreadBrowserPage: {
    scope: string
    tabId: string
    boxId: string | null
    url: string
  } | null = $state(null)

  /** The last (thread, draft-state) pair the draft→todo nudge ran for, so the
   *  effect below only fires when the draft state actually transitions   never
   *  clobbering a manual slice switch while a draft stays unchanged. */
  draftStageSyncKey: string | null = $state(null)

  /** Whether the sidebar is showing the scope-board project view. That view has
   *  its own per-stage lists and inner scrolling; the focus-follow reveal below
   *  is only for the regular Projects/Threads/Chats views. */
  isScopeBoardView = $derived(
    this.root.props.mode === 'projects' && Boolean(scopeState.sidebarContext)
  )

  /** Open a thread from the Scope Board cross-scope search: land back in the
   *  project view, select it, hydrate its board and mark it read (mirrors the
   *  former app-shell openScopeThread flow). */
  async openThreadFromScopeSearch(thread: Thread): Promise<void> {
    this.root.props.navigate('projects')
    const project =
      scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
    workspaceState.openThread(thread, project)
    void scopeState.ensureBoardLoaded(thread.projectId)
    const updated = await invoke('thread:markRead', thread.projectId, thread.id)
    scopeState.updateThread(updated)
    workspaceState.updateThread(updated)
  }

  // Keep managed-worktree health fresh for the scoped sidebar too, so the scope
  // menu offers "Repair worktree" exactly when the board would (deduped in the store).
  //
  // Worktree health belongs to a *scope*, not to a thread, so this is keyed on
  // the docked project+bucket values rather than on the sidebar-context object.
  // `showSidebarForThread` allocates a fresh context object on every thread
  // switch, so depending on the object made each switch inside one scope look
  // like a scope change. Depending on the two strings re-runs only when the
  // scope actually moves or the board changes.
  dockedScopeProjectId = $derived(scopeState.sidebarContext?.projectId ?? '')

  dockedScopeBucketId = $derived(scopeState.sidebarContext?.bucketId ?? '')

  /**
   * Return the caret to the chat composer when the shell takes the screen back
   * from a takeover view (Settings, the Scope board, the global browser).
   *
   * A switch between content views needs nothing here: it changes the thread,
   * which remounts the conversation and the composer's own autofocus puts the
   * caret back. A return from a takeover view keeps the same thread, so nothing
   * remounts and the caret used to stay on the control that was clicked. The
   * switch is the user asking for the conversation, so the composer on screen
   * takes the keyboard exactly as it does after a thread switch.
   *
   * The request waits for the next frame rather than running in this flush: the
   * composer probe measures the element it is about to focus, which forces a
   * style and layout pass, and the switch flush is the wrong place to pay for
   * one. A frame is early enough that the caret is back before the user can
   * reach the keyboard.
   *
   * A surface with its own focus trap (modal, sheet, palette) keeps the keyboard
   * it owns, the same guard the double-modifier composer gesture uses, because
   * a view shortcut can still fire behind such a surface.
   */
  composerFocusWasActive: boolean | null = $state(null)

  wasActive: boolean | null = $state(null)

  async toggleAssistantPin(assistant: Assistant): Promise<void> {
    await assistants.setAssistantPinned(assistant.id, !assistant.pinned)
  }

  async skipNextRun(assistant: Assistant): Promise<void> {
    try {
      await assistants.skipNextRun(assistant.id)
      toast.success('Next assistant run skipped', { description: assistant.name })
    } catch (error) {
      reportError(error, 'The next scheduled run could not be skipped.')
      throw error
    }
  }

  async skipRunsToday(assistant: Assistant): Promise<void> {
    try {
      await assistants.skipRunsToday(assistant.id)
      toast.success("Today's assistant runs skipped", { description: assistant.name })
    } catch (error) {
      reportError(error, "Today's scheduled runs could not be skipped.")
      throw error
    }
  }

  /** Reorder assistants by drag: move the dragged assistant around its drop target. */
  async moveAssistant(
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    if (draggedId === targetId) return
    const list = [...assistants.assistants]
    const from = list.findIndex((assistant) => assistant.id === draggedId)
    if (from < 0) return
    const [moved] = list.splice(from, 1)
    const targetIndex = list.findIndex((assistant) => assistant.id === targetId)
    if (targetIndex < 0) return
    list.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, moved)
    await assistants.reorderAssistants(list.map((assistant) => assistant.id))
  }
}
