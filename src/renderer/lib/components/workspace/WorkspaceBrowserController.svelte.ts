import { invoke } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import type { BrowserDownload } from '$shared/ipc-contract'

export interface WorkspaceBrowserOptions {
  /** Project of the thread on screen; read per call so the controller follows selection. */
  getSelectedProjectId: () => string | null
}

/**
 * Owns the workspace's browser chrome: the rail context menu, the cookie/site
 * data confirmation, and the downloads manager state machine, so
 * `Workspace.svelte` only wires the controller into the dock and its dialogs.
 */
export class WorkspaceBrowserController {
  private readonly getSelectedProjectId: () => string | null

  /** Whether the message-history jump menu's browser context menu is open. */
  menuOpen = $state(false)
  clearDataConfirmOpen = $state(false)
  clearDataProjectId = $state<string | null>(null)
  clearing = $state(false)
  downloads = $state<BrowserDownload[]>([])
  downloadsOpen = $state(false)

  constructor(options: WorkspaceBrowserOptions) {
    this.getSelectedProjectId = options.getSelectedProjectId
  }

  activeDownloadCount = $derived.by(() => {
    const projectId = this.getSelectedProjectId()
    return projectId
      ? this.downloads.filter((download) => download.projectId === projectId).length
      : 0
  })

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

  upsertDownload(next: BrowserDownload): void {
    const index = this.downloads.findIndex((candidate) => candidate.id === next.id)
    if (index >= 0) {
      this.downloads[index] = next
      return
    }
    this.downloads = [...this.downloads, next]
  }

  openDownloads(): void {
    this.menuOpen = false
    this.downloadsOpen = true
    const projectId = this.getSelectedProjectId()
    if (!projectId) return
    void invoke('browser:getDownloads', projectId)
      .then((downloads) => {
        this.downloads = downloads
      })
      .catch((error: unknown) => {
        reportError(error, 'Browser downloads could not be loaded.')
      })
  }

  closeDownloads(): void {
    this.downloadsOpen = false
  }

  pauseDownload(download: BrowserDownload): void {
    void invoke('browser:pauseDownload', download.id).catch(() => {})
  }

  resumeDownload(download: BrowserDownload): void {
    void invoke('browser:resumeDownload', download.id).catch(() => {})
  }

  cancelDownload(download: BrowserDownload): void {
    void invoke('browser:cancelDownload', download.id).catch(() => {})
  }

  openDownload(download: BrowserDownload): void {
    void invoke('browser:openDownload', download.id).catch((error: unknown) => {
      reportError(error, 'The downloaded file could not be opened.')
    })
  }

  revealDownload(download: BrowserDownload): void {
    void invoke('browser:revealDownload', download.id).catch((error: unknown) => {
      reportError(error, 'The downloaded file could not be revealed.')
    })
  }
}
