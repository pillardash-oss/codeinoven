import electronUpdater from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import { Logger } from './logger'
import type { UpdaterStatus } from '../lib/ipc-contract'
import type { StorageEngine } from './storage-engine'

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFERRED_POLL_MS = 5_000
const PENDING_INSTALL_FILE = 'updater/install-pending.json'
const { autoUpdater } = electronUpdater

/** Anything that can report how much interactive work would be interrupted by a restart. */
export interface SessionActivitySource {
  activeSessionCount(): number
}

interface PendingInstallState {
  pending: boolean
  approved: boolean
}

export class UpdaterService {
  private storage: StorageEngine
  private chatEngine: SessionActivitySource | null = null
  private activitySources: SessionActivitySource[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private _status: UpdaterStatus
  private statusListeners: Set<(status: UpdaterStatus) => void> = new Set()
  private deferredInstallPoll: ReturnType<typeof setInterval> | null = null
  private installPending = false
  private installApproved = false

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

  setChatEngine(engine: SessionActivitySource | null): void {
    this.chatEngine = engine
  }

  /** Register an extra activity source (terminal sessions, remote sessions, …). */
  addActivitySource(source: SessionActivitySource): void {
    this.activitySources.push(source)
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
    void this.resumePendingInstall()
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
    // Persist a still-pending install so the next launch resumes it.
    if (this.installPending) {
      void this.persistPendingInstall()
    }
  }

  async checkForUpdates(): Promise<UpdaterStatus> {
    try {
      await this.applyConfiguredChannel()
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

  /**
   * Point the auto-updater at the configured release channel before checking.
   * `nightly` resolves the GitHub provider's `latest-nightly.yml` feed; the
   * default (stable) uses the published release feed.
   */
  private async applyConfiguredChannel(): Promise<void> {
    try {
      const config = await this.storage.getConfig()
      const channel = config.updateChannel === 'nightly' ? 'nightly' : null
      if (autoUpdater.channel !== channel) {
        autoUpdater.channel = channel
        Logger.dev('Updater: channel set to', channel ?? 'latest')
      }
    } catch (error: unknown) {
      Logger.error('Updater: failed to read update channel', error)
    }
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

  /**
   * Explicit user approval to install. Never interrupts active sessions: the
   * install runs once every session and child process has finished.
   */
  quitAndInstall(): void {
    if (this._status.state !== 'downloaded') return
    this.installApproved = true
    void this.persistPendingInstall()
    void this.installWhenIdle()
  }

  /**
   * Install once all sessions are idle — the safe, non-forced install path.
   * Keeps waiting (polling) until every activity source reports idle, then
   * installs exactly once. There is no timeout and no forced quit.
   */
  async installWhenIdle(): Promise<void> {
    if (this._status.state !== 'downloaded') return
    this.installPending = true
    await this.persistPendingInstall()
    this.performDeferredInstall()
  }

  private async handleAutoDownload(): Promise<void> {
    const config = await this.storage.getConfig()
    if (!config.autoDownloadUpdates) return
    if (this._status.state !== 'available') return
    await this.downloadUpdate()
  }

  private async handleAutoInstall(): Promise<void> {
    if (this.installPending) {
      await this.installWhenIdle()
      return
    }
    const config = await this.storage.getConfig()
    if (!config.autoInstallUpdates) return
    await this.installWhenIdle()
  }

  /** Resume an install that was pending when the previous launch shut down. */
  private async resumePendingInstall(): Promise<void> {
    try {
      const pending = await this.storage.read<PendingInstallState>(PENDING_INSTALL_FILE)
      if (!pending?.pending) return
      this.installPending = true
      this.installApproved = pending.approved === true
      if (this._status.state === 'downloaded') {
        this.performDeferredInstall()
      }
    } catch (error: unknown) {
      Logger.error('Updater: failed to resume pending install', error)
    }
  }

  private async persistPendingInstall(): Promise<void> {
    try {
      await this.storage.write(PENDING_INSTALL_FILE, {
        pending: this.installPending,
        approved: this.installApproved
      })
    } catch (error: unknown) {
      Logger.error('Updater: failed to persist pending install', error)
    }
  }

  private performDeferredInstall(): void {
    if (!this.installPending) return
    const activeCount = this.activeSessionCount()
    if (activeCount === 0) {
      this.quitAndInstallNow()
      return
    }

    this.updateState({ state: 'waiting' })
    this.broadcastWaitingForThreads(activeCount)

    this.clearDeferredInstall()
    this.deferredInstallPoll = setInterval(() => {
      const remaining = this.activeSessionCount()
      if (remaining === 0) {
        this.clearDeferredInstall()
        this.quitAndInstallNow()
        return
      }
      this.broadcastWaitingForThreads(remaining)
    }, DEFERRED_POLL_MS)
  }

  private activeSessionCount(): number {
    let count = this.chatEngine?.activeSessionCount() ?? 0
    for (const source of this.activitySources) {
      count += source.activeSessionCount()
    }
    return count
  }

  private broadcastWaitingForThreads(count: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('updater:waiting-for-threads', count)
      }
    }
  }

  private quitAndInstallNow(): void {
    this.installPending = false
    this.installApproved = false
    this.updateState({ state: 'idle' })
    void this.storage
      .write(PENDING_INSTALL_FILE, { pending: false, approved: false })
      .catch((error: unknown) => {
        Logger.error('Updater: failed to clear pending install', error)
      })
    autoUpdater.quitAndInstall(false)
  }

  private clearDeferredInstall(): void {
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
