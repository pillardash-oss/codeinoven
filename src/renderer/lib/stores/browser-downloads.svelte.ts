import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { BrowserDownload } from '$shared/ipc-contract'
import { reportError } from './app-errors.svelte'

/**
 * Downloads the embedded browser started, keyed by download id in the order they
 * started. Main is the owner of every byte written; this store is the renderer's
 * mirror of what it reported, so the toolbar list, the downloads window and any
 * future surface render one list instead of fetching their own copy.
 *
 * The same map instance is mutated for every update: replacing the whole map on
 * a refresh would leave every mounted surface subscribed to the map it read when
 * it rendered, and their progress would stop moving.
 */
class BrowserDownloadsState {
  private readonly downloads = new SvelteMap<string, BrowserDownload>()

  constructor() {
    // One app-lifetime subscription: a download that starts while the browser
    // panel is closed still has to appear, and its progress events must not race
    // the surface that opens later.
    subscribe('browser:download', (download) => this.upsert(download))
  }

  /** Apply one download report from main: newest progress for a known download,
   *  a new entry for one this renderer had not seen yet. */
  upsert(download: BrowserDownload): void {
    this.downloads.set(download.id, download)
  }

  /** Re-read the project's tracked downloads from main, so a surface opened on a
   *  new session (or after main trimmed its list) shows what main actually has.
   *  Live entries main no longer tracks are dropped. */
  async load(projectId: string): Promise<void> {
    let downloads: BrowserDownload[]
    try {
      downloads = await invoke('browser:getDownloads', projectId)
    } catch (error: unknown) {
      reportError(error, 'Browser downloads could not be loaded.')
      return
    }
    const tracked = new Set(downloads.map((download) => download.id))
    for (const [id, existing] of this.downloads) {
      if (existing.projectId === projectId && !tracked.has(id)) this.downloads.delete(id)
    }
    for (const download of downloads) this.downloads.set(download.id, download)
  }

  /** The project's downloads, most recently started first. */
  forProject(projectId: string): BrowserDownload[] {
    const downloads: BrowserDownload[] = []
    for (const download of this.downloads.values()) {
      if (download.projectId === projectId) downloads.push(download)
    }
    return downloads.reverse()
  }

  /** How many of the project's downloads are still running: the number the
   *  toolbar badge reports. Finished and failed ones are not "downloading". */
  activeCount(projectId: string): number {
    let count = 0
    for (const download of this.downloads.values()) {
      if (download.projectId === projectId && download.state === 'progressing') count += 1
    }
    return count
  }

  pause(download: BrowserDownload): void {
    void invoke('browser:pauseDownload', download.id).catch(() => {})
  }

  resume(download: BrowserDownload): void {
    void invoke('browser:resumeDownload', download.id).catch(() => {})
  }

  cancel(download: BrowserDownload): void {
    void invoke('browser:cancelDownload', download.id).catch(() => {})
  }

  open(download: BrowserDownload): void {
    void invoke('browser:openDownload', download.id).catch((error: unknown) => {
      reportError(error, 'The downloaded file could not be opened.')
    })
  }

  /** Reveal a finished download in the operating system's file manager. */
  reveal(download: BrowserDownload): void {
    void invoke('browser:revealDownload', download.id).catch((error: unknown) => {
      reportError(error, 'The downloaded file could not be revealed.')
    })
  }
}

export const browserDownloads = new BrowserDownloadsState()
