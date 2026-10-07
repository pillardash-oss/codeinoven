import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { loadBrowser } from '$lib/stores/browser-access.svelte'
import { browserAddressFocus } from '$lib/stores/browser-address-focus'
import { invoke } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
import type { BrowserDownload } from '$shared/ipc-contract'

export interface WorkspaceBrowserOptions {
  /** Project of the thread on screen; read per call so the controller follows selection. */
  getSelectedProjectId: () => string | null
}

/**
 * Owns the workspace's browser chrome: the rail context menu, the cookie/site
 * data confirmation, and the downloads manager state machine, so
 * `Workspace.svelte` only wires the controller into the dock and its dialogs.
 *
 * The downloads list itself lives in the shared `browserDownloads` store so the
 * toolbar list, this modal and the rail menu always render the same entries.
 */
export class WorkspaceBrowserController {
  private readonly getSelectedProjectId: () => string | null

  /** Whether the message-history jump menu's browser context menu is open. */
  menuOpen = $state(false)
  clearDataConfirmOpen = $state(false)
  clearDataProjectId = $state<string | null>(null)
  clearing = $state(false)
  downloadsOpen = $state(false)

  constructor(options: WorkspaceBrowserOptions) {
    this.getSelectedProjectId = options.getSelectedProjectId
  }

  /** The selected project's downloads, newest first. No selected project means
   *  no project-owned downloads to show. */
  get downloads(): BrowserDownload[] {
    const projectId = this.getSelectedProjectId()
    if (!projectId) return []
    return browserDownloads.forProject(projectId)
  }

  /** How many of the selected project's downloads are unfinished: the running
   *  ones plus the interrupted ones waiting to be resumed or started over. */
  unfinishedDownloadCount = $derived.by(() => {
    const projectId = this.getSelectedProjectId()
    return projectId ? browserDownloads.unfinishedCount(projectId) : 0
  })

  /** Both strips use the same native tab menu, above the native page. */
  async openTabMenu(tabId: string, event: MouseEvent, close: (id: string) => void): Promise<void> {
    event.preventDefault()
    const x = event.clientX
    const y = event.clientY
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === tabId)
    if (tab?.kind !== 'browser') return
    try {
      const store = await loadBrowser()
      const { browserBookmarks } = await import('$lib/stores/browser-bookmarks.svelte')
      const choice = await invoke(
        'browser:tabContextMenu',
        {
          threadScoped: true,
          tabId,
          title: tab.title,
          url: tab.url,
          bookmarkAvailable: Boolean(tab.url),
          bookmarked: browserBookmarks.isBookmarked(tab.url, tab.boxId),
          pinned: false,
          groupId: null,
          boxId: tab.boxId,
          canReopenClosedTab: true,
          groups: [],
          boxes: store.boxes.map(({ id, name }) => ({ id, name }))
        },
        x,
        y
      )
      if (!choice || !contextSidebarState.tabs.some((candidate) => candidate.id === tabId)) return
      if (choice.action === 'close') {
        close(tabId)
        return
      }
      if (choice.action === 'toggleBookmark') {
        browserBookmarks.toggle(tab.url, tab.title, tab.favicon, tab.boxId)
        return
      }
      if (choice.action === 'reopenClosed') {
        const id = contextSidebarState.reopenClosedBrowserTab()
        if (id) browserAddressFocus.request(id)
        return
      }
      if (choice.action === 'reopenInBox') {
        store.closeSourcePeek(tabId)
        contextSidebarState.setBrowserTabBox(tabId, choice.boxId)
        return
      }
      if (!['duplicate', 'newBefore', 'newTab', 'newPlaced'].includes(choice.action)) return
      const boxId = choice.action === 'newPlaced' ? choice.boxId : tab.boxId
      const finalId = contextSidebarState.openBrowserForContext(
        choice.action === 'duplicate' ? tab.url : '',
        tab.projectId,
        tab.threadId,
        undefined,
        true,
        boxId
      )
      contextSidebarState.reorder(
        finalId,
        tabId,
        choice.action === 'newBefore' ? 'before' : 'after'
      )
      if (choice.action !== 'duplicate') browserAddressFocus.request(finalId)
    } catch (error: unknown) {
      reportError(error, 'Browser tab menu could not be opened.')
    }
  }

  openContextMenu(event: MouseEvent): void {
    event.preventDefault()
    this.menuOpen = true
  }

  closeMenu(): void {
    this.menuOpen = false
  }

  requestDataClear(): void {
    const projectId = this.getSelectedProjectId()
    if (!projectId) return
    this.menuOpen = false
    this.clearDataProjectId = projectId
    this.clearDataConfirmOpen = true
  }

  cancelDataClear(): void {
    if (this.clearing) return
    this.clearDataConfirmOpen = false
    this.clearDataProjectId = null
  }

  async clearData(): Promise<void> {
    const projectId = this.clearDataProjectId
    if (!projectId || this.clearing) return
    this.clearing = true
    try {
      await invoke('browser:clearData', projectId)
      this.clearDataConfirmOpen = false
      this.clearDataProjectId = null
    } catch (error) {
      reportError(error, 'Browser cookies and site data could not be cleared.')
    } finally {
      this.clearing = false
    }
  }

  openDownloads(): void {
    this.menuOpen = false
    this.downloadsOpen = true
    const projectId = this.getSelectedProjectId()
    if (!projectId) return
    void browserDownloads.load(projectId)
  }

  closeDownloads(): void {
    this.downloadsOpen = false
  }

  pauseDownload(download: BrowserDownload): void {
    browserDownloads.pause(download)
  }

  resumeDownload(download: BrowserDownload): void {
    browserDownloads.resume(download)
  }

  /** Start a stopped download over from its first byte. */
  retryDownload(download: BrowserDownload): void {
    browserDownloads.retry(download)
  }

  /** Drop a stopped download from the list, keeping the file it saved. */
  removeDownload(download: BrowserDownload): void {
    browserDownloads.remove(download)
  }

  cancelDownload(download: BrowserDownload): void {
    browserDownloads.cancel(download)
  }

  openDownload(download: BrowserDownload): void {
    browserDownloads.open(download)
  }

  revealDownload(download: BrowserDownload): void {
    browserDownloads.reveal(download)
  }
}
