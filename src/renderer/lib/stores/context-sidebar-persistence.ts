import { APP_SLUG } from '$shared/brand'
import type { BrowserContextTab, TerminalPlacement } from './context-sidebar-types'

const TERMINAL_PLACEMENT_STORAGE_KEY = `${APP_SLUG}.terminal-placement.v1`
const BROWSER_TABS_STORAGE_KEY = `${APP_SLUG}.browser-tabs.v1`
const MAX_PERSISTED_BROWSER_TABS = 50
const BROWSER_TAB_ID_PATTERN = /^browser:[a-zA-Z0-9:_-]{1,240}$/u

export function loadTerminalPlacement(): TerminalPlacement {
  if (typeof window === 'undefined') return 'right'
  try {
    const raw = window.localStorage.getItem(TERMINAL_PLACEMENT_STORAGE_KEY)
    return raw === 'bottom' ? 'bottom' : 'right'
  } catch {
    return 'right'
  }
}

export function saveTerminalPlacement(placement: TerminalPlacement): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(TERMINAL_PLACEMENT_STORAGE_KEY, placement)
  } catch {
    // Terminal placement is cosmetic; unavailable storage must not break the app.
  }
}

/** Restored browser tab list plus which tab was last active. The active id is
 *  validated against the restored tabs so a stale id can never win. */
export function loadPersistedBrowserTabs(): {
  tabs: BrowserContextTab[]
  activeTabId: string | null
} {
  const empty: { tabs: BrowserContextTab[]; activeTabId: string | null } = {
    tabs: [],
    activeTabId: null
  }
  if (typeof window === 'undefined') return empty
  try {
    const raw = window.localStorage.getItem(BROWSER_TABS_STORAGE_KEY)
    if (!raw) return empty
    const snapshot: unknown = JSON.parse(raw)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return empty
    const record = snapshot as Record<string, unknown>
    const tabs = loadBrowserTabs(record)
    const activeId = record['activeTabId']
    const activeTabId =
      typeof activeId === 'string' && BROWSER_TAB_ID_PATTERN.test(activeId) ? activeId : null
    return { tabs, activeTabId: tabs.some((tab) => tab.id === activeTabId) ? activeTabId : null }
  } catch {
    return empty
  }
}

function loadBrowserTabs(snapshot: Record<string, unknown>): BrowserContextTab[] {
  const tabs = snapshot['tabs']
  if (!Array.isArray(tabs)) return []
  const restored: BrowserContextTab[] = []
  for (const value of tabs.slice(-MAX_PERSISTED_BROWSER_TABS)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const tab = value as Record<string, unknown>
    const id = tab['id']
    const projectId = tab['projectId']
    const threadId = tab['threadId']
    const title = tab['title']
    const url = tab['url']
    if (
      typeof id !== 'string' ||
      !BROWSER_TAB_ID_PATTERN.test(id) ||
      restored.some((candidate) => candidate.id === id) ||
      typeof projectId !== 'string' ||
      projectId.length === 0 ||
      projectId.length > 512 ||
      typeof threadId !== 'string' ||
      threadId.length > 512 ||
      typeof title !== 'string' ||
      title.length > 240 ||
      typeof url !== 'string'
    ) {
      continue
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      continue
    }
    restored.push({
      id,
      kind: 'browser',
      title,
      projectId,
      threadId,
      url: parsed.href
    })
  }
  return restored
}

export function persistBrowserTabs(tabs: BrowserContextTab[], activeTabId: string | null): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      BROWSER_TABS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        tabs: tabs.slice(-MAX_PERSISTED_BROWSER_TABS),
        activeTabId
      })
    )
  } catch {
    // Browser restoration is best-effort; blocked storage must not break the sidebar.
  }
}
