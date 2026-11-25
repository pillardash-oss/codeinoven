import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import type {
  AgentAccountUsage,
  AgentAccountUsageOverrides,
  AgentRateLimitWindow
} from '$shared/types'

/** Quota is fetched on battery hover and cached briefly so rapid re-hovers
 *  don't hammer the harness CLIs. */
export const ACCOUNT_USAGE_CACHE_MS = 5000
/** Fast drivers (pi answers over an in-memory RPC session in a few ms)
 *  would make the loading bar flash imperceptibly, reading as "nothing
 *  happened". Hold the fetching state briefly so the hover always gives
 *  the same visible feedback the slower harness CLIs produce naturally. */
export const ACCOUNT_USAGE_MIN_LOADING_MS = 800

/** The shoe's background reads start a harness process, so an account gets one a minute at most. */
export const ACCOUNT_USAGE_AUTO_REFRESH_MS = 60_000
/** Lets a thread paint and settle before a background read starts. */
const AUTO_REFRESH_SETTLE_MS = 1_500

function accountKey(request: AgentAccountUsageOverrides): string {
  const { harnessId, providerId, accountId, ovenId } = request
  return JSON.stringify([harnessId, providerId, accountId, ovenId])
}

// Quota belongs to the account, so every thread on it shares the last good
// reading, the request in flight and the background throttle.
const latestLimits = new SvelteMap<string, AgentRateLimitWindow[]>()
// These two are bookkeeping an effect reads: reactive maps would re-run the
// refresh effect on every read it starts, turning it into a poll.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const requestedAt = new Map<string, number>()
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const inflight = new Map<string, Promise<AgentAccountUsage[]>>()

/** The account's last successful reading; a failed read never clears it. */
export function accountLimits(
  request: AgentAccountUsageOverrides
): AgentRateLimitWindow[] | undefined {
  return latestLimits.get(accountKey(request))
}

/** Milliseconds until the account is due another background read. */
export function accountRefreshDelay(request: AgentAccountUsageOverrides): number {
  const last = requestedAt.get(accountKey(request)) ?? 0
  return Math.max(AUTO_REFRESH_SETTLE_MS, last + ACCOUNT_USAGE_AUTO_REFRESH_MS - Date.now())
}

function remember(request: AgentAccountUsageOverrides, list: AgentAccountUsage[]): void {
  const reading = list.find(
    (usage) => usage.harnessId === request.harnessId && usage.providerId === request.providerId
  )
  if (reading?.rateLimits.length) latestLimits.set(accountKey(request), reading.rateLimits)
}

function fetchUsage(request: AgentAccountUsageOverrides): Promise<AgentAccountUsage[]> {
  const key = JSON.stringify(request)
  const existing = inflight.get(key)
  if (existing) return existing
  requestedAt.set(accountKey(request), Date.now())
  const read = invoke('agent:refreshAccountUsage', request)
    .then((list) => {
      if (Array.isArray(list)) remember(request, list)
      return list
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, read)
  return read
}

/**
 * Shared hover-revealed account-quota cache — the single pipeline behind the
 * usage battery in every conversation surface (project threads, inbox chats,
 * temporary chats, and the new-chat composer). Account usage is provider-level
 * account state, independent of any thread or conversation context, so every
 * host asks the same channel for the harness/provider it is showing and gets
 * the same answer. One cache instance per host component; the fetch, TTL,
 * refresh-guard, and loading feedback are identical everywhere by construction.
 */
export function createAccountUsageCache() {
  let usage = $state<AgentAccountUsage[]>([])
  let pending = $state(0)
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
    overrides: AgentAccountUsageOverrides,
    isStaleRequest?: () => boolean
  ): Promise<AgentAccountUsage[]> {
    pending += 1
    try {
      const usageList = await fetchUsage(overrides)
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
      pending -= 1
    }
  }

  /** Replace the cached snapshot outright (e.g. after a banked reset).
   *  Counts as freshly fetched so the next hover inside the TTL reuses it. */
  function replaceUsage(next: AgentAccountUsage[], request: AgentAccountUsageOverrides): void {
    remember(request, next)
    usage = next
    fetchedAt = Date.now()
  }

  return {
    get usage() {
      return usage
    },
    get refreshing() {
      return pending > 0
    },
    isStale,
    markStale,
    refresh,
    replaceUsage
  }
}
