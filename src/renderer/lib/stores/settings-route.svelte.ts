import type { SkillMarketEntry } from '$shared/types'

/** Section tabs of the Utilities catalog. */
export type UtilitiesTab = 'all' | 'skills' | 'bookmarks' | 'mcp' | 'plugins' | 'web' | 'tools'

/** A page inside the Utilities settings section. Recorded by the global history. */
export type UtilitiesRoute =
  | { page: 'catalog'; tab: UtilitiesTab }
  | { page: 'marketplace' }
  | { page: 'plugins-marketplace' }
  | { page: 'plugin'; pluginId: string }
  | { page: 'skill'; entry: SkillMarketEntry }

const CATALOG_ROUTE: UtilitiesRoute = { page: 'catalog', tab: 'all' }

export function sameUtilitiesRoute(a: UtilitiesRoute | null, b: UtilitiesRoute | null): boolean {
  if (a === null || b === null) return a === b
  if (a.page !== b.page) return false
  if (a.page === 'catalog' && b.page === 'catalog') return a.tab === b.tab
  if (a.page === 'plugin' && b.page === 'plugin') return a.pluginId === b.pluginId
  if (a.page === 'skill' && b.page === 'skill') return a.entry.id === b.entry.id
  return true
}

/**
 * The Utilities sub-page on screen. It lives here, not inside the settings view,
 * so the app-wide back/forward history can record and restore it.
 */
class SettingsRouteState {
  utilities: UtilitiesRoute = $state(CATALOG_ROUTE)
  /** The marketplace stays mounted once opened, so Back restores its results. */
  marketplaceMounted = $state(false)
  /** Set by the shell: records a Utilities page change in the navigation history. */
  onUtilitiesChange: (() => void) | null = null

  /** Show a Utilities page and record it in the navigation history. */
  showUtilities(route: UtilitiesRoute): void {
    this.setRoute(route)
    this.onUtilitiesChange?.()
  }

  /** Return to the catalog when the settings section changes. Not recorded by itself. */
  resetUtilities(): void {
    this.setRoute(CATALOG_ROUTE)
    this.marketplaceMounted = false
  }

  private setRoute(route: UtilitiesRoute): void {
    this.utilities = route
    if (route.page === 'marketplace') this.marketplaceMounted = true
  }
}

export const settingsRouteState = new SettingsRouteState()
