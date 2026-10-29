import { invoke } from '$lib/ipc.svelte'
import { getProjectIcon } from '$lib/project-icons'
import { reportError } from '$lib/stores/app-errors.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import { contextSidebarState, type ContextSidebarTab } from '$lib/stores/context-sidebar.svelte'
import { ovens } from '$lib/stores/ovens.svelte'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { assistantEffectiveSettings, threadSettings } from '$lib/stores/thread-settings.svelte'
import { threadOrderKey, workspaceState } from '$lib/stores/workspace.svelte'
import { openAssistantUtilitySetupThread } from '$lib/utility-setup-thread'
import type { ConnectionSetupRequest } from '$lib/components/assistant/assistant-view'
import { persistInheritedThreadSettings } from '$lib/thread-settings-inheritance'
import { assistantPrimaryModel, settingsWithAssistantModel } from '$shared/assistant-agents'
import type { AgentModelSelection, Project, Assistant, Thread } from '$shared/types'
import {
  ASSISTANT_SPACE_ID,
  INBOX_PROJECT_ID,
  isBrowserAssistantThread,
  isOrchestrationChildThread
} from '$shared/types'
import { toast } from 'svelte-sonner'

import {
  groupRunsByAssistant,
  groupRunsByTask,
  assistantForeignThread
} from '../../assistant/assistant-view'
import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceMergeThreadsInList {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root)
      throw new Error('WorkspaceMergeThreadsInList read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  hasMoreHistory = $state(true)

  prevCreateThreadCount = $state(0)

  /** Bumped to open the new-assistant dialog from a keyboard shortcut. */
  assistantCreateTrigger = $state(0)

  creatingThread = $state(false)

  /** Resolve the project a pending create-thread request targets: an explicit
   *  scope bucket matching the docked scoped-threads sidebar overrides the
   *  active project (which is null in that sidebar's empty state, when no
   *  thread is open yet). */
  createThreadRequestProject(): Project | null {
    const pendingBucket = workspaceState.pendingScopeBucketId
    const context = scopeState.sidebarContext
    if (pendingBucket && context && context.bucketId === pendingBucket) {
      const scopedProject = this.root.createThreadInProject.projects.find(
        (candidate) => candidate.id === context.projectId
      )
      if (scopedProject) return scopedProject
    }
    return workspaceState.activeProject
  }

  async handleCreateThreadRequest(project: Project, scopeBucketId?: string): Promise<void> {
    this.creatingThread = true
    try {
      await this.root.createThreadInProject.createThreadInProject(project, scopeBucketId)
    } finally {
      this.creatingThread = false
      // If more requests queued up while we were creating, process the latest
      if (
        workspaceState.requestCreateThreadCount !== this.prevCreateThreadCount &&
        workspaceState.consumeCreateThreadRequest()
      ) {
        this.prevCreateThreadCount = workspaceState.requestCreateThreadCount
        const queuedProject = this.createThreadRequestProject()
        if (queuedProject) {
          this.handleCreateThreadRequest(
            queuedProject,
            workspaceState.pendingScopeBucketId ?? undefined
          )
        }
        workspaceState.pendingScopeBucketId = null
      }
    }
  }

  /**
   * What the rail calls a tab, when its stored title is not the whole story.
   *
   * An Oven tab wears the Oven's own mark and name. An assistant's knowledge tab
   * wears the assistant's, read from the live list rather than from the title the
   * tab was opened with: the setup conversation names the assistant while that
   * panel is open, so the row, the panel header and this conversation all rename
   * themselves the moment the user answers.
   */
  tabPresentation(
    tab: ContextSidebarTab
  ): { title: string; iconUrl?: string | null; color?: string | null } | null {
    if (tab.kind === 'assistant-knowledge') {
      if (!tab.assistantId) return null
      const name = this.assistantList.find((entry) => entry.id === tab.assistantId)?.name.trim()
      return name ? { title: name } : null
    }
    return this.ovenTabPresentation(tab)
  }

  /**
   * The Oven panel names itself.
   *
   * The sidebar header shows the Oven's own mark and name instead of the generic
   * title the tab was opened with, so the panel reads as that box and nothing
   * else. The Oven is the one the thread's last turn ran on, which is the value
   * main writes onto the thread when a turn is sent.
   */
  ovenTabPresentation(tab: ContextSidebarTab) {
    if (tab.kind !== 'oven') return null
    const thread = this.root.openThreadFromSwitcher.selectedThread
    if (!thread || thread.projectId !== tab.projectId || thread.id !== tab.threadId) return null
    const identity = ovens.identity(thread.settings?.ovenId)
    if (!identity || identity.local) return null
    return { title: identity.name, iconUrl: identity.iconUrl, color: identity.color }
  }

  pendingFileCloseTarget(
    tab: ContextSidebarTab
  ): { sidebarTabId: string; projectId: string; fileTabId: string; path: string } | null {
    if (tab.kind !== 'files' || !tab.fileTabId) return null
    try {
      const fileState = projectFilesWorkspace.getState(tab.projectId)
      const fileTab = fileState.tabs.find((candidate) => candidate.id === tab.fileTabId)
      const session = fileTab ? fileState.sessions[fileTab.path] : undefined
      if (!fileTab || !session || session.draft === session.source.content) return null
      return {
        sidebarTabId: tab.id,
        projectId: tab.projectId,
        fileTabId: tab.fileTabId,
        path: fileTab.path
      }
    } catch {
      return null
    }
  }

  /** User-facing projects only   hidden ones (e.g. the chats inbox) stay out of the tree. */
  visibleProjects = $derived(
    this.root.createThreadInProject.projects
      .filter((p) => !p.hidden)
      .sort((a, b) => {
        const aOrder = a.sortOrder ?? -1
        const bOrder = b.sortOrder ?? -1
        if (aOrder !== bOrder) return aOrder - bOrder
        return b.updatedAt - a.updatedAt
      })
  )

  regularProjects = $derived(this.visibleProjects.filter((p) => !p.pinned))

  /** Every assistant-space thread (tasks and runs), active only. */
  assistantThreads = $derived(
    this.root.createThreadInProject.allThreads.filter(
      (thread) => thread.projectId === ASSISTANT_SPACE_ID && !thread.archived
    )
  )

  /** Every task's runs, newest first, for the sidebar's nested rows. */
  assistantRunsByTask = $derived(groupRunsByTask(this.assistantThreads))

  /**
   * The run of the open assistant task that another instance is streaming, when
   * the task itself is not. A run executes on its own thread, so opening the
   * task would otherwise show no card for work happening elsewhere; ThreadView
   * renders the transfer card for this run above the composer.
   */
  selectedAssistantForeignRunThreadId = $derived.by(() => {
    const thread = this.root.openThreadFromSwitcher.selectedThread
    if (this.root.props.mode !== 'assistant' || !thread || thread.projectId !== ASSISTANT_SPACE_ID)
      return null
    const runs = this.assistantRunsByTask.get(thread.id) ?? []
    const foreign = assistantForeignThread(thread, runs, (projectId, threadId) =>
      foreignRuns.isForeign(projectId, threadId)
    )
    return foreign && foreign.id !== thread.id ? foreign.id : null
  })

  /** Every assistant's runs, newest first, for the sidebar's sibling run rows. */
  runsByAssistant = $derived(groupRunsByAssistant(this.assistantThreads))

  /** Every run thread, for the header search's Runs results. */
  assistantRuns = $derived(this.assistantThreads.filter((thread) => thread.assistantTaskId))

  assistantList = $derived(assistants.assistants)

  pinnedTimelineThreads = $derived(this.root.markThreadReadAndApply.timelineLists.pinned)

  /** Whether a sidebar row already carries everything a refresh would give it.
   *  Only the fields the row draws are compared: the list must not be rebuilt
   *  for a thread whose settings or context usage moved. */
  sidebarRowUnchanged(existing: Thread, incoming: Thread): boolean {
    return (
      existing.updatedAt === incoming.updatedAt &&
      existing.lastActivity === incoming.lastActivity &&
      existing.status === incoming.status &&
      existing.title === incoming.title &&
      existing.pinned === incoming.pinned &&
      existing.bookmarked === incoming.bookmarked &&
      existing.read === incoming.read &&
      existing.assistantId === incoming.assistantId
    )
  }

  /**
   * Fold a page of thread snapshots into the sidebar list in one pass.
   *
   * {@link upsertThreadInList} takes a row on its own: it walks the list twice
   * and then rebuilds the whole array through `flatMap`, which allocates a
   * one-element array per row it keeps. Folding a refresh page that way cost two
   * walks and a hundred-odd allocations per row, which measured as a hundred and
   * fifty milliseconds of blocked main thread behind every return to the
   * workspace. A page is a list, so it merges as one.
   */
  mergeThreadsInList(threads: readonly Thread[]): void {
    // Same scratch-index reasoning as the scope store's merge: never read
    // reactively, and a SvelteMap would put a signal behind every lookup.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const incoming = new Map<string, Thread>()
    for (const thread of threads) {
      // Orchestration children are internals; see `upsertThreadInList`. Browser
      // assistant conversations are the browser rail's own rows, not the
      // Threads timeline's, so a page can never merge one in.
      if (isOrchestrationChildThread(thread) || isBrowserAssistantThread(thread)) continue
      incoming.set(thread.id, thread)
    }
    if (incoming.size === 0) return
    let changed = false
    const next = this.root.createThreadInProject.allThreads.map((existing) => {
      const replacement = incoming.get(existing.id)
      if (replacement === undefined) return existing
      incoming.delete(existing.id)
      if (this.sidebarRowUnchanged(existing, replacement)) return existing
      changed = true
      return replacement
    })
    // A thread the list has not seen takes the head, matching the single-row path.
    const additions = [...incoming.values()]
    if (additions.length > 0) changed = true
    if (!changed) return
    this.root.createThreadInProject.allThreads =
      additions.length === 0 ? next : [...additions, ...next]
  }

  /** Threads view must not be bounded by the per-project first-paint slices:
   *  it ranks threads by status and last activity globally, so a project whose
   *  recent slice simply never included an old done thread would distort the
   *  order. Switching to Threads view hydrates the global recent list, bounded
   *  to 200 combined rows with last-activity as the source of truth; deeper
   *  history stays available through the existing "Load older threads" pager.
   *
   *  The 200-row window only ranks by activity, so on its own it hides a
   *  non-done thread that has gone quiet and every thread of a pinned scope,
   *  even though the view ranks those above the done rows that did load. Those
   *  arrive through a second, side-loaded hydration query
   *  (`thread:listAlwaysVisible`) that never gates the window, so the view keeps
   *  its instant first-paint slice and the guarantee set joins it as it lands. */
  THREADS_VIEW_HYDRATION_LIMIT = 200

  /**
   * Fold a hydrated page over `allThreads`. `thread:listRecent` carries
   * harness-usage decoration, while the bounded first-paint slice
   * (`thread:listRecentPerProject`) deliberately omits it. Adding only the ids
   * the list had never seen left every first-paint row on its usage-less copy,
   * so a thread that used several harnesses over its session only ever drew the
   * fallback from `settings.harnessId`. Known rows must take the page's copy;
   * unseen rows append after the list. A scratch index for this one pass, never
   * read reactively.
   */
  foldHydratedThreads(threads: Thread[]): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const incoming = new Map<string, Thread>()
    for (const thread of threads) {
      if (isOrchestrationChildThread(thread)) continue
      incoming.set(thread.id, thread)
    }
    let changed = false
    const refreshed = this.root.createThreadInProject.allThreads.map((existing) => {
      const replacement = incoming.get(existing.id)
      if (replacement === undefined) return existing
      incoming.delete(existing.id)
      if (replacement === existing) return existing
      changed = true
      return replacement
    })
    const additions = [...incoming.values()]
    if (additions.length > 0) changed = true
    if (changed)
      this.root.createThreadInProject.allThreads =
        additions.length > 0 ? [...refreshed, ...additions] : refreshed
  }

  threadsViewHydrating = $state(false)

  async ensureThreadsViewFullyLoaded(): Promise<void> {
    if (this.threadsViewHydrating) return
    this.threadsViewHydrating = true
    try {
      const page = await invoke('thread:listRecent', {
        limit: this.THREADS_VIEW_HYDRATION_LIMIT,
        offset: 0
      })
      const uniquePage = this.root.createThreadInProject.uniqueThreadList(page)
      scopeState.mergeThreads(uniquePage)
      this.foldHydratedThreads(uniquePage)
      this.root.createThreadInProject.historyOffset = Math.max(
        this.root.createThreadInProject.historyOffset,
        page.length
      )
      this.hasMoreHistory = page.length === this.THREADS_VIEW_HYDRATION_LIMIT
    } finally {
      this.threadsViewHydrating = false
    }
  }

  /**
   * The Threads view's guarantee set, side-loaded beside the recency window:
   * pinned rows, non-done rows, and every row of a pinned scope. It resolves on
   * its own and folds in when it lands, so the window's own hydration and the
   * first-paint slice are never made to wait on it.
   */
  threadsViewGuaranteesHydrating = $state(false)

  async hydrateThreadsViewGuarantees(): Promise<void> {
    if (this.threadsViewGuaranteesHydrating) return
    this.threadsViewGuaranteesHydrating = true
    try {
      const alwaysVisible = await invoke('thread:listAlwaysVisible')
      const unique = this.root.createThreadInProject.uniqueThreadList(alwaysVisible)
      scopeState.mergeThreads(unique)
      this.foldHydratedThreads(unique)
    } finally {
      this.threadsViewGuaranteesHydrating = false
    }
  }

  // ─── Folder ellipsis menu actions ────────────────────────────────────────

  // ─── Scope bucket actions ──────────────────────────────────────────────────

  // Scope actions live in the shared controller (see `scopeActions` above) so the
  // board and the scoped-threads sidebar run identical code paths.

  // ─── Drag-to-reorder ──────────────────────────────────────────────────────

  async handleProjectMove(
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    const orderedIds = this.visibleProjects.map((p) => p.id)
    const fromIdx = orderedIds.indexOf(draggedId)
    const toIdx = orderedIds.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) return

    orderedIds.splice(fromIdx, 1)
    const adjustedTo = orderedIds.indexOf(targetId)
    if (adjustedTo === -1) return
    orderedIds.splice(position === 'before' ? adjustedTo : adjustedTo + 1, 0, draggedId)

    const updated = await invoke('project:reorder', orderedIds)
    for (const p of updated) {
      this.root.createThreadInProject.projects = this.root.createThreadInProject.projects.map(
        (pr) => (pr.id === p.id ? p : pr)
      )
    }
  }

  /**
   * Persist a drop in a sidebar list.
   *
   * `ordered` is the arrangement the pane was showing when the user dropped the
   * row, so the anchor is written against the neighbours the user actually saw,
   * whatever order that pane keeps (project folders, chats, or the status-grouped
   * Threads view). The dragged row takes a "frozen recency" anchor between those
   * neighbours' effective keys, so it holds that slot while newer activity can
   * still bubble above it.
   */
  async handleThreadDrop(
    projectId: string,
    ordered: readonly Thread[],
    draggedId: string
  ): Promise<void> {
    const idx = ordered.findIndex((t) => t.id === draggedId)
    if (idx === -1) return
    const above = ordered[idx - 1]
    const below = ordered[idx + 1]
    const aboveKey = above ? threadOrderKey(above) : Number.MAX_SAFE_INTEGER
    const belowKey = below ? threadOrderKey(below) : 0
    let sortOrder: number
    if (above && below) {
      sortOrder = (aboveKey + belowKey) / 2
    } else if (above) {
      sortOrder = Math.max(aboveKey - 1, 0)
    } else if (below) {
      sortOrder = belowKey + 1
    } else {
      sortOrder = Date.now()
    }

    // Optimistic: anchor immediately so the sidebar reorders on drop.
    this.root.createThreadInProject.allThreads = this.root.createThreadInProject.allThreads.map(
      (t) => (t.id === draggedId ? { ...t, sortOrder } : t)
    )
    const persisted = await invoke('thread:setSortOrder', projectId, draggedId, sortOrder)
    this.root.createThreadInProject.upsertThreadInList(persisted)
  }

  /**
   * Manual reorder of the global pinned section in Threads view. Rewrites
   * pinned_at across every project so the first thread is most-recently
   * pinned, applied optimistically so the section reorders the moment the
   * user drops. This is the only thing that changes pin order.
   */
  async handleTimelinePinnedMove(
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    const pinnedIds = this.pinnedTimelineThreads.map((t) => t.id)
    const fromIdx = pinnedIds.indexOf(draggedId)
    const toIdx = pinnedIds.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) return

    pinnedIds.splice(fromIdx, 1)
    const adjustedTo = pinnedIds.indexOf(targetId)
    if (adjustedTo === -1) return
    pinnedIds.splice(position === 'before' ? adjustedTo : adjustedTo + 1, 0, draggedId)

    // Optimistic: assign new pinned_at immediately so the pinned section
    // reorders on drop, before the persisted result returns.
    const base = Date.now()
    this.root.createThreadInProject.allThreads = this.root.createThreadInProject.allThreads.map(
      (t) => {
        const index =
          t.pinned && !t.archived && t.projectId !== INBOX_PROJECT_ID ? pinnedIds.indexOf(t.id) : -1
        return index !== -1 ? { ...t, pinnedAt: base - index } : t
      }
    )

    const updated = await invoke('thread:reorderPinnedGlobal', pinnedIds)
    for (const t of updated) {
      this.root.createThreadInProject.upsertThreadInList(t)
    }
  }

  /**
   * The model the composer would start a new assistant task on: the selected
   * assistant task's model, else the assistant's own last-used model, else the
   * model the project work last ran on. An assistant defaults its primary to it.
   */
  currentAssistantModelSelection(): AgentModelSelection | undefined {
    const selected = workspaceState.selectedThread
    const settings =
      selected && selected.projectId === ASSISTANT_SPACE_ID
        ? selected.settings
        : assistantEffectiveSettings(threadSettings.lastUsed)
    if (!settings?.modelId) return undefined
    return {
      harnessId: settings.harnessId,
      providerId: settings.providerId,
      modelId: settings.modelId,
      ...(settings.accountId ? { accountId: settings.accountId } : {}),
      inferenceMode: settings.inferenceMode,
      contextWindow: settings.contextWindow,
      ...(settings.thinkingLevel ? { thinkingLevel: settings.thinkingLevel } : {})
    }
  }

  /**
   * The assistant the user is currently "inside": the assistant of the selected
   * task, else the assistant whose knowledge panel is docked (so a shortcut still
   * lands in the assistant while its panel is open on another task).
   */
  activeAssistant(): Assistant | null {
    const selectedId = this.root.openThreadFromSwitcher.selectedThread?.id
    const fromSelection = selectedId
      ? this.assistantThreads.find((task) => task.id === selectedId)?.assistantId
      : undefined
    const tab = contextSidebarState.sidebarActiveTab
    const fromPanel =
      tab?.kind === 'assistant-knowledge' ? (tab.assistantId ?? undefined) : undefined
    const assistantId = fromSelection ?? fromPanel
    if (!assistantId) return null
    return this.assistantList.find((assistant) => assistant.id === assistantId) ?? null
  }

  /**
   * Cmd/Ctrl+N on the Assistant view: a new task, in the assistant the user is
   * currently in, or in the one they pick when they are not in any. There is no
   * task outside an assistant, so there is nothing to create without an answer.
   */
  async createAssistantTaskFromShortcut(): Promise<void> {
    const assistant = this.activeAssistant()
    if (assistant) await this.createTaskInAssistant(assistant)
    else this.requestTaskOwner()
  }

  /** Create a task inside an assistant and open the assistant's knowledge panel. */
  async createTaskInAssistant(assistant: Assistant): Promise<void> {
    if (!this.root.markThreadReadAndApply.assistantProject) return
    await this.root.createThreadInProject.createThreadInProject(
      this.root.markThreadReadAndApply.assistantProject,
      undefined,
      { assistantId: assistant.id }
    )
    const created = workspaceState.selectedThread
    await this.applyAssistantModelToTask(created, assistant)
    if (created && created.projectId === ASSISTANT_SPACE_ID) {
      this.root.createThreadInProject.upsertThreadInList(created)
      // Anchor on the assistant id we already hold: a reused blank thread carries
      // no grouping until its async regroup lands, and the panel must not open
      // against the wrong assistant in that window.
      contextSidebarState.openAssistantKnowledge(
        ASSISTANT_SPACE_ID,
        created.id,
        assistant.id,
        assistant.name
      )
    } else {
      await this.root.markThreadReadAndApply.openAssistantKnowledgeFor(assistant)
    }
  }

  /**
   * Run one assistant connection's setup in a thread of the assistant's own.
   *
   * The connection is the assistant's, so the thread is too: it lands beside the
   * assistant's other tasks where this panel reports on it, and it starts on the
   * assistant's primary model. Nothing is docked and no tab is switched, because
   * the user came here from the assistant's Connections tab and stays on it while
   * the agent works: the row they pressed Set up on is what flips to Ready.
   */
  async openAssistantConnectionSetup(input: ConnectionSetupRequest): Promise<void> {
    const project = this.root.markThreadReadAndApply.assistantProject
    if (!project) return
    const assistant = assistants.assistants.find((candidate) => candidate.id === input.assistantId)
    if (!assistant) return
    try {
      this.root.createThreadInProject.upsertThreadInList(
        await openAssistantUtilitySetupThread({
          project,
          assistant,
          label: input.label,
          request: input.request
        })
      )
    } catch (error) {
      reportError(error, 'The setup thread could not be opened.')
    }
  }

  /**
   * A task created inside an assistant starts on the assistant's primary model, so
   * the composer shows the model the assistant actually runs on. Best-effort: the
   * scheduled run applies the assistant's primary regardless, so a failed write
   * only leaves the composer showing the inherited model.
   */
  async applyAssistantModelToTask(
    thread: Thread | null | undefined,
    assistant: Assistant
  ): Promise<void> {
    const primary = assistantPrimaryModel(assistant.agents)
    if (!thread || !primary || !thread.settings) return
    try {
      const updated = await persistInheritedThreadSettings(
        thread,
        settingsWithAssistantModel(thread.settings, primary)
      )
      this.root.createThreadInProject.upsertThreadInList(updated)
      if (workspaceState.selectedThread?.id === updated.id) workspaceState.updateThread(updated)
    } catch {
      // Cosmetic only: the run itself uses the assistant's primary either way.
    }
  }

  /** Remove an assistant and every thread it owns, its hidden knowledge thread included. */
  async deleteAssistant(assistantId: string): Promise<void> {
    const affected = this.root.createThreadInProject.allThreads.filter(
      (thread) => thread.assistantId === assistantId
    )
    // The container and its rows leave the sidebar first: the removal must not
    // wait on the database sweep. The main process then deletes the threads and
    // their runs, forgets the assistant in the scheduler, and removes its artifact
    // folder; the toast reports what went with it.
    for (const thread of affected) {
      this.root.createThreadInProject.allThreads =
        this.root.createThreadInProject.allThreads.filter((candidate) => candidate.id !== thread.id)
      scopeState.removeThread(thread.id)
      if (this.root.openThreadFromSwitcher.selectedThread?.id === thread.id)
        workspaceState.clearThread()
    }
    // The assistant is gone, so its knowledge panel has nothing left to configure.
    contextSidebarState.close(`assistant-knowledge:${ASSISTANT_SPACE_ID}:${assistantId}`)
    try {
      const result = await assistants.removeAssistant(assistantId)
      toast.success('Assistant removed', {
        description: this.removalSummary(result.taskCount, result.runCount, result.artifactsRemoved)
      })
    } catch (error) {
      reportError(error, 'The assistant could not be removed.')
    }
  }

  /**
   * What one assistant removal swept, in one sentence. The artifact folder is
   * called out because it can hold files the agent produced, so the user knows
   * they went with the assistant.
   */
  removalSummary(taskCount: number, runCount: number, artifactsRemoved: boolean): string {
    const parts = [`${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`]
    if (runCount > 0) parts.push(`${runCount} ${runCount === 1 ? 'run' : 'runs'}`)
    const swept = `${parts.join(' and ')} deleted`
    return artifactsRemoved
      ? `${swept}, along with the assistant's artifact folder.`
      : `${swept}. Its artifact folder could not be removed.`
  }

  /** Group a dragged task into an assistant. */
  async assignAssistantTask(taskId: string, assistantId: string): Promise<void> {
    const updated = await assistants.assignTask(taskId, assistantId)
    this.root.createThreadInProject.upsertThreadInList(updated)
    workspaceState.updateThread(updated)
  }

  /**
   * What the user is choosing an assistant for: a task they just asked for, or a
   * task that already exists and still belongs to nobody.
   *
   * Nothing in the Assistant view runs without an assistant, so a task with no
   * owner is never created here: the workspace asks which assistant takes it on,
   * and only a brand-new assistant starts without being asked.
   */
  taskOwnerRequest = $state<{
    mode: 'create' | 'assign'
    taskId?: string
    taskLabel?: string
  } | null>(null)

  /** Ask which assistant a new task belongs to, before it is created. */
  requestTaskOwner(): void {
    if (this.assistantList.length === 0) {
      // Nothing to choose from, so the only way forward is an assistant of its
      // own; the create flow seeds its first task and opens the panel.
      this.assistantCreateTrigger++
      return
    }
    this.taskOwnerRequest = { mode: 'create' }
  }

  /** Offer to move one existing task into an assistant. */
  requestTaskOwnerForTask(task: Thread): void {
    if (this.assistantList.length === 0) {
      this.assistantCreateTrigger++
      return
    }
    this.taskOwnerRequest = { mode: 'assign', taskId: task.id, taskLabel: task.title }
  }

  /** The assistant the user picked: create the task in it, or move one into it. */
  async pickTaskOwner(assistantId: string): Promise<void> {
    const request = this.taskOwnerRequest
    this.taskOwnerRequest = null
    const assistant = this.assistantList.find((entry) => entry.id === assistantId)
    if (!assistant || !request) return
    if (request.mode === 'assign' && request.taskId) {
      try {
        await this.assignAssistantTask(request.taskId, assistant.id)
        toast.success(`Moved into ${assistant.name}`)
      } catch (error) {
        reportError(error, 'The task could not be moved')
      }
      return
    }
    await this.createTaskInAssistant(assistant)
  }

  openAssistantKnowledgeForTask(task: Thread): void {
    // One panel per assistant: the title follows the assistant, so opening the
    // knowledge from any of its tasks focuses the same panel with the same name
    // instead of re-titling it with whichever task was clicked. A run is one
    // execution, not the task the panel belongs to, so it anchors on its task
    // (falling back to the run only when that task is gone): an assistant must
    // never grow a second knowledge tab just because it ran.
    const anchor = task.assistantTaskId
      ? (this.assistantThreads.find((entry) => entry.id === task.assistantTaskId) ?? task)
      : task
    const assistantId = anchor.assistantId ?? task.assistantId
    const assistant = assistantId
      ? this.assistantList.find((entry) => entry.id === assistantId)
      : undefined
    contextSidebarState.openAssistantKnowledge(
      ASSISTANT_SPACE_ID,
      anchor.id,
      assistantId ?? null,
      assistant?.name ?? anchor.title
    )
  }

  async switchScopedProject(projectId: string): Promise<void> {
    const project = this.root.createThreadInProject.projects.find(
      (candidate) => candidate.id === projectId
    )
    if (!project) return

    await scopeState.activateProject(projectId)
    const thread =
      this.root.createThreadInProject.allThreads
        .filter((candidate) => candidate.projectId === projectId && !candidate.archived)
        .sort((a, b) => b.lastActivity - a.lastActivity)[0] ?? null

    if (thread) {
      workspaceState.openThread(
        thread,
        project,
        getProjectIcon(project, this.root.createThreadInProject.projectIcons.get(projectId))
      )
      scopeState.showSidebarForThread(thread)
    } else {
      workspaceState.clearThread()
      workspaceState.activeProject = project
      workspaceState.activeProjectIconUrl = getProjectIcon(
        project,
        this.root.createThreadInProject.projectIcons.get(projectId)
      )
      rendererRecovery.setSelectedProject(projectId)
      scopeState.showSidebarForProject(projectId)
    }
  }
}
