/**
 * Download tracking for the embedded browser. Owns the tracked-download map,
 * the save-dialog defaults, throttled renderer events, and the cancel/pause/
 * resume/open/reveal actions the renderer drives.
 */

import { BrowserWindow, Menu, MenuItem, app, shell, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { BrowserDownload, BrowserDownloadState } from '../../../lib/ipc-contract'
import { downloadStatusLabel } from './browser-download-label'
import { sendToRenderer } from '../../ipc/renderer-delivery'
import {
  DOWNLOAD_EVENT_INTERVAL_MS,
  MAX_TRACKED_DOWNLOADS,
  safeBasename
} from './browser-validation'
import type { BrowserDownloadRecord } from './browser-types'

export interface BrowserDownloadTrackerDeps {
  window: BrowserWindow
  /** Tab id of the WebContentsView that started a download, when known. */
  findTabId: (projectId: string, contentsId: number) => string | undefined
}

export class BrowserDownloadTracker {
  private readonly downloads = new Map<string, BrowserDownloadRecord>()

  constructor(private readonly deps: BrowserDownloadTrackerDeps) {}

  /** Route a session download through the app-scoped save dialog and tracker. */
  handleDownload(projectId: string, item: Electron.DownloadItem, contentsId: number): void {
    const tabId = this.deps.findTabId(projectId, contentsId) ?? ''
    const fileName = safeBasename(item.getFilename())
    const defaultPath = join(app.getPath('downloads'), fileName)
    item.setSaveDialogOptions({
      title: 'Save downloaded file',
      defaultPath
    })

    const id = crypto.randomUUID()
    const record: BrowserDownloadRecord = {
      item,
      download: {
        id,
        tabId,
        projectId,
        fileName,
        url: item.getURL().slice(0, 2048),
        mimeType: item.getMimeType().slice(0, 256),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        speedBytes: item.getCurrentBytesPerSecond(),
        progress: item.getPercentComplete(),
        state: 'progressing',
        paused: false,
        savePath: '',
        error: ''
      },
      lastEmittedAt: 0
    }
    this.downloads.set(id, record)
    this.emitDownload(id)

    item.on('updated', () => {
      const current = this.downloads.get(id)
      if (!current) return
      current.download = {
        ...current.download,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes() || current.download.totalBytes,
        speedBytes: item.getCurrentBytesPerSecond(),
        progress: item.getPercentComplete(),
        paused: item.isPaused()
      }
      this.emitDownload(id)
    })
    item.once('done', (_event, state) => {
      const current = this.downloads.get(id)
      if (!current) return
      const finished = state as BrowserDownloadState
      current.download = {
        ...current.download,
        state: finished,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes() || current.download.totalBytes,
        progress: item.getPercentComplete(),
        paused: false,
        savePath: item.getSavePath(),
        error:
          finished === 'interrupted'
            ? 'The download was interrupted and could not resume.'
            : current.download.error
      }
      this.emitDownload(id, true)
      this.trimDownloads()
    })
  }

  list(projectId: string): BrowserDownload[] {
    return [...this.downloads.values()]
      .filter((record) => record.download.projectId === projectId)
      .map((record) => ({ ...record.download }))
  }

  cancel(downloadId: string): void {
    this.downloads.get(downloadId)?.item.cancel()
  }

  pause(downloadId: string): void {
    const record = this.downloads.get(downloadId)
    if (record && !record.item.isPaused()) {
      record.item.pause()
      record.download = { ...record.download, paused: true }
      this.emitDownload(record.download.id, true)
    }
  }

  resume(downloadId: string): void {
    const record = this.downloads.get(downloadId)
    if (record && record.item.canResume()) {
      record.item.resume()
      record.download = { ...record.download, paused: false }
      this.emitDownload(record.download.id, true)
    }
  }

  open(downloadId: string): void {
    const record = this.downloads.get(downloadId)
    if (record && record.download.savePath) void shell.openPath(record.download.savePath)
  }

  reveal(downloadId: string): boolean {
    const record = this.downloads.get(downloadId)
    if (!record?.download.savePath) return false
    shell.showItemInFolder(record.download.savePath)
    return true
  }

  /** Open the OS-native downloads menu for a project, anchored under the
   *  toolbar's download button. The menu composites above the WebContentsView,
   *  so the panel's layout never has to change for it. Each entry carries the
   *  actions its live state allows; clicking a filename opens the file. */
  showMenu(projectId: string, x: number, y: number): void {
    if (this.deps.window.isDestroyed()) return
    const menu = new Menu()
    const downloads = this.list(projectId)
    if (downloads.length === 0) {
      menu.append(new MenuItem({ label: 'No downloads yet', enabled: false }))
      menu.popup({ window: this.deps.window, x, y })
      return
    }
    for (const download of downloads) {
      menu.append(this.downloadItem(download))
    }
    menu.popup({ window: this.deps.window, x, y })
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
      if (download.state === 'completed' && download.savePath) {
        actions.push({ label: 'Open', click: () => this.open(download.id) })
      }
      if (download.savePath) {
        actions.push({ label: 'Show in folder', click: () => this.reveal(download.id) })
      }
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

  /** Cancel every in-flight download that belongs to a project being cleared. */
  cancelProject(projectId: string): void {
    for (const record of this.downloads.values()) {
      if (record.download.projectId === projectId && record.download.state === 'progressing') {
        record.item.cancel()
      }
    }
  }

  dispose(): void {
    for (const record of this.downloads.values()) {
      if (record.download.state === 'progressing') record.item.cancel()
    }
    this.downloads.clear()
  }

  private emitDownload(id: string, force = false): void {
    const record = this.downloads.get(id)
    if (!record || this.deps.window.webContents.isDestroyed()) return
    const now = Date.now()
    if (!force && now - record.lastEmittedAt < DOWNLOAD_EVENT_INTERVAL_MS) return
    record.lastEmittedAt = now
    sendToRenderer(this.deps.window.webContents, 'browser:download', { ...record.download })
  }

  private trimDownloads(): void {
    if (this.downloads.size <= MAX_TRACKED_DOWNLOADS) return
    const terminal = [...this.downloads.entries()].filter(
      ([, record]) => record.download.state !== 'progressing'
    )
    while (this.downloads.size > MAX_TRACKED_DOWNLOADS && terminal.length > 0) {
      const [id] = terminal.shift() ?? []
      if (id) this.downloads.delete(id)
    }
  }
}
