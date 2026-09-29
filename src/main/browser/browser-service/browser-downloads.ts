/**
 * Downloads for the embedded browser: the one process-wide owner of every
 * download a browser tab starts.
 *
 * It is deliberately *not* window-bound. A window is parked to the menu bar and
 * rebuilt on reopen, and a download outlives both: its bytes are on the user's
 * disk and its progress belongs to the session, not to the window that happened
 * to be showing the page. The manager therefore holds its own map, its own
 * `will-download` registration per project session, and a window *provider*; a
 * parked window costs progress events (there is nothing to show them on) and
 * nothing else.
 *
 * Records are durable for the same reason. Two runs sit on either side of a
 * completed download: the run that started it and the run that finds it. The
 * durable record is what lets the second one show the download, keep its kept
 * bytes, and offer Resume instead of a silent half-written file.
 *
 * Chromium deletes a download's partial file when the download is cancelled or
 * the process owning it exits, so the only way a download can survive a quit is
 * to move its bytes aside first ({@link stagePartialDownload}). That is what a
 * deliberate quit does, and what {@link resumeFromDisk} continues from, through
 * `session.createInterruptedDownload`   Electron's own resume path, which sends
 * the range request plus the validation header a resumable server needs.
 */

import {
  Menu,
  MenuItem,
  app,
  session,
  shell,
  type BrowserWindow,
  type DownloadItem,
  type MenuItemConstructorOptions,
  type Session
} from 'electron'
import { join } from 'node:path'
import type { BrowserDownload, BrowserDownloadState } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import { downloadStatusLabel } from './browser-download-label'
import {
  fileSizeOf,
  removeFileQuietly,
  restoreStagedDownload,
  stagePartialDownload,
  stagedDownloadPath
} from './browser-download-files'
import { hasResumeValidator, recoverDownloadRecord } from './browser-download-recovery'
import {
  BrowserDownloadStore,
  type DownloadPersistence,
  type PersistedBrowserDownload
} from './browser-download-store'
import {
  DOWNLOAD_EVENT_INTERVAL_MS,
  MAX_BROWSER_URL_LENGTH,
  MAX_TRACKED_DOWNLOADS,
  browserPartitionFor,
  safeBasename
} from './browser-validation'

/**
 * How long a download is given to stop after it is paused during a quit, before
 * its bytes are moved aside. Chromium flushes and closes the file asynchronously,
 * and a quit that moved the file mid-write would keep a torn tail.
 */
const QUIT_PAUSE_SETTLE_MS = 300

/** Shortest gap between two writes of the durable records, so a fast download
 *  does not rewrite the file for every progress tick. */
const PERSIST_INTERVAL_MS = 2_000

/** How long a resume or retry intent waits for the download it asked for before
 *  the attempt is reported as failed. */
const ADOPTION_TIMEOUT_MS = 10_000

/** A download this manager is tracking: the live item while one exists, and the
 *  record that outlives it. */
interface TrackedDownload {
  download: BrowserDownload
  /** The live Chromium download, or null once it finished and after a restart. */
  item: DownloadItem | null
  /** Every URL the download was redirected through, which is what a resume needs. */
  urlChain: string[]
  /** `Last-Modified` of the response, one of the two validators Chromium checks a
   *  resumed range request against. */
  lastModified: string
  /** `ETag` of the response, the other validator. Chromium prefers a strong one
   *  over `Last-Modified`, and a download with neither cannot be resumed safely. */
  eTag: string
  /** Where this download's kept bytes are while it is not running, when they were
   *  moved out of Chromium's reach. Empty when there are none. */
  stagedPath: string
  lastEmittedAt: number
}

/**
 * A resume or retry the manager asked for and is waiting to see arrive as a
 * `will-download`. Electron answers `session.downloadURL` and
 * `session.createInterruptedDownload` that way, so this is how the new download
 * is matched back to the record it belongs to instead of appearing as a second
 * entry.
 */
interface PendingAdoption {
  id: string
  /** The record as it was before the attempt, restored when it never arrives. */
  previous: BrowserDownload
  timer: ReturnType<typeof setTimeout>
}

export interface BrowserDownloadManagerDeps {
  persistence: DownloadPersistence
  /** The window that currently shows the app, or null while none does. */
  window: () => BrowserWindow | null
  /** Tab id of the WebContents that started a download, when that tab is known.
   *  Replaced by `setTabResolver` whenever a browser service is attached, because
   *  the tabs belong to the window that was rebuilt. */
  findTabId?: (projectId: string, contentsId: number) => string | undefined
}

export class BrowserDownloadManager {
  private readonly downloads = new Map<string, TrackedDownload>()
  private readonly store: BrowserDownloadStore
  private readonly watchedPartitions = new Set<string>()
  private readonly pendingAdoptions = new Map<string, PendingAdoption>()
  /** Records this run dropped (the user removed them, or they were trimmed),
   *  which the next write has to remove from the file too. Each id stays here
   *  until a write that excludes it has landed, so a removal made while a write
   *  is in flight is never cleared by the write that missed it. */
  private readonly removedRecords = new Set<string>()
  private findTabId: ((projectId: string, contentsId: number) => string | undefined) | null
  private hydrated = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persisting = false
  private persistAgain = false

  constructor(private readonly deps: BrowserDownloadManagerDeps) {
    this.store = new BrowserDownloadStore(deps.persistence)
    this.findTabId = deps.findTabId ?? null
  }

  /** Point tab lookup at the browser service that owns the current window's
   *  tabs, or at nothing when that window was released. */
  setTabResolver(
    resolver: ((projectId: string, contentsId: number) => string | undefined) | null
  ): void {
    this.findTabId = resolver
  }

  /**
   * Read the durable records once and reconcile each unfinished one against the
   * bytes it left on disk, so a download from an earlier run is on screen   with
   * the action it can actually honour   from the first time the list is asked
   * for. Idempotent: later window attaches reuse the reconciled map.
   */
  async hydrate(): Promise<void> {
    if (this.hydrated) return
    this.hydrated = true
    // The store answers with the records it could validate and nothing else, so
    // an unreadable or corrupt file is an empty list rather than a failure here.
    const records = await this.store.load()
    if (records.length === 0) return
    // Oldest first, so the map's insertion order stays "order the downloads
    // started in" and every surface keeps rendering newest first.
    const oldestFirst = [...records].sort((left, right) => left.startedAt - right.startedAt)
    const measured = await Promise.all(
      oldestFirst.map(async (record) => ({
        record,
        facts: {
          saveBytes: await fileSizeOf(record.savePath),
          stagedBytes: await fileSizeOf(record.stagedPath)
        }
      }))
    )
    let changed = false
    for (const { record, facts } of measured) {
      const recovered = recoverDownloadRecord(record, facts)
      if (
        recovered.state !== record.state ||
        recovered.receivedBytes !== record.receivedBytes ||
        recovered.progress !== record.progress ||
        recovered.paused !== record.paused ||
        recovered.error !== record.error
      ) {
        changed = true
      }
      this.downloads.set(record.id, {
        download: {
          id: record.id,
          tabId: record.tabId,
          projectId: record.projectId,
          fileName: record.fileName,
          url: record.url,
          mimeType: record.mimeType,
          receivedBytes: recovered.receivedBytes,
          totalBytes: record.totalBytes,
          speedBytes: 0,
          progress: recovered.progress,
          state: recovered.state,
          paused: recovered.paused,
          savePath: record.savePath,
          error: recovered.error,
          resumable: recovered.resumable,
          startedAt: record.startedAt
        },
        item: null,
        urlChain: record.urlChain,
        lastModified: record.lastModified,
        eTag: record.eTag,
        stagedPath: record.stagedPath,
        lastEmittedAt: 0
      })
    }
    if (changed) await this.persist()
  }

  /** Watch one project's browser session for downloads. One registration per
   *  partition, however many times the window that uses it is rebuilt. */
  watchSession(projectId: string, browserSession: Session): void {
    const partition = browserPartitionFor(projectId)
    if (this.watchedPartitions.has(partition)) return
    this.watchedPartitions.add(partition)
    browserSession.on('will-download', (_event, item, contents) => {
      this.handleDownload(projectId, item, contents?.id)
    })
  }

  /** The project's downloads, oldest first; every surface renders them reversed
   *  so the most recent download is on top. */
  list(projectId: string): BrowserDownload[] {
    const downloads: BrowserDownload[] = []
    for (const record of this.downloads.values()) {
      if (record.download.projectId === projectId) downloads.push({ ...record.download })
    }
    return downloads
  }

  /**
   * Every download this manager currently holds open, across all projects: the
   * set a quit would have to stop. A download the user paused is included,
   * because its bytes are still Chromium's to delete and a quit still has to
   * move them aside. Records restored from an earlier run are not: those have no
   * live download left to stop, so closing changes nothing about them.
   */
  inFlight(): BrowserDownload[] {
    const downloads: BrowserDownload[] = []
    for (const record of this.downloads.values()) {
      if (record.item === null || record.download.state !== 'progressing') continue
      downloads.push({ ...record.download })
    }
    return downloads.sort((a, b) => a.startedAt - b.startedAt)
  }

  pause(downloadId: string): void {
    const record = this.downloads.get(downloadId)
    const item = record?.item
    if (!record || !item || record.download.state !== 'progressing' || item.isPaused()) return
    item.pause()
    record.download = { ...record.download, paused: true, speedBytes: 0 }
    this.emit(downloadId, true)
    this.schedulePersist()
  }

  /** Continue a download from where it stopped: the live item when this run owns
   *  it, the bytes on disk when an earlier run does. */
  resume(downloadId: string): void {
    const record = this.downloads.get(downloadId)
    if (!record) return
    const item = record.item
    if (item && record.download.state === 'progressing') {
      if (!item.isPaused()) return
      item.resume()
      record.download = { ...record.download, paused: false }
      this.emit(downloadId, true)
      this.schedulePersist()
      return
    }
    if (!record.download.resumable) return
    void this.resumeFromDisk(downloadId)
  }

  /** Start a stopped download over from its first byte, into the same file. */
  retry(downloadId: string): void {
    const record = this.downloads.get(downloadId)
    if (!record) return
    const { url, savePath, projectId } = record.download
    if (url.length === 0) return
    const stagedPath = record.stagedPath || stagedDownloadPath(savePath)
    record.stagedPath = ''
    void removeFileQuietly(stagedPath)
    const previous = record.download
    record.item = null
    record.download = {
      ...previous,
      receivedBytes: 0,
      totalBytes: 0,
      speedBytes: 0,
      progress: 0,
      state: 'progressing',
      paused: false,
      error: '',
      resumable: false,
      startedAt: Date.now()
    }
    this.watchAdoption(`retry:${url}`, record, previous)
    this.emit(downloadId, true)
    this.schedulePersist()
    this.sessionFor(projectId).downloadURL(url)
  }

  cancel(downloadId: string): void {
    const record = this.downloads.get(downloadId)
    if (!record) return
    const item = record.item
    if (item && record.download.state === 'progressing') {
      // Chromium deletes the partial file and reports the cancellation itself, so
      // the record is settled from its `done` event rather than here.
      item.cancel()
      return
    }
    const stagedPath = record.stagedPath || stagedDownloadPath(record.download.savePath)
    record.stagedPath = ''
    void removeFileQuietly(stagedPath)
    record.download = {
      ...record.download,
      state: 'cancelled',
      paused: false,
      receivedBytes: 0,
      speedBytes: 0,
      progress: 0,
      resumable: false,
      error: ''
    }
    this.emit(downloadId, true)
    this.schedulePersist()
  }

  /** Drop a stopped download from the list. Its kept bytes go with the record;
   *  the file the user asked for is never touched. */
  remove(downloadId: string): void {
    const record = this.downloads.get(downloadId)
    if (!record || record.download.state === 'progressing') return
    this.downloads.delete(downloadId)
    this.removedRecords.add(downloadId)
    if (record.stagedPath.length > 0) void removeFileQuietly(record.stagedPath)
    this.schedulePersist()
  }

  open(downloadId: string): void {
    const record = this.downloads.get(downloadId)
    if (!record || record.download.state !== 'completed') return
    if (record.download.savePath.length === 0) return
    void shell.openPath(record.download.savePath)
  }

  reveal(downloadId: string): boolean {
    const record = this.downloads.get(downloadId)
    if (!record) return false
    // A download whose bytes are kept aside has no file at the save path yet, and
    // that kept copy is what "show in folder" is useful for.
    const path = record.stagedPath.length > 0 ? record.stagedPath : record.download.savePath
    if (path.length === 0) return false
    shell.showItemInFolder(path)
    return true
  }

  /** Open the OS-native downloads menu for a project, anchored under the
   *  toolbar's download button. The menu composites above the WebContentsView,
   *  so the panel's layout never has to change for it. Each entry carries the
   *  actions its live state allows; clicking a filename opens the file. */
  showMenu(projectId: string, x: number, y: number): void {
    const window = this.deps.window()
    if (!window || window.isDestroyed()) return
    const menu = new Menu()
    const downloads = this.list(projectId)
    if (downloads.length === 0) {
      menu.append(new MenuItem({ label: 'No downloads yet', enabled: false }))
      menu.popup({ window, x, y })
      return
    }
    for (const download of downloads) {
      menu.append(this.downloadItem(download))
    }
    menu.popup({ window, x, y })
  }

  /** Stop every running download of a project whose browser data is being
   *  cleared. The records settle as cancelled through each `done` event. */
  cancelProject(projectId: string): void {
    for (const record of this.downloads.values()) {
      if (record.download.projectId !== projectId) continue
      if (record.download.state !== 'progressing') continue
      record.item?.cancel()
    }
  }

  /** Forget a project's downloads, because the project itself is gone. Kept
   *  bytes are this app's own artifacts and go with the records. */
  forgetProject(projectId: string): void {
    let removed = false
    for (const [id, record] of [...this.downloads]) {
      if (record.download.projectId !== projectId) continue
      if (record.download.state === 'progressing') continue
      if (record.stagedPath.length > 0) void removeFileQuietly(record.stagedPath)
      this.downloads.delete(id)
      this.removedRecords.add(id)
      removed = true
    }
    if (removed) this.schedulePersist()
  }

  /**
   * Keep every running download across the quit that is about to happen.
   *
   * Chromium removes a running download's file as the session is torn down, so
   * each one is paused and given a moment to stop writing, then its bytes are
   * moved beside the target file   where Chromium will not look   and the records
   * are written. The next launch resumes them; without this step a quit leaves a
   * record with nothing to resume from.
   */
  async prepareForQuit(): Promise<void> {
    const running = [...this.downloads.values()]
      .filter((record) => record.item !== null && record.download.state === 'progressing')
      // The pause below is the app stopping the download so its bytes can be
      // moved, not a pause the user asked for, so their own intent is read first
      // and written back after.
      .map((record) => ({ record, pausedByUser: record.download.paused }))
    if (running.length === 0) {
      if (this.persistTimer) clearTimeout(this.persistTimer)
      this.persistTimer = null
      await this.persist()
      return
    }
    for (const { record, pausedByUser } of running) {
      if (!pausedByUser) record.item?.pause()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, QUIT_PAUSE_SETTLE_MS))
    for (const { record, pausedByUser } of running) {
      const item = record.item
      if (!item) continue
      const savePath = item.getSavePath() || record.download.savePath
      const receivedBytes = item.getReceivedBytes()
      const totalBytes = item.getTotalBytes() || record.download.totalBytes
      record.download = {
        ...record.download,
        savePath,
        receivedBytes,
        totalBytes,
        speedBytes: 0,
        paused: pausedByUser,
        // Nothing is downloading this any more and its bytes are about to leave
        // Chromium's reach, so from here on the record describes a stopped
        // download, which is how the next launch reads it back anyway. It also
        // keeps the record out of `inFlight()`: the set a quit would have to stop
        // is empty once it has stopped them.
        state: 'interrupted',
        // The bytes about to be moved aside are the resume point, so the offset
        // never exceeds what was written.
        progress: this.progressFor(receivedBytes, totalBytes)
      }
      record.stagedPath = await stagePartialDownload(savePath)
    }
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    await this.persist()
  }

  /** Release the manager as the process ends. Downloads are never cancelled here:
   *  their bytes are what a later launch resumes from. */
  dispose(): void {
    for (const pending of this.pendingAdoptions.values()) clearTimeout(pending.timer)
    this.pendingAdoptions.clear()
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    this.downloads.clear()
    this.watchedPartitions.clear()
  }

  /** Route a `will-download` into the record it belongs to: a resume or retry the
   *  manager asked for, or a download the user just started. */
  private handleDownload(projectId: string, item: DownloadItem, contentsId?: number): void {
    const url = item.getURL().slice(0, MAX_BROWSER_URL_LENGTH)
    const savePath = item.getSavePath()
    const resumed = savePath.length > 0 ? this.takeAdoption(`resume:${savePath}`) : null
    if (resumed) {
      this.adoptResumed(projectId, resumed.id, item)
      return
    }
    const retry = this.takeAdoption(`retry:${url}`)
    if (retry) {
      const record = this.downloads.get(retry.id)
      if (record?.download.savePath) {
        // The same file the download already had, without asking again: this is
        // the download the user just told the app to start over.
        item.setSavePath(record.download.savePath)
      }
    } else {
      item.setSaveDialogOptions({
        title: 'Save downloaded file',
        // Chromium's own filename determination (the `download` attribute, a
        // Content-Disposition header, the URL's last segment) is what makes the
        // suggestion right during a save, so it is kept for every new download.
        defaultPath: join(app.getPath('downloads'), safeBasename(item.getFilename()))
      })
    }

    const id = retry?.id ?? crypto.randomUUID()
    const record: TrackedDownload = {
      download: {
        id,
        tabId: contentsId === undefined ? '' : (this.findTabId?.(projectId, contentsId) ?? ''),
        projectId,
        fileName: safeBasename(item.getFilename()),
        url,
        mimeType: item.getMimeType().slice(0, 256),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        speedBytes: 0,
        progress: item.getPercentComplete(),
        state: 'progressing',
        paused: false,
        savePath: item.getSavePath(),
        error: '',
        resumable: false,
        startedAt: Date.now()
      },
      item,
      urlChain: item.getURLChain(),
      lastModified: item.getLastModifiedTime(),
      eTag: item.getETag(),
      stagedPath: '',
      lastEmittedAt: 0
    }
    this.downloads.set(id, record)
    this.trackItem(id, item)
    this.emit(id, true)
    this.schedulePersist()
  }

  /** Attach to a download Chromium created for a resume, and let it continue. */
  private adoptResumed(projectId: string, id: string, item: DownloadItem): void {
    const record = this.downloads.get(id)
    if (!record) {
      // The record was dropped while the resume was in flight; the download is
      // still real, so it is tracked as a download of its own instead of being
      // left to finish unseen.
      this.handleDownload(projectId, item, undefined)
      return
    }
    record.item = item
    record.stagedPath = ''
    record.lastModified = item.getLastModifiedTime() || record.lastModified
    record.eTag = item.getETag() || record.eTag
    record.urlChain = item.getURLChain().length > 0 ? item.getURLChain() : record.urlChain
    record.download = {
      ...record.download,
      state: 'progressing',
      paused: false,
      speedBytes: 0,
      error: '',
      resumable: false,
      savePath: item.getSavePath() || record.download.savePath
    }
    this.trackItem(id, item)
    this.emit(id, true)
    this.schedulePersist()
    // The download Chromium created for a resume waits for this call.
    setImmediate(() => item.resume())
  }

  private trackItem(id: string, item: DownloadItem): void {
    item.on('updated', () => this.refreshFromItem(id))
    item.once('done', (_event, state) => {
      this.settleDownload(id, state as BrowserDownloadState)
    })
  }

  private refreshFromItem(id: string): void {
    const record = this.downloads.get(id)
    const item = record?.item
    if (!record || !item) return
    const state = item.getState()
    record.download = {
      ...record.download,
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes() || record.download.totalBytes,
      speedBytes: item.getCurrentBytesPerSecond(),
      progress: item.getPercentComplete(),
      paused: item.isPaused(),
      savePath: item.getSavePath() || record.download.savePath,
      // A download Chromium reports as interrupted is settled by its `done`
      // event; anything else here is this run still downloading it.
      state: state === 'progressing' ? 'progressing' : record.download.state
    }
    const lastModified = item.getLastModifiedTime()
    if (lastModified.length > 0) record.lastModified = lastModified
    const eTag = item.getETag()
    if (eTag.length > 0) record.eTag = eTag
    this.emit(id)
    this.schedulePersist()
  }

  /** Settle a download Chromium finished, cancelled or gave up on. */
  private settleDownload(id: string, finished: BrowserDownloadState): void {
    const record = this.downloads.get(id)
    const item = record?.item
    if (!record || !item) return
    const receivedBytes = item.getReceivedBytes()
    const totalBytes = item.getTotalBytes() || record.download.totalBytes
    const savePath = item.getSavePath() || record.download.savePath
    record.item = null
    const lastModified = item.getLastModifiedTime()
    if (lastModified.length > 0) record.lastModified = lastModified
    const eTag = item.getETag()
    if (eTag.length > 0) record.eTag = eTag
    record.urlChain = item.getURLChain().length > 0 ? item.getURLChain() : record.urlChain

    if (finished === 'completed') {
      record.download = {
        ...record.download,
        state: 'completed',
        paused: false,
        savePath,
        receivedBytes: receivedBytes || totalBytes,
        totalBytes,
        speedBytes: 0,
        progress: 100,
        resumable: false,
        error: ''
      }
    } else if (finished === 'cancelled') {
      record.download = {
        ...record.download,
        state: 'cancelled',
        paused: false,
        savePath,
        receivedBytes: 0,
        totalBytes,
        speedBytes: 0,
        progress: 0,
        resumable: false,
        error: ''
      }
    } else {
      record.download = {
        ...record.download,
        state: 'interrupted',
        paused: false,
        savePath,
        receivedBytes,
        totalBytes,
        speedBytes: 0,
        progress: this.progressFor(receivedBytes, totalBytes),
        // Optimistic until the file is measured below: Chromium keeps an
        // interrupted download's bytes, and the measurement is what makes the
        // resume point exact.
        resumable: receivedBytes > 0 && hasResumeValidator(record.eTag, record.lastModified),
        error: receivedBytes > 0 ? 'The download was interrupted.' : ''
      }
    }
    this.emit(id, true)
    this.schedulePersist()
    if (finished === 'interrupted') void this.measureInterruptedBytes(id, savePath, receivedBytes)
    this.trimDownloads()
  }

  /** Confirm the bytes an interrupted download kept, so `Resume` is offered only
   *  when there is something to resume from. */
  private async measureInterruptedBytes(
    id: string,
    savePath: string,
    reportedBytes: number
  ): Promise<void> {
    const record = this.downloads.get(id)
    if (!record || record.download.state !== 'interrupted') return
    const bytes = await fileSizeOf(savePath)
    const offset = Math.min(reportedBytes, bytes)
    if (record.download.totalBytes > 0 && offset >= record.download.totalBytes) {
      // The whole file is on disk: only the completion event was lost, so the
      // download is settled as finished rather than offered a resume that would
      // start it over.
      record.download = {
        ...record.download,
        state: 'completed',
        receivedBytes: record.download.totalBytes,
        speedBytes: 0,
        progress: 100,
        resumable: false,
        error: ''
      }
      this.emit(id, true)
      this.schedulePersist()
      return
    }
    record.download = {
      ...record.download,
      receivedBytes: offset,
      progress: this.progressFor(offset, record.download.totalBytes),
      resumable:
        offset > 0 &&
        record.download.totalBytes > offset &&
        hasResumeValidator(record.eTag, record.lastModified),
      error:
        offset > 0
          ? 'The download was interrupted. Resume it to continue.'
          : 'The download was interrupted and nothing was kept, so it has to start over.'
    }
    this.emit(id, true)
    this.schedulePersist()
  }

  /** Resume a download no live item owns, from the bytes kept on disk. */
  private async resumeFromDisk(downloadId: string): Promise<void> {
    const record = this.downloads.get(downloadId)
    if (!record) return
    const { savePath, receivedBytes, totalBytes, startedAt, projectId, mimeType } = record.download
    const stagedPath = record.stagedPath || stagedDownloadPath(savePath)
    let bytes = await fileSizeOf(stagedPath)
    if (bytes > 0) {
      bytes = await restoreStagedDownload(stagedPath, savePath)
      record.stagedPath = ''
    } else {
      bytes = await fileSizeOf(savePath)
    }
    // Never larger than what this app wrote: a file that was longer before the
    // download started must not be mistaken for downloaded bytes.
    const offset = Math.min(receivedBytes, bytes)
    // A total Chromium never learned cannot be resumed: `length` is what tells it
    // when a resumed download has arrived, so there would be nothing to finish
    // against. A response that named neither an ETag nor a Last-Modified cannot
    // be resumed safely either: the range request would carry no validator, and
    // bytes from a file the server has since changed would be appended to.
    if (
      offset <= 0 ||
      totalBytes <= offset ||
      savePath.length === 0 ||
      !hasResumeValidator(record.eTag, record.lastModified)
    ) {
      // Nothing to continue from after all (the bytes were deleted by hand, or a
      // previous run failed before Chromium told us what the download was).
      this.retry(downloadId)
      return
    }
    const previous = record.download
    record.item = null
    record.download = {
      ...previous,
      state: 'progressing',
      paused: false,
      savePath,
      receivedBytes: offset,
      speedBytes: 0,
      progress: this.progressFor(offset, totalBytes),
      error: '',
      resumable: false
    }
    this.watchAdoption(`resume:${savePath}`, record, previous)
    this.emit(downloadId, true)
    this.schedulePersist()
    try {
      this.sessionFor(projectId).createInterruptedDownload({
        path: savePath,
        urlChain: record.urlChain,
        mimeType,
        offset,
        length: totalBytes,
        lastModified: record.lastModified.length > 0 ? record.lastModified : undefined,
        eTag: record.eTag.length > 0 ? record.eTag : undefined,
        startTime: Math.floor(startedAt / 1000)
      })
    } catch (error: unknown) {
      Logger.error('A browser download could not be resumed:', error)
      this.abandonAdoption(`resume:${savePath}`, 'The download could not be resumed.')
    }
  }

  /** Ask for a download and remember which record it belongs to, so the
   *  `will-download` it produces is adopted instead of listed twice. */
  private watchAdoption(key: string, record: TrackedDownload, previous: BrowserDownload): void {
    const existing = this.pendingAdoptions.get(key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this.abandonAdoption(key, 'The download could not be started again.')
    }, ADOPTION_TIMEOUT_MS)
    this.pendingAdoptions.set(key, { id: record.download.id, previous, timer })
  }

  private takeAdoption(key: string): PendingAdoption | null {
    const pending = this.pendingAdoptions.get(key)
    if (!pending) return null
    clearTimeout(pending.timer)
    this.pendingAdoptions.delete(key)
    return pending
  }

  /** An asked-for download never arrived: put the record back as it was, with the
   *  reason, instead of leaving a row that claims to be downloading. */
  private abandonAdoption(key: string, error: string): void {
    const pending = this.takeAdoption(key)
    if (!pending) return
    const record = this.downloads.get(pending.id)
    if (!record) return
    record.item = null
    record.download = { ...pending.previous, error }
    this.emit(record.download.id, true)
    this.schedulePersist()
  }

  /** One download as a submenu rooted at its labelled filename. */
  private downloadItem(download: BrowserDownload): MenuItem {
    const actions: MenuItemConstructorOptions[] = []
    if (download.state === 'progressing') {
      actions.push(
        {
          label: download.paused ? 'Resume' : 'Pause',
          click: () => (download.paused ? this.resume(download.id) : this.pause(download.id))
        },
        { label: 'Cancel', click: () => this.cancel(download.id) }
      )
    } else {
      if (download.state === 'completed' && download.savePath.length > 0) {
        actions.push({ label: 'Open', click: () => this.open(download.id) })
      }
      if (download.state === 'interrupted' && download.resumable) {
        actions.push({ label: 'Resume', click: () => this.resume(download.id) })
      }
      if (download.state === 'interrupted' || download.state === 'cancelled') {
        actions.push({ label: 'Start over', click: () => this.retry(download.id) })
      }
      if (download.savePath.length > 0) {
        actions.push({ label: 'Show in folder', click: () => this.reveal(download.id) })
      }
      actions.push({ label: 'Remove from list', click: () => this.remove(download.id) })
    }
    return new MenuItem({
      label: download.fileName,
      submenu: [
        { label: downloadStatusLabel(download), enabled: false },
        { type: 'separator' },
        ...actions
      ]
    })
  }

  /** The project's browser session, which is also the thing a resume or retry has
   *  to be issued through, so the download listener is registered here as well as
   *  when a tab first reaches the session: a download recovered from an earlier
   *  run can be resumed before any browser tab exists in this one. */
  private sessionFor(projectId: string): Session {
    const browserSession = session.fromPartition(browserPartitionFor(projectId))
    this.watchSession(projectId, browserSession)
    return browserSession
  }

  private progressFor(receivedBytes: number, totalBytes: number): number {
    if (totalBytes <= 0) return 0
    return Math.min(100, (receivedBytes / totalBytes) * 100)
  }

  private emit(id: string, force = false): void {
    const record = this.downloads.get(id)
    if (!record) return
    const window = this.deps.window()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    const now = Date.now()
    if (!force && now - record.lastEmittedAt < DOWNLOAD_EVENT_INTERVAL_MS) return
    record.lastEmittedAt = now
    sendToRenderer(window.webContents, 'browser:download', { ...record.download })
  }

  /** Coalesce progress into at most one write per interval. A request that
   *  arrives while a write is in flight is owed a write of its own rather than
   *  dropped: the write running now was built from the state before the request,
   *  so without this a record the user removed during it would be put back and
   *  never taken out again. */
  private schedulePersist(): void {
    if (this.persisting) {
      this.persistAgain = true
      return
    }
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, PERSIST_INTERVAL_MS)
  }

  private async persist(): Promise<void> {
    if (this.persisting) {
      this.persistAgain = true
      return
    }
    this.persisting = true
    // The ids are read once and cleared by id, never as a whole: a removal that
    // lands while this write is running belongs to the next write, and clearing
    // the set wholesale here would discard it before anything wrote it out.
    const removed = new Set(this.removedRecords)
    try {
      await this.store.save(this.snapshot(), removed)
      // Only a landed write means the dropped records are really gone from the
      // file; a failed one keeps them queued for the next attempt.
      for (const id of removed) this.removedRecords.delete(id)
    } catch {
      // The store logged the failure; the records are written again on the next
      // change, and a quit flushes them.
    } finally {
      this.persisting = false
      if (this.persistAgain) {
        this.persistAgain = false
        await this.persist()
      }
    }
  }

  private snapshot(): PersistedBrowserDownload[] {
    const updatedAt = Date.now()
    const records: PersistedBrowserDownload[] = []
    for (const record of this.downloads.values()) {
      records.push({
        id: record.download.id,
        tabId: record.download.tabId,
        projectId: record.download.projectId,
        fileName: record.download.fileName,
        url: record.download.url,
        urlChain: record.urlChain,
        mimeType: record.download.mimeType,
        receivedBytes: record.download.receivedBytes,
        totalBytes: record.download.totalBytes,
        progress: record.download.progress,
        state: record.download.state,
        paused: record.download.paused,
        savePath: record.download.savePath,
        stagedPath: record.stagedPath,
        lastModified: record.lastModified,
        eTag: record.eTag,
        error: record.download.error,
        startedAt: record.download.startedAt,
        updatedAt
      })
    }
    return records
  }

  private trimDownloads(): void {
    if (this.downloads.size <= MAX_TRACKED_DOWNLOADS) return
    const terminal = [...this.downloads.entries()].filter(
      ([, record]) => record.download.state !== 'progressing'
    )
    while (this.downloads.size > MAX_TRACKED_DOWNLOADS && terminal.length > 0) {
      const [id] = terminal.shift() ?? []
      if (!id) continue
      this.downloads.delete(id)
      this.removedRecords.add(id)
    }
  }
}
