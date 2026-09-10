import { invoke } from '$lib/ipc.svelte'
import type { HarnessAccount } from '$shared/types'

const ACCOUNT_CACHE_MS = 5_000

interface CachedAccounts {
  accounts: HarnessAccount[]
  expiresAt: number
}

class HarnessAccountCache {
  private readonly cache = new Map<string, CachedAccounts>()
  private readonly inflight = new Map<string, Promise<HarnessAccount[]>>()

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

  invalidate(harnessId?: string): void {
    if (harnessId) this.cache.delete(harnessId)
    else this.cache.clear()
  }
}

export const harnessAccountCache = new HarnessAccountCache()
