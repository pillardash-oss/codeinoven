/**
 * Background mode: keep the backend alive after the window closes.
 *
 * "Closed" in background mode means **no window and no renderer process**. The
 * main process keeps running with a menu bar icon, SQLite, and a 30s scheduler
 * tick; when a routine comes due the run fires exactly as it does with a window
 * open, persists, notifies, and returns to idle. Reopening hydrates everything
 * from durable state, which is why nothing about background state may live in
 * renderer memory.
 *
 * This service owns the decisions and the surfaces:
 *   - whether a close parks or quits (`shouldPark`),
 *   - the menu bar icon and its two states (working / attention),
 *   - the Dock icon hiding while windowless and returning with a window,
 *   - the login item,
 *   - this process's role against the shared backend (`instanceRegistry`), so a
 *     second instance schedules nothing and says so instead of double-firing,
 *   - whether this launch registers for any of it at all: a probe sets
 *     `CODEINOVEN_NO_BACKGROUND` and gets a plain window instead
 *     (`isBackgroundRegistrationDisabled`).
 *
 * It is deliberately decoupled from the window and from the schedulers: the
 * composition root hands in the callbacks (`openWindow`, `destroyWindow`,
 * `quitApp`, `hasUpcomingWork`), so the service never imports the boot module
 * that creates them.
 */

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage
} from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { join } from 'node:path'
import type { AppConfig, BackgroundMode, InstanceRole } from '../../lib/types'
import type { UpdaterStatus } from '../../lib/ipc-contract'
import { getConfigRoot, isBackgroundRegistrationDisabled } from '../../lib/utils'
import { APP_NAME } from '../../lib/brand'
import { Logger } from './logger'
import { instanceRegistry } from './instance-registry'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { StorageEngine } from '../storage/storage-engine'
import type { BootstrapState } from '../bootstrap/bootstrap-state'

/** How long the renderer gets to persist its own state before the window dies. */
const PARK_GRACE_MS = 350

/** How often the activation directory is re-read between watcher events. */
const ACTIVATION_POLL_MS = 2_000

/** Activation requests older than this are leftovers from a crashed instance. */
const ACTIVATION_TTL_MS = 60_000

const NOTICE_MARKER_PATH = 'background/menu-bar-notice-shown'

export interface BackgroundLifecycleDeps {
  state: BootstrapState
  storage: StorageEngine
  /** Create the window, or show and focus the existing one. */
  openWindow: () => void
  /** Destroy the current window. Its renderer process goes with it. */
  destroyWindow: () => void
  /** Run the real quit (sets `quitConfirmed` and calls `app.quit()`). */
  quitApp: () => void
  /** Persist window geometry before the window is destroyed. */
  persistWindowState: () => Promise<void>
  /** Release window-bound services (browser views, PTY sender) before destroy. */
  releaseWindowServices: () => void
  /**
   * Whether something is running or due soon. Used for the menu bar tooltip and
   * to decide whether a real quit should warn.
   */
  hasUpcomingWork: () => boolean
  /** Something needs the user: a parked gate or an unread failure. */
  computeAttention: () => boolean
  /** Called when this instance becomes the owner of scheduled work. */
  onBecameOwner: () => void
  /** Absolute path to the tray template art (attention variant when true). */
  resolveTrayIcon: (attention: boolean) => string
}

/**
 * The updater as the menu bar sees it.
 *
 * Held behind a bridge, not imported, because the updater is built later than
 * the tray: the composition root creates the menu bar icon before the feature
 * service graph exists, then hands the updater in through {@link setUpdater}.
 */
export interface BackgroundUpdaterBridge {
  /** Check, and on availability download, install, and relaunch. */
  updateInBackground: () => Promise<void>
  /** Current updater state, for the menu item's label. */
  status: () => UpdaterStatus
  /** Subscribe to updater state changes; returns the unsubscribe. */
  onStatusChange: (callback: (status: UpdaterStatus) => void) => () => void
}

export class BackgroundLifecycleService {
  private tray: Tray | null = null
  private mode: BackgroundMode = 'off'
  /**
   * A probe launch runs as a plain window: no icon, no login item, no wake
   * hold, and a close that quits. Resolved once because it is fixed for the
   * life of the process.
   */
  private readonly optedOut = isBackgroundRegistrationDisabled()
  private config: AppConfig | null = null
  private attention = false
  private stopped = false
  private activationWatcher: FSWatcher | null = null
  private activationTimer: ReturnType<typeof setInterval> | null = null
  private readonly activationDir = join(getConfigRoot(), 'instances', 'activate')
  private readonly unsubscribers: Array<() => void> = []
  private updater: BackgroundUpdaterBridge | null = null
  private updaterStatus: UpdaterStatus | null = null
  private updaterUnsubscribe: (() => void) | null = null
  /** True while a menu bar update check the user asked for is still resolving. */
  private trayCheckRequested = false

  constructor(private readonly deps: BackgroundLifecycleDeps) {}

  /** Load persisted state, apply the login item, and publish the role. */
  async start(): Promise<void> {
    this.config = await this.deps.storage.getConfig()
    this.mode = this.config.backgroundMode
    this.applyLoginItem(this.config)
    // The menu bar icon exists whenever background mode is on, so Cmd+Q always
    // has a place to park to. A secondary instance never shows one, and a probe
    // launch never registers at all.
    this.syncTray()
    this.unsubscribers.push(instanceRegistry.onLiveInstanceSetChanged(() => this.evaluateRole()))
    this.unsubscribers.push(instanceRegistry.onOwnershipChanged(() => this.evaluateRole()))
    this.startActivationWatcher()
    this.broadcastRole()
  }

  stop(): void {
    this.stopped = true
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers.length = 0
    this.updaterUnsubscribe?.()
    this.updaterUnsubscribe = null
    this.activationWatcher?.close()
    this.activationWatcher = null
    if (this.activationTimer) {
      clearInterval(this.activationTimer)
      this.activationTimer = null
    }
    this.destroyTray()
  }

  /** The persisted background mode. */
  get backgroundMode(): BackgroundMode {
    return this.mode
  }

  /**
   * Whether this process registers as a background instance at all. A probe
   * launch opts out, and an explicit `backgroundMode: 'off'` disables it too.
   */
  get backgroundEnabled(): boolean {
    return !this.optedOut && this.mode !== 'off'
  }

  /** Whether this launch opted out of background registration entirely. */
  get backgroundOptOut(): boolean {
    return this.optedOut
  }

  /** How long before a due run the machine is held awake, in milliseconds. */
  get wakeLeadMs(): number {
    if (!this.backgroundEnabled) return 0
    return this.config?.backgroundWakeLeadMs ?? 0
  }

  /** Whether slots missed to sleep or a closed app run when the app returns. */
  get autoRunMissedRuns(): boolean {
    return this.config?.autoRunMissedAssistantRuns ?? true
  }

  /** Register the updater once the feature graph is up, and rebuild the menu. */
  setUpdater(bridge: BackgroundUpdaterBridge): void {
    this.updaterUnsubscribe?.()
    this.updater = bridge
    this.updaterStatus = bridge.status()
    this.updaterUnsubscribe = bridge.onStatusChange((status) => this.onUpdaterStatus(status))
    this.refreshTrayMenu()
  }

  /**
   * Whether closing the window (or Cmd+Q) should park to the menu bar instead of
   * quitting. Background mode on means the backend is expected to keep the
   * schedule, so the only full quit is the menu bar's Quit item (or OS logout).
   * A secondary instance parks nothing: it owns no schedule, so closing it quits
   * that process and leaves the owner alone. A probe launch opted out of
   * registration outright, so closing its window closes the process.
   */
  shouldPark(): boolean {
    if (this.stopped || this.optedOut || this.mode === 'off') return false
    return this.currentRole().role === 'owner'
  }

  /** Apply a config change without a restart. */
  async applyConfig(config: AppConfig): Promise<void> {
    this.config = config
    this.mode = config.backgroundMode
    this.applyLoginItem(config)
    this.syncTray()
    this.broadcastRole()
  }

  /** A window now exists: restore the Dock icon and push the current role. */
  onWindowOpened(window: BrowserWindow): void {
    this.showDock()
    this.pushRoleTo(window)
    this.refreshAttention()
  }

  /** The window is gone: menu-bar-only while background mode is on. */
  onWindowClosed(): void {
    if (this.mode !== 'off' && !this.optedOut) this.hideDock()
    this.syncTray()
    this.refreshAttention()
  }

  /** Recompute the attention state and update the icon. */
  refreshAttention(): void {
    let next = false
    try {
      next = this.deps.computeAttention()
    } catch (error) {
      Logger.error('Background attention check failed', error)
    }
    if (next === this.attention && this.tray) return
    this.attention = next
    this.updateTrayAppearance()
  }

  /** Push this process's role to every open window. */
  broadcastRole(): void {
    const role = this.currentRole()
    for (const window of BrowserWindow.getAllWindows()) this.pushRoleTo(window, role)
  }

  /** Answer the renderer's hydration read. */
  currentRole(): InstanceRole {
    if (instanceRegistry.isIncumbentInstance()) {
      return { role: 'owner', ownerPid: process.pid }
    }
    return { role: 'secondary', ownerPid: instanceRegistry.incumbentPid() ?? 0 }
  }

  /**
   * A secondary asks the owner to bring its window forward. Writes one small
   * request file the owner watches for; the owner creates or shows its window
   * and removes the request. Returns false when there is no reachable owner.
   */
  requestOwnerActivation(): boolean {
    const ownerPid = instanceRegistry.incumbentPid()
    if (!ownerPid || ownerPid === process.pid) return false
    try {
      mkdirSync(this.activationDir, { recursive: true })
      const payload = JSON.stringify({ requesterPid: process.pid, createdAt: Date.now() })
      writeFileSync(join(this.activationDir, `${ownerPid}-${process.pid}.json`), payload, 'utf8')
      return true
    } catch (error) {
      Logger.error('Could not ask the running instance to open', error)
      return false
    }
  }

  /**
   * Make this instance the owner of scheduled work, at the user's request. A
   * secondary's "Make this the main instance" action asks for it, which is the
   * escape hatch when the elected owner is a stale window, or a crashed process
   * still in the registry, and the user wants the schedule where they are
   * working. The previous owner steps down through the same ownership
   * notification and shows the secondary notice instead.
   */
  takeOverControl(): boolean {
    return instanceRegistry.transferOwnership(process.pid)
  }

  /** Tear the window down for background mode: hibernate, persist, destroy. */
  async park(): Promise<void> {
    if (this.stopped || this.deps.state.quitCleanupStarted) return
    const window = this.deps.state.mainWindow
    if (!window || window.isDestroyed()) {
      // No window to park; just make sure the icon is present.
      this.syncTray()
      return
    }
    this.deps.state.parkingForBackground = true
    // Let the renderer persist what only it holds (durable browser tab lists,
    // editor drafts) before its process is torn down.
    if (!window.webContents.isDestroyed()) {
      sendToRenderer(window.webContents, 'window:beforePark')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PARK_GRACE_MS))
    try {
      await this.deps.persistWindowState()
    } catch (error) {
      Logger.error('Window state flush failed while parking', error)
    }
    this.showBackgroundNoticeOnce()
    this.deps.releaseWindowServices()
    this.deps.destroyWindow()
    this.syncTray()
    this.hideDock()
  }

  // ---------------------------------------------------------------- tray ----

  /** Create, destroy, or refresh the menu bar icon for the current role/mode. */
  private syncTray(): void {
    const shouldExist = !this.optedOut && this.mode !== 'off' && this.currentRole().role === 'owner'
    if (!shouldExist) {
      this.destroyTray()
      return
    }
    if (this.tray) {
      this.updateTrayAppearance()
      return
    }
    try {
      const image = this.loadTrayImage(this.attention)
      this.tray = new Tray(image)
      this.tray.setToolTip(this.trayTooltip())
      this.tray.setContextMenu(this.buildContextMenu())
      // A left click on the icon opens the app, matching every other menu bar app.
      this.tray.on('click', () => this.deps.openWindow())
    } catch (error) {
      Logger.error('Could not create the menu bar icon', error)
      this.tray = null
    }
  }

  private destroyTray(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private updateTrayAppearance(): void {
    if (!this.tray) return
    try {
      this.tray.setImage(this.loadTrayImage(this.attention))
      this.tray.setToolTip(this.trayTooltip())
    } catch (error) {
      Logger.error('Could not update the menu bar icon', error)
    }
  }

  private loadTrayImage(attention: boolean): NativeImage {
    const image = nativeImage.createFromPath(this.deps.resolveTrayIcon(attention))
    if (process.platform === 'darwin') image.setTemplateImage(true)
    return image
  }

  private trayTooltip(): string {
    if (this.attention) return `${APP_NAME} is waiting for your approval`
    if (this.deps.hasUpcomingWork()) return `${APP_NAME} is running a scheduled task`
    return `${APP_NAME} is running in the menu bar`
  }

  /** Rebuild the menu, so a status change or a newly attached updater shows. */
  private refreshTrayMenu(): void {
    if (!this.tray) return
    try {
      this.tray.setContextMenu(this.buildContextMenu())
    } catch (error) {
      Logger.error('Could not update the menu bar menu', error)
    }
  }

  private buildContextMenu(): Menu {
    return Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => this.deps.openWindow() },
      { type: 'separator' },
      this.updateMenuItem(),
      { type: 'separator' },
      { label: `Quit ${APP_NAME}`, click: () => this.deps.quitApp() }
    ])
  }

  /** The update item's label and action follow the updater's current state. */
  private updateMenuItem(): MenuItemConstructorOptions {
    const status = this.updaterStatus
    if (!this.updater || status === null || !status.canAutoUpdate) {
      return { label: 'Check for Updates', enabled: false }
    }
    switch (status.state) {
      case 'checking':
        return { label: 'Checking for Updates…', enabled: false }
      case 'available':
      case 'downloading':
        return {
          label:
            status.downloadProgress !== undefined
              ? `Downloading Update… ${status.downloadProgress}%`
              : 'Downloading Update…',
          enabled: false
        }
      case 'downloaded':
      case 'waiting':
        return { label: 'Restarting to Update…', enabled: false }
      default:
        return { label: 'Check for Updates', click: () => this.runTrayUpdate() }
    }
  }

  /**
   * The user asked for an update from the menu bar. Show the check in the menu
   * immediately so the click has visible feedback, then let the updater drive the
   * rest: download, then a silent install that relaunches windowless.
   */
  private runTrayUpdate(): void {
    const updater = this.updater
    if (!updater) return
    this.trayCheckRequested = true
    this.updaterStatus = { ...updater.status(), state: 'checking' }
    this.refreshTrayMenu()
    void updater.updateInBackground().catch((error) => {
      Logger.error('Menu bar update failed', error)
      this.trayCheckRequested = false
      this.refreshTrayMenu()
    })
  }

  private onUpdaterStatus(status: UpdaterStatus): void {
    const previousState = this.updaterStatus?.state
    this.updaterStatus = status
    if (this.trayCheckRequested) {
      if (status.state === 'idle' && previousState === 'checking') {
        // `idle` right after a check means the feed had nothing newer.
        this.trayCheckRequested = false
        this.notifyUpdate(
          `${APP_NAME} is up to date`,
          `You are on the latest version (${status.currentVersion ?? 'unknown'}).`
        )
      } else if (status.state === 'error') {
        this.trayCheckRequested = false
        this.notifyUpdate(
          'Update check failed',
          status.errorMessage ?? 'The update could not be completed.'
        )
      } else if (status.state !== 'checking') {
        // Availability, download, and install carry on in the background and the
        // menu label tracks them, so the request needs no outcome notification.
        this.trayCheckRequested = false
      }
    }
    this.refreshTrayMenu()
  }

  private notifyUpdate(title: string, body: string): void {
    if (!Notification.isSupported()) return
    try {
      new Notification({ title, body }).show()
    } catch (error) {
      Logger.dev('Update notification could not be shown (non-fatal):', error)
    }
  }

  // --------------------------------------------------------------- role -----

  private evaluateRole(): void {
    if (this.stopped) return
    // A promoted survivor creates the icon and takes over the schedule.
    const wasOwner = this.tray !== null
    this.syncTray()
    this.broadcastRole()
    // A launch that opted out never owned the icon, so "promotion" is not a
    // hand-off and must not run the catch-up.
    if (!wasOwner && this.backgroundEnabled && this.currentRole().role === 'owner') {
      this.deps.onBecameOwner()
    }
  }

  private pushRoleTo(window: BrowserWindow, role?: InstanceRole): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    sendToRenderer(window.webContents, 'app:instanceRole', role ?? this.currentRole())
  }

  // ------------------------------------------------------------ login item --

  /**
   * Apply the login item. Background mode off turns the login item off with it,
   * so `off` really means the app the user closes. Linux has no Electron login
   * item API and is a no-op here.
   */
  private applyLoginItem(config: AppConfig): void {
    // A probe launch must never register itself to start at login.
    if (this.optedOut) return
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    // Never register a development launch as a login item: the dev Electron
    // binary is not the app, and a stray entry would start it at every login.
    if (!app.isPackaged) return
    const openAtLogin = config.backgroundMode !== 'off' && config.launchAtLogin
    try {
      app.setLoginItemSettings({ openAtLogin })
    } catch (error) {
      Logger.error('Could not apply the login item setting', error)
    }
  }

  // --------------------------------------------------------- dock control ---

  private showDock(): void {
    if (process.platform !== 'darwin' || !app.dock) return
    try {
      app.dock.show()
    } catch (error) {
      Logger.dev('dock show failed (non-fatal):', error)
    }
  }

  private hideDock(): void {
    if (process.platform !== 'darwin' || !app.dock) return
    if (this.deps.state.quitCleanupStarted) return
    try {
      app.dock.hide()
    } catch (error) {
      Logger.dev('dock hide failed (non-fatal):', error)
    }
  }

  // ------------------------------------------------------- activation bus ---

  private startActivationWatcher(): void {
    try {
      mkdirSync(this.activationDir, { recursive: true })
      this.activationWatcher = watch(this.activationDir, { persistent: false }, () =>
        this.drainActivationRequests()
      )
      this.activationWatcher.on('error', () => {
        this.activationWatcher?.close()
        this.activationWatcher = null
      })
    } catch (error) {
      Logger.dev('Activation directory unavailable (non-fatal):', error)
    }
    this.activationTimer = setInterval(() => this.drainActivationRequests(), ACTIVATION_POLL_MS)
    this.activationTimer.unref()
    this.drainActivationRequests()
  }

  private drainActivationRequests(): void {
    if (this.stopped) return
    let files: string[]
    try {
      files = readdirSync(this.activationDir).filter((name) => name.endsWith('.json'))
    } catch {
      return
    }
    if (files.length === 0) return
    const now = Date.now()
    for (const file of files) {
      const path = join(this.activationDir, file)
      if (!file.startsWith(`${process.pid}-`)) {
        // Sweep an abandoned request so a crashed requester leaves nothing behind.
        try {
          if (now - Number(file.split('-')[1] ?? 0) > ACTIVATION_TTL_MS)
            rmSync(path, { force: true })
        } catch {
          // Best effort.
        }
        continue
      }
      try {
        rmSync(path, { force: true })
      } catch {
        // Best effort.
      }
      this.deps.openWindow()
    }
  }

  // ------------------------------------------------------------ one-time ----

  /**
   * The first time a close parks, tell the user the app is still running. Shown
   * once ever, because `scheduled` is the default and an unexpected menu bar
   * process is exactly the sort of surprise this avoids.
   */
  private showBackgroundNoticeOnce(): void {
    const marker = join(getConfigRoot(), NOTICE_MARKER_PATH)
    try {
      if (existsSync(marker)) return
      mkdirSync(join(getConfigRoot(), 'background'), { recursive: true })
      writeFileSync(marker, String(Date.now()), 'utf8')
    } catch (error) {
      Logger.dev('Could not write the background notice marker (non-fatal):', error)
      return
    }
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({
        title: `${APP_NAME} is still running`,
        body: 'It stays in the menu bar so your schedules keep firing. Quit it from the menu bar icon.'
      })
      notification.show()
    } catch (error) {
      Logger.dev('Background notice could not be shown (non-fatal):', error)
    }
  }
}
