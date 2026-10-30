import electronUpdater from 'electron-updater'
import { BrowserWindow, app, autoUpdater as nativeAutoUpdater } from 'electron'
import os from 'node:os'
import { Logger } from '../system/logger'
import type {
  BrowserDownload,
  CloseConfirmationProject,
  UpdateBlockerTerminal,
  UpdateBlockers,
  UpdaterChangelog,
  UpdaterStatus
} from '../../lib/ipc-contract'
import type { ReleaseChannel } from '../../lib/download-mirror'
import { isWindowsStorePackage } from '../../lib/utils'
import { isShippedBuild } from '../bootstrap/app-resources'
import type { StorageEngine } from '../storage/storage-engine'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { markBackgroundRelaunch } from './updater-relaunch'
import { UpdaterReleaseProvider } from './updater-release-provider'
import {
  INSTALL_ATTEMPT_LIMIT,
  INSTALL_DISPATCH_FILE,
  INSTALL_FAILURE_FILE,
  isRunningNewestBuild,
  nextFailureState,
  nextInstallPermitted,
  purgeAbandonedInstallStaging,
  readMacBundleIdentifier,
  resolveDispatchOutcome,
  suppressedInstallReason,
  type InstallDispatch,
  type InstallFailureState,
  type StagingSweepContext
} from './updater-install-recovery'
import {
  getAppCacheDir,
  resolveUpdaterCacheLocation,
  seedUpdaterCache,
  selectUpdateArtifact,
  updateDownloadSources,
  type ResolvedUpdateArtifact,
  type UpdateArtifactInfo
} from './updater-download'

const UPDATE_CHECK_TIMEOUT_MS = 30_000
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFERRED_POLL_MS = 5_000
/**
 * How long a dispatched install may leave this process running before it counts
 * as failed. The payload is handed to the platform installer, which quits us to
 * swap the bundle; macOS ShipIt can reject a staged build without ever quitting
 * us or reporting anything, and that is exactly the shape that used to leave the
 * install surface spinning forever.
 */
const INSTALL_QUIT_WATCHDOG_MS = 30_000
const PENDING_INSTALL_FILE = 'updater/install-pending.json'
/** GitHub release lookup by exact tag (public repo, no auth needed). */
function githubReleaseTagUrl(tag: string): string {
  return `https://api.github.com/repos/pillardash-oss/codeinoven/releases/tags/${encodeURIComponent(tag)}`
}
/** Refetch window for the cached changelog; avoids hammering the API per visit. */
const CHANGELOG_CACHE_MS = 15 * 60 * 1000
/** Hard cap on the notes body sent over IPC and rendered. */
const CHANGELOG_MAX_NOTES_CHARS = 40_000
/** Release download base of the published feed (public repo, no auth needed). */
const GITHUB_RELEASES_DOWNLOAD_URL =
  'https://github.com/pillardash-oss/codeinoven/releases/download'
const { autoUpdater } = electronUpdater

/** Anything that can report how much interactive work would be interrupted by a restart. */
export interface SessionActivitySource {
  activeSessionCount(): number
  /**
   * Optional narrower count: only the work actively being produced, leaving the
   * waiting, queued and child work {@link activeSessionCount} also includes out
   * of it. The chat engine implements it so the install gate mirrors the header
   * pulse instead of blocking on a card the user has not answered yet.
   */
  workingSessionCount?(): number
  /**
   * Optional authoritative sweep run before an install decision: settle the work
   * this source believes is running but cannot corroborate, and return how much
   * it settled. A source whose count is a direct observation of live resources
   * (a terminal session) has nothing to reconcile and omits this.
   */
  reconcileUnverifiedWork?(): Promise<number>
  /**
   * Everything behind this source's count that is not a working thread, such as a
   * live terminal session. Listed in the same force-install modal as the threads,
   * because a restart takes both down and the user is being asked to approve
   * exactly that.
   */
  describeOtherSessions?(): UpdateBlockerTerminal[]
  /**
   * Stop everything this source counts. Reached only from the force-install
   * override the user explicitly confirms, so it may interrupt live work. Must be
   * best-effort and never throw: one source failing to stop must not keep the
   * others running.
   */
  terminateActiveWork?(): Promise<void>
}

interface PendingInstallState {
  pending: boolean
  approved: boolean
}

/**
 * Every browser download this process is running, as the install gate sees it.
 *
 * Supply-only interface: the browser owns the downloads and this service owns
 * the install decision, so the gate asks instead of holding a second copy of the
 * transfer state.
 */
export interface DownloadActivitySource {
  /** Downloads whose bytes are still arriving, across every project and box. */
  inFlightDownloads(): BrowserDownload[]
}

/** A download holds the unattended install back only while its bytes arrive. */
function activelyDownloading(downloads: readonly BrowserDownload[]): BrowserDownload[] {
  // A download the user paused is not progressing: it keeps its bytes and
  // resumes on demand, so waiting for it would hold an update indefinitely and
  // report a stall the user never asked for.
  return downloads.filter((download) => !download.paused && download.state === 'progressing')
}

export class UpdaterService {
  private editorIsActive: (() => boolean) | undefined
  setEditorActivitySource(source: () => boolean): void {
    this.editorIsActive = source
  }
  private storage: StorageEngine
  private chatEngine: SessionActivitySource | null = null
  /** How to name the working threads behind the engine's count, for the modal. */
  private workingThreadReport: (() => CloseConfirmationProject[]) | undefined
  private activitySources: SessionActivitySource[] = []
  /** The browser's live transfers, or null before the browser graph exists. */
  private downloadSource: DownloadActivitySource | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private _status: UpdaterStatus
  private statusListeners: Set<(status: UpdaterStatus) => void> = new Set()
  private deferredInstallPoll: ReturnType<typeof setInterval> | null = null
  /** True while a deferred-install decision is reconciling its activity sources. */
  private deferredInstallDeciding = false
  private installPending = false
  private installApproved = false
  /** True while the user explicitly asked for a check (Settings)   its failure is reportable. */
  private explicitCheckInFlight = false
  /** True while a check initiated by this service is still resolving. */
  private checkInFlight = false
  private changelogCache: {
    changelog: UpdaterChangelog | null
    fetchedAt: number
    /** Exact release tag the cached notes belong to (the installed version). */
    tag: string
  } | null = null
  /** Feed info of the newest available update, captured for the resumable seed. */
  private pendingUpdateInfo: UpdateArtifactInfo | null = null
  /** Selected release's channel, so the seed picks the matching mirror directory. */
  private activeChannel: ReleaseChannel = 'stable'
  /** True while a download (seed or electron-updater) is in flight. */
  private downloadInFlight = false
  /**
   * True while a menu bar "Check for Updates" is being honoured. It makes the
   * cycle ignore the background auto-download/auto-install preferences (a tray
   * click is a direct request) and turns the final install into a silent one
   * that relaunches windowless when nothing was on screen.
   */
  private forceUpdateInBackground = false
  /**
   * Brackets the quit lifecycle around an install. `begin` runs right before
   * `autoUpdater.quitAndInstall()` so the bootstrap can clear background mode's
   * park gate (otherwise the updater's own `app.quit()` is swallowed and the
   * update never applies); `end` runs when the install cannot proceed, so a
   * failed install leaves the app parkable in the menu bar as before.
   */
  private updateQuitHooks: { begin: () => void; end: () => void } | null = null
  /**
   * Installs of the current version that were handed to the platform installer
   * and never applied. A macOS ShipIt signature rejection produces no error
   * event, so the failure is only observable as "we relaunched on the old
   * version"; see `reconcileInstallDispatch`. The record bounds how many times
   * the automatic path may try the same build.
   */
  private installFailure: InstallFailureState | null = null
  /** True between handing the payload to the platform installer and its exit. */
  private installDispatched = false
  /** One retry of Squirrel's localhost GET per install dispatch. */
  private localTransferRetried = false
  /** Bounds how long a dispatched install may leave us running; see its arm site. */
  private installQuitWatchdog: ReturnType<typeof setTimeout> | null = null
  private installRecoveryPending = false
  /**
   * Runs at the start of every update-check cycle (startup, periodic, explicit).
   * Skill freshness rides this cadence instead of running a timer of its own.
   */
  private checkCycleHook: ((explicit: boolean) => void) | null = null

  constructor(storage: StorageEngine) {
    this.storage = storage
    this._status = {
      // A Store (MSIX) install cannot self-update. The package directory is
      // read-only, so the NSIS payload electron-updater would hand to the
      // platform installer has nowhere to install, and once a package has
      // identity the Store owns delivery. Gating here is enough: the periodic
      // timer, the explicit check, the tray path, the updater IPC and the fatal
      // recovery path all key off `canAutoUpdate`.
      //
      // A development launch is gated the same way, and not by
      // `autoUpdater.isUpdaterActive()` alone: that only asks
      // `app.isPackaged`, which a misbranded dev runtime reports as true, and
      // the check then opens `app-update.yml` in the Electron download's
      // Resources directory, where no packaged feed config exists (ENOENT).
      // Nothing updates during development anyway, so the app's own shipped
      // build signal decides.
      canAutoUpdate: isShippedBuild() && autoUpdater.isUpdaterActive() && !isWindowsStorePackage(),
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
    if (this._status.canAutoUpdate) {
      autoUpdater.setFeedURL({ provider: 'custom', updateProvider: UpdaterReleaseProvider })
    }

    autoUpdater.on('checking-for-update', () => {
      Logger.dev('Updater: checking for update')
      this.updateState({ state: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
      // A stale channel can make the feed offer a build the app already has, or
      // even an older one (a nightly of the release that is already installed),
      // and a bare release of the running nightly's own base is the same release
      // it previews. Handing either to the installer re-downloads and re-runs it
      // on every launch, so it is dropped before any download is started. See
      // `isRunningNewestBuild`.
      if (isRunningNewestBuild(app.getVersion(), info.version)) {
        Logger.dev('Updater: offered update is not newer than the running build; ignoring', {
          running: app.getVersion(),
          offered: info.version
        })
        this.pendingUpdateInfo = null
        this.updateState({ state: 'idle', blockedReason: undefined })
        return
      }
      Logger.dev('Updater: update available', info)
      // A nightly preference may select the stable release its cycle was
      // promoted to (a newer base than the nightly feed still offers). Download
      // from that release's mirror directory, rather than the preference's
      // channel.
      this.activeChannel = info.version.includes('-nightly') ? 'nightly' : 'stable'
      this.pendingUpdateInfo = {
        version: info.version,
        files: info.files
      }
      // A different version than the one that failed starts with a clean slate.
      if (this.installFailure !== null && this.installFailure.version !== info.version) {
        void this.clearInstallFailure()
      }
      this.updateState({
        state: 'available',
        availableVersion: info.version,
        blockedReason: undefined
      })
      void this.handleAutoDownload()
    })

    autoUpdater.on('update-not-available', () => {
      Logger.dev('Updater: no update available')
      this.pendingUpdateInfo = null
      this.forceUpdateInBackground = false
      this.updateQuitHooks?.end()
      this.updateState({ state: 'idle', blockedReason: undefined })
    })

    autoUpdater.on('download-progress', (progress) => {
      // Only update-downloaded confirms validation and publishes completion.
      const percent = Math.min(99, Math.floor(progress.percent))
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
      // Squirrel fetches the already verified ZIP from MacUpdater's localhost
      // server at install time. A dropped connection here is not a failed
      // internet download or a rejected build. Retry that GET once, keeping the
      // existing quit-on-download listener instead of calling quitAndInstall
      // again and registering another one.
      const localTransferFailed =
        process.platform === 'darwin' &&
        this.installDispatched &&
        (/network connection was lost/i.test(error.message) ||
          ('code' in error && error.code === -1005))
      if (localTransferFailed && !this.localTransferRetried) {
        this.localTransferRetried = true
        Logger.info('Updater: retrying the cached update transfer to the macOS installer')
        queueMicrotask(() => {
          if (!this.installDispatched) return
          try {
            nativeAutoUpdater.checkForUpdates()
            if (this.installDispatched) {
              this.armInstallQuitWatchdog(this._status.availableVersion)
            }
          } catch (retryError: unknown) {
            autoUpdater.emit(
              'error',
              retryError instanceof Error ? retryError : new Error(String(retryError))
            )
          }
        })
        return
      }
      this.forceUpdateInBackground = false
      // An install that fails inside the process never reaches the platform
      // installer, so record it here instead of waiting for the relaunch to
      // reveal it: macOS ShipIt, the NSIS installer, and the AppImage runtime
      // all fail silently from our side.
      const failedDispatch = this.installDispatched
      if (failedDispatch) {
        this.installDispatched = false
        this.clearInstallQuitWatchdog()
        if (localTransferFailed) {
          // Preserve the valid payload and failure budget. No build was
          // installed or rejected, and sweeping staging would race Squirrel.
          void this.storage.remove(INSTALL_DISPATCH_FILE).catch((cause: unknown) => {
            Logger.error('Updater: failed to clear the local transfer dispatch', cause)
          })
        } else {
          void this.recordInstallFailure(this._status.availableVersion)
        }
      }
      // An install that failed before it could quit must not leave the park gate
      // disabled: the app has to stay parkable in the menu bar.
      this.updateQuitHooks?.end()
      // An install that had already been handed over is never a background blip:
      // we are still running, the user clicked install, and nothing else is
      // going to tell them. Report it before the idle-state guard below, which
      // exists for transient check failures and would otherwise swallow it.
      if (failedDispatch) {
        this.updateState({
          state: 'error',
          errorMessage: localTransferFailed
            ? 'The update was downloaded and verified, but the local transfer to the macOS installer failed after retrying. Check for updates to retry the cached update.'
            : `The update could not be installed: ${error.message}`
        })
        return
      }
      // During a check, the rejected check promise settles the state (see
      // `settleCheckFailure`): the event must not race it into a sticky error.
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

  /**
   * Register the chat engine as the primary activity source, and with it how the
   * working threads behind its count are named for the force-install modal.
   *
   * The engine knows how many sessions are working but not their titles or
   * projects: those live in the database, which the engine has no business
   * querying for an install prompt. `workingThreads` is therefore supplied by the
   * bootstrap, sharing the one report the close gate already asks for.
   */
  setChatEngine(
    engine: SessionActivitySource | null,
    workingThreads?: () => CloseConfirmationProject[]
  ): void {
    this.chatEngine = engine
    this.workingThreadReport = engine ? workingThreads : undefined
  }

  /**
   * Register how an update install brackets the quit lifecycle. Background mode
   * parks on the `app.quit()` the updater triggers, which would leave a
   * downloaded update unapplied, so the bootstrap clears the park gate for the
   * duration of the install through these hooks.
   */
  attachUpdateQuitHooks(hooks: { begin: () => void; end: () => void }): void {
    this.updateQuitHooks = hooks
  }

  /**
   * Register an extra activity source (for example live terminal sessions). */
  addActivitySource(source: SessionActivitySource): void {
    this.activitySources.push(source)
  }

  /**
   * Register the browser's downloads as a gate on the unattended install.
   *
   * A quit stops a transfer: Chromium deletes the file of a running download as
   * its session goes away, so an install triggered mid-download both interrupts
   * the user's download and pops the close-confirmation prompt at them. Waiting
   * for the transfers to finish is what makes the automatic install silent.
   */
  setDownloadActivitySource(source: DownloadActivitySource | null): void {
    this.downloadSource = source
  }

  /**
   * Downloads the unattended install is still waiting on, oldest first.
   * An explicit install (`installApproved`) and a tray-initiated one are direct
   * requests: they proceed, and the shutdown pipeline keeps every running
   * download for a later resume, exactly as a manual quit does.
   */
  private blockingDownloads(): BrowserDownload[] {
    if (this.installApproved || this.forceUpdateInBackground) return []
    try {
      return activelyDownloading(this.downloadSource?.inFlightDownloads() ?? [])
    } catch (error: unknown) {
      Logger.error('Updater: failed to read browser downloads', error)
      return []
    }
  }

  /**
   * Describe everything standing between the app and the update it is waiting to
   * install, for the force-install modal.
   *
   * `activeCount` comes from the gate itself, so the modal's wording is derived
   * from the same number the rail is already showing. The lists come from each
   * source's own detail and can trail it by a poll, which is why the count is
   * sent separately rather than recomputed from the lists.
   */
  blockers(): UpdateBlockers {
    const terminals: UpdateBlockerTerminal[] = []
    for (const source of this.activitySources) {
      try {
        terminals.push(...(source.describeOtherSessions?.() ?? []))
      } catch (error: unknown) {
        Logger.error('Updater: failed to describe blocking activity', error)
      }
    }
    let projects: CloseConfirmationProject[] = []
    try {
      projects = this.workingThreadReport?.() ?? []
    } catch (error: unknown) {
      Logger.error('Updater: failed to describe working threads', error)
    }
    // Read once: the count and the list must describe the same instant, or the
    // modal's wording disagrees with the rows under it.
    const downloads = this.blockingDownloads()
    return {
      version: this._status.availableVersion ?? '',
      activeCount: this.activeSessionCount() + downloads.length,
      projects,
      terminals,
      downloads
    }
  }

  /**
   * Stop every activity source, then install without waiting for anything.
   *
   * The user's explicit override, reached only from the force-install modal and
   * only while an install is actually being held back. Two things happen in this
   * order on purpose. The work is stopped first, so the harness connections a
   * turn holds open are terminated by the same path a forced close uses instead
   * of being torn down mid-dispatch by the installer's exit; and the install then
   * reuses {@link quitAndInstallNow}, so a forced install records its dispatch,
   * clears the pending file and clears background mode's park gate exactly as an
   * ungated one does.
   *
   * The guard is `installPending` rather than the reported state, because the
   * state the modal is reached in is `waiting`   there is nothing to override
   * once a pending install is gone, and the case that matters is a click that
   * lands after the gate opened on its own, which is exactly what a cleared
   * `installPending` catches.
   *
   * Nothing here is recoverable once the user has asked, so a source that fails
   * to stop is reported and the install still proceeds: leaving the app open
   * behind an update they already approved would be the worse outcome.
   */
  async forceInstall(): Promise<void> {
    if (!this.installPending) return
    // The override wins outright. Clearing the gate first means a poll already
    // reconciling reads a cleared `installPending` when it resumes and never
    // dispatches a second install behind this one.
    this.installPending = false
    this.clearDeferredInstall()
    for (const source of [this.chatEngine, ...this.activitySources]) {
      if (!source?.terminateActiveWork) continue
      try {
        await source.terminateActiveWork()
      } catch (error: unknown) {
        Logger.error('Updater: could not stop active work before installing', error)
      }
    }
    this.quitAndInstallNow()
  }

  /**
   * Observe every update-check cycle. Used by the skill updater so installed
   * skills are looked at exactly when the user's "is there something newer"
   * expectation is met, without a second scheduler.
   */
  setCheckCycleHook(hook: ((explicit: boolean) => void) | null): void {
    this.checkCycleHook = hook
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
    this.installRecoveryPending = true
    // Install bookkeeping is optional. Slow or damaged storage must not hold
    // the first network check behind reconciliation.
    void this.checkForUpdates().catch((error: unknown) =>
      Logger.error('Updater: initial check failed', error)
    )
    void (async () => {
      try {
        await this.reconcileInstallDispatch()
        await this.resumePendingInstall()
      } catch (error: unknown) {
        Logger.error('Updater: install recovery failed; continuing update checks', error)
      } finally {
        this.installRecoveryPending = false
      }
    })().catch((error: unknown) => Logger.error('Updater: install recovery failed', error))
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
    this.clearInstallQuitWatchdog()
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
    // The cycle is announced before the `canAutoUpdate` guard on purpose: that
    // flag only gates the app's own binary feed (it is false in development and
    // wherever the updater is inactive), while installed skills still need
    // keeping fresh. The hook is fire-and-forget and never blocks the check.
    try {
      this.checkCycleHook?.(explicit)
    } catch (error: unknown) {
      Logger.error('Updater: check-cycle hook failed', error)
    }
    if (!this._status.canAutoUpdate) return this.status
    if (this.checkInFlight) return this.status
    this.explicitCheckInFlight = explicit
    this.checkInFlight = true
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await this.applyConfiguredChannel()
      await Promise.race([
        autoUpdater.checkForUpdates(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Update check timed out. Please try again.')),
            UPDATE_CHECK_TIMEOUT_MS
          )
        })
      ])
      // Some updater implementations resolve without emitting a terminal event.
      if (this._status.state === 'checking') this.updateState({ state: 'idle' })
    } catch (error: unknown) {
      Logger.error('Updater: check failed', error)
      this.settleCheckFailure(error)
    } finally {
      if (timeout) clearTimeout(timeout)
      this.checkInFlight = false
      this.explicitCheckInFlight = false
    }
    return this.status
  }

  /** Resolve a failed check: sticky error only when the user asked for it. */
  private settleCheckFailure(error: unknown): void {
    if (this._status.state === 'downloaded' || this._status.state === 'downloading') return
    if (!this.explicitCheckInFlight) {
      // Transient (often offline) background failure   keep the sidebar calm
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
   * Nightly considers both prereleases and stable releases; stable only
   * considers the published stable feed.
   */
  private async applyConfiguredChannel(): Promise<void> {
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const config = await Promise.race([
        this.storage.getConfig(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Update channel settings read timed out')),
            2_000
          )
        })
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
      })
      const nightly = config.updateChannel === 'nightly'
      // electron-updater's channel setter accepts only a string; its stable feed
      // is `latest`. Assigning `null` here threw "Channel must be a string, but
      // got: null", which the catch below swallowed and left the updater on
      // whatever channel the previous run had set.
      const channel = nightly ? 'nightly' : 'latest'
      // Nightlies are published as semver-lower prereleases on a non-latest tag
      // (`vX.Y.Z-nightly.N`), so the GitHub provider only finds their feed file
      // when prereleases are allowed. Without this it resolves the latest stable
      // release, whose artifacts are `latest-*.yml`, and 404s on `nightly-*.yml`.
      // Re-asserted on every check so opting back out to stable clears it even
      // when the channel value itself did not change.
      autoUpdater.allowPrerelease = nightly
      if (autoUpdater.channel !== channel) {
        autoUpdater.channel = channel
        Logger.dev('Updater: channel set to', channel)
      }
    } catch (error: unknown) {
      Logger.error('Updater: failed to read update channel', error)
    }
  }

  /**
   * Release notes of the build the user is running, resolved by its own version:
   * a stable install reads its stable release notes and a nightly install reads
   * that exact nightly. Never the channel's newest release, which drifted from
   * the version the About header shows (a 0.5.63 install displaying
   * 0.5.64-nightly notes). A development or unpublished build has no release of
   * its own, so it gets null. Served from a short in-memory cache so repeated
   * About visits never hit the GitHub API.
   */
  async fetchChangelog(): Promise<UpdaterChangelog | null> {
    const version = app.getVersion()
    const tag = version.startsWith('v') ? version : `v${version}`
    if (
      this.changelogCache?.tag === tag &&
      Date.now() - this.changelogCache.fetchedAt < CHANGELOG_CACHE_MS
    ) {
      return this.changelogCache.changelog
    }
    try {
      const response = await fetch(githubReleaseTagUrl(tag), {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000)
      })
      if (response.status === 404) {
        // An unpublished build has no release of its own. Cache the absence for
        // the same window so About does not re-probe the API on every visit.
        this.changelogCache = { changelog: null, fetchedAt: Date.now(), tag }
        return null
      }
      if (!response.ok) throw new Error(`GitHub releases responded ${String(response.status)}`)
      interface GhRelease {
        tag_name?: unknown
        published_at?: unknown
        body?: unknown
      }
      const entry = (await response.json()) as GhRelease
      const changelog: UpdaterChangelog | null =
        typeof entry.tag_name === 'string' && typeof entry.body === 'string'
          ? {
              tag: entry.tag_name,
              publishedAt: typeof entry.published_at === 'string' ? entry.published_at : '',
              notes: entry.body.slice(0, CHANGELOG_MAX_NOTES_CHARS)
            }
          : null
      this.changelogCache = { changelog, fetchedAt: Date.now(), tag }
      return changelog
    } catch (error: unknown) {
      Logger.error('Updater: changelog fetch failed', error)
      // Do not cache failures: the next About visit retries the network.
      return null
    }
  }

  async downloadUpdate(): Promise<void> {
    if (this._status.state !== 'available' || this.downloadInFlight) return
    this.downloadInFlight = true
    void this.runDownload().finally(() => {
      this.downloadInFlight = false
    })
  }

  private async runDownload(): Promise<void> {
    try {
      await this.seedResumableDownload()
      // electron-updater validates the seeded cache (sha512) and skips its own
      // network download on a hit; on a cache miss it falls back to a normal
      // (non-resumable) download, so this call is always the final word.
      await this.downloadWithAutoUpdater()
    } catch (error: unknown) {
      Logger.error('Updater: download failed', error)
      this.updateState({
        state: 'error',
        errorMessage: error instanceof Error ? error.message : 'Download failed'
      })
    }
  }

  /**
   * Resumably pre-download the available update into electron-updater's own
   * pending cache so its next `downloadUpdate()` validates the cached file
   * (sha512) and skips the network entirely. A dropped connection then resumes
   * from the received byte offset instead of restarting from zero.
   *
   * The bytes come from the CodeInOven download mirror when the mirror proves it
   * holds the same artifact as the update feed, and from GitHub Releases
   * otherwise or as the fallback (see `updateDownloadSources`), so an update is
   * served from our own origin without ever depending on it being up.
   *
   * Returns true when the cache is seeded, false when seeding could not be
   * set up (no artifact resolved, no cache dir). The caller always finishes
   * with `autoUpdater.downloadUpdate()`, which on a seeded cache validates it
   * offline and otherwise falls back to its own download path. A failed
   * transfer keeps the partial file on disk and throws, surfacing the error
   * state: the next attempt continues from where it left.
   */
  private async seedResumableDownload(): Promise<boolean> {
    const info = this.pendingUpdateInfo
    if (info === null) return false
    const selection = selectUpdateArtifact(info, process.platform, process.arch)
    const cacheLocation = selection === null ? null : resolveUpdaterCacheLocation()
    if (selection === null || cacheLocation === null) {
      Logger.dev('Updater: resumable seed not available, using electron-updater download')
      return false
    }
    const artifact: ResolvedUpdateArtifact = {
      ...selection,
      sources: await updateDownloadSources({
        version: info.version,
        channel: this.activeChannel,
        githubBase: GITHUB_RELEASES_DOWNLOAD_URL,
        artifact: selection
      })
    }
    const seedProgress = (receivedBytes: number, totalBytes: number): void => {
      if (totalBytes <= 0) return
      const percent = Math.min(99, Math.floor((receivedBytes / totalBytes) * 100))
      if (percent !== this._status.downloadProgress) {
        this.updateState({ state: 'downloading', downloadProgress: percent })
      }
    }
    await seedUpdaterCache(
      artifact,
      cacheLocation.pendingDir,
      new AbortController().signal,
      seedProgress
    )
    Logger.dev(
      'Updater: update pre-downloaded into the updater cache; validating with electron-updater'
    )
    return true
  }

  /** Plain electron-updater download (the previous, non-resumable behavior). */
  private async downloadWithAutoUpdater(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate()
    } catch (error: unknown) {
      Logger.error('Updater: download failed', error)
      this.updateState({
        state: 'error',
        errorMessage: error instanceof Error ? error.message : 'Download failed'
      })
    }
  }

  /**
   * The menu bar's "Check for Updates": run the whole cycle silently and restart
   * into it. A tray click is a direct request, so the forced flag makes this
   * ignore the background auto-download/auto-install preferences; the final
   * install is silent and, when nothing was on screen, relaunches windowless.
   */
  async updateInBackground(): Promise<UpdaterStatus> {
    if (!this._status.canAutoUpdate) return this.status
    this.forceUpdateInBackground = true
    this.installApproved = true
    return this.checkForUpdates(true)
  }

  /**
   * Explicit user approval to install. Never interrupts active sessions: the
   * install runs once every session and child process has finished.
   */
  quitAndInstall(): void {
    if (this._status.state !== 'downloaded') return
    // Clicking through the guard is the user overriding it, so the attempts for
    // this version start over rather than resuming at the limit.
    void this.clearInstallFailure()
    this.installApproved = true
    this.updateState({ blockedReason: undefined })
    void this.persistPendingInstall()
    void this.installWhenIdle()
  }

  /**
   * Install once all sessions are idle   the safe, non-forced install path.
   * Keeps waiting (polling) until every activity source reports idle, then
   * installs exactly once. There is no timeout and no forced quit.
   */
  async installWhenIdle(): Promise<void> {
    if (this._status.state !== 'downloaded') return
    this.installPending = true
    await this.persistPendingInstall()
    await this.evaluateDeferredInstall()
  }

  private async handleAutoDownload(): Promise<void> {
    if (this._status.state !== 'available') return
    // A tray-initiated update is the user's explicit request, so it is not gated
    // by the background auto-download preference.
    if (!this.forceUpdateInBackground) {
      const config = await this.storage.getConfig()
      if (!config.autoDownloadUpdates) return
    }
    await this.downloadUpdate()
  }

  private async handleAutoInstall(): Promise<void> {
    if (this.installPending) {
      await this.installWhenIdle()
      return
    }
    // A menu bar "Check for Updates" is a direct request and always wins over
    // the guard; so does an explicit install, which reaches `installWhenIdle`
    // without passing through here at all.
    if (!this.forceUpdateInBackground) {
      const config = await this.storage.getConfig()
      if (!config.autoInstallUpdates) return
      if (!this.installPermittedForTarget()) return
    }
    await this.installWhenIdle()
  }

  /**
   * Whether the unattended path may hand the offered version to the platform
   * installer. A version whose install already failed keeps the update visible
   * and installable by hand; it just stops being retried on every launch.
   */
  private installPermittedForTarget(): boolean {
    const version = this._status.availableVersion
    if (!version) return true
    if (nextInstallPermitted(this.installFailure, version, Date.now())) return true
    const reason = suppressedInstallReason(this.installFailure, version)
    Logger.error(`Updater: automatic install suppressed   ${reason ?? ''}`)
    this.updateState({ state: 'downloaded', blockedReason: reason ?? undefined })
    return false
  }

  /** Resume an install that was pending when the previous launch shut down. */
  private async resumePendingInstall(): Promise<void> {
    try {
      const pending = await this.storage.read<PendingInstallState>(PENDING_INSTALL_FILE)
      if (!pending?.pending) return
      this.installPending = true
      this.installApproved = pending.approved === true
      // The resume is unattended, so a version that already failed stays out.
      if (!this.forceUpdateInBackground && this._status.state === 'downloaded') {
        if (!this.installPermittedForTarget()) return
        await this.evaluateDeferredInstall()
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

  /**
   * Settle the install we handed to the platform installer on the previous
   * launch. macOS validates the staged bundle's signature after the app is
   * already gone, so a rejected install comes back as a silent relaunch on the
   * old version with no error event anywhere. Comparing the recorded dispatch
   * with the version now running is the only signal that works on all three
   * platforms, and it is what stops the relaunch storm: a failure is counted,
   * the abandoned staging is swept, and the automatic path stops re-arming the
   * same build.
   */
  private async reconcileInstallDispatch(): Promise<void> {
    try {
      const dispatch = await this.storage.read<InstallDispatch>(INSTALL_DISPATCH_FILE)
      const failure = await this.storage.read<InstallFailureState>(INSTALL_FAILURE_FILE)
      const outcome = resolveDispatchOutcome(dispatch, app.getVersion())
      if (outcome.outcome === 'applied') {
        await this.storage.remove(INSTALL_DISPATCH_FILE)
        if (dispatch !== null) {
          Logger.dev(`Updater: install of ${outcome.version} applied`)
        }
        await this.clearInstallFailure()
        return
      }
      if (outcome.outcome === 'none') {
        this.installFailure = failure
        return
      }
      const record = nextFailureState(failure, outcome.version, outcome.dispatchedAt)
      this.installFailure = record
      await this.storage.remove(INSTALL_DISPATCH_FILE)
      await this.storage.write(INSTALL_FAILURE_FILE, record)
      Logger.error(
        `Updater: install of ${outcome.version} did not apply (attempt ${record.attempts} of ${INSTALL_ATTEMPT_LIMIT})`
      )
      await this.purgeStaging(record.attempts >= INSTALL_ATTEMPT_LIMIT)
    } catch (error: unknown) {
      Logger.error('Updater: failed to reconcile the previous install', error)
    }
  }

  /**
   * Count an install that failed in-process and sweep the staging it left.
   * The dispatch record is cleared as well: the failure is already known, so
   * the next launch has nothing left to reconcile and must not count it twice.
   */
  private async recordInstallFailure(version: string | undefined): Promise<void> {
    if (!version) return
    const record = nextFailureState(this.installFailure, version, Date.now())
    this.installFailure = record
    Logger.error(
      `Updater: install of ${version} failed (attempt ${record.attempts} of ${INSTALL_ATTEMPT_LIMIT})`
    )
    try {
      await this.storage.remove(INSTALL_DISPATCH_FILE)
      await this.storage.write(INSTALL_FAILURE_FILE, record)
    } catch (error: unknown) {
      Logger.error('Updater: failed to persist the install failure record', error)
    }
    await this.purgeStaging(record.attempts >= INSTALL_ATTEMPT_LIMIT)
  }

  private async clearInstallFailure(): Promise<void> {
    if (this.installFailure === null) return
    this.installFailure = null
    try {
      await this.storage.remove(INSTALL_FAILURE_FILE)
    } catch (error: unknown) {
      Logger.error('Updater: failed to clear the install failure record', error)
    }
  }

  /**
   * Drop the staging the platform's installer abandoned, and once the attempts
   * for this build are used up also the cached payload, so the next retry
   * fetches fresh bytes instead of replaying the artifact that was rejected.
   */
  private async purgeStaging(dropPendingPayload: boolean): Promise<void> {
    // Everything that can fail lives inside the try, including reading the app's
    // own name: this runs from a failure path that is fired and forgotten, so a
    // rejection here would surface as an unhandled one instead of a swept disk.
    try {
      const cacheLocation = resolveUpdaterCacheLocation()
      let bundleId: string | null = null
      if (process.platform === 'darwin') {
        bundleId = await readMacBundleIdentifier(process.resourcesPath)
        if (bundleId === null) {
          Logger.dev('Updater: no bundle identifier resolved, skipping ShipIt staging sweep')
        }
      }
      const context: StagingSweepContext = {
        platform: process.platform,
        tmpDir: os.tmpdir(),
        cacheHome: getAppCacheDir(process.platform, os.homedir()),
        updaterCacheDir: cacheLocation?.cacheDir ?? null,
        bundleId,
        appName: app.getName().toLowerCase()
      }
      await purgeAbandonedInstallStaging(context, { dropPendingPayload })
    } catch (error: unknown) {
      Logger.error('Updater: staging sweep failed', error)
    }
  }

  /**
   * Decide whether the deferred install can run now, and keep watching if not.
   * A no-op unless an install is actually pending.
   *
   * The decision is reconciled before it is taken, never after: a source that
   * infers work from an optimistic status has to be asked to settle what it
   * cannot corroborate first, or a session the app calls "working" with no
   * harness behind it holds the gate open forever. That is the shape of the
   * deadlock this gate could reach after an update   the launch that resumes the
   * interrupted threads runs before this one, so the recovered threads are
   * `working` before the first question is even asked, and an update whose
   * install was still pending waits for threads that will never finish.
   */
  private async evaluateDeferredInstall(): Promise<void> {
    // One decision at a time. Reconciling is asynchronous, so a poll landing
    // mid-reconcile would otherwise run a second decision beside the first and
    // hand the same payload to the platform installer twice.
    if (!this.installPending || this.deferredInstallDeciding) return
    this.deferredInstallDeciding = true
    try {
      await this.reconcileUnverifiedWork()
      // Reconciling awaits, and `installPending` can flip across that await: a
      // stop, or the user's own force-install override clearing the gate. The
      // decision below acts on it, so it is re-read here instead of trusted from
      // before the await.
      if (!this.installPending) return
      if (
        !this.installApproved &&
        !this.forceUpdateInBackground &&
        !this.installRecoveryPending &&
        !this.installPermittedForTarget()
      )
        return

      // Fetching the feed can run ahead of disk recovery, but unattended
      // installation must still observe the previous failed-install guard.
      // An explicit recovery install can proceed even if that disk read hangs.
      if (!this.installApproved && this.editorIsActive?.()) {
        this.installPending = false
        this.clearDeferredInstall()
        this.updateState({
          state: 'downloaded',
          blockedReason: 'IDE Mode is open. Restart to install when you have finished editing.'
        })
        await this.persistPendingInstall()
        return
      }
      const threadCount =
        this.activeSessionCount() +
        (this.installRecoveryPending && !this.installApproved && !this.forceUpdateInBackground
          ? 1
          : 0)
      // Downloads are read after the thread count because the read is too cheap
      // to do on a path that is about to install anyway, and never for an
      // install the user or the tray asked for directly.
      const downloads = threadCount === 0 ? this.blockingDownloads() : []
      if (threadCount === 0 && downloads.length === 0) {
        this.quitAndInstallNow()
        return
      }

      this.updateState({ state: 'waiting' })
      this.broadcastWaitingForWork(threadCount, downloads.length)

      this.clearDeferredInstall()
      this.deferredInstallPoll = setInterval(() => {
        void this.evaluateDeferredInstall()
      }, DEFERRED_POLL_MS)
    } finally {
      this.deferredInstallDeciding = false
    }
  }

  /**
   * Ask every source that infers activity to settle what it cannot corroborate.
   * A source that fails is left exactly as it reported itself: this narrows a
   * count that may be wrong, it never invents one.
   */
  private async reconcileUnverifiedWork(): Promise<void> {
    for (const source of [this.chatEngine, ...this.activitySources]) {
      if (!source?.reconcileUnverifiedWork) continue
      try {
        const settled = await source.reconcileUnverifiedWork()
        if (settled > 0) {
          Logger.info('Updater: settled uncorroborated active work before installing', { settled })
        }
      } catch (error: unknown) {
        Logger.error('Updater: failed to reconcile active work', error)
      }
    }
  }

  private activeSessionCount(): number {
    // Mirrors AppHeader's working-activity badges (workingThreadCounts):
    // only sessions with `sessionStatuses === 'working'` count. Idle PTYs,
    // `waiting` sessions, pending permissions/questions, compactions,
    // brainstorm/loop runs do not pulse the header and must not block
    // "Restart to update".
    //
    // The extra sources count on top of the engine's answer rather than being
    // replaced by it. A live terminal is real work a restart would destroy, and
    // the engine's working-session badge cannot see one; returning the badge
    // alone silently dropped every terminal from this gate.
    let count = this.chatEngine?.workingSessionCount
      ? this.chatEngine.workingSessionCount()
      : (this.chatEngine?.activeSessionCount() ?? 0)
    for (const source of this.activitySources) {
      count += source.activeSessionCount()
    }
    return count
  }

  private broadcastWaitingForWork(threads: number, downloads: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        sendToRenderer(win.webContents, 'updater:waiting-for-work', threads, downloads)
      }
    }
  }

  /**
   * Pause the bound on a dispatched install while the app is asking the user
   * whether it may quit.
   *
   * The bound exists to catch an install the platform installer silently dropped
   * while this process keeps running. A close-confirmation prompt on screen is
   * the opposite situation: the app is alive on purpose, waiting for an answer,
   * and a user who takes longer than the bound would otherwise be told the
   * install failed   and have a failed attempt counted against that version. A
   * confirmed quit takes the process down anyway, so nothing needs re-arming.
   */
  pauseInstallQuitWatchdog(): void {
    this.clearInstallQuitWatchdog()
  }

  /**
   * The update-driven quit was declined: the close prompt was dismissed or a
   * save it asked for failed, so the app is staying open.
   *
   * Everything the dispatch wrote is undone here, and that is the whole point.
   * The install had already recorded itself as handed over and cleared the
   * pending marker, so leaving it that way both lost the install surface (the
   * rail fell back to "up to date" over an update still sitting in the cache)
   * and left a dispatch record the next launch would count as a failed attempt.
   * The payload itself is untouched: the state returns to `downloaded`, so the
   * user can install the build they already downloaded without fetching it
   * again, by hand or on the next automatic cycle.
   */
  handleInstallDeclined(): void {
    if (!this.installDispatched) return
    this.installDispatched = false
    this.clearInstallQuitWatchdog()
    // The quit this dispatch was driving is not happening, so the park gate goes
    // back to whatever it was before the install began.
    this.updateQuitHooks?.end()
    this.localTransferRetried = false
    this.installPending = false
    this.installApproved = false
    this.clearDeferredInstall()
    void this.storage.remove(INSTALL_DISPATCH_FILE).catch((error: unknown) => {
      Logger.error('Updater: failed to clear the declined install dispatch', error)
    })
    // A later launch must not treat the declined install as one in progress. The
    // pending-install marker was cleared at dispatch time, but rewriting it here
    // keeps the record honest if that write is what failed.
    void this.storage
      .write(PENDING_INSTALL_FILE, { pending: false, approved: false })
      .catch((error: unknown) => {
        Logger.error('Updater: failed to clear the declined pending install', error)
      })
    Logger.info('Updater: install declined at the close prompt; the update stays downloaded')
    if (this._status.availableVersion) {
      this.updateState({
        state: 'downloaded',
        downloadProgress: 100,
        blockedReason: undefined
      })
      return
    }
    this.updateState({ state: 'idle', blockedReason: undefined })
  }

  private quitAndInstallNow(): void {
    this.localTransferRetried = false
    this.installPending = false
    this.installApproved = false
    this.updateState({ state: 'idle' })
    // The install runs in a process that outlives us (ShipIt, the NSIS
    // installer, the AppImage runtime) and reports nothing back, so record what
    // we handed over. `reconcileInstallDispatch` reads it on the next launch to
    // learn whether the update actually landed.
    const targetVersion = this._status.availableVersion
    void this.storage
      .write(PENDING_INSTALL_FILE, { pending: false, approved: false })
      .catch((error: unknown) => {
        Logger.error('Updater: failed to clear pending install', error)
      })
    if (targetVersion) {
      this.installDispatched = true
      void this.storage
        .write(INSTALL_DISPATCH_FILE, {
          version: targetVersion,
          dispatchedAt: Date.now()
        } satisfies InstallDispatch)
        .catch((error: unknown) => {
          Logger.error('Updater: failed to record the install dispatch', error)
        })
    }
    // A background update installs silently and, when nothing was on screen,
    // leaves a marker so the relaunched app comes back in the menu bar instead
    // of throwing a window at the user.
    const background = this.forceUpdateInBackground
    this.forceUpdateInBackground = false
    if (background && BrowserWindow.getAllWindows().length === 0) markBackgroundRelaunch()
    // The install must be a real quit. Background mode would otherwise park on
    // the app.quit() that quitAndInstall triggers, and the update would never be
    // applied; `begin` clears that gate and `end` (on failure) restores it.
    this.updateQuitHooks?.begin()
    autoUpdater.quitAndInstall(background, background)
    // The install is supposed to take this process down with it. If it does not,
    // nothing else reports back, so bound it here rather than leaving a click
    // that never finishes on screen.
    if (this.installDispatched) this.armInstallQuitWatchdog(targetVersion)
  }

  /**
   * Bound a dispatched install that has not taken the process down.
   *
   * The installer runs outside this process and reports nothing on success, so
   * "we are still alive" is the only failure signal available on every platform.
   * Without it, a payload the platform installer rejects silently (ShipIt
   * validates the staged bundle after we are gone, and has refused a nightly
   * build for an unmet code requirement) leaves the user watching a spinner for
   * an install that will never happen. Counted as a failed attempt, so the same
   * build is not re-armed on every launch.
   */
  private armInstallQuitWatchdog(version: string | undefined): void {
    this.clearInstallQuitWatchdog()
    const timer = setTimeout(() => {
      this.installQuitWatchdog = null
      if (!this.installDispatched) return
      this.installDispatched = false
      Logger.error(`Updater: install of ${version ?? 'the update'} did not restart the app`)
      this.updateQuitHooks?.end()
      void this.recordInstallFailure(version)
      this.updateState({
        state: 'error',
        errorMessage: `The update to ${version ?? 'the latest version'} did not install. Try again, or download it from the releases page.`
      })
    }, INSTALL_QUIT_WATCHDOG_MS)
    // Never keep the process alive just for this bound.
    timer.unref()
    this.installQuitWatchdog = timer
  }

  private clearInstallQuitWatchdog(): void {
    if (!this.installQuitWatchdog) return
    clearTimeout(this.installQuitWatchdog)
    this.installQuitWatchdog = null
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
