import AssistantTaskIcon from '$lib/components/icons/cio/AssistantTaskIcon.svelte'
import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
import { scheduleDeferredWork } from '$lib/deferred-work'
import { focusVisibleComposer } from '$lib/focus/composer-focus-registry'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { keymapState } from '$lib/keymap/keymap-state.svelte'
import { motionDuration } from '$lib/motion'
import { isOverlayOpen } from '$lib/overlay-close.svelte'
import { getProjectIcon } from '$lib/project-icons'
import { speechController } from '$lib/speech/speech-controller.svelte'

import { loadBrowser } from '$lib/stores/browser-access.svelte'
import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { designCoordinatorState } from '$lib/stores/design-coordinator.svelte'
import { projectWorkState } from '$lib/stores/project-work.svelte'
import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
import { ovens } from '$lib/stores/ovens.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { scopeState, STAGE_ORDER } from '$lib/stores/scope.svelte'
import { threadChangesState } from '$lib/stores/thread-changes.svelte'
import { threadProjectFilterState } from '$lib/stores/thread-project-filter.svelte'
import { threadUnreadIntent } from '$lib/stores/thread-unread-intent'
import { viewActions, type ViewActionItem } from '$lib/stores/view-actions.svelte'
import { threadStatusSortKey, workspaceState } from '$lib/stores/workspace.svelte'
import { GLOBAL_BROWSER_PROJECT_ID, type AuthoredWorkKind } from '$shared/ipc-contract'
import type { Project, Assistant, Thread } from '$shared/types'
import {
  activeThreadRowId,
  ASSISTANT_SPACE_ID,
  conversationScopeId,
  DEFAULT_SCOPE_BUCKET_ID,
  INBOX_PROJECT_ID,
  isBrowserAssistantThread,
  isOrchestrationChildThread,
  isThreadBusy,
  threadTracksReadStatus
} from '$shared/types'
import { onMount } from 'svelte'
import AssistantSearchControl from '../../assistant/AssistantSearchControl.svelte'
import AssistantCreateControl from '../../assistant/AssistantCreateControl.svelte'
import ProjectCreateControl from '../../shared/ProjectCreateControl.svelte'
import ScopeCreateControl from '../../shared/ScopeCreateControl.svelte'
import ThreadProjectFilterMenu from '../../shared/ThreadProjectFilterMenu.svelte'
import ThreadSearchControl from '../../shared/ThreadSearchControl.svelte'
import SidebarSearchControl from '../SidebarSearchControl.svelte'
import { threadHasVisibleWork } from '../workspace-thread-helpers'
import type { Workspace } from './Workspace-board.svelte'
import { SvelteSet } from 'svelte/reactivity'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the Workspace board. */
export class WorkspaceEffects extends BoardUnit<Workspace> {
  constructor(root: Workspace) {
    super(root)
  }
  /**
   * The work the surface used to do as it set itself up: effects, the
   * subscriptions it opened and the first load it kicked off. It runs from
   * the board's constructor, which the component calls during its own setup,
   * so every effect here is owned by the component.
   */
  init(): void {
    // Decide the launch's first frame before it paints: a saved thread means a
    // restore is coming, so the conversation pane must not flash the Welcome
    // screen at a user whose thread is already on its way.
    workspaceState.restoringLastThread = rendererRecovery.selectedThread !== null
    // Runs before the DOM swaps: capture the outgoing mode's scrollTop while its
    // list is still mounted, render the incoming mode's row, then settle the
    // incoming list once it has rendered.
    $effect.pre(() => {
      if (this.root.props.mode === this.root.state.previousMode) return
      const scroller = this.root.switcherPanelTabs.sidebarScroller
      if (scroller)
        this.root.switcherPanelTabs.sidebarScrollByMode.set(
          this.root.state.previousMode,
          scroller.scrollTop
        )
      this.root.state.previousMode = this.root.props.mode
      // A mode switch is the thread's turn to control the scroll: the reader's
      // place in the list they just left does not follow them into the new one.
      this.root.openThreadFromSwitcher.sidebarReaderOwnsScroll = false
      this.root.switcherPanelTabs.sidebarModeSettlePending = true
      const generation = ++this.root.switcherPanelTabs.sidebarSettleGeneration
      // The row of a thread whose folder is collapsed is not in the incoming list
      // yet. Expanding here, before Svelte renders it, is what lets the settle
      // place the list on the row before the browser paints the switch.
      const thread = this.root.openThreadFromSwitcher.selectedThread
      if (thread) this.root.switcherPanelTabs.prepareThreadRow(thread)
      void this.root.switcherPanelTabs.settleSidebarForMode(this.root.props.mode, generation)
    })

    // This view hosts the terminal panel   advertise it to the header.
    $effect(() => {
      workspaceState.terminalAvailable = true
      return () => {
        workspaceState.terminalAvailable = false
      }
    })

    /** React to Cmd/Ctrl+N → create thread in active project (optionally in a scope bucket). */
    $effect(() => {
      const current = workspaceState.requestCreateThreadCount
      if (
        current !== this.root.mergeThreadsInList.prevCreateThreadCount &&
        !this.root.mergeThreadsInList.creatingThread &&
        workspaceState.consumeCreateThreadRequest()
      ) {
        this.root.mergeThreadsInList.prevCreateThreadCount = current
        const project = this.root.mergeThreadsInList.createThreadRequestProject()
        if (project) {
          this.root.mergeThreadsInList.handleCreateThreadRequest(
            project,
            workspaceState.pendingScopeBucketId ?? undefined
          )
        }
        workspaceState.pendingScopeBucketId = null
      }
    })

    /** React to Cmd/Ctrl+N (no active project) → trigger add-project flow. */
    $effect(() => {
      const current = workspaceState.requestAddProjectCount
      if (
        current !== this.root.state.prevAddProjectCount &&
        workspaceState.consumeAddProjectRequest()
      ) {
        this.root.state.prevAddProjectCount = current
        this.root.state.projectCreateTrigger++
      }
    })

    /** React to Ctrl+K → New chat. */
    $effect(() => {
      const current = workspaceState.requestNewChatCount
      if (current !== this.root.state.prevNewChatCount && workspaceState.consumeNewChatRequest()) {
        this.root.state.prevNewChatCount = current
        this.root.markThreadReadAndApply.startNewChat()
      }
    })

    /** React to Cmd/Ctrl+N on the Assistant view → new task, inside the assistant
     *  the user is currently in when there is one, assistant-less otherwise. */
    $effect(() => {
      const current = workspaceState.requestAssistantTaskCount
      if (
        current !== this.root.state.prevAssistantTaskCount &&
        workspaceState.consumeAssistantTaskRequest()
      ) {
        this.root.state.prevAssistantTaskCount = current
        void this.root.mergeThreadsInList.createAssistantTaskFromShortcut()
      }
    })

    /** React to Cmd/Ctrl+Shift+N on the Assistant view → new assistant. */
    $effect(() => {
      const current = workspaceState.requestAssistantCount
      if (
        current !== this.root.state.prevAssistantCount &&
        workspaceState.consumeAssistantRequest()
      ) {
        this.root.state.prevAssistantCount = current
        this.root.mergeThreadsInList.assistantCreateTrigger++
      }
    })

    /** React to Cmd/Ctrl+Shift+S → toggle the right (context) sidebar. */
    $effect(() => {
      const current = workspaceState.requestToggleContextSidebarCount
      if (current !== this.root.state.prevToggleContextSidebarCount) {
        this.root.state.prevToggleContextSidebarCount = current
        if (workspaceState.consumeToggleContextSidebarRequest())
          this.root.openThreadFromSwitcher.toggleContextSidebar()
      }
    })

    /** Reveal a file selected from the cross-project Ctrl+K search. */
    $effect(() => {
      const current = workspaceState.requestProjectFileOpenCount
      if (
        current !== this.root.state.prevProjectFileOpenCount &&
        !this.root.switcherPanelTabs.loading
      ) {
        this.root.state.prevProjectFileOpenCount = current
        const request = workspaceState.consumeProjectFileOpenRequest()
        if (request)
          void this.root.createThreadInProject.openProjectFileFromCommand(
            request.projectId,
            request.path,
            request.kind
          )
      }
    })

    /** Pick up projects added externally (e.g. from the Scope view) so the sidebar stays in sync. */
    $effect(() => {
      const project = workspaceState.pendingAddedProject
      if (project) {
        workspaceState.pendingAddedProject = null
        void this.root.switcherPanelTabs.handleProjectCreated(project)
      }
    })

    /**
     * Keep the coordinator in step with the on-screen thread.
     *
     * A session belongs to a thread and survives everything the turn that started it
     * did, so this re-reads when the thread changes and whenever that thread sees
     * activity: the `@cio-design` or `@cio-video` tag can arrive on any later message,
     * and main is the one that decides from the persisted messages, so the coordinator
     * docks the moment the tag lands rather than waiting for a reload.
     */
    $effect(() => {
      const thread = this.root.openThreadFromSwitcher.selectedThread
      if (!thread) {
        // Nothing is on screen, so nothing may dock itself: a read still in flight
        // for the thread that was just closed must not open its coordinator panel.
        designCoordinatorState.release()
        return
      }
      // The sidebar's panels are scoped to the project it is docked on, so make
      // sure it is docked on the thread on screen before anything reads it. A
      // surface that moved the visible thread without activating the sidebar would
      // otherwise leave another project's coordinator board on screen.
      contextSidebarState.ensureDockedThread(
        thread.projectId,
        thread.id,
        thread.title,
        activeThreadRowId(thread) ?? thread.id
      )
      // Read as a dependency: a new message on this thread re-runs the refresh.
      void thread.lastActivity
      void designCoordinatorState.refresh(thread.projectId, thread.id)
      // The project's own design and video folders are a project-level fact the rail
      // shows on any thread: read once when this thread comes up, and again as it
      // settles so work the agent just wrote appears. The store coalesces the reads.
      void projectWorkState.ensure(thread.projectId, thread.id)
      if (!isThreadBusy(thread)) void projectWorkState.refresh(thread.projectId, thread.id)
    })

    /**
     * Keep the Changes rail indicator on the on-screen conversation. The store is
     * event-driven, so tracking a thread also starts (and stops) its updates; the
     * Changes panel itself is only mounted while it is open, so this is what keeps
     * the rail's summary current either way.
     */
    $effect(() => {
      const thread = this.root.openThreadFromSwitcher.selectedThread
      if (!thread) {
        threadChangesState.untrack()
        return
      }
      threadChangesState.track(thread.projectId, thread.id)
    })

    $effect(() => {
      const current = this.root.openThreadFromSwitcher.selectedThread
      const auditorId = current?.auditorThreadId
      if (!current || !auditorId) return
      const scopeKey = `${current.projectId}:${auditorId}`
      if (
        this.root.openThreadFromSwitcher.auditorThread ||
        this.root.state.auditorFetchRequested.has(scopeKey)
      )
        return
      this.root.state.auditorFetchRequested.add(scopeKey)
      void invoke('thread:get', current.projectId, auditorId)
        .then((fetched) => {
          if (fetched) scopeState.updateThread(fetched)
        })
        .catch(() => {
          // Missing or deleted auditor: leave the badge unlit rather than retry
          // forever on a thread that cannot exist.
        })
    })

    /** The Oven registry is read once so the rail can draw the Oven's own mark. */
    $effect(() => {
      const ovenId = this.root.openThreadFromSwitcher.selectedThread?.settings?.ovenId
      if (ovenId && ovenId !== 'local') void ovens.ensure()
    })

    /**
     * Keep the full screen browser on the sidebar's active browser tab.
     *
     * The overlay records the tab it shows separately from the sidebar's store,
     * and that store's active tab moves from many places: a tab a page opened, a
     * reopened tab, a close that fell back, a tab selected in the overlay's own
     * strip. Mirroring it here means the two can never drift apart, so minimizing
     * always lands on the tab the user was reading rather than the one that was
     * active when the fullscreen opened.
     */
    $effect(() => {
      if (!this.root.openThreadFromSwitcher.browserFullscreenTabId) return
      if (
        !this.root.props.active ||
        this.root.openThreadFromSwitcher.selectedThread?.id !==
          this.root.switcherPanelTabs.browserFullscreenThreadId
      ) {
        this.root.openThreadFromSwitcher.browserFullscreenTabId = null
        return
      }
      const activeBrowserTabId = contextSidebarState.activeBrowserTabId
      if (activeBrowserTabId === this.root.openThreadFromSwitcher.browserFullscreenTabId) return
      this.root.openThreadFromSwitcher.browserFullscreenTabId = activeBrowserTabId
    })

    $effect(() => {
      const tab = contextSidebarState.sidebarActiveTab
      const openProjectId = this.root.openThreadFromSwitcher.activeProject?.id ?? null
      if (!tab || !('projectId' in tab)) {
        // No panel is claiming the keep-mounted host right now (the sidebar is
        // hidden, or a tab without a project is active). Hold the open project's
        // panel across thread switches, but drop it once the user has moved to
        // another project: a host left behind would bootstrap the repository the
        // user just left the moment the sidebar shows again.
        if (
          this.root.state.gitPanelProjectId !== null &&
          this.root.state.gitPanelProjectId !== openProjectId
        ) {
          this.root.state.gitPanelProjectId = null
        }
        return
      }
      if (tab.kind !== 'git' && !this.root.openThreadFromSwitcher.gitPanelVisible) {
        if (tab.projectId !== this.root.state.gitPanelProjectId)
          this.root.state.gitPanelProjectId = null
        return
      }
      // Scope comes from the store's resolved bucket for that project (the open
      // thread's scope, else the project's last one). Reading it off the bounded
      // thread list missed a thread that was not hydrated yet and fell back to
      // the project root, so the panel swapped scopes twice on open.
      this.root.state.gitPanelProjectId = tab.projectId
      this.root.state.gitPanelScopeBucketId = workspaceState.activeScopeBucketIdFor(tab.projectId)
    })

    // A full-window DOM surface (fullscreen terminal, media previews, fullscreen
    // file editors) covers the workspace. The browser's native view floats above
    // every DOM surface, so it must be hidden while such a surface is open   the
    // browser panel asks the browser-visibility store and detaches its native
    // surface accordingly. The browser's own fullscreen dialog is not registered
    // here so the browser stays visible when the user fullscreens it deliberately.
    // Every modal publishes that block for itself now (`ui/Modal.svelte`), and the
    // full screen browser is the one surface that opts out of it
    // (`blocksBrowserView`), because the view it would suppress is the page it is
    // showing.
    $effect(() =>
      browserVisibility.hideWhile(
        'workspace-terminal-fullscreen',
        'fullscreen-surface',
        this.root.switcherPanelTabs.terminalFullscreenTab !== null
      )
    )

    // App.svelte keeps this Workspace mounted (but CSS-hidden) when the user
    // navigates to Settings/Scope, so its state survives the trip. The browser's
    // native view has no notion of that DOM hide and keeps floating at its last
    // screen bounds on top of whatever renders there instead   suppress it
    // whenever this Workspace isn't the active top-level view.
    $effect(() =>
      browserVisibility.hideWhile(
        'workspace-inactive',
        'workspace-inactive',
        !this.root.props.active
      )
    )

    $effect(() => {
      if (this.root.panelExitMs.sidebarVisible || this.root.state.sidebarHostsFullscreenEditor) {
        this.root.state.sidebarWasVisible = true
        this.root.contextPanelColumns.sidebarTrackReserved = true
        return
      }
      if (!this.root.state.sidebarWasVisible) return
      this.root.state.sidebarWasVisible = false
      const timer = setTimeout(
        () => {
          this.root.contextPanelColumns.sidebarTrackReserved = false
        },
        motionDuration(this.root.panelExitMs.PANEL_EXIT_MS + 40)
      )
      return () => clearTimeout(timer)
    })

    $effect(() => {
      if (this.root.state.terminalDockVisible) {
        this.root.state.terminalWasVisible = true
        this.root.contextPanelRows.terminalTrackReserved = true
        return
      }
      if (!this.root.state.terminalWasVisible) return
      this.root.state.terminalWasVisible = false
      const timer = setTimeout(
        () => {
          this.root.contextPanelRows.terminalTrackReserved = false
        },
        motionDuration(this.root.panelExitMs.PANEL_EXIT_MS + 40)
      )
      return () => clearTimeout(timer)
    })

    $effect(() => {
      // Load scope boards for every project that has threads in the sidebar, not
      // just the top-10 recent ones. Scope tags and the two-row layout resolve per
      // thread through the project's own board, so after a refresh (when the boards
      // map starts empty) every visible project's board must be loaded or the tags
      // disappear until a project switch forces them in. ensureBoardLoaded is cached,
      // so this stays cheap after the first pass.
      const projectIds = [
        ...new SvelteSet(
          this.root.createThreadInProject.allThreads
            .filter((thread) => thread.projectId !== INBOX_PROJECT_ID)
            .map((thread) => thread.projectId)
        )
      ]
      void this.root.ensureRecentScopeBoards.ensureRecentScopeBoards(projectIds)
    })

    // Any thread the user lands on (notification click, cache restore, scope
    // board, switcher) must be visible in the regular sidebar even when it sits
    // beyond the bounded recent hydration list   otherwise its row never appears
    // and its live status transitions are lost.
    $effect(() => {
      const selected = workspaceState.selectedThread
      if (selected && !isOrchestrationChildThread(selected))
        this.root.createThreadInProject.upsertThreadInList(selected)
    })

    // A run resolves the task it ran through its `assistantTaskId`, which names
    // the run's row and decides where the sidebar lifts it. Selecting one from a
    // notification can land on a run whose task sits beyond the bounded recent
    // hydration slice, so the parent is fetched and added before the row is drawn
    //   without it the run loses its task name and cannot be revealed where it
    // belongs, and the thread looks like it opened nowhere at all.
    $effect(() => {
      const thread = this.root.openThreadFromSwitcher.selectedThread
      if (!thread || this.root.props.mode !== 'assistant') return
      if (thread.projectId !== ASSISTANT_SPACE_ID) return
      const parentId = thread.assistantTaskId
      if (!parentId) return
      if (this.root.createThreadInProject.allThreads.some((candidate) => candidate.id === parentId))
        return
      if (this.root.state.pendingAssistantParentReads.has(parentId)) return
      this.root.state.pendingAssistantParentReads.add(parentId)
      void (async () => {
        try {
          const parent = await invoke('thread:get', ASSISTANT_SPACE_ID, parentId)
          if (parent) {
            this.root.createThreadInProject.upsertThreadInList(parent)
            scopeState.updateThread(parent)
          }
        } catch {
          // A run whose task is gone still opens on its own; nothing to add.
        } finally {
          this.root.state.pendingAssistantParentReads.delete(parentId)
        }
      })()
    })

    // Full user-message history is prefetched by ThreadView shortly after mount
    // (idle-deferred off the first-paint path), so the panel is already populated
    // when the menu opens. This effect remains as a fallback: it re-fires when
    // the active thread changes (the callback pointer swaps on ThreadView mount)
    // so the list refreshes for the new thread if the menu is already open.
    $effect(() => {
      const load = workspaceState.loadUserMessageHistory
      if (!this.root.jumpToHistoryMessage.showHistoryMenu || !load) return
      void load()
    })

    // Live thread updates pushed from the main process (status/read changes
    // during agent runs)   keeps the sidebar indicators in sync without polling.
    // Updates are applied immediately so a finished turn flips the status badge
    // to done/unread the moment the harness reports it, never after a debounce.
    $effect(() => {
      return subscribe('thread:updated', (...args: unknown[]) => {
        const updated = args[0] as Thread
        // A thread that reads as read by any path ends a deliberate unread mark.
        if (updated.read) threadUnreadIntent.clear(updated.id)
        scopeState.updateThread(updated)
        // Children stay out of the sidebar list, but the read flow below must
        // still cover them: the coordinator panel renders a worker's live status
        // chip from its own thread row, so an opened worker settles unread to
        // read exactly like a regular thread.
        if (!isOrchestrationChildThread(updated) && !isBrowserAssistantThread(updated))
          this.root.createThreadInProject.upsertThreadInList(updated)
        if (workspaceState.selectedThread?.id === updated.id) {
          workspaceState.updateThread(updated)
          // Auto-mark the selected thread read only while the window actually
          // has OS focus. While the user is away, the thread must stay unread:
          // the badge keeps counting it and the notification card stays up, and
          // the read transition happens once the user is back and a further
          // update arrives (or they explicitly open the thread). The confirmed
          // snapshot is applied to every sidebar store here so the badge can
          // never linger on a stale unread state when the backend's own
          // broadcast is missed.
          if (!updated.read && document.hasFocus() && threadTracksReadStatus(updated)) {
            this.root.markThreadReadAndApply.requestThreadRead(updated.projectId, updated.id)
          }
        }
      })
    })

    /** Live draft-state updates pushed from the main process (this window's own
     *  commits plus other windows/instances): merge the drafting flag into every
     *  thread list and apply the committed draft locally   seeding a draft this
     *  window does not have, and dropping one it still shows after the commit that
     *  cleared it. */
    $effect(() => {
      return subscribe('thread:draftUpdated', (...args: unknown[]) => {
        const [projectId, threadId, drafting, draftJson] = args as [
          string,
          string,
          boolean,
          string | null
        ]
        rendererRecovery.applyCommittedDraft(projectId, threadId, draftJson)
        const withDraftState = (thread: Thread): Thread =>
          thread.id === threadId && thread.projectId === projectId
            ? { ...thread, drafting: drafting || undefined, draftJson }
            : thread
        this.root.createThreadInProject.allThreads =
          this.root.createThreadInProject.allThreads.map(withDraftState)
        for (const thread of scopeState.allScopeThreads) {
          if (thread.id === threadId && thread.projectId === projectId) {
            scopeState.updateThread(withDraftState(thread))
          }
        }
      })
    })

    $effect(() => {
      const thread = this.root.openThreadFromSwitcher.selectedThread
      if (!thread || thread.id === this.root.state.readSettledThreadId) return
      this.root.state.readSettledThreadId = thread.id
      // Selecting the thread is opening it: a deliberate unread mark ends here.
      threadUnreadIntent.clear(thread.id)
      // Only a thread that tracks read status settles here: a regular thread, or
      // a worker whose reporting the user switched off (the coordinator panel
      // shows its status chip, so an opened or selected non-reporting worker must
      // not stay unread). Reporting workers and auditors carry no read state:
      // the Assignment lifecycle is their indicator.
      if (thread.read || !threadTracksReadStatus(thread) || !document.hasFocus()) return
      this.root.markThreadReadAndApply.markThreadReadAfterPaint(thread)
    })

    // Returning to the window with a thread already open must settle its unread
    // badge. While the window was unfocused the focus gate above deliberately
    // left the thread unread, but no further thread:updated may ever arrive once
    // the turn already finished   so without this the badge would linger green
    // while the user sits in the conversation reading it. Regaining focus is the
    // read signal for the open thread; marking read is idempotent.
    $effect(() => {
      const onWindowFocus = (): void => {
        const selected = workspaceState.selectedThread
        if (!selected || selected.read || !threadTracksReadStatus(selected)) return
        this.root.markThreadReadAndApply.requestThreadRead(selected.projectId, selected.id)
      }
      window.addEventListener('focus', onWindowFocus)
      return () => window.removeEventListener('focus', onWindowFocus)
    })

    // Git branch settlement is deliberately a separate, lighter broadcast (see
    // `broadcastThreadBranchUpdated`) so it never routes through the full
    // `thread:updated` fan-out   that would force ThreadView's message
    // reconcile (and every other subscriber) to run at whatever moment the
    // branch resolves, including mid-typing on an already-open conversation.
    // Patch the field in place: mutating the proxied thread objects is enough
    // for the composer's branch pill to update reactively without rebuilding
    // any list or reloading messages.
    $effect(() => {
      return subscribe('thread:branchUpdated', (...args: unknown[]) => {
        const [projectId, threadId, branch] = args as [string, string, string | undefined]
        if (
          workspaceState.selectedThread?.projectId === projectId &&
          workspaceState.selectedThread.id === threadId
        ) {
          workspaceState.selectedThread.branch = branch
        }
        const listed = this.root.createThreadInProject.allThreads.find(
          (candidate) => candidate.projectId === projectId && candidate.id === threadId
        )
        if (listed) listed.branch = branch
      })
    })

    // The authored-work markers arrive on their own light broadcast for the same
    // reason as the branch: the agent can open a design or video session on its
    // own, mid-turn, and routing that through `thread:updated` would force
    // ThreadView's message reconcile at that moment. Patch the fields on the
    // sidebar's own row so the markers appear without rebuilding any list. The set
    // is what the row draws, so it is patched with the session kind.
    $effect(() => {
      return subscribe('thread:authoredWorkUpdated', (...args: unknown[]) => {
        const [projectId, threadId, kind, kinds] = args as [
          string,
          string,
          AuthoredWorkKind,
          AuthoredWorkKind[]
        ]
        const listed = this.root.createThreadInProject.allThreads.find(
          (candidate) => candidate.projectId === projectId && candidate.id === threadId
        )
        if (!listed) return
        listed.authoredWorkKind = kind
        listed.authoredWorkKinds = [...kinds]
      })
    })

    onMount(() =>
      subscribe('archive:changed', (kind, id, archived) => {
        if (archived) {
          const matches = (thread: Thread): boolean =>
            kind === 'project'
              ? thread.projectId === id
              : kind === 'assistant'
                ? thread.assistantId === id
                : thread.id === id ||
                  thread.assistantTaskId === id ||
                  thread.coordinatorThreadId === id
          this.root.createThreadInProject.allThreads =
            this.root.createThreadInProject.allThreads.filter((thread) => !matches(thread))
          scopeState.archiveVisibilityChanged(matches)
          notificationPanelState.hideArchived(kind, id)
          const selected = workspaceState.selectedThread
          if (selected && matches(selected)) workspaceState.clearThread()
          if (kind === 'project')
            this.root.createThreadInProject.projects =
              this.root.createThreadInProject.projects.filter((project) => project.id !== id)
          scopeState.setScopesFromProjects(
            this.root.createThreadInProject.projects,
            this.root.createThreadInProject.projectIcons
          )
        }
        if (!archived) scopeState.archiveVisibilityChanged()
        void this.root.createThreadInProject.refreshListData()
      })
    )

    $effect(() => {
      return subscribe('thread:deleted', (projectId, threadId) => {
        this.root.createThreadInProject.allThreads =
          this.root.createThreadInProject.allThreads.filter((thread) => thread.id !== threadId)
        scopeState.removeThread(threadId)
        threadUnreadIntent.clear(threadId)
        const browserTabIds = contextSidebarState.removeThreadBrowsers(projectId, threadId)
        if (
          this.root.openThreadFromSwitcher.browserFullscreenTabId &&
          browserTabIds.includes(this.root.openThreadFromSwitcher.browserFullscreenTabId)
        ) {
          this.root.openThreadFromSwitcher.browserFullscreenTabId = null
        }
        void invoke('browser:destroyThread', projectId, threadId)
        if (workspaceState.selectedThread?.id === threadId) workspaceState.clearThread()
      })
    })

    $effect(() => {
      return subscribe('agent:processesChanged', (projectId, threadId) => {
        if (
          workspaceState.selectedThread?.projectId === projectId &&
          workspaceState.selectedThread.id === threadId
        ) {
          void workspaceState.refreshSourceProcessCount(projectId, threadId, { force: true })
        }
      })
    })

    $effect(() => {
      // The sidebar owns the browser tab list but holds no thread rows, so it asks
      // the workspace which conversation a tab belongs to. The resolver reads the
      // scope index lazily, so registering it once is enough.
      contextSidebarState.setThreadBrowserScopeResolver((projectId, threadId) =>
        projectId === ASSISTANT_SPACE_ID
          ? (this.root.switcherPanelTabs.assistantBrowserScopes.get(threadId) ?? threadId)
          : conversationScopeId(projectId, threadId, null)
      )
      // The same resolver pattern names a conversation's own box: a project's
      // name, an assistant's name, or a chat's title. It is read lazily by the
      // browser's box control, so the reactive lists are tracked where it is
      // called rather than here.
      contextSidebarState.setThreadBrowserScopeLabelResolver((projectId, threadId) => {
        if (projectId === ASSISTANT_SPACE_ID) {
          const thread = this.root.createThreadInProject.allThreads.find(
            (candidate) => candidate.id === threadId
          )
          const assistant = thread?.assistantId
            ? this.root.mergeThreadsInList.assistantList.find(
                (candidate) => candidate.id === thread.assistantId
              )
            : null
          return assistant?.name ?? thread?.title ?? 'Assistant'
        }
        if (projectId === INBOX_PROJECT_ID) {
          return (
            this.root.createThreadInProject.allThreads.find(
              (candidate) => candidate.id === threadId
            )?.title ?? 'Chat'
          )
        }
        return (
          this.root.createThreadInProject.projects.find((candidate) => candidate.id === projectId)
            ?.name ?? 'Project'
        )
      })
    })

    /**
     * Tell main which page a conversation's thread browser is on.
     *
     * A thread browser is the browser a conversation shares with its agent, so this
     * is what lets the agent's browser capability reach the page the user is
     * reading, in whatever box the user put it, instead of only pages it opened
     * itself. It is reported for the conversation on screen, which is the one whose
     * strip is in use, and the report never moves that strip: only the app writes
     * this, so no agent operation can switch the tab or the box under the user.
     */
    $effect(() => {
      const projectId = contextSidebarState.dockedProjectId
      const threadId = projectId ? contextSidebarState.threadIdForProject(projectId) : null
      const page = contextSidebarState.activeBrowserPage
      if (!projectId || !threadId) return
      const scope = contextSidebarState.browserScopeIdFor(projectId, threadId)
      const reported = this.root.state.reportedThreadBrowserPage
      if (!page || contextSidebarState.browserScopeIdFor(page.projectId, page.threadId) !== scope) {
        // The strip on screen holds no page for this conversation, so the page main
        // remembers for it is one nothing shows any more.
        if (reported?.scope !== scope) return
        this.root.state.reportedThreadBrowserPage = null
        void invoke('browser:unbindThreadBrowserPage', scope).catch(() => {})
        return
      }
      if (
        reported?.scope === scope &&
        reported.tabId === page.tabId &&
        reported.boxId === page.boxId &&
        reported.url === page.url
      ) {
        return
      }
      this.root.state.reportedThreadBrowserPage = {
        scope,
        tabId: page.tabId,
        boxId: page.boxId,
        url: page.url
      }
      void invoke('browser:bindThreadBrowserPage', scope, page).catch(() => {})
    })

    $effect(() => {
      return subscribe('browser:openRequested', (url, context) => {
        // A tab opened by the global browser belongs to the global strip, which
        // adopts it in its own store; the workspace sidebar must not mirror it.
        if (context?.projectId === GLOBAL_BROWSER_PROJECT_ID) return
        if (context?.peek) {
          const ownerThreadId =
            contextSidebarState.threadIdForProject(context.projectId) ?? context.threadId
          void loadBrowser().then((browser) =>
            browser.adoptOpenRequest(url, context, ownerThreadId)
          )
          return
        }
        if (context) {
          contextSidebarState.openBrowserForContext(
            url,
            context.projectId,
            context.threadId,
            context.requestedTabId,
            context.reveal,
            context.boxId
          )
          return
        }
        if (contextSidebarState.openBrowser(url) === null) void invoke('shell:openExternal', url)
      })
    })

    $effect(() => {
      return subscribe('browser:panelShortcut', (tabId, action) => {
        // Focusing the address bar is the panel's own: it owns the input, and it
        // is the surface (sidebar or full screen) that decides whether it shows it.
        if (action === 'focus-address') return
        const tab = contextSidebarState.tabs.find((candidate) => candidate.id === tabId)
        if (!tab || tab.kind !== 'browser') return
        if (action === 'close-tab') {
          this.root.openThreadFromSwitcher.closeContextTab(tabId)
          return
        }
        if (action === 'reopen-tab') {
          contextSidebarState.reopenClosedBrowserTab()
          return
        }
        if (action !== 'new-tab') return
        // The tab that held the keyboard names the container, so a chord can never
        // open a tab in a strip the user is not looking at.
        this.root.openThreadFromSwitcher.openNewBrowserTab(tab)
      })
    })

    // Sync the selected thread's draft state to scope so draft-aware slicing works.
    // This MUST run before the pending-updates effect so scope's draftThreadId is
    // always current when stageForThread is evaluated.
    $effect(() => {
      const id = this.root.openThreadFromSwitcher.selectedThread?.id ?? null
      const hasDraft = this.root.openThreadFromSwitcher.selectedThreadHasDraft
      scopeState.setSelectedThreadDraftState(id, hasDraft)
      // Immediately switch the scope sidebar to 'todo' when draft promotion kicks in
      // for the thread the sidebar is currently showing   but only when the draft
      // state changes. Reading sidebarContext here would otherwise make this effect
      // re-run on every manual stage change and undo the user's slice switch.
      const key = `${id}:${hasDraft}`
      if (
        id &&
        hasDraft &&
        scopeState.sidebarContext?.threadId === id &&
        scopeState.sidebarContext.stage !== 'todo' &&
        this.root.state.draftStageSyncKey !== key
      ) {
        scopeState.sidebarContext = { ...scopeState.sidebarContext, stage: 'todo' }
      }
      this.root.state.draftStageSyncKey = key
    })

    // Draft state is memory-only: any thread holding unsent composer content is
    // staged as draft ('todo') in scope views, and returns to its DB-derived
    // slice (done) the moment the user clears the draft again.
    $effect(() => {
      const ids: string[] = []
      for (const t of this.root.createThreadInProject.allThreads) {
        if (t.archived) continue
        if (
          rendererRecovery.hasDraftContent(t.projectId, t.id) ||
          speechController.isCapturingThread(t.id)
        ) {
          ids.push(t.id)
        }
      }
      scopeState.setDraftStageThreadIds(ids)
    })

    // Detect user-initiated scrolling of the sidebar so focus-follow doesn't
    // fight the user once they have taken over the scroll.
    $effect(() => {
      const scroller = this.root.switcherPanelTabs.sidebarScroller
      if (!scroller) return
      const onScrollGesture = (): void => this.root.switcherPanelTabs.handleSidebarUserScroll()
      scroller.addEventListener('wheel', onScrollGesture, { passive: true })
      scroller.addEventListener('touchmove', onScrollGesture, { passive: true })
      return () => {
        scroller.removeEventListener('wheel', onScrollGesture)
        scroller.removeEventListener('touchmove', onScrollGesture)
      }
    })

    // ─── Sidebar title dropdown   Projects / Scoped threads / Threads / Chats ──
    // The app header owns the view switcher now; the workspace only registers
    // the per-view quick actions that render next to it.
    $effect(() => {
      // The workspace owns the header's quick-action slot only while it is the
      // surface on screen, or while the Scope Board (which it also draws) is.
      // Every other top-level view publishes its own actions and this effect must
      // leave them alone - the browser does exactly that, and its teardown clears
      // the slot. Reading `active` here is also what re-runs the effect the moment
      // the workspace comes back, which is what restores a view's actions after a
      // trip to the browser; without it the slot stayed empty on return.
      if (!this.root.props.active && !this.root.props.scopeViewActive) return
      // Held in a local so the callbacks below keep the narrowing this check gives.
      const project = this.root.openThreadFromSwitcher.activeProject
      if (workspaceState.specStudioOpen) {
        viewActions.set('none', [])
        return
      }
      // Scope Board page: new scope, cross-scope search, new project   replacing
      // the old far-right toolbar of the scope view header.
      if (this.root.props.scopeViewActive) {
        const scopeBoardActions: ViewActionItem[] = [
          {
            id: 'new-scope',
            component: ScopeCreateControl as unknown as ViewActionItem['component'],
            props: { title: 'New scope' }
          },
          {
            id: 'search',
            component: ThreadSearchControl as unknown as ViewActionItem['component'],
            props: {
              threads: scopeState.allScopeThreads,
              contextLabel: 'threads across all scopes',
              title: 'Search threads across all scopes',
              onOpen: this.root.state.openThreadFromScopeSearch,
              // The board spans one project's scopes, but a search on it stays a
              // search for threads: the chats, assistant tasks and browser
              // container that share the threads table are never board threads.
              fts: { family: 'projects' }
            }
          },
          {
            id: 'new-project',
            component: ProjectCreateControl as unknown as ViewActionItem['component'],
            props: {
              onProjectCreated: this.root.switcherPanelTabs.handleProjectCreated,
              onExisting: (project: Project) => void scopeState.activateProject(project.id),
              triggerAddProject: this.root.state.projectCreateTrigger,
              triggerKind: this.root.state.projectCreateTriggerKind
            }
          }
        ]
        viewActions.set('scope', scopeBoardActions)
        return
      }
      if (this.root.props.mode === 'threads') {
        const actions: ViewActionItem[] = [
          {
            id: 'search',
            component: SidebarSearchControl as unknown as ViewActionItem['component'],
            props: {
              open: this.root.switcherPanelTabs.sidebar.threadsSearchOpen,
              query: this.root.switcherPanelTabs.sidebar.threadsSearchQuery,
              loading: this.root.switcherPanelTabs.sidebar.threadsSearching,
              onOpenChange: (open: boolean) => {
                if (open) this.root.switcherPanelTabs.sidebar.openThreadsSearch()
                else this.root.switcherPanelTabs.sidebar.closeThreadsSearch()
              },
              onQueryChange: (value: string) =>
                this.root.switcherPanelTabs.sidebar.runThreadsSearch(value),
              ariaLabel: 'Search threads',
              title: 'Search threads',
              placeholder: 'Search threads…',
              size: 'md'
            }
          },
          ...(project
            ? [
                {
                  id: 'new-thread',
                  icon: CioPlus,
                  ariaLabel: `New thread in ${project.name}`,
                  title: `New thread in ${project.name}`,
                  shortcut: keymapState.keysFor('nav-new-thread'),
                  run: () => void this.root.createThreadInProject.createThreadInProject(project)
                } satisfies ViewActionItem
              ]
            : []),
          {
            id: 'filter',
            component: ThreadProjectFilterMenu as unknown as ViewActionItem['component']
          }
        ]
        viewActions.set('threads', actions)
      } else if (this.root.props.mode === 'chats') {
        const chatsActions: ViewActionItem[] = [
          {
            id: 'search',
            component: ThreadSearchControl as unknown as ViewActionItem['component'],
            props: {
              threads: scopeState.allScopeThreads.filter(
                (thread) => thread.projectId === INBOX_PROJECT_ID
              ),
              contextLabel: 'chats',
              title: 'Search chats',
              onOpen: this.root.openThreadFromSwitcher.openThread,
              // The Chats view is the inbox family and nothing else.
              fts: { family: 'chats' }
            }
          },
          {
            id: 'new-chat',
            icon: CioPencil,
            ariaLabel: 'New chat',
            title: 'New chat',
            shortcut: keymapState.keysFor('nav-new-thread'),
            run: this.root.markThreadReadAndApply.startNewChat
          }
        ]
        viewActions.set('chats', chatsActions)
      } else if (this.root.props.mode === 'projects' && scopeState.sidebarContext) {
        // Same paradigm as every other view: search first, then new thread.
        const scopeContextProjectId = scopeState.sidebarContext.projectId
        const scopedActions: ViewActionItem[] = [
          {
            id: 'search',
            component: ThreadSearchControl as unknown as ViewActionItem['component'],
            props: {
              threads: STAGE_ORDER.flatMap((stage) =>
                scopeState.threadsFor(
                  scopeState.sidebarContext?.bucketId ?? DEFAULT_SCOPE_BUCKET_ID,
                  stage
                )
              ),
              contextLabel: 'threads in this scope',
              title: 'Search threads in this scope',
              onOpen: (thread: Thread) => void this.root.switcherPanelTabs.openScopedThread(thread),
              // A scope belongs to exactly one project, so its search is that
              // project's threads and never another project's, a chat's, or an
              // assistant task's. The scope's bucket is a ledger stage, not a
              // search scope: narrowing to it would hide matching threads that
              // the board filters by stage rather than by ownership.
              fts: { family: 'projects', projectId: scopeContextProjectId }
            }
          },
          {
            id: 'new-thread',
            icon: CioPlus,
            ariaLabel: 'New thread in this scope',
            title: 'New thread in this scope',
            shortcut: keymapState.keysFor('nav-new-thread'),
            run: () => this.root.switcherPanelTabs.newThreadInScopeContext()
          },
          {
            id: 'new-scope',
            component: ScopeCreateControl as unknown as ViewActionItem['component'],
            props: { title: 'New scope' }
          }
        ]
        viewActions.set('scoped-threads', scopedActions)
      } else if (this.root.props.mode === 'assistant') {
        const assistantActions: ViewActionItem[] = [
          {
            id: 'search',
            component: AssistantSearchControl as unknown as ViewActionItem['component'],
            props: {
              assistants: this.root.mergeThreadsInList.assistantList,
              tasks: this.root.markThreadReadAndApply.assistantTasks,
              runs: this.root.mergeThreadsInList.assistantRuns,
              onOpenTask: this.root.markThreadReadAndApply.openAssistantTask,
              onOpenAssistant: (assistant: Assistant) =>
                void this.root.markThreadReadAndApply.openAssistantKnowledgeFor(assistant)
            }
          },
          {
            id: 'new-assistant',
            component: AssistantCreateControl as unknown as ViewActionItem['component'],
            props: {
              onCreate: this.root.markThreadReadAndApply.createAssistant,
              onCreateViaChat: this.root.markThreadReadAndApply.createAssistantViaChat,
              trigger: this.root.mergeThreadsInList.assistantCreateTrigger
            }
          },
          {
            id: 'new-task',
            icon: AssistantTaskIcon,
            ariaLabel: 'New task',
            title: 'New task',
            shortcut: keymapState.keysFor('assistant-new-task'),
            run: () => void this.root.mergeThreadsInList.createAssistantTaskFromShortcut()
          }
        ]
        viewActions.set('assistant', assistantActions)
      } else {
        const projectActions: ViewActionItem[] = [
          {
            id: 'search',
            component: ThreadSearchControl as unknown as ViewActionItem['component'],
            props: {
              threads: this.root.createThreadInProject.allThreads,
              contextLabel: 'threads',
              title: 'Search threads',
              onOpen: this.root.openThreadFromSwitcher.openThread,
              // The Projects view lists projects and their threads; a chat or an
              // assistant task belongs to its own view and its own search.
              fts: { family: 'projects' }
            }
          },
          {
            id: 'new-project',
            component: ProjectCreateControl as unknown as ViewActionItem['component'],
            props: {
              onProjectCreated: this.root.switcherPanelTabs.handleProjectCreated,
              onExisting: this.root.switcherPanelTabs.handleExistingProject,
              triggerAddProject: this.root.state.projectCreateTrigger,
              triggerKind: this.root.state.projectCreateTriggerKind
            }
          }
        ]
        viewActions.set('projects', projectActions)
      }
    })

    // The scope-state sidebar board reads its data from the active project's board
    // and thread list (`scopeState.board` / `currentProjectThreads`, keyed off
    // `activeProjectId`). The sidebar context is set with a fire-and-forget
    // `activateProject`, so `sidebarContext.projectId` and `activeProjectId` can be
    // out of sync on first entry   which would render stale/empty stage slices until
    // a project switch realigned them. Keep them aligned reactively so the board
    // hydrates immediately (mirrors ScopeView's own activeProjectId reload effect).
    $effect(() => {
      const context = scopeState.sidebarContext
      if (context && context.projectId !== scopeState.activeProjectId) {
        void scopeState.activateProject(context.projectId)
      }
    })

    $effect(() => {
      const projectId = this.root.state.dockedScopeProjectId
      if (!projectId) return
      const buckets = scopeState.boards.get(projectId)?.buckets
      scheduleDeferredWork('scope:boardHealth', () =>
        scopeState.syncBoardWorktreeHealth(projectId, buckets)
      )
    })

    // Switching the docked scope is an interaction with it: re-read that scope's
    // health so a checkout that changed on disk is reported right away. Same
    // value-keyed dependency as above, so a thread switch inside one scope asks
    // for nothing at all. What does need reading is queued for after the switch
    // has painted, because discovery shells out to Git.
    $effect(() => {
      const projectId = this.root.state.dockedScopeProjectId
      const bucketId = this.root.state.dockedScopeBucketId
      if (!projectId || !bucketId) return
      scheduleDeferredWork('scope:worktreeHealth', () => {
        void scopeState.revalidateWorktreeHealth(projectId, bucketId).catch(() => undefined)
      })
    })

    // While a thread is selected, its row (and thus its project) stays in view in
    // the sidebar. Selecting another thread expands the owning folder and reveals
    // the row; a row the thread moves by itself is followed; background list
    // changes only reveal while the reader has not taken the scroll over. The
    // scope-board view is left untouched.
    $effect(() => {
      const thread = this.root.openThreadFromSwitcher.selectedThread
      if (!thread) return
      // The sidebar only exists while the workspace is on screen. Revealing into a
      // hidden workspace (Settings/Scope) measures a DOM the user cannot see, and
      // every background thread update would pay for it. When the workspace comes
      // back, `active` flips and this effect re-runs to restore the reveal.
      if (!this.root.props.active) return
      // A mode switch settles the incoming list itself, once its own rows are
      // mounted: this run would measure the position of the list being replaced.
      if (this.root.switcherPanelTabs.sidebarModeSettlePending) return
      // The assistant sidebar is a separate, lazily imported component: re-run the
      // reveal once its scroller attaches, and once the sidebar had to appear for
      // the very run this is revealing, so a row that mounted a tick late is still
      // brought into view.
      void this.root.switcherPanelTabs.sidebarScroller
      void this.root.markThreadReadAndApply.workspaceSidebarVisible
      void this.root.props.mode
      // Track the sort source arrays so the effect re-runs whenever the sidebar
      // lists reorder (thread updates, project reorders) and re-reveals if needed.
      void this.root.createThreadInProject.allThreads
      void this.root.createThreadInProject.projects
      // A row moves without its thread changing hands: typing an unsent draft
      // sends the active row to the top of the list, and clearing it sends the
      // row back down. Its slot is that movement, and the reader's hold on the
      // scroll does not survive it   the move is the thread's own doing.
      const activeRowSortKey = threadStatusSortKey(
        thread,
        this.root.markThreadReadAndApply.draftThreadKeys
      )
      const selectedNewThread = thread.id !== this.root.state.lastFocusedThreadId
      const rowMoved =
        this.root.state.lastActiveRowSortKey !== null &&
        activeRowSortKey !== this.root.state.lastActiveRowSortKey
      this.root.state.lastFocusedThreadId = thread.id
      this.root.state.lastActiveRowSortKey = activeRowSortKey
      if (selectedNewThread) {
        // Picking a thread ends the reader's hold on the scroll: the one they
        // chose is what they are looking for now.
        this.root.openThreadFromSwitcher.sidebarReaderOwnsScroll = false
        this.root.switcherPanelTabs.prepareThreadRow(thread)
      }
      if (this.root.state.isScopeBoardView) return
      // A row that is still in view needs no reveal, and the reveal loop costs a
      // DOM query plus up to twelve animation frames. Seeing the row again also
      // hands the scroll back to the thread.
      if (this.root.switcherPanelTabs.isThreadRowVisible(thread.id)) {
        this.root.openThreadFromSwitcher.sidebarReaderOwnsScroll = false
        return
      }
      // Background changes wait for the reader to hand the scroll back; a new
      // thread, or a row the thread moved itself, always gets its row into view.
      if (
        this.root.openThreadFromSwitcher.sidebarReaderOwnsScroll &&
        !selectedNewThread &&
        !rowMoved
      )
        return
      void this.root.openThreadFromSwitcher.revealThreadInSidebar(thread)
    })

    // Keep the header icon in sync with the active project and icon cache.
    // Reading activeProjectIconUrl also re-syncs after a thread switch: openThread
    // resets the URL to null when the project has no custom icon, and switching
    // between threads of the same project leaves activeProject unchanged, so this
    // effect must re-run on the reset to restore the resolved fallback icon.
    $effect(() => {
      const project = workspaceState.activeProject
      if (project) {
        void workspaceState.activeProjectIconUrl
        const storedUrl = this.root.createThreadInProject.projectIcons.get(project.id)
        workspaceState.setActiveProjectIconUrl(getProjectIcon(project, storedUrl))
      }
    })

    // Keep active-project thread stats in sync for the header menu.
    $effect(() => {
      const projectId = workspaceState.activeProject?.id
      if (!projectId) {
        workspaceState.setActiveProjectStats(0, 0)
        return
      }
      const projectThreads = this.root.createThreadInProject.allThreads.filter(
        (t) => t.projectId === projectId && !t.archived
      )
      const working = projectThreads.filter((thread) => threadHasVisibleWork(thread)).length
      workspaceState.setActiveProjectStats(projectThreads.length, working)
    })

    // Open the edit modal when AppHeader signals it.
    $effect(() => {
      const projectId = workspaceState.projectIdToEdit
      if (!projectId) return
      this.root.createThreadInProject.projectDialogs.askEditProject(projectId)
      workspaceState.closeProjectEdit()
    })

    /** The scoped board renders only threads held in memory for its project.
     *  First-paint hydration is a bounded recent slice, so every open or restore
     *  of a scope hydrates that project's full thread list in the background. */
    $effect(() => {
      const projectId = scopeState.sidebarContext?.projectId
      if (projectId) void scopeState.ensureProjectThreadsLoaded(projectId)
    })

    $effect(() => {
      const nowActive = this.root.props.active
      const returnedToShell = this.root.state.composerFocusWasActive === false && nowActive
      this.root.state.composerFocusWasActive = nowActive
      if (!returnedToShell || isOverlayOpen()) return
      const frame = requestAnimationFrame(() => {
        if (isOverlayOpen()) return
        focusVisibleComposer()
      })
      return () => cancelAnimationFrame(frame)
    })

    $effect(() => {
      const nowActive = this.root.props.active
      if (this.root.state.wasActive !== null && nowActive && !this.root.state.wasActive) {
        void this.root.createThreadInProject.refreshListData()
      }
      this.root.state.wasActive = nowActive
    })

    /** Cmd/Ctrl+W while the context sidebar has focus closes its active tab
     *  (through the unsaved-changes confirmation) rather than the thread. The
     *  store captures the tab id when the request is made and hands it over
     *  exactly once, and this effect reads nothing else: resolving the active tab
     *  here instead closed the *next* tab on every re-run, because closing a tab
     *  changes which tab is active, so one shortcut press cascaded through every
     *  panel the thread had and kept closing each new panel afterwards. */
    $effect(() => {
      const tabId = contextSidebarState.consumeCloseActiveTabRequest()
      if (tabId) this.root.openThreadFromSwitcher.closeContextTab(tabId)
    })

    $effect(() => {
      if (this.root.props.mode !== 'threads' || !this.root.props.active) return
      void this.root.mergeThreadsInList.ensureThreadsViewFullyLoaded()
      void this.root.mergeThreadsInList.hydrateThreadsViewGuarantees()
    })

    /** Filter backfill: the 200-row hydration window is unfiltered, so a narrowed
     *  project filter can render far fewer than 200 rows even though matching
     *  threads exist beyond the window. The filter must replace hidden rows with
     *  matching ones, so while the visible (unpinned) count is below the window
     *  and DB pages remain, keep pulling 50-row history pages. Each page changes
     *  `allThreads`/`hasMoreHistory` and re-runs this effect, so the loop is
     *  self-terminating and bounded by the pager's own exhaustion flag. */
    $effect(() => {
      if (this.root.props.mode !== 'threads' || !this.root.props.active) return
      if (threadProjectFilterState.isAll) return
      if (
        this.root.switcherPanelTabs.sidebar.threadsSearching &&
        this.root.switcherPanelTabs.sidebar.threadsSearchQuery.trim()
      )
        return
      const visible = this.root.createThreadInProject.allThreads.filter(
        (t) =>
          !t.archived &&
          !t.pinned &&
          t.projectId !== INBOX_PROJECT_ID &&
          threadProjectFilterState.matches(t.projectId)
      ).length
      if (
        visible >= this.root.mergeThreadsInList.THREADS_VIEW_HYDRATION_LIMIT ||
        !this.root.mergeThreadsInList.hasMoreHistory
      )
        return
      void this.root.createThreadInProject.loadHistoryPage()
    })

    this.root.createThreadInProject.loadData()
  }
}
