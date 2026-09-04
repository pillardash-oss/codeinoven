import { invoke } from '$lib/ipc.svelte'
import type { AgentAccountUsage, AgentAccountUsageOverrides } from '$shared/types'

/** Quota is fetched on battery hover and cached briefly so rapid re-hovers
 *  don't hammer the harness CLIs. */
export const ACCOUNT_USAGE_CACHE_MS = 5000
/** Fast drivers (pi answers over an in-memory RPC session in a few ms)
 *  would make the loading bar flash imperceptibly, reading as "nothing
 *  happened". Hold the fetching state briefly so the hover always gives
 *  the same visible feedback the slower harness CLIs produce naturally. */
export const ACCOUNT_USAGE_MIN_LOADING_MS = 800

export interface AccountUsageRequest {
  projectId: string
  /** Thread id, temporary chat id, or a stable pseudo id (e.g. `new-chat`). */
  threadId: string
  /** Harness/provider to answer for when no thread row or live temporary
   *  session exists yet — the same telemetry chain runs regardless. */
  overrides?: AgentAccountUsageOverrides
}

/**
 * Shared hover-revealed account-quota cache — the single pipeline behind the
 * usage battery in every conversation surface (project threads, inbox chats,
 * temporary chats, and the new-chat composer). One cache instance per host
 * component; the fetch, TTL, refresh-guard, and loading feedback are identical
 * everywhere by construction.
 */
export function createAccountUsageCache() {
  let usage = $state<AgentAccountUsage[]>([])
  let refreshing = $state(false)
  let fetchedAt = 0

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** True when the cached snapshot is missing or older than the TTL. */
  function isStale(): boolean {
    return usage.length === 0 || fetchedAt === 0 || Date.now() - fetchedAt > ACCOUNT_USAGE_CACHE_MS
  }

  /** Called when the user stops hovering the usage indicator. Resets the
   *  quota cache so the *next* hover always fetches fresh data — while the
   *  user keeps hovering, no further fetch is scheduled. */
  function markStale(): void {
    fetchedAt = 0
  }

  /**
   * Fetch live quota through the same on-demand channel every surface uses.
   * Returns the fetched list (empty on failure) so hosts can merge it into
   * their own display state. `isStaleRequest` lets a host reject an
   * out-of-order resolve after the user switched harness or conversation.
   */
  async function refresh(
    request: AccountUsageRequest,
    isStaleRequest?: () => boolean
  ): Promise<AgentAccountUsage[]> {
    if (refreshing) return []
    refreshing = true
    try {
      const usageList = await invoke(
        'agent:refreshAccountUsage',
        request.projectId,
        request.threadId,
        request.overrides
      )
      // Guard against a stale/partial main process resolving the call with a
      // non-array; an undefined `usage` crashes any derived reading it.
      if (!Array.isArray(usageList)) return []
      if (isStaleRequest?.()) return []
      usage = usageList
      fetchedAt = Date.now()
      return usageList
    } catch {
      // Best-effort quota refresh — never surface a transient harness failure.
      return []
    } finally {
      const elapsed = Date.now() - fetchedAt
      const wait = Math.max(0, ACCOUNT_USAGE_MIN_LOADING_MS - elapsed)
      if (wait > 0) await delay(wait)
      refreshing = false
    }
  }

  /** Replace the cached snapshot outright (e.g. after a banked reset).
   *  Counts as freshly fetched so the next hover inside the TTL reuses it. */
  function replaceUsage(next: AgentAccountUsage[]): void {
    usage = next
    fetchedAt = Date.now()
  }

  return {
    get usage() {
      return usage
    },
    get refreshing() {
      return refreshing
    },
    isStale,
    markStale,
    refresh,
    replaceUsage
  }
}
