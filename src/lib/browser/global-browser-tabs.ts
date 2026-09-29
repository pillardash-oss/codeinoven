/**
 * The global browser's durable tab list: one bounded shape both processes agree on.
 *
 * The list used to live only in the renderer's `localStorage`, which is scoped to
 * the renderer origin and is silently unavailable whenever another app instance
 * already holds the profile's storage database. A second instance then reads an
 * empty list, writes nothing, and the user's tabs are gone on the next launch
 * without a single error being raised. The list is app-owned state, so it now
 * lives in the config directory through the atomic storage engine and is read and
 * written over the IPC contract, exactly like every other durable record.
 *
 * Every field is still treated as untrusted input: it arrives from a renderer, or
 * from a file any process could have written. Unlike a plain rejection, the parse
 * here *repairs*: a tab with an unusable field keeps its row (with that field
 * bounded or cleared) instead of disappearing, because silently dropping a stored
 * tab is exactly the data loss this module exists to prevent.
 */

import { isBrowserTabId } from '../ipc/browser'

/** Where the durable tab list lives, relative to the config root. */
export const GLOBAL_BROWSER_TABS_STATE_RELATIVE_PATH = 'state/global-browser-tabs.json'

/** Bumped only if the stored shape changes incompatibly. */
export const GLOBAL_BROWSER_TABS_SNAPSHOT_VERSION = 1

/** Group names, tab titles and descriptions are bounded the way thread titles are. */
export const MAX_BROWSER_GROUP_NAME_LENGTH = 60
export const MAX_BROWSER_GROUP_DESCRIPTION_LENGTH = 240
export const MAX_BROWSER_TAB_TITLE_LENGTH = 120
/** A page's own title is not a label the user typed, so it gets a wider bound. */
export const MAX_BROWSER_TAB_PAGE_TITLE_LENGTH = 300
export const MAX_GLOBAL_BROWSER_TABS = 100
export const MAX_GLOBAL_BROWSER_GROUPS = 40
/** Bounds for the appearance payload a group or tab may persist. The SVG ceiling
 *  matches `sanitizeCustomSvg`, so a stored value can only be one it accepted. */
export const MAX_BROWSER_GROUP_ICON_TYPE_LENGTH = 64
export const MAX_BROWSER_GROUP_CUSTOM_SVG_LENGTH = 16_384
export const MAX_BROWSER_GROUP_IMAGE_PATH_LENGTH = 2_048
export const MAX_BROWSER_TAB_URL_LENGTH = 2_048
/** A thread id is a generated UUID, so the bound is generous but still finite. */
export const MAX_BROWSER_ASSISTANT_THREAD_ID_LENGTH = 64

const GROUP_ID_PATTERN = /^group:[a-zA-Z0-9:_-]{1,240}$/u
const COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/u
/** The character class every generated id uses; anything else is not an id. */
const ENTITY_ID_PATTERN = /^[a-zA-Z0-9:_-]+$/u

/**
 * The appearance vocabulary a browser tab and a browser group share, copied
 * from the project/routine model: a hex colour, a `PROJECT_SVG_ICONS` key, a
 * sanitized custom SVG, and a picked image file. One shape means one editor and
 * one icon resolver for every browser surface that carries an identity.
 */
export interface BrowserAppearance {
  /** A `PROJECT_COLORS` hex, or a custom hex, or null for no colour. */
  color: string | null
  /** A `PROJECT_SVG_ICONS` key, or null. */
  iconType: string | null
  /** A sanitized pasted SVG, or null. */
  customSvg: string | null
  /** Absolute path of a picked image file, read to a data URL for display. */
  imagePath: string | null
}

/** One fold of tabs as it is stored. */
export interface PersistedBrowserGroup extends BrowserAppearance {
  id: string
  name: string
  description: string
  pinned: boolean
}

/** One tab as it is stored. The live page state (loading, audio, favicon
 *  freshness) describes a running page and is deliberately absent. */
export interface PersistedBrowserTab extends BrowserAppearance {
  id: string
  title: string
  customTitle: string | null
  url: string
  groupId: string | null
  createdAt: number
  lastUsedAt: number
  hibernated: boolean
  pinned: boolean
  pinnedAt: number | null
  /**
   * The assistant conversation bound to this tab: a real thread in the reserved
   * hidden browser project, or null while the tab has never asked the agent
   * anything. It is stored on the tab because that is the lifetime the user
   * agreed to: the conversation lives exactly as long as the tab that owns it,
   * and a restart restores both.
   */
  assistantThreadId: string | null
}

/** The durable tab list: the tabs, their folds, and which tab was on screen. */
export interface GlobalBrowserTabsSnapshot {
  tabs: PersistedBrowserTab[]
  groups: PersistedBrowserGroup[]
  activeTabId: string | null
}

function emptySnapshot(): GlobalBrowserTabsSnapshot {
  return { tabs: [], groups: [], activeTabId: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A bounded string, or the fallback when the stored value is not one. Repairing
 *  the field keeps the record it belongs to, which is the whole point. */
function boundedString(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

/** A bounded string that is `null` when it is missing or empty. */
function boundedOptionalString(value: unknown, maxLength: number): string | null {
  const text = boundedString(value, maxLength)
  return text === '' ? null : text
}

/** A safe integer, or the fallback when the stored value is not one. */
function safeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

/** A bounded optional integer, or null. */
function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

/** One identity that can be addressed as a tab, synthesised only when the stored
 *  one is unusable. A tab id keys its note and its agent chat, so a repaired id
 *  is a last resort, never a routine path. */
function browserTabId(value: unknown): string {
  return isBrowserTabId(value) ? value : `browser:${crypto.randomUUID()}`
}

/**
 * The agent-chat thread id one browser tab owns.
 *
 * A tab's conversation is a real thread in the hidden browser project, and its
 * workspace is `browser-cwd/<thread id>`, so the id is derived from the tab id
 * rather than minted at random: the tab and its conversation then name one
 * directory, and a conversation recreated for the same tab lands in the same
 * place. A tab id carries a colon, which is not a legal path segment on Windows,
 * so every character outside the safe id set is replaced.
 */
export function browserAssistantThreadId(tabId: string): string {
  return tabId.replace(/[^A-Za-z0-9._-]/gu, '-')
}

/** A stored assistant thread id, or null when the field is absent or unusable.
 *  A repaired field here costs one conversation: the tab simply asks the agent
 *  again and gets a fresh thread, so this never fabricates an id. */
function assistantThreadId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value === '' || value.length > MAX_BROWSER_ASSISTANT_THREAD_ID_LENGTH) return null
  return ENTITY_ID_PATTERN.test(value) ? value : null
}

function groupId(value: unknown): string {
  return typeof value === 'string' && GROUP_ID_PATTERN.test(value)
    ? value
    : `group:${crypto.randomUUID()}`
}

function parseAppearance(record: Record<string, unknown>): BrowserAppearance {
  const color = record['color']
  return {
    color: typeof color === 'string' && COLOR_PATTERN.test(color) ? color : null,
    iconType: boundedOptionalString(record['iconType'], MAX_BROWSER_GROUP_ICON_TYPE_LENGTH),
    customSvg: boundedOptionalString(record['customSvg'], MAX_BROWSER_GROUP_CUSTOM_SVG_LENGTH),
    imagePath: boundedOptionalString(record['imagePath'], MAX_BROWSER_GROUP_IMAGE_PATH_LENGTH)
  }
}

/**
 * A stored address the browser may actually load, or an empty address for a tab
 * that has no committed page. Anything else (an `about:blank` popup document, a
 * `javascript:` string, a truncated URL) becomes the blank address the strip
 * already renders as a new tab, so the row is never lost over its address.
 */
function parseAddress(value: unknown): string {
  if (typeof value !== 'string') return ''
  if (value === '') return ''
  if (value.length > MAX_BROWSER_TAB_URL_LENGTH) return ''
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (parsed.username !== '' || parsed.password !== '') return ''
    return parsed.href
  } catch {
    return ''
  }
}

function parseGroups(value: unknown): PersistedBrowserGroup[] {
  if (!Array.isArray(value)) return []
  const groups: PersistedBrowserGroup[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (groups.length >= MAX_GLOBAL_BROWSER_GROUPS) break
    if (!isRecord(entry)) continue
    let id = groupId(entry['id'])
    while (seen.has(id)) id = groupId(null)
    seen.add(id)
    const name = boundedString(entry['name'], MAX_BROWSER_GROUP_NAME_LENGTH).trim()
    groups.push({
      id,
      name: name === '' ? 'Group' : name,
      description: boundedString(entry['description'], MAX_BROWSER_GROUP_DESCRIPTION_LENGTH),
      pinned: entry['pinned'] === true,
      ...parseAppearance(entry)
    })
  }
  return groups
}

/**
 * Restore the tabs, bounded to the strip's cap, in stored order.
 *
 * Tabs keep their stored order because the strip's order is the user's own: a
 * repaired field must never reshuffle what they arranged.
 */
function parseTabs(
  value: unknown,
  groups: readonly PersistedBrowserGroup[]
): PersistedBrowserTab[] {
  if (!Array.isArray(value)) return []
  const groupIds = new Set(groups.map((group) => group.id))
  const tabs: PersistedBrowserTab[] = []
  const seen = new Set<string>()
  const now = Date.now()
  for (const entry of value) {
    if (tabs.length >= MAX_GLOBAL_BROWSER_TABS) break
    if (!isRecord(entry)) continue
    let id = browserTabId(entry['id'])
    while (seen.has(id)) id = browserTabId(null)
    seen.add(id)
    const createdAt = safeInteger(entry['createdAt'], now)
    const customTitle = boundedOptionalString(entry['customTitle'], MAX_BROWSER_TAB_TITLE_LENGTH)
    const storedGroupId = entry['groupId']
    const pinned = entry['pinned'] === true
    tabs.push({
      id,
      title: boundedString(entry['title'], MAX_BROWSER_TAB_PAGE_TITLE_LENGTH),
      customTitle: customTitle === null ? null : customTitle.trim() || null,
      url: parseAddress(entry['url']),
      groupId:
        typeof storedGroupId === 'string' && groupIds.has(storedGroupId) ? storedGroupId : null,
      createdAt,
      lastUsedAt: safeInteger(entry['lastUsedAt'], createdAt),
      hibernated: entry['hibernated'] === true,
      pinned,
      pinnedAt: pinned ? (optionalInteger(entry['pinnedAt']) ?? createdAt) : null,
      assistantThreadId: assistantThreadId(entry['assistantThreadId']),
      ...parseAppearance(entry)
    })
  }
  return tabs
}

/**
 * A bounded, repaired view of anything that claims to be a stored tab list.
 *
 * This never fails and never returns null: a value that is not a snapshot at all
 * parses to an empty one, and a value that is one keeps every tab it describes.
 */
export function parseGlobalBrowserTabsSnapshot(value: unknown): GlobalBrowserTabsSnapshot {
  if (!isRecord(value)) return emptySnapshot()
  const groups = parseGroups(value['groups'])
  const tabs = parseTabs(value['tabs'], groups)
  const activeTabId = value['activeTabId']
  return {
    tabs,
    groups,
    activeTabId:
      typeof activeTabId === 'string' && tabs.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : null
  }
}

/**
 * The JSON payload for the durable file: the snapshot, stamped with the moment it
 * was written and the shape it was written in, so a reader can tell a stale file
 * from a corrupt one without guessing.
 */
export function globalBrowserTabsSnapshotPayload(
  snapshot: GlobalBrowserTabsSnapshot
): Record<string, unknown> {
  return {
    version: GLOBAL_BROWSER_TABS_SNAPSHOT_VERSION,
    updatedAt: new Date().toISOString(),
    groups: snapshot.groups,
    tabs: snapshot.tabs,
    activeTabId: snapshot.activeTabId
  }
}
