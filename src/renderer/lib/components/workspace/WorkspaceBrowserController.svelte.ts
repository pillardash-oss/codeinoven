import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { loadBrowser } from '$lib/stores/browser-access.svelte'
import { browserAddressFocus } from '$lib/stores/browser-address-focus'
import { invoke } from '$lib/ipc.svelte'
import { copyText } from '$lib/copy-text'
import { reportError } from '$lib/stores/app-errors.svelte'
import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
import type { BrowserDownload } from '$shared/ipc-contract'

export interface WorkspaceBrowserOptions {
  /** Project of the thread on screen; read per call so the controller follows selection. */
  getSelectedProjectId: () => string | null
  /** Thread on screen; the thread browser's tabs belong to it. */
  getSelectedThreadId: () => string | null
  /** Hide the thread browser dock for the thread on screen. */
  closeThreadBrowser: () => void
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
  private readonly getSelectedThreadId: () => string | null
  private readonly closeThreadBrowser: () => void

  clearDataConfirmOpen = $state(false)
  clearDataProjectId = $state<string | null>(null)
  downloadsOpen = $state(false)

  constructor(options: WorkspaceBrowserOptions) {
    this.getSelectedProjectId = options.getSelectedProjectId
    this.getSelectedThreadId = options.getSelectedThreadId
    this.closeThreadBrowser = options.closeThreadBrowser
  }

  /**
   * Close every tab the conversation's browser shows, then leave one blank page
   * so the address bar still has somewhere to navigate.
   *
   * This is the rail menu's escape hatch for a browser that has accumulated
   * pages: destroying the views is what gives the renderer processes back.
   */
  async closeAllTabs(): Promise<void> {
    const projectId = this.getSelectedProjectId()
    const threadId = this.getSelectedThreadId()
    if (!projectId || !threadId) return
    try {
      await contextSidebarState.closeActiveBrowserTabs()
      const blank = contextSidebarState.openBrowserForContext(
        '',
        projectId,
        threadId,
        undefined,
        true
      )
      browserAddressFocus.request(blank)
    } catch (error: unknown) {
      reportError(error, 'The browser tabs could not be closed.')
    }
  }

  /** Close every tab and put the thread browser away for this thread. */
  async closeBrowser(): Promise<void> {
    const projectId = this.getSelectedProjectId()
    const threadId = this.getSelectedThreadId()
    if (projectId && threadId) {
      try {
        await contextSidebarState.closeActiveBrowserTabs()
      } catch (error: unknown) {
        reportError(error, 'The thread browser could not be closed.')
      }
    }
    this.closeThreadBrowser()
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
          // A thread tab sleeps on the same clock as a global one, so the menu's
          // sleep item is live for it too, and it is off only while the page is
          // already asleep or is the page on screen.
          hibernated: tab.hibernated,
          active: contextSidebarState.activeBrowserTabId === tabId,
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
      if (choice.action === 'copyTabId') {
        // The id an agent is pointed at, copied from the tab it names.
        void copyText(tabId, 'Tab ID copied')
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
      if (choice.action === 'sleep') {
        // The store refuses a page a surface is showing, so the row can never be
        // left saying it is asleep while its page is still on screen.
        contextSidebarState.hibernateBrowserTab(tabId)
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

  /** Show the rail's native menu above the thread browser page. */
  async openContextMenu(event: MouseEvent): Promise<void> {
    event.preventDefault()
    try {
      const choice = await invoke('browser:railContextMenu', event.clientX, event.clientY)
      if (!choice) return
      switch (choice.action) {
        case 'closeAllTabs':
          await this.closeAllTabs()
          return
        case 'closeBrowser':
          await this.closeBrowser()
          return
        case 'downloads':
          this.openDownloads()
          return
        case 'clearData':
          this.requestDataClear()
          return
      }
    } catch (error: unknown) {
      reportError(error, 'The browser menu could not be opened.')
    }
  }

  requestDataClear(): void {
    const projectId = this.getSelectedProjectId()
    if (!projectId) return
    this.clearDataProjectId = projectId
    this.clearDataConfirmOpen = true
  }

  cancelDataClear(): void {
    this.clearDataConfirmOpen = false
    this.clearDataProjectId = null
  }

  /**
   * Dismiss the confirmation the moment the user confirms, then clear in the
   * background. Clearing site data touches every jar's cookies and cache and
   * can outlast a click by seconds; the dialog must never sit there holding
   * the window while it finishes. A failure lands as a toast, and the panel is
   * already back so the user can keep working.
   */
  clearData(): void {
    const projectId = this.clearDataProjectId
    this.clearDataConfirmOpen = false
    this.clearDataProjectId = null
    if (!projectId) return
    void invoke('browser:clearData', projectId).catch((error: unknown) => {
      reportError(error, 'Browser cookies and site data could not be cleared.')
    })
  }

  openDownloads(): void {
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
