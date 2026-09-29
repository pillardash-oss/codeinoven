/**
 * Durable storage for the global browser's tab list.
 *
 * The list is stored by the main process (see `browser:loadTabs` /
 * `browser:saveTabs`), because renderer `localStorage` is scoped to the renderer
 * origin and turns into an empty, process-local storage whenever another app
 * instance already holds the profile's storage database. A browser session on
 * that storage read no tabs, saved none, and the next launch had nothing to
 * restore, with no error raised anywhere.
 *
 * This module is the one place that knows how a runtime tab maps onto the stored
 * shape. It also owns the one-time migration of the old `localStorage` key, so a
 * profile that predates the durable file keeps the tabs it already had.
 */

import { APP_SLUG } from '$shared/brand'
import {
  parseGlobalBrowserTabsSnapshot,
  type GlobalBrowserTabsSnapshot,
  type PersistedBrowserGroup,
  type PersistedBrowserTab
} from '$shared/browser/global-browser-tabs'
import { invoke } from '$lib/ipc.svelte'
import type { GlobalBrowserGroup, GlobalBrowserTab } from './global-browser-types'

/** The renderer `localStorage` key the list used to live in. It is read once, to
 *  migrate a profile that predates the durable file, and then cleared. */
const LEGACY_STORAGE_KEY = `${APP_SLUG}.global-browser.v1`

/** One tab in its stored shape: the live page state (favicon freshness, audio,
 *  capture, loading) describes a running page and is deliberately never stored. */
export function persistedTabFromRuntime(tab: GlobalBrowserTab): PersistedBrowserTab {
  return {
    id: tab.id,
    title: tab.title,
    customTitle: tab.customTitle,
    url: tab.url,
    groupId: tab.groupId,
    createdAt: tab.createdAt,
    lastUsedAt: tab.lastUsedAt,
    hibernated: tab.hibernated,
    pinned: tab.pinned,
    pinnedAt: tab.pinnedAt,
    assistantThreadId: tab.assistantThreadId,
    color: tab.color,
    iconType: tab.iconType,
    customSvg: tab.customSvg,
    imagePath: tab.imagePath
  }
}

export function persistedGroupFromRuntime(group: GlobalBrowserGroup): PersistedBrowserGroup {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    pinned: group.pinned,
    color: group.color,
    iconType: group.iconType,
    customSvg: group.customSvg,
    imagePath: group.imagePath
  }
}

/**
 * One stored tab as the strip reads it.
 *
 * A restored tab is never live: no page survives a restart, so the tab starts
 * hibernated and reloads from its stored address the moment the user visits it.
 * The favicon is dropped with the page it belonged to.
 */
export function runtimeTabFromPersisted(tab: PersistedBrowserTab): GlobalBrowserTab {
  return { ...tab, favicon: null, hibernated: true }
}

export function runtimeGroupFromPersisted(group: PersistedBrowserGroup): GlobalBrowserGroup {
  return { ...group }
}

/** The stored shape of a whole strip. */
export function globalBrowserTabsSnapshot(
  tabs: readonly GlobalBrowserTab[],
  groups: readonly GlobalBrowserGroup[],
  activeTabId: string | null
): GlobalBrowserTabsSnapshot {
  return {
    tabs: tabs.map(persistedTabFromRuntime),
    groups: groups.map(persistedGroupFromRuntime),
    activeTabId
  }
}

/** The stored tab list, or null when this profile has never stored one. A failed
 *  call is reported to the caller rather than swallowed, because a silent failure
 *  here is what used to lose the list. */
export async function loadStoredGlobalBrowserTabs(): Promise<GlobalBrowserTabsSnapshot | null> {
  return await invoke('browser:loadTabs')
}

export async function saveStoredGlobalBrowserTabs(
  snapshot: GlobalBrowserTabsSnapshot
): Promise<void> {
  await invoke('browser:saveTabs', snapshot)
}

/**
 * The tab list left behind by a renderer that stored it in `localStorage`.
 *
 * Read once when the durable file does not exist yet, so an upgrade keeps the
 * tabs the user had open. It is parsed with the same repair rules as the durable
 * file, so an old payload cannot drop a tab on the way in.
 */
export function loadLegacyGlobalBrowserTabs(): GlobalBrowserTabsSnapshot | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return null
    const snapshot = parseGlobalBrowserTabsSnapshot(JSON.parse(raw))
    return snapshot.tabs.length > 0 || snapshot.groups.length > 0 ? snapshot : null
  } catch {
    return null
  }
}

/** Drop the migrated key, so a later launch reads the durable file and never the
 *  stale copy it replaced. */
export function clearLegacyGlobalBrowserTabs(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // A storage that refuses the removal is still read first next launch, where
    // the durable file wins; losing this cleanup costs nothing.
  }
}
