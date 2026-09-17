import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { MessagesSquare } from '@lucide/svelte'
import type { ActionDefinition, ActionSelection } from '$lib/actions'
import { invoke } from '$lib/ipc.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { statusBadgeForThread } from '$lib/thread-status-badge'
import {
  isOrchestrationChildThread,
  isThreadWorking,
  type Thread,
  type ThreadSearchResult
} from '$shared/types'
import { actionId } from './app-palette-actions'

interface ThreadSearchTarget {
  thread: Thread
}

const SEARCH_DEBOUNCE_MS = 160
const MIN_QUERY_LENGTH = 2
const MAX_RESULTS = 60
const RESULT_LIMIT = 50

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
}

/**
 * Reactive state machine behind the cross-project thread search palette:
 * scoped project selection, debounced fan-out search, thread row metadata, and
 * opening the picked thread through the shell's own notification path.
 */
export class ThreadSearchPaletteController {
  paletteOpen = $state(false)
  actions = $state<ActionDefinition[]>([])
  loading = $state(false)
  /** Scoped project ids for the footer picker; empty = all projects. */
  projectIds = $state<string[]>([])

  private timer: number | null = null
  private request = 0
  private lastQuery = ''
  private readonly targets = new SvelteMap<ActionDefinition['id'], ThreadSearchTarget>()

  constructor(private readonly deps: ThreadSearchPaletteDeps) {}

  reset(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    this.request++
    this.loading = false
    this.actions = []
    this.targets.clear()
    this.projectIds = []
    this.lastQuery = ''
  }

  openPalette(): void {
    this.reset()
    this.paletteOpen = true
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
      return
    }

    this.loading = true
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.search(normalized, request)
    }, SEARCH_DEBOUNCE_MS)
  }

  /** Re-run the in-flight search immediately when the project scope changes. */
  setScope(projectIds: string[]): void {
    this.projectIds = projectIds
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
    this.deps.openThread(target.thread)
  }

  private async search(query: string, request: number): Promise<void> {
    let results: ThreadSearchResult[]
    try {
      // Scoped search: fan out per selected project so the manager can use its
      // per-project index; empty selection searches all projects in one call.
      results =
        this.projectIds.length > 0
          ? (
              await Promise.all(
                this.projectIds.map((projectId) =>
                  invoke('threads:search', query, { projectId, limit: RESULT_LIMIT }).catch(
                    (): ThreadSearchResult[] => []
                  )
                )
              )
            ).flat()
          : await invoke('threads:search', query, { limit: RESULT_LIMIT })
    } catch {
      results = []
    }
    if (request !== this.request || !this.paletteOpen) return

    const targets = new SvelteMap<ActionDefinition['id'], ThreadSearchTarget>()
    const actions: ActionDefinition[] = []
    for (const result of results) {
      const thread = result.thread
      if (thread.archived || isOrchestrationChildThread(thread)) continue
      const project = scopeState.projectRecords.find(
        (candidate) => candidate.id === thread.projectId
      )
      const id = actionId(`thread:${thread.projectId}:${thread.id}`)
      targets.set(id, { thread })
      const snippet = result.kind === 'message' && result.snippet ? result.snippet : undefined
      // Threads carry their project's icon and color, not a generic thread icon.
      // Resolve the icon from the scope state so it stays in sync with whatever
      // hydration owns the project/icon cache (Workspace on startup, App when a
      // new project is created). App's own projectIconUrls was never populated on
      // startup, so it always fell back to the generic monochrome thread icon.
      const projectIconUri = scopeState.projects.find(
        (candidate) => candidate.id === thread.projectId
      )?.iconUrl
      const isLiveWorking = agentRuns.hasSettled(thread.projectId, thread.id)
        ? agentRuns.isBusy(thread.projectId, thread.id)
        : Boolean(thread.sessionId) && isThreadWorking(thread)
      const status = statusBadgeForThread(thread, isLiveWorking)
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
      const projectLabel = project?.name ?? thread.projectId
      // Thread rows always surface the thread's last-activity time, never its
      // creation time, so freshly worked-on threads read as "1h" etc.
      const activityLabel = relativeThreadTime(thread.lastActivity)
      actions.push({
        id,
        title: thread.title,
        description: snippet
          ? `${projectLabel} · ${activityLabel} · ${snippet}`
          : `${projectLabel} · ${activityLabel}`,
        category: 'thread',
        source: {
          id: `project:${thread.projectId}`,
          label: projectLabel,
          kind: 'app',
          ...(project?.color ? { color: project.color } : {})
        },
        showSourceBadge: false,
        ...(projectIconUri ? { iconUri: projectIconUri } : { icon: MessagesSquare }),
        ...(status ? { status } : {}),
        threadMeta: {
          working: isLiveWorking,
          harnessIds,
          providerName,
          providerId,
          modelId: thread.settings?.modelId ?? null
        },
        keywords: [project?.name ?? thread.projectId, thread.title, ...(snippet ? [snippet] : [])]
      })
    }
    this.targets.clear()
    for (const [id, target] of targets) this.targets.set(id, target)
    this.actions = actions.slice(0, MAX_RESULTS)
    this.loading = false
  }
}
