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
