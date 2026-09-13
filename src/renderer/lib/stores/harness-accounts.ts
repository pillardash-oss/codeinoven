import { invoke } from '$lib/ipc.svelte'
import type { HarnessAccount } from '$shared/types'
import { SvelteMap } from 'svelte/reactivity'

const ACCOUNT_CACHE_MS = 5 * 60 * 1000
const ACCOUNT_REFRESH_BATCH_SIZE = 4

interface CachedAccounts {
  accounts: HarnessAccount[]
  expiresAt: number
}

class HarnessAccountCache {
  private readonly cache = new SvelteMap<string, CachedAccounts>()
  private readonly inflight = new Map<string, Promise<HarnessAccount[]>>()
  private warmInflight: Promise<HarnessAccount[]> | null = null

  cached(harnessId: string): HarnessAccount[] | undefined {
    return this.cache.get(harnessId)?.accounts
  }

  list(harnessId: string, force = false): Promise<HarnessAccount[]> {
    const cached = this.cache.get(harnessId)
    if (!force && cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.accounts)
    const pending = this.inflight.get(harnessId)
    if (pending) return pending
    const request = invoke('providerAccounts:list', harnessId)
      .then((accounts) => {
        this.cache.set(harnessId, { accounts, expiresAt: Date.now() + ACCOUNT_CACHE_MS })
        return accounts
      })
      .finally(() => this.inflight.delete(harnessId))
    this.inflight.set(harnessId, request)
    return request
  }

  /** Seed every harness from the persisted registry in one inexpensive IPC read. */
  warm(): Promise<HarnessAccount[]> {
    if (this.warmInflight) return this.warmInflight
    const request = invoke('providerAccounts:list')
      .then((accounts) => {
        const harnessIds = new Set(accounts.map((account) => account.harnessId))
        for (const harnessId of harnessIds) {
          this.cache.set(harnessId, {
            accounts: accounts.filter((account) => account.harnessId === harnessId),
            expiresAt: Date.now() + ACCOUNT_CACHE_MS
          })
        }
        return accounts
      })
      .finally(() => {
        if (this.warmInflight === request) this.warmInflight = null
      })
    this.warmInflight = request
    return request
  }

  /** Reconcile account registries whenever the matching model catalogs refresh. */
  async refreshHarnesses(harnessIds: Iterable<string>): Promise<void> {
    const targets = [...new Set(harnessIds)]
    for (let offset = 0; offset < targets.length; offset += ACCOUNT_REFRESH_BATCH_SIZE) {
      await Promise.all(
        targets
          .slice(offset, offset + ACCOUNT_REFRESH_BATCH_SIZE)
          .map((harnessId) => this.list(harnessId, true).catch(() => []))
      )
    }
  }

  invalidate(harnessId?: string): void {
    if (harnessId) this.cache.delete(harnessId)
    else this.cache.clear()
  }
}

export const harnessAccountCache = new HarnessAccountCache()
