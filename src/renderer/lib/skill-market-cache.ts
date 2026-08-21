import { invoke } from '$lib/ipc.svelte'
import type { SkillMarketDetail, SkillMarketLeaderboard, SkillMarketView } from '$shared/types'

const details = new Map<string, SkillMarketDetail>()
const requests = new Map<string, Promise<SkillMarketDetail>>()
const leaderboards = new Map<SkillMarketView, SkillMarketLeaderboard>()
const leaderboardRequests = new Map<SkillMarketView, Promise<SkillMarketLeaderboard>>()
const DETAIL_CACHE_LIMIT = 100

function cacheDetail(id: string, detail: SkillMarketDetail): void {
  if (!details.has(id) && details.size >= DETAIL_CACHE_LIMIT) {
    const oldestId = details.keys().next().value
    if (oldestId) details.delete(oldestId)
  }
  details.set(id, detail)
}

export function cachedSkillMarketDetail(id: string): SkillMarketDetail | null {
  return details.get(id) ?? null
}

export function cachedSkillMarketLeaderboard(view: SkillMarketView): SkillMarketLeaderboard | null {
  return leaderboards.get(view) ?? null
}

/** Return cached leaderboard data immediately while one shared refresh updates it. */
export function refreshSkillMarketLeaderboard(
  view: SkillMarketView
): Promise<SkillMarketLeaderboard> {
  const pending = leaderboardRequests.get(view)
  if (pending) return pending

  const request = invoke('utilities:listSkillMarket', view)
    .then((leaderboard) => {
      leaderboards.set(view, leaderboard)
      return leaderboard
    })
    .finally(() => leaderboardRequests.delete(view))
  leaderboardRequests.set(view, request)
  return request
}

export function loadSkillMarketDetail(id: string): Promise<SkillMarketDetail> {
  const cached = details.get(id)
  if (cached) return Promise.resolve(cached)
  const pending = requests.get(id)
  if (pending) return pending

  const request = invoke('utilities:getSkillMarketDetail', id)
    .then((detail) => {
      cacheDetail(id, detail)
      return detail
    })
    .finally(() => requests.delete(id))
  requests.set(id, request)
  return request
}

export async function preloadSkillMarketDetails(ids: readonly string[]): Promise<void> {
  const uncached = ids.filter((id) => !details.has(id))
  const concurrency = 3
  for (let index = 0; index < uncached.length; index += concurrency) {
    const batch = uncached.slice(index, index + concurrency)
    await Promise.allSettled(batch.map((id) => loadSkillMarketDetail(id)))
  }
}
