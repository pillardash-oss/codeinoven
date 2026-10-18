import CioChat from '@pillardash-oss/cio-icon/CioChat.svelte'
import { SvelteMap } from 'svelte/reactivity'

import type { Component } from 'svelte'
import type { ActionDefinition, ActionSelection } from '$lib/actions'
import { invoke } from '$lib/ipc.svelte'
import { warmIntentSearch } from './app-search-warm'
import { ovens } from '$lib/stores/ovens.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
import { threadPaletteRow } from '$lib/threads/thread-palette-row'
import {
  isOrchestrationChildThread,
  type Assistant,
  type Thread,
  type ThreadSearchResult
} from '$shared/types'
import { actionId } from './app-palette-actions'

/** The thread families the spotlight can search in their own screen. */
export type ThreadSearchFamily = 'projects' | 'chats' | 'assistant'

/** A picked row is either a thread to open or an assistant to focus. */
type ThreadSearchTarget = { thread: Thread } | { assistant: Assistant }

const SEARCH_DEBOUNCE_MS = 160
const MIN_QUERY_LENGTH = 2
const MAX_RESULTS = 60
const RESULT_LIMIT = 50
/** Assistant-name matches surfaced above the task rows. */
const MAX_ASSISTANT_RESULTS = 12

export interface ThreadSearchPaletteDeps {
  openThread: (thread: Thread) => void
  /** Focus a matching assistant (assistant search only). */
  openAssistant?: (assistant: Assistant) => void
}

/**
 * Reactive state machine behind a family-scoped thread search palette: the
 * debounced fan-out search, the row metadata, and opening the picked thread or
 * assistant. One instance serves the Projects screen (filtered by project), the
 * Chats screen (no filter), and the Assistant screen (filtered by assistant, where
 * matching assistant names are surfaced above their tasks).
 */
export class ThreadSearchPaletteController {
  paletteOpen = $state(false)
  actions = $state<ActionDefinition[]>([])
  loading = $state(false)
  /** Selected sub-container ids for the footer picker; empty = all of them.
   *  Project ids for the Projects screen, assistant ids for the Assistant one. */
  scopeIds = $state<string[]>([])

  private timer: number | null = null
  private request = 0
  private lastQuery = ''
  /** Latest result set, kept so rows can be rebuilt (scope badges) without
   *  re-running the search. */
  private lastResults: readonly ThreadSearchResult[] = []
  /**
   * The request whose keyword rows are on screen; -1 until the first search
   * answers. A semantic batch that arrives before its rows is held in
   * `deferredIntents` instead of being dropped.
   */
  private renderedRequest = -1
  /** Semantic batches that beat their own keyword rows, keyed by request. */
  private readonly deferredIntents = new SvelteMap<number, ThreadSearchResult[][]>()
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
    this.renderedRequest = -1
    this.deferredIntents.clear()
  }

  openPalette(): void {
    this.reset()
    this.paletteOpen = true
    // The model ranks by meaning and boots cold after its five-minute idle
    // retire; start that boot while the user is still typing. Main no-ops it
    // unless intent search is enabled.
    warmIntentSearch()
    // The assistant screen's assistant picker and assistant rows read the assistants
    // Store, which may not have hydrated yet on a session that restored onto a
    // non-content view. Idempotent, so an already-initialised store is free.
    if (this.family === 'assistant') assistants.initialize()
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
      this.renderedRequest = -1
      this.deferredIntents.clear()
      return
    }

    this.loading = true
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.search(normalized, request)
    }, SEARCH_DEBOUNCE_MS)
  }

  /** Re-run the in-flight search immediately when the sub-container scope
   *  (project or assistant) changes. */
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
    if ('assistant' in target) this.deps.openAssistant?.(target.assistant)
    else this.deps.openThread(target.thread)
  }

  private async search(query: string, request: number): Promise<void> {
    // A superseded request's held semantic batches belong to rows that will never
    // land; only the request being searched now may keep its held batch.
    for (const key of [...this.deferredIntents.keys()]) {
      if (key !== request) this.deferredIntents.delete(key)
    }
    let results: ThreadSearchResult[]
    try {
      // Scoped search: fan out per selected sub-container so the manager can use
      // its per-project index (projects) or narrow to one assistant (assistant);
      // an empty selection searches the whole family in one call.
      results = await this.runFanOut(query)
    } catch {
      results = []
    }
    if (request !== this.request || !this.paletteOpen) return

    this.lastResults = results
    this.renderedRequest = request
    this.renderRows()
    this.loading = false
    // A semantic batch that beat these rows is folded in now. The local model
    // answers in tens of milliseconds once warm, so on a fast machine the two
    // IPC deliveries can invert; dropping the batch here would lose the
    // meaning-based matches the screen was opened for.
    const held = this.deferredIntents.get(request)
    if (held) {
      this.deferredIntents.delete(request)
      for (const batch of held) this.applyIntent(request, batch)
    }
    // A scope badge needs the thread's project scope board, which is only cached
    // for projects the user already opened. Warm the missing boards in the
    // background and repaint the rows once they land   the search itself never
    // waits on a board read. Only project threads carry scope badges.
    if (this.family === 'projects') void this.warmScopeBoards(request)
  }

  /** Whether this screen fans out into one search per selected sub-container. */
  private get fannedOut(): boolean {
    return this.scopeIds.length > 0 && (this.family === 'projects' || this.family === 'assistant')
  }

  private async runFanOut(query: string): Promise<ThreadSearchResult[]> {
    if (this.family === 'projects' && this.scopeIds.length > 0) {
      return (
        await Promise.all(
          this.scopeIds.map((projectId) =>
            invoke('threads:search', query, {
              family: 'projects',
              projectId,
              limit: RESULT_LIMIT,
              semantic: true,
              requestId: this.request
            }).catch((): ThreadSearchResult[] => [])
          )
        )
      ).flat()
    }
    if (this.family === 'assistant' && this.scopeIds.length > 0) {
      return (
        await Promise.all(
          this.scopeIds.map((assistantId) =>
            invoke('threads:search', query, {
              family: 'assistant',
              assistantId,
              limit: RESULT_LIMIT,
              semantic: true,
              requestId: this.request
            }).catch((): ThreadSearchResult[] => [])
          )
        )
      ).flat()
    }
    return invoke('threads:search', query, {
      family: this.family,
      limit: RESULT_LIMIT,
      semantic: true,
      requestId: this.request
    })
  }

  /**
   * Take the semantic half of the search when it lands.
   *
   * The spotlight is the only surface that ranks by meaning, and it shows its
   * keyword rows first so the panel never waits on the local model. This is the
   * replacement: a batch for the current request and query either swaps the rows
   * (one query) or folds into them (a per-scope fan-out), and anything stale is
   * dropped. A batch that beats its own keyword rows is held until they land.
   */
  applyIntentResults(payload: {
    query: string
    requestId: number
    results: ThreadSearchResult[]
  }): void {
    if (!this.paletteOpen) return
    if (payload.requestId !== this.request) return
    if (payload.query !== this.lastQuery.trim()) return
    if (this.renderedRequest !== payload.requestId) {
      this.deferredIntents.set(payload.requestId, [
        ...(this.deferredIntents.get(payload.requestId) ?? []),
        payload.results
      ])
      return
    }
    this.applyIntent(payload.requestId, payload.results)
  }

  /** Fold one semantic batch into the rows on screen. */
  private applyIntent(request: number, incoming: readonly ThreadSearchResult[]): void {
    if (request !== this.request) return
    // A fan-out answers one query with several hybrid rankings; merging keeps the
    // rows each of them already returned. A single query swaps wholesale, which
    // is the ranking the merge produced (title matches, then meaning, then the
    // rest).
    this.lastResults = this.fannedOut ? mergeIntentResults(this.lastResults, incoming) : incoming
    this.renderRows()
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
   * assistant they run under.
   */
  private containerFor(thread: Thread): {
    label: string
    color?: string
    iconUri?: string
    icon?: Component
  } {
    if (this.family === 'chats') return { label: 'Chats', icon: CioChat }
    if (this.family === 'assistant') {
      const assistant = assistants.assistantForTask(thread)
      if (assistant) {
        const iconUri = getAssistantIcon(assistant, assistants.iconUrls.get(assistant.id) ?? null)
        return {
          label: assistant.name,
          ...(assistant.color ? { color: assistant.color } : {}),
          ...(iconUri ? { iconUri } : { icon: AssistantDefaultIcon })
        }
      }
      return { label: 'Assistant', icon: AssistantDefaultIcon }
    }
    const project = scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId)
    const iconUri = scopeState.projects.find(
      (candidate) => candidate.id === thread.projectId
    )?.iconUrl
    return {
      label: project?.name ?? thread.projectId,
      ...(project?.color ? { color: project.color } : {}),
      ...(iconUri ? { iconUri } : { icon: CioChat })
    }
  }

  /** Assistant rows for assistant searches: an assistant whose name matches the query
   *  is surfaced above its tasks, the way the Assistant view's own search lists
   *  it. Hidden while an assistant filter is active, where the user is already
   *  searching inside one assistant. */
  private buildAssistantRows(query: string): {
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
    for (const assistant of assistants.assistants) {
      if (!assistant.name.toLowerCase().includes(normalized)) continue
      const iconUri = getAssistantIcon(assistant, assistants.iconUrls.get(assistant.id) ?? null)
      const id = actionId(`assistant:${assistant.id}`)
      actions.push({
        id,
        title: assistant.name,
        description: 'Assistant',
        category: 'assistant',
        source: {
          id: `assistant:${assistant.id}`,
          label: assistant.name,
          kind: 'app',
          ...(assistant.color ? { color: assistant.color } : {})
        },
        showSourceBadge: false,
        ...(iconUri ? { iconUri } : { icon: AssistantDefaultIcon }),
        keywords: [assistant.name, assistant.description ?? ''].filter(Boolean)
      })
      targets.push([id, { assistant }])
      if (actions.length >= MAX_ASSISTANT_RESULTS) break
    }
    return { actions, targets }
  }

  /** Map search results to palette rows and their open targets. */
  private buildRows(results: readonly ThreadSearchResult[]): {
    actions: ActionDefinition[]
    targets: SvelteMap<ActionDefinition['id'], ThreadSearchTarget>
  } {
    const targets = new SvelteMap<ActionDefinition['id'], ThreadSearchTarget>()
    const assistants = this.buildAssistantRows(this.lastQuery)
    const actions: ActionDefinition[] = assistants.actions
    for (const [id, target] of assistants.targets) targets.set(id, target)
    for (const result of results) {
      const thread = result.thread
      if (thread.archived || isOrchestrationChildThread(thread)) continue
      const container = this.containerFor(thread)
      const id = actionId(`thread:${thread.projectId}:${thread.id}`)
      targets.set(id, { thread })
      actions.push(
        threadPaletteRow({
          id,
          thread,
          container,
          ...(result.kind === 'message' && result.snippet ? { snippet: result.snippet } : {}),
          // Only project threads carry a scope board.
          withScope: this.family === 'projects'
        })
      )
    }
    return { actions: actions.slice(0, MAX_RESULTS), targets }
  }
}

/**
 * Fold one semantic batch into the rows already on screen.
 *
 * Used by a per-scope fan-out, where several searches answer one query and each
 * carries its own hybrid ranking: a row already shown keeps its place (with the
 * batch's metadata when the batch re-ranks it), and a row the batch adds joins
 * the end rather than resetting the list the reader is looking at.
 */
function mergeIntentResults(
  current: readonly ThreadSearchResult[],
  incoming: readonly ThreadSearchResult[]
): ThreadSearchResult[] {
  const positions = new SvelteMap<string, number>()
  current.forEach((result, position) => positions.set(result.thread.id, position))
  const merged = [...current]
  for (const result of incoming) {
    const position = positions.get(result.thread.id)
    if (position === undefined) {
      positions.set(result.thread.id, merged.length)
      merged.push(result)
    } else {
      merged[position] = result
    }
  }
  return merged
}
