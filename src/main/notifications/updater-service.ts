import electronUpdater from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import { Logger } from '../system/logger'
import type { UpdaterStatus } from '../../lib/ipc-contract'
import type { StorageEngine } from '../storage/storage-engine'
import { sendToRenderer } from '../ipc/renderer-delivery'

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
  /** True while the user explicitly asked for a check (Settings) — its failure is reportable. */
  private explicitCheckInFlight = false
  /** True while a check initiated by this service is still resolving. */
  private checkInFlight = false

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
      // During a check, the rejected check promise settles the state (see
      // `settleCheckFailure`) — the event must not race it into a sticky error.
      // Idle/checking states mean the failure came from a background check, so
      // a transient network issue must not leave a sticky sidebar badge.
      if (
        this.checkInFlight ||
        this._status.state === 'idle' ||
        this._status.state === 'checking'
      ) {
        return
      }
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
        sendToRenderer(win.webContents, 'updater:status', status)
      }
    }
  }

  start(): void {
    if (this.timer || !this._status.canAutoUpdate) return
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

  /**
   * Check for updates. When `explicit` is set (user initiated from Settings), a
   * failure is reported as a visible error state; background checks (startup,
   * periodic) fail silently back to idle so a transient network issue never
   * leaves a permanent error badge in the sidebar.
   */
  async checkForUpdates(explicit = false): Promise<UpdaterStatus> {
    if (!this._status.canAutoUpdate) return this.status
    this.explicitCheckInFlight = explicit
    this.checkInFlight = true
    try {
      await this.applyConfiguredChannel()
      autoUpdater
        .checkForUpdates()
        .catch((error: unknown) => {
          Logger.error('Updater: check failed', error)
          this.settleCheckFailure(error)
        })
        .finally(() => {
          this.checkInFlight = false
          this.explicitCheckInFlight = false
        })
    } catch (error: unknown) {
      Logger.error('Updater: check failed', error)
      this.checkInFlight = false
      this.explicitCheckInFlight = false
      this.settleCheckFailure(error)
    }
    return this.status
  }

  /** Resolve a failed check: sticky error only when the user asked for it. */
  private settleCheckFailure(error: unknown): void {
    if (this._status.state === 'downloaded' || this._status.state === 'downloading') return
    if (!this.explicitCheckInFlight) {
      // Transient (often offline) background failure — keep the sidebar calm
      // and never clobber a meaningful state (available/waiting/downloaded).
      if (this._status.state === 'checking' || this._status.state === 'error') {
        this.updateState({ state: 'idle' })
      }
      return
    }
    this.updateState({
      state: 'error',
      errorMessage: error instanceof Error ? error.message : 'Update check failed'
    })
  }

  /**
   * Point the auto-updater at the configured release channel before checking.
   * `nightly` resolves the GitHub provider's `nightly-*.yml` feed; the default
   * (stable) uses the published release feed.
   */
  private async applyConfiguredChannel(): Promise<void> {
    try {
      const config = await this.storage.getConfig()
      const nightly = config.updateChannel === 'nightly'
      const channel = nightly ? 'nightly' : null
      if (autoUpdater.channel !== channel) {
        autoUpdater.channel = channel
        Logger.dev('Updater: channel set to', channel ?? 'latest')
      }
      // Nightlies are published as semver-lower prereleases on a non-latest tag
      // (`vX.Y.Z-nightly.N`), so the GitHub provider only finds their feed file
      // when prereleases are allowed. Without this it resolves the latest stable
      // release, whose artifacts are `latest-*.yml`, and 404s on `nightly-*.yml`.
      // Re-assert every check so opting back out to stable clears it too.
      autoUpdater.allowPrerelease = nightly
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
    // Mirrors AppHeader's pulse (anyProjectWorking / anyChatWorking):
    // only sessions with `sessionStatuses === 'working'` count. Idle PTYs,
    // `waiting` sessions, pending permissions/questions, compactions,
    // brainstorm/loop runs and remote blockedQuit do not pulse the header
    // and must not block "Restart to update".
    const engine = this.chatEngine as unknown as { workingSessionCount?: () => number } | null
    if (engine?.workingSessionCount) return engine.workingSessionCount()
    let count = this.chatEngine?.activeSessionCount() ?? 0
    for (const source of this.activitySources) {
      count += source.activeSessionCount()
    }
    return count
  }

  private broadcastWaitingForThreads(count: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        sendToRenderer(win.webContents, 'updater:waiting-for-threads', count)
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
