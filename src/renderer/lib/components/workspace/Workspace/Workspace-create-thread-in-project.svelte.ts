import { scheduleDeferredWork } from '$lib/deferred-work'

import { invoke, waitForFeatures } from '$lib/ipc.svelte'
import { getProjectIcon, loadProjectIcons } from '$lib/project-icons'
import { reportError } from '$lib/stores/app-errors.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import { attentionState } from '$lib/stores/attention.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { gitState } from '$lib/stores/git.svelte'
import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
import { providerStore } from '$lib/stores/providers.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { threadSettings } from '$lib/stores/thread-settings.svelte'
import { findEmptyNewThread, threadVisitKey, workspaceState } from '$lib/stores/workspace.svelte'
import {
  inheritEngineeringLifecycle,
  persistInheritedThreadSettings,
  settingsForNewAssistantTask,
  settingsForNewThread,
  threadWithInheritedSettings,
  withProjectOven
} from '$lib/thread-settings-inheritance'
import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
import type { Project, Thread } from '$shared/types'
import {
  ASSISTANT_SETUP_TITLE,
  ASSISTANT_SPACE_ID,
  DEFAULT_THREAD_TITLE,
  INBOX_PROJECT_ID,
  isBrowserAssistantThread,
  isOrchestrationChildThread
} from '$shared/types'

import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { WorkspaceProjectDialogs } from '../WorkspaceProjectDialogs.svelte'
import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceCreateThreadInProject {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root)
      throw new Error('WorkspaceCreateThreadInProject read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  projects = $state<Project[]>([])

  allThreads = $state<Thread[]>([])

  historyOffset = $state(0)

  /** Project icon data URLs keyed by project id. */
  projectIcons = new SvelteMap<string, string>()

  projectDialogs = new WorkspaceProjectDialogs({
    getProjects: () => this.projects,
    setProjects: (next) => (this.projects = next),
    getProjectIcons: () => this.projectIcons,
    deleteProject: this.root.openThreadFromSwitcher.deleteProject
  })

  // ─── Data loading ────────────────────────────────────────────────────────

  /** Keep keyed sidebar rows safe even when hydration and live updates overlap. */
  uniqueThreadList(threads: Thread[]): Thread[] {
    const seen = new SvelteSet<string>()
    return threads.filter((thread) => {
      if (seen.has(thread.id)) return false
      seen.add(thread.id)
      return true
    })
  }

  /** Insert or refresh a thread in the sidebar list. The bounded hydration
   *  query only loads recent threads, so a thread opened from the scope board
   *  or history   or one the harness just started working on   must be added
   *  on first sighting instead of silently dropped. */
  upsertThreadInList(thread: Thread): void {
    // Orchestration children (Assignment workers and auditors) are internals:
    // their activity rolls up onto the Sr. Engineer's row, so they never get a
    // sidebar row of their own. This guard lives here, not only at the call
    // sites, because the sidebar list is exactly the user-facing surface a
    // child must never enter   an unguarded ingestion (for example restoring
    // the last-open thread when the user had a worker open) previously inserted
    // one, and every later `thread:updated` for it was then skipped by the same
    // predicate, freezing that row on the stale snapshot it was restored with.
    if (isOrchestrationChildThread(thread)) return
    // A browser tab's assistant conversation lives in the hidden global browser
    // container. Its surface is the browser's own rail, so a `thread:updated`
    // broadcast for one must never plant a phantom row in the Threads timeline
    // (the browser store already owns that conversation).
    if (isBrowserAssistantThread(thread)) return
    const index = this.allThreads.findIndex((candidate) => candidate.id === thread.id)
    if (index < 0) {
      this.allThreads = [thread, ...this.allThreads]
      return
    }
    const existing = this.allThreads[index]
    const hasDuplicate = this.allThreads.some(
      (candidate, candidateIndex) => candidateIndex !== index && candidate.id === thread.id
    )
    if (!hasDuplicate && this.root.mergeThreadsInList.sidebarRowUnchanged(existing, thread)) return
    let replaced = false
    this.allThreads = this.allThreads.flatMap((candidate) => {
      if (candidate.id !== thread.id) return [candidate]
      if (replaced) return []
      replaced = true
      return [thread]
    })
  }

  async loadData(): Promise<void> {
    try {
      // Assistant View is a secondary surface and never hydrates in this pass:
      // its assistants and missed runs are deferred to post-paint (see the finally
      // block), so nothing about the assistant competes with the first usable
      // frame. The hidden assistant container itself is created by the main
      // process before navigation, so its project record is already in
      // `project:list`.
      const [projectList, threadList] = await Promise.all([
        invoke('project:list'),
        invoke('thread:listRecentPerProject')
      ])
      this.projects = projectList
      const uniqueThreads = this.uniqueThreadList(threadList)
      this.allThreads = uniqueThreads.filter((t) => !isOrchestrationChildThread(t))
      this.historyOffset = this.uniqueThreadList(threadList).length
      this.root.mergeThreadsInList.hasMoreHistory = false
      // Restore what the last session left in the durable inbox, alongside the
      // thread-state hydration below. Deliberately not awaited: hydration
      // already refills the statuses it can see on its own, and the restored
      // entries merge in whenever the read lands (both paths dedupe on id).
      void notificationPanelState.restoreFromStore()
      notificationPanelState.hydrateFromThreads(uniqueThreads, projectList)
      this.projectIcons.clear()
      // Publish the workspace with deterministic fallback icons immediately.
      // Custom icon IPC is cosmetic and must never delay the first usable frame.
      scopeState.setScopesFromProjects(projectList, this.projectIcons)
      scopeState.setThreads(uniqueThreads)
      void this.rescueDraftThreads()
      this.root.switcherPanelTabs.sidebar.initExpandedFolders(projectList.filter((p) => !p.hidden))
      void loadProjectIcons(projectList).then((icons) => {
        for (const [projectId, iconUrl] of icons) this.projectIcons.set(projectId, iconUrl)
        scopeState.setScopesFromProjects(projectList, this.projectIcons)
      })
      const saved = rendererRecovery.selectedThread
      const restoredThread = saved
        ? uniqueThreads.find(
            (candidate) =>
              candidate.id === saved.threadId &&
              candidate.projectId === saved.projectId &&
              !candidate.archived
          )
        : undefined
      if (restoredThread) {
        workspaceState.openThread(
          restoredThread,
          projectList.find((candidate) => candidate.id === restoredThread.projectId) ?? null
        )
        // Read-settling for programmatic selections is centralized in the
        // selected-thread effect above; startup restore needs no extra call.
        void scopeState.ensureBoardLoaded(restoredThread.projectId)
      } else if (saved) {
        // The saved thread may sit beyond the bounded recent hydration list
        // (e.g. it was manually reordered below the cut). Fetch it directly so
        // the workspace restores onto the same thread instead of clearing it.
        try {
          const savedThread = await invoke('thread:get', saved.projectId, saved.threadId)
          const project = projectList.find((candidate) => candidate.id === saved.projectId) ?? null
          if (savedThread && !savedThread.archived) {
            this.upsertThreadInList(savedThread)
            workspaceState.openThread(savedThread, project)
            void scopeState.ensureBoardLoaded(saved.projectId)
          } else {
            rendererRecovery.clearSelectedThread()
          }
        } catch {
          rendererRecovery.clearSelectedThread()
        }
      }

      // Restore the last active project even without a thread
      if (rendererRecovery.selectedProjectId && !workspaceState.activeProject) {
        const project = projectList.find((p) => p.id === rendererRecovery.selectedProjectId) ?? null
        if (project) {
          workspaceState.activeProject = project
          workspaceState.activeProjectIconUrl = this.projectIcons.get(project.id) ?? null
        }
      }
      // App-start Git discovery launches several local subprocesses, and its
      // stale-gated fetch opens a network round trip. Keep both out of the first
      // usable frame: the delay lands them once the restored conversation has
      // painted, and thread selection or opening the Git panel still triggers
      // them immediately when the user gets there first. Triggering the fetch
      // here is what keeps it off the panel's open path, where a user asking the
      // panel for something is the last moment a round trip should start.
      window.setTimeout(() => {
        gitState.notifyAppStarted(workspaceState.activeProject)
      }, 2000)

      // The workspace is the single owner of initial hydration. Keep provider
      // catalog work after the first data pass and after a frame so startup
      // thread rendering is not competing with model discovery.
      void waitForFeatures()
        .then(() => {
          window.requestAnimationFrame(() => {
            const targets = scopeState.activeProjectId
              ? [scopeState.activeProjectId, INBOX_PROJECT_ID]
              : [INBOX_PROJECT_ID]
            void providerCatalog.init(targets, { refresh: true })
            void providerStore.init()
          })
        })
        // A feature graph that never started is reported by `waitForFeatures`, so
        // the workspace never turns that into an unhandled rejection.
        .catch(() => undefined)

      // Never auto-create a chat, thread, or project on startup   the user
      // (or the onboarding tour) initiates that. When no thread was restored
      // from the recovery snapshot, reopen the last thread the user actually
      // visited (recentThreadVisits is persisted visit order); fall back to
      // the most recently active thread of the mode. allThreads order is not
      // visit recency (listRecent hoists the selected project first), so it
      // must never be used to guess the last-open thread.
      if (this.root.props.active && !workspaceState.selectedThread) {
        const wantChat = this.root.props.mode === 'chats'
        const candidates = this.allThreads.filter(
          (t) => !t.archived && (t.projectId === INBOX_PROJECT_ID) === wantChat
        )
        const byVisit = new SvelteMap(candidates.map((t) => [threadVisitKey(t), t]))
        const last =
          workspaceState.recentThreadVisits
            .map((key) => byVisit.get(key))
            .find((t) => t !== undefined) ??
          candidates.sort((a, b) => b.lastActivity - a.lastActivity)[0]
        if (last) {
          workspaceState.openThread(
            last,
            projectList.find((candidate) => candidate.id === last.projectId) ?? null
          )
          void scopeState.ensureBoardLoaded(last.projectId)
        }
      }
    } catch {
      this.projects = []
      this.allThreads = []
    } finally {
      this.root.switcherPanelTabs.loading = false
      void invoke('app:rendererReady').catch(() => undefined)
      // Assistant View hydrates only after the main project view has landed.
      // Deferred work runs once the shell has painted and the renderer is idle,
      // so assistant/missed-run reads can never occupy the startup frame or race
      // the project and thread hydration for the main process. Idempotent: a
      // second call is a no-op, and re-scheduling replaces the pending task.
      scheduleDeferredWork('assistant:hydrate', () => {
        assistants.initialize()
        attentionState.initialize()
      })
    }
  }

  /**
   * Lightweight re-sync of the project/thread lists when the shell becomes
   * visible again after a trip to Settings or Scope. The full loadData() pass
   * is intentionally not re-run: it would reset folder expansion and re-restore
   * the thread, and the open thread never unmounts so it needs no re-fetch.
   *
   * The thread re-sync **merges** into the list rather than replacing it.
   * `thread:listRecentPerProject` is the bounded first-paint slice   ten rows per
   * project   while the Threads view hydrates up to two hundred rows from the
   * global list. Replacing the list with the slice unmounted every hydrated row,
   * and the Threads view's own hydration then rebuilt them right after the
   * switch: the list visibly shrank to the slice and grew back over about a
   * second, in two blocking passes. Merging refreshes the rows the slice knows
   * about (a rename, a status change, a thread created while the workspace was
   * hidden) and leaves the hydrated ones in place, so the re-sync never has to
   * undo itself. The pager bookkeeping is deliberately left alone for the same
   * reason: the rows it accounts for are still in the list.
   */
  async refreshListData(): Promise<void> {
    try {
      const [projectList, threadList] = await Promise.all([
        invoke('project:list'),
        invoke('thread:listRecentPerProject')
      ])
      this.projects = projectList
      const uniqueThreads = this.uniqueThreadList(threadList)
      this.root.mergeThreadsInList.mergeThreadsInList(uniqueThreads)
      notificationPanelState.hydrateFromThreads(uniqueThreads, projectList)
      this.projectIcons.clear()
      for (const [projectId, iconUrl] of await loadProjectIcons(projectList)) {
        this.projectIcons.set(projectId, iconUrl)
      }
      scopeState.setScopesFromProjects(projectList, this.projectIcons)
      // Hand the scope store the list this workspace holds now, not the bounded
      // slice: its own merge protects board-hydrated projects, but the Threads
      // view's hydrated rows live here, and seeding the scope store with the
      // slice alone would drop them from the docked sidebar and the board.
      // Archived rows and the reserved browser container stay out, exactly as
      // `scopeState.updateThread` filters them on every other ingestion path.
      scopeState.setThreads(
        this.uniqueThreadList(this.allThreads).filter(
          (thread) => !thread.archived && thread.projectId !== GLOBAL_BROWSER_PROJECT_ID
        )
      )
      void this.rescueDraftThreads()
    } catch {
      // Non-fatal   keep the current lists on failure.
    }
  }

  async rescueDraftThreads(): Promise<void> {
    if (this.root.switcherPanelTabs.rescuingDraftThreads) return
    this.root.switcherPanelTabs.rescuingDraftThreads = true
    try {
      const known = new SvelteSet([
        ...this.allThreads.map((thread) => thread.id),
        ...scopeState.allScopeThreads.map((thread) => thread.id)
      ])
      const candidates = rendererRecovery
        .listDraftThreadRefs()
        .filter(
          (ref) =>
            !known.has(ref.threadId) &&
            !this.root.switcherPanelTabs.unreachableDraftRefs.has(
              this.root.switcherPanelTabs.draftRefKey(ref.projectId, ref.threadId)
            )
        )
      const gone: Array<{ projectId: string; threadId: string }> = []
      let next = 0
      const resolveOne = async (): Promise<void> => {
        while (next < candidates.length) {
          const ref = candidates[next]
          next += 1
          if (!ref) continue
          let thread: Thread | null
          try {
            thread = await invoke('thread:get', ref.projectId, ref.threadId)
          } catch {
            // A read that failed says nothing about the thread, so neither the
            // draft nor a verdict may be drawn from it: leave both for the next
            // pass rather than forgetting content on a transient error.
            continue
          }
          if (!thread) {
            gone.push(ref)
            continue
          }
          if (thread.archived || isOrchestrationChildThread(thread)) {
            this.root.switcherPanelTabs.unreachableDraftRefs.add(
              this.root.switcherPanelTabs.draftRefKey(ref.projectId, ref.threadId)
            )
            continue
          }
          this.upsertThreadInList(thread)
          scopeState.updateThread(thread)
        }
      }
      const workers = Math.min(
        this.root.switcherPanelTabs.DRAFT_RESCUE_CONCURRENCY,
        candidates.length
      )
      await Promise.all(Array.from({ length: workers }, resolveOne))
      rendererRecovery.forgetDraftRefs(gone)
      // Threads flagged drafting in the DB (this or another instance's draft
      // commits) must surface too, even when they fell outside the bounded
      // first-paint slice: a thread being dictated in another window can never
      // be dropped from the listing. Their drafts seed the local recovery
      // Store whenever this window does not hold a newer local draft.
      const draftingThreads = await invoke('thread:listDrafting').catch(() => [] as Thread[])
      for (const thread of draftingThreads) {
        rendererRecovery.importDbDraft(thread.projectId, thread.id, thread.draftJson ?? null)
        if (
          thread.archived ||
          isOrchestrationChildThread(thread) ||
          this.allThreads.some((candidate) => candidate.id === thread.id) ||
          scopeState.allScopeThreads.some((candidate) => candidate.id === thread.id)
        ) {
          continue
        }
        this.upsertThreadInList(thread)
        scopeState.updateThread(thread)
      }
    } finally {
      this.root.switcherPanelTabs.rescuingDraftThreads = false
    }
  }

  /** Explicit timeline expansion. The initial shell intentionally carries
   * only a bounded recent slice; older tasks remain paged and deduped. */
  async loadHistoryPage(): Promise<void> {
    if (this.root.switcherPanelTabs.historyLoading || !this.root.mergeThreadsInList.hasMoreHistory)
      return
    this.root.switcherPanelTabs.historyLoading = true
    try {
      const page = await invoke('thread:listHistoryPage', {
        limit: this.root.switcherPanelTabs.HISTORY_PAGE_LIMIT,
        offset: this.historyOffset
      })
      this.historyOffset += page.length
      this.root.mergeThreadsInList.hasMoreHistory =
        page.length === this.root.switcherPanelTabs.HISTORY_PAGE_LIMIT
      const uniqueCurrentThreads = this.uniqueThreadList(this.allThreads)
      const known = new SvelteSet(uniqueCurrentThreads.map((thread) => thread.id))
      const additions = this.uniqueThreadList(page).filter(
        (thread) => !known.has(thread.id) && !isOrchestrationChildThread(thread)
      )
      scopeState.mergeThreads(page)
      if (additions.length > 0 || uniqueCurrentThreads.length !== this.allThreads.length) {
        this.allThreads = [...uniqueCurrentThreads, ...additions]
      }
    } finally {
      this.root.switcherPanelTabs.historyLoading = false
    }
  }

  /**
   * Fetch a project's older threads from the DB when its sidebar list is
   * expanded past the per-project hydration slice. Results accumulate in
   * `allThreads`, so subsequent renders are served from the in-memory cache.
   */
  async loadProjectThreadsPage(projectId: string): Promise<void> {
    if (this.root.switcherPanelTabs.projectPageLoading === projectId) return
    this.root.switcherPanelTabs.projectPageLoading = projectId
    try {
      const offset = this.root.switcherPanelTabs.projectPageOffsets.get(projectId) ?? 0
      const page = await invoke('thread:listProjectPage', {
        projectId,
        limit: this.root.switcherPanelTabs.PROJECT_PAGE_LIMIT,
        offset
      })
      this.root.switcherPanelTabs.projectPageOffsets.set(projectId, offset + page.length)
      if (page.length < this.root.switcherPanelTabs.PROJECT_PAGE_LIMIT)
        this.root.switcherPanelTabs.projectExhausted.add(projectId)
      const additions = page
        .filter((t) => !isOrchestrationChildThread(t))
        .filter((t) => !this.allThreads.some((existing) => existing.id === t.id))
      if (additions.length > 0) {
        this.allThreads = [...this.allThreads, ...additions]
        for (const thread of additions) {
          if (!thread.archived) scopeState.updateThread(thread)
        }
      }
      // Reveal the freshly fetched rows immediately   the user asked for older
      // threads, so they must not need a second "Show more" click to see them.
      if (additions.length > 0 || page.length > 0) {
        const folderThreads = this.allThreads.filter(
          (t) => t.projectId === projectId && !t.archived && !t.pinned
        )
        this.root.switcherPanelTabs.sidebar.extendVisibleCount(
          projectId,
          additions.length,
          folderThreads.length
        )
      }
    } finally {
      this.root.switcherPanelTabs.projectPageLoading = null
    }
  }

  /** Create a project task by cloning the active thread; fresh installs use the saved defaults. */
  async createThreadInProject(
    project: Project,
    requestedBucketId?: string,
    /** Assistant-space grouping: the assistant the new task belongs to, and whether
     *  this is an assistant's seed "Getting started" thread. */
    assistant: { assistantId?: string; gettingStarted?: boolean } = {}
  ): Promise<void> {
    const assistantId = assistant.assistantId
    const gettingStarted = assistant.gettingStarted === true
    // A task created inside an assistant starts on demand: it runs only when the
    // user switches its own schedule on, so a thread they open to work with the
    // assistant never becomes a quiet recurring job of the assistant. The
    // assistant's seed Getting started thread is the exception: it carries the
    // assistant's own clock.
    const needsOnDemand = assistantId !== undefined && !gettingStarted
    // Scope inheritance mirrors settings inheritance: the new thread object
    // carries the current thread's scope bucket, nothing more. It must never
    // activate the scope sidebar or switch the view  that side effect is
    // reserved for callers that explicitly ask for a scope bucket (scope
    // board's new-thread action, file-tree drop, ...).
    const activeThread = workspaceState.selectedThread
    const inheritedBucketId =
      activeThread && activeThread.projectId === project.id ? activeThread.scopeBucketId : undefined
    const scopeBucketId = requestedBucketId ?? inheritedBucketId
    // The assistant space is its own model-memory family: a new task inherits
    // the assistant task in focus, and nothing else, so a chat or project
    // thread that happens to be selected never leaks into the assistant space.
    // A task of another assistant is not a source either: it carries that
    // assistant's Oven and workspace, which do not belong to this one.
    const assistantFocus =
      project.id === ASSISTANT_SPACE_ID &&
      activeThread?.projectId === ASSISTANT_SPACE_ID &&
      (assistantId === undefined || activeThread.assistantId === assistantId)
        ? activeThread
        : null
    const assistantRecord =
      assistantId === undefined
        ? null
        : (assistants.assistants.find((candidate) => candidate.id === assistantId) ?? null)
    const inheritedSettings =
      project.id === ASSISTANT_SPACE_ID
        ? settingsForNewAssistantTask(
            assistantFocus,
            threadSettings.lastUsed,
            assistantRecord?.execution
          )
        : withProjectOven(
            settingsForNewThread(activeThread, threadSettings.lastUsed),
            project,
            activeThread?.projectId === project.id
          )
    const existing = findEmptyNewThread(this.allThreads, project.id, scopeBucketId)
    if (existing) {
      // An assistant-scoped create always lands inside its assistant, even when it
      // reuses a blank thread: the reused row predates this call, so its
      // grouping and setup label are applied here rather than at creation time.
      // A task the user creates starts off the assistant's clock (see needsOnDemand
      // above), so a reused blank row is put back on demand here too.
      const regroup = assistantId !== undefined && existing.assistantId !== assistantId
      const needsSetupPatch = gettingStarted && existing.assistantGettingStarted !== true
      if (regroup || needsSetupPatch || needsOnDemand) {
        const optimistic: Thread = {
          ...existing,
          // An assistant's knowledge ("Getting started") thread is pinned for life, and
          // a reused blank row must join the Pinned section too.
          ...(gettingStarted ? { pinned: true } : {}),
          ...(regroup ? { assistantId } : {}),
          ...(needsOnDemand ? { scheduled: false } : {}),
          ...(gettingStarted
            ? {
                title: ASSISTANT_SETUP_TITLE,
                titleSource: 'manual' as const,
                assistantGettingStarted: true
              }
            : {})
        }
        this.upsertThreadInList(optimistic)
        if (workspaceState.selectedThread?.id === existing.id) {
          workspaceState.updateThread(optimistic)
        }
        const persist = async (): Promise<void> => {
          if (regroup && assistantId) {
            this.upsertThreadInList(await assistants.assignTask(existing.id, assistantId))
          }
          if (needsOnDemand) {
            this.upsertThreadInList(await assistants.setTaskScheduled(existing.id, false))
          }
          if (needsSetupPatch) {
            this.upsertThreadInList(
              await invoke('thread:update', existing.projectId, existing.id, {
                title: ASSISTANT_SETUP_TITLE,
                titleSource: 'manual',
                assistantGettingStarted: true
              })
            )
            // `thread:update` cannot carry the pin, and the knowledge thread is
            // pinned for life, so a reused blank row is pinned in its own write.
            this.upsertThreadInList(
              await invoke('thread:setPinned', existing.projectId, existing.id, true)
            )
          }
          const current = this.allThreads.find((candidate) => candidate.id === existing.id)
          if (current && workspaceState.selectedThread?.id === existing.id) {
            workspaceState.updateThread(current)
          }
        }
        void persist().catch(() => undefined)
      }
      if (workspaceState.selectedThread?.id === existing.id) {
        workspaceState.requestFocusComposer()
      } else {
        // Open instantly   settings/lifecycle sync is best-effort off the critical path
        // A project bound to an Oven always refreshes the reused blank thread, so
        // it starts on the project's Oven even when nothing was open to inherit.
        const needsSettingsUpdate = Boolean(activeThread?.settings) || Boolean(project.ovenId)
        const thread = existing
        this.upsertThreadInList(thread)
        threadMessages.seedEmpty(thread.projectId, thread.id)
        // Empty-state creation (no existing thread open): the reused blank
        // thread still counts as the fresh thread this moment created.
        if (!activeThread) workspaceState.markThreadFreshFromEmptyState(thread.id)
        workspaceState.openThread(thread, project)
        if (scopeBucketId) {
          scopeState.updateThread(thread)
        }
        if (requestedBucketId) {
          scopeState.showSidebarForThread(thread, requestedBucketId)
        }
        if (needsSettingsUpdate) {
          void invoke('thread:updateSettings', existing.projectId, existing.id, inheritedSettings)
            .then((updated) => this.upsertThreadInList(updated))
            .catch(() => {})
        }
        if (activeThread && activeThread.projectId === project.id) {
          void inheritEngineeringLifecycle(project.id, activeThread.id, thread.id)
        }
      }
      return
    }
    // Instant mount: create optimistic thread locally so the composer
    // paints on the same tick as the click   no IPC on the critical path.
    // Git branch and persistence hydrate async via the thread:update broadcast.
    const optimisticId = this.root.markThreadReadAndApply.newOptimisticThreadId()
    const optimisticThread = {
      id: optimisticId,
      projectId: project.id,
      providerId: 'pi' as const,
      title: gettingStarted ? ASSISTANT_SETUP_TITLE : DEFAULT_THREAD_TITLE,
      titleSource: gettingStarted ? ('manual' as const) : ('default' as const),
      status: 'created' as const,
      // The knowledge thread is pinned from the instant it exists, so it never
      // appears outside the Pinned section and is never an eviction candidate.
      pinned: gettingStarted,
      archived: false,
      read: true,
      settings: inheritedSettings,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActivity: Date.now(),
      workingDirectory: project.path,
      ...(assistantId ? { assistantId } : {}),
      ...(needsOnDemand ? { scheduled: false } : {}),
      ...(gettingStarted ? { assistantGettingStarted: true } : {}),
      ...(scopeBucketId ? { scopeBucketId } : {})
    }
    // Apply inherited settings immediately so the composer has correct model
    const thread = optimisticThread as unknown as typeof optimisticThread & {
      settings: typeof inheritedSettings
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.upsertThreadInList(thread as any)
    threadMessages.seedEmpty(thread.projectId, thread.id)
    this.root.switcherPanelTabs.sidebar.expandedFolders.add(project.id)
    if (scopeBucketId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (scopeBucketId) scopeState.updateThread(thread as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (requestedBucketId) scopeState.showSidebarForThread(thread as any, requestedBucketId)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workspaceState.openThread(thread as any, project)
    // Empty-state creation (no existing thread was open): this new thread gets
    // the centered composer head start even if the project holds other threads.
    // Threads created from an existing thread never get the marker.
    if (!activeThread) workspaceState.markThreadFreshFromEmptyState(thread.id)
    // Persist in background with the same stable id   no ID swap, branch
    // detection runs after the first thread:update broadcast, never blocking typing.
    void invoke('thread:create', {
      id: optimisticId,
      projectId: project.id,
      providerId: 'pi',
      title: gettingStarted ? ASSISTANT_SETUP_TITLE : DEFAULT_THREAD_TITLE,
      workingDirectory: project.path,
      settings: inheritedSettings,
      ...(scopeBucketId ? { scopeBucketId } : {}),
      ...(assistantId ? { assistantId } : {}),
      ...(needsOnDemand ? { scheduled: false } : {}),
      ...(gettingStarted ? { titleSource: 'manual' as const, assistantGettingStarted: true } : {})
    })
      .then((created) => {
        // Server confirms with same id; upsert the authoritative row (now with branch when ready)
        const confirmed = activeThread?.settings
          ? threadWithInheritedSettings(created, inheritedSettings)
          : created
        this.upsertThreadInList(confirmed)
        if (workspaceState.selectedThread?.id === optimisticId) {
          workspaceState.openThread(confirmed, project)
        }
        // Lifecycle inheritance must run only after the destination row is
        // durable: fired concurrently with creation, its internal `thread:get`
        // can race ahead of the insert and the "Thread not found" failure is
        // swallowed   leaving the toolbox icon lit while every switch reads off.
        if (activeThread && activeThread.projectId === project.id) {
          void inheritEngineeringLifecycle(project.id, activeThread.id, optimisticId)
        }
        if (activeThread?.settings) {
          // Settings already applied optimistically and persisted by thread:create;
          // this update keeps the pre-fix main-process path honest now that the
          // row is guaranteed durable.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          void persistInheritedThreadSettings(thread as any, inheritedSettings).catch(() => {})
        }
      })
      .catch((error) => {
        // Creation failed   remove the optimistic thread so the UI does not strand on a phantom
        const idx = this.allThreads.findIndex((t) => t.id === optimisticId)
        if (idx !== -1) this.allThreads.splice(idx, 1)
        if (workspaceState.selectedThread?.id === optimisticId) {
          workspaceState.clearThread()
        }
        reportError(error, 'The new thread could not be created.')
      })
  }

  async openProjectFileFromCommand(
    projectId: string,
    path: string,
    kind: 'file' | 'directory'
  ): Promise<void> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    if (!project || project.source !== 'local' || !project.path) return

    // Preserve the current content view (remember the project sidebar state)
    // instead of forcing the Projects view. Chats cannot host a project file.
    if (this.root.props.mode === 'chats') {
      this.root.props.navigate('projects')
    } else if (!this.root.props.active) {
      this.root.props.navigate(this.root.props.mode)
    }

    let projectThread: Thread | null =
      this.root.openThreadFromSwitcher.selectedThread?.projectId === projectId
        ? this.root.openThreadFromSwitcher.selectedThread
        : this.allThreads
            .filter((thread) => thread.projectId === projectId && !thread.archived)
            .sort((a, b) => b.lastActivity - a.lastActivity)[0]

    if (projectThread) {
      await this.root.openThreadFromSwitcher.openThread(projectThread)
    } else {
      // No thread yet   create one so the file opens inside a real thread context.
      await this.createThreadInProject(project)
      projectThread =
        workspaceState.selectedThread?.projectId === projectId
          ? workspaceState.selectedThread
          : null
      if (!projectThread) {
        workspaceState.clearThread()
        workspaceState.activeProject = project
        workspaceState.activeProjectIconUrl = getProjectIcon(
          project,
          this.projectIcons.get(project.id)
        )
        rendererRecovery.setSelectedProject(project.id)
        contextSidebarState.activateThread(project.id, '')
      }
    }

    await projectFilesWorkspace.loadDirectory(project.id, '')
    contextSidebarState.openFiles(project.id, projectThread?.id ?? '')
    if (kind === 'directory') {
      await projectFilesWorkspace.revealFile(project.id, path)
      projectFilesWorkspace.markDirectoryExpanded(project.id, path)
      await projectFilesWorkspace.loadDirectory(project.id, path, true)
    } else {
      await projectFilesWorkspace.openFile(project.id, path)
      await projectFilesWorkspace.revealFile(project.id, path)
    }
  }
}
