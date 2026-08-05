import electronUpdater from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import { Logger } from './logger'
import type { UpdaterStatus } from '../lib/ipc-contract'
import type { StorageEngine } from './storage-engine'
import type { ChatEngine } from './chat-engine'

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFERRED_MAX_WAIT_MS = 30 * 60 * 1000
const DEFERRED_POLL_MS = 5_000
const { autoUpdater } = electronUpdater

export class UpdaterService {
  private storage: StorageEngine
  private chatEngine: ChatEngine | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private _status: UpdaterStatus
  private statusListeners: Set<(status: UpdaterStatus) => void> = new Set()
  private deferredInstallTimer: ReturnType<typeof setTimeout> | null = null
  private deferredInstallPoll: ReturnType<typeof setInterval> | null = null
  private installPending = false

  constructor(storage: StorageEngine) {
    this.storage = storage
    this._status = {
      canAutoUpdate: autoUpdater.isUpdaterActive(),
      state: 'idle',
      currentVersion: app.getVersion()
    }
    autoUpdater.logger = {
      info: (...args: unknown[]) => Logger.dev('[updater]', ...args),
      warn: (...args: unknown[]) => Logger.dev('[updater]', ...args),
      error: (...args: unknown[]) => Logger.error('[updater]', ...args)
    } satisfies {
      info: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
    }
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => {
      Logger.dev('Updater: checking for update')
      this.updateState({ state: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
      Logger.dev('Updater: update available', info)
      this.updateState({
        state: 'available',
        availableVersion: info.version
      })
      void this.handleAutoDownload()
    })

    autoUpdater.on('update-not-available', () => {
      Logger.dev('Updater: no update available')
      this.updateState({ state: 'idle' })
    })

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent)
      this.updateState({
        state: 'downloading',
        downloadProgress: percent
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      Logger.dev('Updater: update downloaded', info)
      this.updateState({
        state: 'downloaded',
        availableVersion: info.version,
        downloadProgress: 100
      })
      void this.handleAutoInstall()
    })

    autoUpdater.on('error', (error) => {
      Logger.error('Updater error:', error.message)
      this.updateState({
        state: 'error',
        errorMessage: error.message
      })
    })
  }

  setChatEngine(engine: ChatEngine | null): void {
    this.chatEngine = engine
  }

  get status(): UpdaterStatus {
    return { ...this._status }
  }

  onStatusChange(callback: (status: UpdaterStatus) => void): () => void {
    this.statusListeners.add(callback)
    return () => {
      this.statusListeners.delete(callback)
    }
  }

  broadcastToWindows(): void {
    const status = this.status
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('updater:status', status)
      }
    }
  }

  start(): void {
    if (this.timer) return
    void this.checkForUpdates()
    this.timer = setInterval(() => {
      void this.checkForUpdates()
    }, UPDATE_CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.clearDeferredInstall()
  }

  async checkForUpdates(): Promise<UpdaterStatus> {
    try {
      autoUpdater.checkForUpdates().catch((error: unknown) => {
        Logger.error('Updater: check failed', error)
        if (this._status.state !== 'downloaded' && this._status.state !== 'downloading') {
          this.updateState({
            state: 'error',
            errorMessage: error instanceof Error ? error.message : 'Update check failed'
          })
        }
      })
    } catch (error: unknown) {
      Logger.error('Updater: check failed', error)
      if (this._status.state !== 'downloaded' && this._status.state !== 'downloading') {
        this.updateState({
          state: 'error',
          errorMessage: error instanceof Error ? error.message : 'Update check failed'
        })
      }
    }
    return this.status
  }

  async downloadUpdate(): Promise<void> {
    if (this._status.state !== 'available') return
    try {
      autoUpdater.downloadUpdate().catch((error: unknown) => {
        Logger.error('Updater: download failed', error)
        this.updateState({
          state: 'error',
          errorMessage: error instanceof Error ? error.message : 'Download failed'
        })
      })
    } catch (error: unknown) {
      Logger.error('Updater: download failed', error)
      this.updateState({
        state: 'error',
        errorMessage: error instanceof Error ? error.message : 'Download failed'
      })
    }
  }

  quitAndInstall(): void {
    if (this._status.state !== 'downloaded') return
    this.installPending = true
    void this.performDeferredInstall()
  }

  private async handleAutoDownload(): Promise<void> {
    const config = await this.storage.getConfig()
    if (!config.autoDownloadUpdates) return
    if (this._status.state !== 'available') return
    await this.downloadUpdate()
  }

  private async handleAutoInstall(): Promise<void> {
    const config = await this.storage.getConfig()
    if (!config.autoInstallUpdates) return
    this.installPending = true
    void this.performDeferredInstall()
  }

  private async performDeferredInstall(): Promise<void> {
    if (!this.chatEngine) {
      this.quitAndInstallNow()
      return
    }

    const activeCount = this.chatEngine.activeSessionCount()
    if (activeCount === 0) {
      this.quitAndInstallNow()
      return
    }

    this.updateState({ state: 'waiting' })
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('updater:waiting-for-threads', activeCount)
      }
    }

    const startTime = Date.now()
    this.deferredInstallPoll = setInterval(() => {
      const elapsed = Date.now() - startTime
      if (elapsed >= DEFERRED_MAX_WAIT_MS) {
        this.clearDeferredInstall()
        this.quitAndInstallNow()
        return
      }
      if (!this.chatEngine) {
        this.clearDeferredInstall()
        this.quitAndInstallNow()
        return
      }
      const remaining = this.chatEngine.activeSessionCount()
      if (remaining === 0) {
        this.clearDeferredInstall()
        this.quitAndInstallNow()
      }
    }, DEFERRED_POLL_MS)
  }

  private quitAndInstallNow(): void {
    this.updateState({ state: 'idle' })
    autoUpdater.quitAndInstall(false)
  }

  private clearDeferredInstall(): void {
    if (this.deferredInstallTimer) {
      clearTimeout(this.deferredInstallTimer)
      this.deferredInstallTimer = null
    }
    if (this.deferredInstallPoll) {
      clearInterval(this.deferredInstallPoll)
      this.deferredInstallPoll = null
    }
  }

  private updateState(partial: Partial<UpdaterStatus>): void {
    this._status = { ...this._status, ...partial }
    this.broadcastToWindows()
    for (const listener of this.statusListeners) {
      listener(this._status)
    }
  }
}
