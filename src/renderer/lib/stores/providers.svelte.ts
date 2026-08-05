import type { ProviderConnectionInfo } from '$shared/types'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'

/** Minimum time the checking state stays visible so feedback is perceptible. */
const MIN_CHECKING_MS = 900

/**
 * Reactive provider connection store — single source of truth for harness
 * availability across the renderer. Loading states are driven locally
 * (optimistic) so the UI always responds instantly; the main-process
 * broadcast acts as background sync for multi-window consistency.
 */
class ProviderStore {
  providers = $state<ProviderConnectionInfo[]>([])
  initialized = $state(false)

  private unsubscribe: (() => void) | null = null
  /** Providers with an active local check — broadcasts won't clobber their spinner. */
  private pendingIds = new Set<string>()
  /** Previous statuses to detect provider availability changes. */
  private previousStatuses = new Map<string, ProviderConnectionInfo['status']>()

  /** Subscribe to main-process broadcasts and fetch the current snapshot. */
  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    this.unsubscribe = subscribe('providers:status', (...args: unknown[]) => {
      const payload = args[0]
      if (!Array.isArray(payload)) return
      const incoming = payload as ProviderConnectionInfo[]
      // Detect newly available providers to invalidate the model catalog cache.
      for (const provider of incoming) {
        const previous = this.previousStatuses.get(provider.id)
        if (previous !== 'available' && provider.status === 'available') {
          providerCatalog.invalidateAll()
          break
        }
      }
      // Track current statuses for future change detection.
      for (const provider of incoming) {
        this.previousStatuses.set(provider.id, provider.status)
      }
      // Merge: keep local checking states intact, sync everything else.
      this.providers =
        this.providers.length === 0
          ? incoming
          : this.providers.map((local) =>
              this.pendingIds.has(local.id)
                ? local
                : (incoming.find((p) => p.id === local.id) ?? local)
            )
    })

    try {
      const snapshot = await invoke('providers:getStatus')
      if (this.providers.length === 0) {
        this.providers = snapshot
      }
    } catch {
      // Main process not ready yet — broadcasts will populate once available.
    }
  }

  /** Ask the main process to re-probe all harnesses. */
  async checkAll(): Promise<void> {
    const startedAt = Date.now()
    for (const p of this.providers) this.pendingIds.add(p.id)
    this.providers = this.providers.map((p) => ({
      ...p,
      status: 'checking' as const,
      detail: undefined
    }))

    let results: ProviderConnectionInfo[] = []
    try {
      results = await invoke('providers:checkAll')
    } catch {
      results = this.providers.map((p) => ({
        ...p,
        status: 'error' as const,
        detail: 'IPC call failed'
      }))
    }
    await this.settle(startedAt, results)
  }

  /** Re-probe a single harness by id. */
  async checkOne(id: string): Promise<void> {
    const startedAt = Date.now()
    this.pendingIds.add(id)
    this.providers = this.providers.map((p) =>
      p.id === id ? { ...p, status: 'checking' as const, detail: undefined } : p
    )

    let result: ProviderConnectionInfo | null = null
    try {
      result = await invoke('providers:check', id)
    } catch {
      result = null
    }

    const final = result ?? {
      ...(this.providers.find((p) => p.id === id) as ProviderConnectionInfo),
      status: 'error' as const,
      detail: 'Check failed — IPC unavailable'
    }
    await this.settle(startedAt, [final])
  }

  get availableCount(): number {
    return this.providers.filter((p) => p.status === 'available').length
  }

  get checkingCount(): number {
    return this.providers.filter((p) => p.status === 'checking').length
  }

  get totalCount(): number {
    return this.providers.length
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.initialized = false
    this.pendingIds.clear()
  }

  /** Hold the checking state for a minimum duration, then apply results. */
  private async settle(startedAt: number, results: ProviderConnectionInfo[]): Promise<void> {
    const remaining = MIN_CHECKING_MS - (Date.now() - startedAt)
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining))
    }
    const resultIds = new Set(results.map((r) => r.id))
    this.providers = this.providers.map((p) =>
      resultIds.has(p.id) ? (results.find((r) => r.id === p.id) ?? p) : p
    )
    for (const r of results) this.pendingIds.delete(r.id)
  }
}

export const providerStore = new ProviderStore()
