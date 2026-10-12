import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { MessagesSquare, Workflow } from '@lucide/svelte'
import type { Component } from 'svelte'
import type { ActionDefinition, ActionSelection } from '$lib/actions'
import { invoke } from '$lib/ipc.svelte'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
import { ovens } from '$lib/stores/ovens.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
import { getRoutineIcon } from '$lib/routine-icons'
import { isThreadLiveWorking, statusBadgeForThread } from '$lib/thread-status-badge'
import { threadScopeBucket } from '$lib/threads/thread-scope'
import {
  isOrchestrationChildThread,
  type Routine,
  type Thread,
  type ThreadSearchResult
} from '$shared/types'
import { LOCAL_OVEN_ID } from '$shared/ovens'
import { actionId } from './app-palette-actions'

/** The thread families the spotlight can search in their own screen. */
export type ThreadSearchFamily = 'projects' | 'chats' | 'assistant'

/** A picked row is either a thread to open or a routine to focus. */
type ThreadSearchTarget = { thread: Thread } | { routine: Routine }

const SEARCH_DEBOUNCE_MS = 160
const MIN_QUERY_LENGTH = 2
const MAX_RESULTS = 60
const RESULT_LIMIT = 50
/** Routine-name matches surfaced above the task rows. */
const MAX_ROUTINE_RESULTS = 12

function relativeThreadTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

export interface ThreadSearchPaletteDeps {
  openThread: (thread: Thread) => void
  /** Focus a matching routine (assistant search only). */
  openRoutine?: (routine: Routine) => void
}

/**
 * Reactive state machine behind a family-scoped thread search palette: the
 * debounced fan-out search, the row metadata, and opening the picked thread or
 * routine. One instance serves the Projects screen (filtered by project), the
 * Chats screen (no filter), and the Assistant screen (filtered by routine, where
 * matching routine names are surfaced above their tasks).
 */
export class ThreadSearchPaletteController {
  paletteOpen = $state(false)
  actions = $state<ActionDefinition[]>([])
  loading = $state(false)
  /** Selected sub-container ids for the footer picker; empty = all of them.
   *  Project ids for the Projects screen, routine ids for the Assistant one. */
  scopeIds = $state<string[]>([])

  private timer: number | null = null
  private request = 0
  private lastQuery = ''
  /** Latest result set, kept so rows can be rebuilt (scope badges) without
   *  re-running the search. */
  private lastResults: readonly ThreadSearchResult[] = []
  private readonly targets = new SvelteMap<ActionDefinition['id'], ThreadSearchTarget>()

  constructor(
    private readonly deps: ThreadSearchPaletteDeps,
    private readonly family: ThreadSearchFamily
  ) {}

  reset(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    this.request++
    this.loading = false
    this.actions = []
    this.targets.clear()
    this.scopeIds = []
    this.lastResults = []
    this.lastQuery = ''
  }

  openPalette(): void {
    this.reset()
    this.paletteOpen = true
    // The assistant screen's routine picker and routine rows read the routines
    // store, which may not have hydrated yet on a session that restored onto a
    // non-content view. Idempotent, so an already-initialised store is free.
    if (this.family === 'assistant') assistantRoutines.initialize()
    // Rows carry the thread's Oven next to its scope, so the registry has to be
    // read once before the first result can name one.
    void ovens.ensure()
  }

  close(): void {
    this.paletteOpen = false
    this.reset()
  }

  handleQuery(query: string): void {
    this.lastQuery = query
    if (this.timer !== null) window.clearTimeout(this.timer)
    const request = ++this.request
    const normalized = query.trim()
    if (normalized.length < MIN_QUERY_LENGTH) {
      this.loading = false
      this.actions = []
      this.targets.clear()
      this.lastResults = []
      return
    }

    this.loading = true
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.search(normalized, request)
    }, SEARCH_DEBOUNCE_MS)
  }

  /** Re-run the in-flight search immediately when the sub-container scope
   *  (project or routine) changes. */
  setScope(scopeIds: string[]): void {
    this.scopeIds = scopeIds
    if (!this.paletteOpen || this.lastQuery.trim().length < MIN_QUERY_LENGTH) return
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    const request = ++this.request
    this.loading = true
    void this.search(this.lastQuery.trim(), request)
  }

  select(selection: ActionSelection): void {
    const target = this.targets.get(selection.action.id)
    if (!target) return
    this.close()
    if ('routine' in target) this.deps.openRoutine?.(target.routine)
    else this.deps.openThread(target.thread)
  }

  private async search(query: string, request: number): Promise<void> {
    let results: ThreadSearchResult[]
    try {
      // Scoped search: fan out per selected sub-container so the manager can use
      // its per-project index (projects) or narrow to one routine (assistant);
      // an empty selection searches the whole family in one call.
      results = await this.runFanOut(query)
    } catch {
      results = []
    }
    if (request !== this.request || !this.paletteOpen) return

    this.lastResults = results
    this.renderRows()
    this.loading = false
    // A scope badge needs the thread's project scope board, which is only cached
    // for projects the user already opened. Warm the missing boards in the
    // background and repaint the rows once they land   the search itself never
    // waits on a board read. Only project threads carry scope badges.
    if (this.family === 'projects') void this.warmScopeBoards(request)
  }

  private async runFanOut(query: string): Promise<ThreadSearchResult[]> {
    if (this.family === 'projects' && this.scopeIds.length > 0) {
      return (
        await Promise.all(
          this.scopeIds.map((projectId) =>
            invoke('threads:search', query, {
              family: 'projects',
              projectId,
              limit: RESULT_LIMIT
            }).catch((): ThreadSearchResult[] => [])
          )
        )
      ).flat()
    }
    if (this.family === 'assistant' && this.scopeIds.length > 0) {
      return (
        await Promise.all(
          this.scopeIds.map((routineId) =>
            invoke('threads:search', query, {
              family: 'assistant',
              routineId,
              limit: RESULT_LIMIT
            }).catch((): ThreadSearchResult[] => [])
          )
        )
      ).flat()
    }
    return invoke('threads:search', query, { family: this.family, limit: RESULT_LIMIT })
  }

  /** Rebuild the visible rows from the cached results. Scope badges read the
   *  cached scope boards, so a board that lands after the search refreshes its
   *  rows without another query. */
  private renderRows(): void {
    const { actions, targets } = this.buildRows(this.lastResults)
    this.targets.clear()
    for (const [id, target] of targets) this.targets.set(id, target)
    this.actions = actions
  }

  /** Cache the scope boards of the projects in the current results that are not
   *  cached yet, then repaint so their scope badges appear. Deduped per project
   *  and bounded by the number of projects the results actually span. */
  private async warmScopeBoards(request: number): Promise<void> {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const missing = new Set<string>()
    for (const result of this.lastResults) {
      const thread = result.thread
      if (thread.archived || isOrchestrationChildThread(thread)) continue
      if (scopeState.hasBoard(thread.projectId)) continue
      missing.add(thread.projectId)
    }
    if (missing.size === 0) return
    await Promise.all([...missing].map((projectId) => scopeState.cacheBoardForLookup(projectId)))
    if (request !== this.request || !this.paletteOpen) return
    this.renderRows()
  }

  /**
   * The container a result row belongs to, presented the way the palette already
   * presents a thread's project: its display label, colour, and icon. Projects
   * resolve their real record, chats are the inbox, and assistant rows name the
   * routine they run under.
   */
  private containerFor(thread: Thread): {
    label: string
    color?: string
    iconUri?: string
    icon?: Component
  } {
    if (this.family === 'chats') return { label: 'Chats', icon: MessagesSquare }
    if (this.family === 'assistant') {
      const routine = assistantRoutines.routineForTask(thread)
      if (routine) {
        const iconUri = getRoutineIcon(routine, assistantRoutines.iconUrls.get(routine.id) ?? null)
        return {
          label: routine.name,
          ...(routine.color ? { color: routine.color } : {}),
          ...(iconUri ? { iconUri } : { icon: Workflow })
        }
      }
      return { label: 'Assistant', icon: Workflow }
    }
    const project = scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId)
    const iconUri = scopeState.projects.find(
      (candidate) => candidate.id === thread.projectId
    )?.iconUrl
    return {
      label: project?.name ?? thread.projectId,
      ...(project?.color ? { color: project.color } : {}),
      ...(iconUri ? { iconUri } : { icon: MessagesSquare })
    }
  }

  /** Routine rows for assistant searches: a routine whose name matches the query
   *  is surfaced above its tasks, the way the Assistant view's own search lists
   *  it. Hidden while a routine filter is active, where the user is already
   *  searching inside one routine. */
  private buildRoutineRows(query: string): {
    actions: ActionDefinition[]
    targets: Array<[ActionDefinition['id'], ThreadSearchTarget]>
  } {
    if (this.family !== 'assistant' || this.scopeIds.length > 0) {
      return { actions: [], targets: [] }
    }
    const normalized = query.trim().toLowerCase()
    if (!normalized) return { actions: [], targets: [] }
    const actions: ActionDefinition[] = []
    const targets: Array<[ActionDefinition['id'], ThreadSearchTarget]> = []
    for (const routine of assistantRoutines.routines) {
      if (!routine.name.toLowerCase().includes(normalized)) continue
      const iconUri = getRoutineIcon(routine, assistantRoutines.iconUrls.get(routine.id) ?? null)
      const id = actionId(`routine:${routine.id}`)
      actions.push({
        id,
        title: routine.name,
        description: 'Assistant routine',
        category: 'routine',
        source: {
          id: `routine:${routine.id}`,
          label: routine.name,
          kind: 'app',
          ...(routine.color ? { color: routine.color } : {})
        },
        showSourceBadge: false,
        ...(iconUri ? { iconUri } : { icon: Workflow }),
        keywords: [routine.name, routine.description ?? ''].filter(Boolean)
      })
      targets.push([id, { routine }])
      if (actions.length >= MAX_ROUTINE_RESULTS) break
    }
    return { actions, targets }
  }

  /** Map search results to palette rows and their open targets. */
  private buildRows(results: readonly ThreadSearchResult[]): {
    actions: ActionDefinition[]
    targets: SvelteMap<ActionDefinition['id'], ThreadSearchTarget>
  } {
    const targets = new SvelteMap<ActionDefinition['id'], ThreadSearchTarget>()
    const routines = this.buildRoutineRows(this.lastQuery)
    const actions: ActionDefinition[] = routines.actions
    for (const [id, target] of routines.targets) targets.set(id, target)
    for (const result of results) {
      const thread = result.thread
      if (thread.archived || isOrchestrationChildThread(thread)) continue
      const container = this.containerFor(thread)
      const id = actionId(`thread:${thread.projectId}:${thread.id}`)
      targets.set(id, { thread })
      const snippet = result.kind === 'message' && result.snippet ? result.snippet : undefined
      const isLiveWorking = isThreadLiveWorking(thread)
      const status = statusBadgeForThread(
        thread,
        isLiveWorking,
        rendererRecovery.queuedMessageCount(thread.projectId, thread.id) > 0
      )
      // Model/harness metadata for the result row: while the thread is working
      // the current provider + model is shown, otherwise the thread's harnesses
      // and provider appear as icons - mirroring the sidebar thread row.
      const harnessIds = Array.from(
        new SvelteSet([
          ...(thread.usedHarnessIds ?? []),
          ...(thread.settings?.harnessId ? [thread.settings.harnessId] : [])
        ])
      )
      const providerId = thread.settings?.providerId ?? thread.providerId
      const providers = providerCatalog.cached(thread.projectId) ?? providerCatalog.allCached()
      const providerName = providerId
        ? (providers.find((provider) => provider.id === providerId)?.name ?? null)
        : null
      // Thread rows always surface the thread's last-activity time, never its
      // creation time, so freshly worked-on threads read as "1h" etc.
      const activityLabel = relativeThreadTime(thread.lastActivity)
      // The thread's scope, so the row says which scope it belongs to   the same
      // signal the sidebar thread rows and the hover card already carry. Only
      // project threads carry a scope board.
      const scope = this.family === 'projects' ? threadScopeBucket(thread) : null
      // Oven and branch, the two facts about where a thread actually runs.
      const oven =
        thread.settings?.ovenId && thread.settings.ovenId !== LOCAL_OVEN_ID
          ? ovens.identity(thread.settings.ovenId)
          : null
      const branch = thread.branch?.trim() || null
      actions.push({
        id,
        title: thread.title,
        description: snippet
          ? `${container.label} · ${activityLabel} · ${snippet}`
          : `${container.label} · ${activityLabel}`,
        category: 'thread',
        source: {
          id: `project:${thread.projectId}`,
          label: container.label,
          kind: 'app',
          ...(container.color ? { color: container.color } : {})
        },
        showSourceBadge: false,
        ...(container.iconUri
          ? { iconUri: container.iconUri }
          : { icon: container.icon ?? MessagesSquare }),
        ...(status ? { status } : {}),
        ...(scope ? { scope } : {}),
        threadMeta: {
          working: isLiveWorking,
          harnessIds,
          providerName,
          providerId,
          modelId: thread.settings?.modelId ?? null,
          ...(oven ? { oven: { name: oven.name, iconUrl: oven.iconUrl } } : {}),
          ...(branch ? { branch } : {})
        },
        keywords: [
          container.label,
          thread.title,
          ...(oven ? [oven.name] : []),
          ...(branch ? [branch] : []),
          ...(snippet ? [snippet] : [])
        ]
      })
    }
    return { actions: actions.slice(0, MAX_RESULTS), targets }
  }
}
