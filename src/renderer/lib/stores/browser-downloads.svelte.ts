import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { BrowserDownload } from '$shared/ipc-contract'
import { reportError } from './app-errors.svelte'

/**
 * A project's outstanding downloads, split by whether anything is moving.
 *
 * `running` is transferring bytes; `stopped` is paused or interrupted and
 * waiting on the user. A surface that only needs a total adds the two, so both
 * kinds of count are derived from one classification.
 */
export interface BrowserDownloadOutstanding {
  running: number
  stopped: number
}

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

  /**
   * Whether {@link start} has wired the listener. Downloads belong to the
   * browser, and the browser is not part of the first paint, so this stays inert
   * until the runtime seam asks for it.
   */
  private started = false

  /** Register the runtime's one subscription. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    // One app-lifetime subscription: a download that starts while the browser
    // panel is closed still has to appear, and its progress events must not race
    // the surface that opens later.
    subscribe('browser:download', (download) => this.upsert(download))
    // Main drops a record without a replacement for it (removed from the list,
    // forgotten with its project, or trimmed past the tracking cap). Nothing
    // else can report that row again, so the removal itself is the only signal
    // that takes it off the list the user is looking at.
    subscribe('browser:downloadRemoved', (downloadId) => this.downloads.delete(downloadId))
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

  /**
   * The project's outstanding downloads in one read, split by whether anything
   * is moving: how much the browser still has in flight, and how much of it is
   * waiting on the user.
   *
   * `running` is what is transferring bytes right now. A download the user
   * paused is `progressing` in main's bookkeeping but is not moving, so it
   * belongs to `stopped` together with the interrupted ones   the entries that
   * need a resume, a restart or a removal. One classification, so a badge that
   * splits the two and one that only counts them can never disagree about the
   * same list of downloads.
   */
  outstandingCounts(projectId: string): BrowserDownloadOutstanding {
    let running = 0
    let stopped = 0
    for (const download of this.downloads.values()) {
      if (download.projectId !== projectId) continue
      if (download.state === 'completed' || download.state === 'cancelled') continue
      if (download.state === 'progressing' && !download.paused) running += 1
      else stopped += 1
    }
    return { running, stopped }
  }

  /**
   * How many of the project's downloads are not finished: the running ones plus
   * the interrupted ones the user has to resume or start over.
   *
   * A download the app stopped on its way out is exactly the entry the user
   * would otherwise never know about   it is on screen, waiting for a decision,
   * and a badge is what says so   which is why the count covers stopped
   * downloads and not only the live ones.
   */
  unfinishedCount(projectId: string): number {
    const outstanding = this.outstandingCounts(projectId)
    return outstanding.running + outstanding.stopped
  }

  pause(download: BrowserDownload): void {
    void invoke('browser:pauseDownload', download.id).catch(() => {})
  }

  resume(download: BrowserDownload): void {
    void invoke('browser:resumeDownload', download.id).catch((error: unknown) => {
      reportError(error, 'The download could not be resumed.')
    })
  }

  /** Start a stopped download over from its first byte. */
  retry(download: BrowserDownload): void {
    void invoke('browser:retryDownload', download.id).catch((error: unknown) => {
      reportError(error, 'The download could not be started again.')
    })
  }

  cancel(download: BrowserDownload): void {
    void invoke('browser:cancelDownload', download.id).catch(() => {})
  }

  /**
   * Drop a stopped download from the list, keeping the file it saved.
   *
   * The row leaves the list when main answers with the removal, not on this
   * click: main is the one that decides (it refuses a download still running),
   * and a row deleted here would come straight back on the next report.
   */
  remove(download: BrowserDownload): void {
    void invoke('browser:removeDownload', download.id).catch((error: unknown) => {
      reportError(error, 'The download could not be removed from the list.')
    })
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
