import { SvelteSet } from 'svelte/reactivity'
import { Globe } from '@lucide/svelte'
import type { ActionDefinition, ActionSelection } from '$lib/actions'
import { browserStore, loadBrowser } from '$lib/stores/browser-access.svelte'
import { browserTabLabel } from '$lib/stores/global-browser-types'
import { actionId } from './app-palette-actions'

export interface BrowserTabSearchPaletteDeps {
  /** Focus the picked tab in the top-level Browser view. */
  openTab: (tabId: string) => void
}

const MAX_RESULTS = 60
const ACTION_ID_PREFIX = 'browsertab:'

/** The host a tab's address points at, or the raw address when it has none. */
function tabHost(url: string): string {
  if (!url) return 'New tab'
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/**
 * Reactive state machine behind the browser-tab search palette: it searches the
 * live browser strip's tabs (label, address, and group), filters by group, and
 * focuses the picked tab. The browser is only loaded when this screen opens, so
 * nothing pays for it until the user asks for it.
 */
export class BrowserTabPaletteController {
  paletteOpen = $state(false)
  /** Selected group ids for the footer picker; empty = every group. */
  groupIds = $state<string[]>([])
  private query = $state('')

  /**
   * Rows are derived from the live store, so they appear the moment the browser
   * finishes loading and follow every tab or group change while the screen is
   * open. No target map is kept: the tab id is encoded in the row's action id.
   */
  actions = $derived.by(() => this.buildRows())

  constructor(private readonly deps: BrowserTabSearchPaletteDeps) {}

  openPalette(): void {
    this.paletteOpen = true
    this.groupIds = []
    this.query = ''
    void loadBrowser()
  }

  close(): void {
    this.paletteOpen = false
    this.groupIds = []
    this.query = ''
  }

  handleQuery(query: string): void {
    this.query = query
  }

  setScope(groupIds: string[]): void {
    this.groupIds = groupIds
  }

  select(selection: ActionSelection): void {
    if (!selection.action.id.startsWith(ACTION_ID_PREFIX)) return
    const tabId = selection.action.id.slice(ACTION_ID_PREFIX.length)
    this.close()
    this.deps.openTab(tabId)
  }

  private buildRows(): ActionDefinition[] {
    const store = browserStore()
    if (!store) return []
    const normalized = this.query.trim().toLowerCase()
    const groupIds = new SvelteSet(this.groupIds)
    const actions: ActionDefinition[] = []
    for (const tab of store.tabs) {
      if (groupIds.size > 0 && (!tab.groupId || !groupIds.has(tab.groupId))) continue
      const group = tab.groupId
        ? store.groups.find((candidate) => candidate.id === tab.groupId)
        : undefined
      const groupName = group?.name ?? 'Ungrouped'
      const label = browserTabLabel(tab)
      if (
        normalized &&
        ![label, tab.url, groupName].some((value) => value.toLowerCase().includes(normalized))
      ) {
        continue
      }
      const iconUri = tab.favicon ?? null
      actions.push({
        id: actionId(`${ACTION_ID_PREFIX}${tab.id}`),
        title: label,
        description: `${tabHost(tab.url)} · ${groupName}`,
        category: 'browser',
        source: {
          id: `browsergroup:${tab.groupId ?? 'ungrouped'}`,
          label: groupName,
          kind: 'app',
          ...(group?.color ? { color: group.color } : {})
        },
        showSourceBadge: false,
        ...(iconUri ? { iconUri } : { icon: Globe }),
        keywords: [label, tab.url, groupName].filter(Boolean)
      })
      if (actions.length >= MAX_RESULTS) break
    }
    return actions
  }
}
