/**
 * Cached agent tool catalog (stale-while-revalidate) for the Utilities →
 * Tools tab. `agent:listTools` walks every installed harness driver and can
 * take a while, so the catalog and the tab's filter selections live here
 * instead of in the tab's component state — switching tabs (which
 * mounts/unmounts the tab content) no longer re-triggers a fetch or resets
 * the search/filter the user had set.
 */
import type { AgentToolCatalog, Thread } from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { rendererRecovery } from './renderer-recovery.svelte'
import { workspaceState } from './workspace.svelte'

/** Fresh catalog is reused within this window instead of re-probing every harness. */
const FRESH_TTL_MS = 5 * 60 * 1000

class AgentToolsStore {
  catalog = $state<AgentToolCatalog | null>(null)
  /** True only for the very first load (no cached data to show yet). */
  loading = $state(false)
  /** True while a background revalidation is in flight but cached data is already showing. */
  refreshing = $state(false)
  error = $state('')
  query = $state('')
  selectedHarness = $state<string | null>(null)
  selectedSource = $state<'all' | 'application' | 'harness'>('all')

  private fetchedAt = 0
  private lastKey: string | null = null
  private inflight: Promise<void> | null = null

  private async resolveThread(): Promise<Thread | null> {
    const selected = workspaceState.selectedThread
    const reference = selected
      ? { projectId: selected.projectId, threadId: selected.id }
      : rendererRecovery.selectedThread
    if (!reference) return null
    return (await invoke('thread:get', reference.projectId, reference.threadId)) ?? selected ?? null
  }

  /** Load the catalog. Reuses a fresh cached copy unless `force` is set. */
  async load(force = false): Promise<void> {
    if (this.inflight) return this.inflight
    const isFresh = this.catalog !== null && Date.now() - this.fetchedAt < FRESH_TTL_MS
    if (!force && isFresh) return
    if (this.catalog === null) this.loading = true
    else this.refreshing = true
    this.error = ''

    const request = (async () => {
      try {
        const thread = await this.resolveThread()
        const settings = thread?.settings
        const key =
          thread && settings?.harnessId && settings.providerId && settings.modelId
            ? `${thread.projectId}:${settings.harnessId}:${settings.providerId}:${settings.modelId}`
            : 'default'
        const catalog = await (thread && settings?.harnessId && settings.providerId && settings.modelId
          ? invoke(
              'agent:listTools',
              thread.projectId,
              settings.harnessId,
              settings.providerId,
              settings.modelId,
              force
            )
          : invoke('agent:listTools', undefined, undefined, undefined, undefined, force))
        if (key !== this.lastKey) this.selectedHarness = null
        this.lastKey = key
        this.catalog = catalog
        this.fetchedAt = Date.now()
        if (
          this.selectedHarness !== null &&
          !catalog.tools.some((tool) => tool.harnessId === this.selectedHarness)
        ) {
          this.selectedHarness = null
        }
      } catch (loadError) {
        this.error =
          loadError instanceof Error
            ? loadError.message
            : 'The agent tool catalog could not be loaded.'
      } finally {
        this.loading = false
        this.refreshing = false
        this.inflight = null
      }
    })()
    this.inflight = request
    return request
  }
}

export const agentToolsStore = new AgentToolsStore()
