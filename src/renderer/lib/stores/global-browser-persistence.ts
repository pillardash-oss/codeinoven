/**
 * Persistence for the global browser workspace.
 *
 * Only the tab list, its groups, and which tab was last active are stored. Live
 * page state (loading, audio, capture, favicon freshness) describes a running
 * page and is deliberately never written: after a restart the pages are gone
 * and every restored tab is hibernated until the user visits it.
 *
 * Every field is validated on read, because this is untrusted storage that any
 * renderer script could have written. A snapshot that fails validation is
 * dropped rather than partially trusted.
 */

import { APP_SLUG } from '$shared/brand'
import {
  BROWSER_GROUP_COLORS,
  MAX_BROWSER_GROUP_NAME_LENGTH,
  MAX_GLOBAL_BROWSER_GROUPS,
  MAX_GLOBAL_BROWSER_TABS,
  isBrowserGroupIconId,
  type GlobalBrowserGroup,
  type GlobalBrowserTab
} from './global-browser-types'

const GLOBAL_BROWSER_STORAGE_KEY = `${APP_SLUG}.global-browser.v1`
const TAB_ID_PATTERN = /^browser:[a-zA-Z0-9:_-]{1,240}$/u
const GROUP_ID_PATTERN = /^group:[a-zA-Z0-9:_-]{1,240}$/u

export interface GlobalBrowserSnapshot {
  tabs: GlobalBrowserTab[]
  groups: GlobalBrowserGroup[]
  activeTabId: string | null
}

const COLOR_IDS = new Set(BROWSER_GROUP_COLORS.map((entry) => entry.id))

function emptySnapshot(): GlobalBrowserSnapshot {
  return { tabs: [], groups: [], activeTabId: null }
}

function parseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value === '') return ''
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username !== '' || parsed.password !== '') return null
    return parsed.href
  } catch {
    return null
  }
}

function parseGroups(value: unknown): GlobalBrowserGroup[] {
  if (!Array.isArray(value)) return []
  const groups: GlobalBrowserGroup[] = []
  for (const entry of value) {
    if (groups.length >= MAX_GLOBAL_BROWSER_GROUPS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const id = record['id']
    const name = record['name']
    const color = record['color']
    const icon = record['icon']
    if (
      typeof id !== 'string' ||
      !GROUP_ID_PATTERN.test(id) ||
      groups.some((candidate) => candidate.id === id) ||
      typeof name !== 'string' ||
      name.trim() === '' ||
      name.length > MAX_BROWSER_GROUP_NAME_LENGTH ||
      typeof color !== 'string' ||
      !COLOR_IDS.has(color)
    ) {
      continue
    }
    groups.push({
      id,
      name: name.trim(),
      color,
      icon: typeof icon === 'string' && isBrowserGroupIconId(icon) ? icon : null
    })
  }
  return groups
}

function parseTabs(value: unknown, groups: readonly GlobalBrowserGroup[]): GlobalBrowserTab[] {
  if (!Array.isArray(value)) return []
  const groupIds = new Set(groups.map((group) => group.id))
  const tabs: GlobalBrowserTab[] = []
  for (const entry of value) {
    if (tabs.length >= MAX_GLOBAL_BROWSER_TABS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const id = record['id']
    const title = record['title']
    const url = parseUrl(record['url'])
    const groupId = record['groupId']
    const createdAt = record['createdAt']
    const lastUsedAt = record['lastUsedAt']
    const hibernated = record['hibernated']
    if (
      typeof id !== 'string' ||
      !TAB_ID_PATTERN.test(id) ||
      tabs.some((candidate) => candidate.id === id) ||
      typeof title !== 'string' ||
      title.length > 300 ||
      url === null ||
      (groupId !== null && (typeof groupId !== 'string' || !groupIds.has(groupId))) ||
      typeof createdAt !== 'number' ||
      !Number.isSafeInteger(createdAt) ||
      typeof lastUsedAt !== 'number' ||
      !Number.isSafeInteger(lastUsedAt) ||
      typeof hibernated !== 'boolean'
    ) {
      continue
    }
    tabs.push({
      id,
      title,
      url,
      favicon: null,
      groupId,
      createdAt,
      lastUsedAt,
      // A restored page is never live: the snapshot's own flag is validated but
      // never trusted, because no page survives a restart.
      hibernated: true
    })
  }
  return tabs
}

/** The persisted snapshot, or an empty one when nothing valid was stored. */
export function loadGlobalBrowserSnapshot(): GlobalBrowserSnapshot {
  if (typeof window === 'undefined') return emptySnapshot()
  try {
    const raw = window.localStorage.getItem(GLOBAL_BROWSER_STORAGE_KEY)
    if (!raw) return emptySnapshot()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptySnapshot()
    const record = parsed as Record<string, unknown>
    const groups = parseGroups(record['groups'])
    const tabs = parseTabs(record['tabs'], groups)
    const activeId = record['activeTabId']
    const activeTabId =
      typeof activeId === 'string' && tabs.some((tab) => tab.id === activeId) ? activeId : null
    return { tabs, groups, activeTabId }
  } catch {
    return emptySnapshot()
  }
}

export function persistGlobalBrowserSnapshot(snapshot: GlobalBrowserSnapshot): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      GLOBAL_BROWSER_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        groups: snapshot.groups,
        tabs: snapshot.tabs.map((tab) => ({
          id: tab.id,
          title: tab.title,
          url: tab.url,
          groupId: tab.groupId,
          createdAt: tab.createdAt,
          lastUsedAt: tab.lastUsedAt,
          hibernated: tab.hibernated
        })),
        activeTabId: snapshot.activeTabId
      })
    )
  } catch {
    // Browser restoration is best-effort; blocked storage must not break the view.
  }
}
