import { invoke } from '$lib/ipc.svelte'
import type {
  AgentPluginDetail,
  AgentPluginMarketEntry,
  AgentPluginMarketplace,
  InstalledAgentPlugin
} from '$shared/types'

/**
 * What the plugin marketplace holds between visits, mirroring the skills
 * marketplace cache: a page of results, icons, details, and the installed set.
 * Every read is shared, so two views asking for the same thing in the same
 * moment start one request instead of two, and coming back to a page paints
 * from memory while a background refresh updates it.
 */

export const PLUGIN_PAGE_SIZE = 40
export type PluginMarketView = 'discover' | 'bookmarks' | 'installed'

export interface AgentPluginPage {
  entries: AgentPluginMarketEntry[]
  hasMore: boolean
}

const pages = new Map<PluginMarketView, AgentPluginPage>()
const pageRequests = new Map<PluginMarketView, Promise<AgentPluginPage>>()
const details = new Map<string, AgentPluginDetail>()
const detailRequests = new Map<string, Promise<AgentPluginDetail>>()
const icons = new Map<string, string | null>()
const iconRequests = new Map<string, Promise<string | null>>()
const DETAIL_CACHE_LIMIT = 100
const ICON_CACHE_LIMIT = 400

let marketplaces: AgentPluginMarketplace[] | null = null
let marketplaceRequest: Promise<AgentPluginMarketplace[]> | null = null
let sourcesRefreshedThisSession = false
let installed: InstalledAgentPlugin[] | null = null
let installedRequest: Promise<InstalledAgentPlugin[]> | null = null

function keepBounded<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  if (!cache.has(key) && cache.size >= limit) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

export function cachedAgentPluginPage(view: PluginMarketView): AgentPluginPage | null {
  return pages.get(view) ?? null
}

/** Return a cached page while one shared refresh replaces it. */
export function refreshAgentPluginPage(view: PluginMarketView): Promise<AgentPluginPage> {
  const pending = pageRequests.get(view)
  if (pending) return pending

  const request = invoke('plugins:list', '', 0, PLUGIN_PAGE_SIZE, view)
    .then((entries) => {
      const page: AgentPluginPage = { entries, hasMore: entries.length === PLUGIN_PAGE_SIZE }
      pages.set(view, page)
      return page
    })
    .finally(() => pageRequests.delete(view))
  pageRequests.set(view, request)
  return request
}

/** Drop the cached pages, for the moment installing something changes them. */
export function invalidateAgentPluginPages(): void {
  pages.clear()
}

export function loadAgentPluginDetail(pluginId: string): Promise<AgentPluginDetail> {
  const cached = details.get(pluginId)
  if (cached) return Promise.resolve(cached)
  const pending = detailRequests.get(pluginId)
  if (pending) return pending

  const request = invoke('plugins:getDetail', pluginId)
    .then((detail) => {
      keepBounded(details, pluginId, detail, DETAIL_CACHE_LIMIT)
      return detail
    })
    .finally(() => detailRequests.delete(pluginId))
  detailRequests.set(pluginId, request)
  return request
}

/** Warm the pages either side of the plugin the user is about to open. */
export async function preloadAgentPluginDetails(ids: readonly string[]): Promise<void> {
  const uncached = ids.filter((id) => !details.has(id))
  for (let index = 0; index < uncached.length; index += 3) {
    await Promise.allSettled(
      uncached.slice(index, index + 3).map((id) => loadAgentPluginDetail(id))
    )
  }
}

export function cachedAgentPluginIcon(pluginId: string): string | null | undefined {
  return icons.get(pluginId)
}

export function loadAgentPluginIcon(pluginId: string): Promise<string | null> {
  const cached = icons.get(pluginId)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = iconRequests.get(pluginId)
  if (pending) return pending

  const request = invoke('plugins:getIcon', pluginId)
    .catch(() => null)
    .then((icon) => {
      // A plugin without an icon is remembered too: one lookup per plugin, and
      // the grid never asks again for a logo the package does not have.
      keepBounded(icons, pluginId, icon, ICON_CACHE_LIMIT)
      return icon
    })
    .finally(() => iconRequests.delete(pluginId))
  iconRequests.set(pluginId, request)
  return request
}

/** Load icons in small batches so a full page never fires all its requests at once. */
export async function preloadAgentPluginIcons(ids: readonly string[]): Promise<void> {
  const uncached = ids.filter((id) => !icons.has(id))
  for (let index = 0; index < uncached.length; index += 4) {
    await Promise.allSettled(uncached.slice(index, index + 4).map((id) => loadAgentPluginIcon(id)))
  }
}

/**
 * Whether the first open of the plugin marketplace in this app run should re-read
 * every source catalog. A stored catalog is what the pages list from, so a source
 * whose catalog was never fetched would show an empty marketplace until Refresh.
 */
export function shouldRefreshSourcesOnOpen(): boolean {
  if (sourcesRefreshedThisSession) return false
  sourcesRefreshedThisSession = true
  return true
}

export function cachedAgentPluginMarketplaces(): AgentPluginMarketplace[] | null {
  return marketplaces
}

export function refreshAgentPluginMarketplaces(): Promise<AgentPluginMarketplace[]> {
  if (marketplaceRequest) return marketplaceRequest
  const request = invoke('plugins:listMarketplaces')
    .then((list) => {
      marketplaces = list
      return list
    })
    .finally(() => {
      marketplaceRequest = null
    })
  marketplaceRequest = request
  return request
}

export function cachedInstalledAgentPlugins(): InstalledAgentPlugin[] | null {
  return installed
}

export function refreshInstalledAgentPlugins(): Promise<InstalledAgentPlugin[]> {
  if (installedRequest) return installedRequest
  const request = invoke('plugins:listInstalled')
    .then((list) => {
      installed = list
      return list
    })
    .finally(() => {
      installedRequest = null
    })
  installedRequest = request
  return request
}

/** An install changes what every page shows, so all shared reads are dropped. */
export async function invalidateAgentPluginMarket(pluginId?: string): Promise<void> {
  pages.clear()
  if (pluginId) details.delete(pluginId)
  await refreshInstalledAgentPlugins().catch(() => undefined)
}
