import { invoke } from '$lib/ipc.svelte'
import { loadPersistedBrowserTabs, persistBrowserTabs } from './context-sidebar-persistence'
import type { BrowserContextTab } from './context-sidebar-types'

const EMPTY_BROWSER_TABS: BrowserContextTab[] = []

/** Parsed once at module load: the persisted tab list plus the last active tab. */
const persistedBrowserTabs = loadPersistedBrowserTabs()

/**
 * Host access the browser-tabs controller needs from the sidebar store.
 * The controller owns the browser tab list and its visibility; the store owns
 * the active project/thread and the notifications flag.
 */
export interface SidebarBrowserTabsHost {
  activeProjectId(): string | null
  activeThreadId(): string | null
  clearNotifications(): void
}

/**
 * Browser tabs docked in the sidebar. Owns the tab list, the remembered active
 * tab, and visibility, plus persistence and the native view detach. Project
 * scoping is resolved through the host so the store stays the active-identity
 * owner.
 */
export class SidebarBrowserTabs {
  tabs: BrowserContextTab[] = $state(persistedBrowserTabs.tabs)
  activeTabId: string | null = $state(persistedBrowserTabs.activeTabId)
  visible = $state(false)

  constructor(private readonly host: SidebarBrowserTabsHost) {}

  /** Browser tabs for the active project. */
  get activeTabs(): BrowserContextTab[] {
    const projectId = this.host.activeProjectId()
    if (!projectId) return EMPTY_BROWSER_TABS
    return this.tabs.filter((tab) => tab.projectId === projectId)
  }

  has(id: string): boolean {
    return this.tabs.some((tab) => tab.id === id)
  }

  /**
   * The browser tab to focus when the browser workspace is revealed: the
   * remembered active tab when it still belongs to the active project,
   * otherwise the project's last open tab. Restarts, project switches and
   * tab closures all funnel through this so the sidebar never falls back to
   * an arbitrary tab.
   */
  get rememberedTabId(): string | null {
    const tabs = this.activeTabs
    if (tabs.length === 0) return null
    return this.activeTabId && tabs.some((tab) => tab.id === this.activeTabId)
      ? this.activeTabId
      : (tabs.at(-1)?.id ?? null)
  }

  /** Active tab id for the browser region of the sidebar (never null while visible). */
  activeTabIdOrLast(): string | null {
    return this.activeTabId && this.activeTabs.some((tab) => tab.id === this.activeTabId)
      ? this.activeTabId
      : (this.activeTabs.at(-1)?.id ?? null)
  }

  setVisible(value: boolean): void {
    this.visible = value
  }

  /** Detach the native browser view without changing store visibility. */
  detachView(): void {
    const tabId = this.activeTabId ?? this.activeTabs.at(-1)?.id
    if (tabId) void invoke('browser:hide', tabId)
  }

  /** Hide the browser region and detach its native view. */
  hide(): void {
    this.detachView()
    this.visible = false
  }

  /** Hide the browser region when a context tab takes focus, detaching only
   *  when the native view was actually visible. */
  hideForFocus(): void {
    if (this.visible) this.detachView()
    this.visible = false
  }

  open(url: string, requestedTabId?: string): string | null {
    const projectId = this.host.activeProjectId()
    const threadId = this.host.activeThreadId()
    if (!projectId || !threadId) return null
    return this.openForContext(url, projectId, threadId, requestedTabId, true)
  }

  openForContext(
    url: string,
    projectId: string,
    threadId: string,
    requestedTabId?: string,
    reveal = false
  ): string {
    const id = requestedTabId ?? `browser:${crypto.randomUUID()}`
    const existing = this.tabs.find((tab) => tab.id === id && tab.projectId === projectId)
    if (existing) {
      existing.url = url
      existing.threadId = threadId
      this.persist()
      if (
        reveal &&
        this.host.activeProjectId() === projectId &&
        this.host.activeThreadId() === threadId
      ) {
        this.focus(id)
      }
      return id
    }
    let title = 'Browser'
    try {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      const parsed = new URL(url)
      title = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
    } catch {
      // The main-process browser boundary reports malformed custom URLs.
    }
    this.tabs = [...this.tabs, { id, kind: 'browser', title, projectId, threadId, url }]
    this.persist()
    if (
      reveal &&
      this.host.activeProjectId() === projectId &&
      this.host.activeThreadId() === threadId
    ) {
      this.focus(id)
    }
    return id
  }

  updateTab(tabId: string, url: string, title?: string, favicon?: string | null): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    tab.url = url
    if (title?.trim()) tab.title = title.trim()
    if (favicon !== undefined) {
      if (favicon) tab.favicon = favicon
      else delete tab.favicon
    }
    this.persist()
  }

  removeForProject(projectId: string): string[] {
    const removedIds = this.tabs.filter((tab) => tab.projectId === projectId).map((tab) => tab.id)
    if (removedIds.length === 0) return []
    this.tabs = this.tabs.filter((tab) => tab.projectId !== projectId)
    if (this.activeTabId && removedIds.includes(this.activeTabId)) {
      this.activeTabId = null
    }
    if (this.host.activeProjectId() === projectId) this.visible = false
    this.persist()
    return removedIds
  }

  removeForThread(projectId: string, threadId: string): string[] {
    const removedIds = this.tabs
      .filter((tab) => tab.projectId === projectId && tab.threadId === threadId)
      .map((tab) => tab.id)
    if (removedIds.length === 0) return []
    this.tabs = this.tabs.filter((tab) => tab.projectId !== projectId || tab.threadId !== threadId)
    if (this.activeTabId && removedIds.includes(this.activeTabId)) {
      this.activeTabId = this.activeTabs.at(-1)?.id ?? null
    }
    if (this.activeTabs.length === 0) this.visible = false
    this.persist()
    return removedIds
  }

  /** Close one browser tab and fall back to the project's last remaining tab. */
  close(id: string): void {
    const browserIndex = this.tabs.findIndex((tab) => tab.id === id)
    if (browserIndex < 0) return
    const closedProjectId = this.tabs[browserIndex].projectId
    this.tabs = this.tabs.filter((tab) => tab.id !== id)
    if (this.activeTabId === id) {
      this.activeTabId =
        this.tabs.filter((tab) => tab.projectId === closedProjectId).at(-1)?.id ?? null
    }
    if (this.activeTabs.length === 0) this.visible = false
    this.persist()
  }

  focus(id: string): void {
    const tab = this.tabs.find((candidate) => candidate.id === id)
    if (!tab || tab.projectId !== this.host.activeProjectId()) return
    this.activeTabId = id
    this.visible = true
    this.host.clearNotifications()
    this.persist()
  }

  reorder(id: string, targetId: string, position: 'before' | 'after'): void {
    const fromIndex = this.tabs.findIndex((tab) => tab.id === id)
    const toIndex = this.tabs.findIndex((tab) => tab.id === targetId)
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return
    const ordered = [...this.tabs]
    const [moved] = ordered.splice(fromIndex, 1)
    const adjustedTarget = ordered.findIndex((tab) => tab.id === targetId)
    ordered.splice(position === 'before' ? adjustedTarget : adjustedTarget + 1, 0, moved)
    this.tabs = ordered
    this.persist()
  }

  private persist(): void {
    persistBrowserTabs(this.tabs, this.activeTabId)
  }
}
