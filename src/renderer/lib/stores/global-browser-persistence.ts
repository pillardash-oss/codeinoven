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
import { isBrowserTabId } from '$shared/ipc-contract'
import {
  MAX_BROWSER_GROUP_CUSTOM_SVG_LENGTH,
  MAX_BROWSER_GROUP_DESCRIPTION_LENGTH,
  MAX_BROWSER_GROUP_ICON_TYPE_LENGTH,
  MAX_BROWSER_GROUP_IMAGE_PATH_LENGTH,
  MAX_BROWSER_GROUP_NAME_LENGTH,
  MAX_BROWSER_TAB_TITLE_LENGTH,
  MAX_GLOBAL_BROWSER_GROUPS,
  MAX_GLOBAL_BROWSER_TABS,
  type BrowserAppearance,
  type GlobalBrowserGroup,
  type GlobalBrowserTab
} from './global-browser-types'

const GLOBAL_BROWSER_STORAGE_KEY = `${APP_SLUG}.global-browser.v1`
const GROUP_ID_PATTERN = /^group:[a-zA-Z0-9:_-]{1,240}$/u

const COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/u

export interface GlobalBrowserSnapshot {
  tabs: GlobalBrowserTab[]
  groups: GlobalBrowserGroup[]
  activeTabId: string | null
}

/** A bounded optional string, so untrusted storage cannot smuggle a huge value
 *  past a field that only ever holds a short one. */
function parseOptionalString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length <= maxLength ? value : null
}

/** The appearance payload a tab or group persisted, validated field by field. */
function parseAppearance(record: Record<string, unknown>): BrowserAppearance {
  const color = record['color']
  const imagePath = parseOptionalString(record['imagePath'], MAX_BROWSER_GROUP_IMAGE_PATH_LENGTH)
  return {
    color: typeof color === 'string' && COLOR_PATTERN.test(color) ? color : null,
    iconType: parseOptionalString(record['iconType'], MAX_BROWSER_GROUP_ICON_TYPE_LENGTH),
    customSvg: parseOptionalString(record['customSvg'], MAX_BROWSER_GROUP_CUSTOM_SVG_LENGTH),
    imagePath: imagePath && imagePath !== '' ? imagePath : null
  }
}

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
    const description = record['description']
    if (
      typeof id !== 'string' ||
      !GROUP_ID_PATTERN.test(id) ||
      groups.some((candidate) => candidate.id === id) ||
      typeof name !== 'string' ||
      name.trim() === '' ||
      name.length > MAX_BROWSER_GROUP_NAME_LENGTH ||
      (description !== undefined &&
        (typeof description !== 'string' ||
          description.length > MAX_BROWSER_GROUP_DESCRIPTION_LENGTH))
    ) {
      continue
    }
    groups.push({
      id,
      name: name.trim(),
      description: typeof description === 'string' ? description : '',
      pinned: record['pinned'] === true,
      ...parseAppearance(record)
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
    const customTitle = record['customTitle']
    const url = parseUrl(record['url'])
    const groupId = record['groupId']
    const createdAt = record['createdAt']
    const lastUsedAt = record['lastUsedAt']
    const hibernated = record['hibernated']
    const pinnedAt = record['pinnedAt']
    if (
      typeof id !== 'string' ||
      !isBrowserTabId(id) ||
      tabs.some((candidate) => candidate.id === id) ||
      typeof title !== 'string' ||
      title.length > 300 ||
      (customTitle !== undefined &&
        customTitle !== null &&
        (typeof customTitle !== 'string' || customTitle.length > MAX_BROWSER_TAB_TITLE_LENGTH)) ||
      url === null ||
      (groupId !== null && (typeof groupId !== 'string' || !groupIds.has(groupId))) ||
      typeof createdAt !== 'number' ||
      !Number.isSafeInteger(createdAt) ||
      typeof lastUsedAt !== 'number' ||
      !Number.isSafeInteger(lastUsedAt) ||
      typeof hibernated !== 'boolean' ||
      (pinnedAt !== undefined && pinnedAt !== null && typeof pinnedAt !== 'number')
    ) {
      continue
    }
    tabs.push({
      id,
      title,
      customTitle: typeof customTitle === 'string' ? customTitle : null,
      url,
      favicon: null,
      groupId,
      createdAt,
      lastUsedAt,
      // A restored page is never live: the snapshot's own flag is validated but
      // never trusted, because no page survives a restart.
      hibernated: true,
      pinned: record['pinned'] === true,
      pinnedAt: typeof pinnedAt === 'number' ? pinnedAt : null,
      ...parseAppearance(record)
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
          customTitle: tab.customTitle,
          url: tab.url,
          groupId: tab.groupId,
          createdAt: tab.createdAt,
          lastUsedAt: tab.lastUsedAt,
          hibernated: tab.hibernated,
          pinned: tab.pinned,
          pinnedAt: tab.pinnedAt,
          color: tab.color,
          iconType: tab.iconType,
          customSvg: tab.customSvg,
          imagePath: tab.imagePath
        })),
        activeTabId: snapshot.activeTabId
      })
    )
  } catch {
    // Browser restoration is best-effort; blocked storage must not break the view.
  }
}
