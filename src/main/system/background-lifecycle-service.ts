/**
 * Background mode: keep the backend alive after the window closes.
 *
 * "Closed" in background mode means **no window and no renderer process**. The
 * main process keeps running with a menu bar icon, SQLite, and a 30s scheduler
 * tick; when an assistant comes due the run fires exactly as it does with a window
 * open, persists, notifies, and returns to idle. Reopening hydrates everything
 * from durable state, which is why nothing about background state may live in
 * renderer memory.
 *
 * This service owns the decisions and the surfaces:
 *   - whether a close parks or quits (`shouldPark`, which is only true while the
 *     process still has something to preserve; see `evaluateResidency`),
 *   - the menu bar icon and its states: the mark alone, the mark with a bold
 *     exclamation beside it whenever a thread holds a live problem, and (on
 *     macOS) the mark carrying the number of working threads in that same slot
 *     (see {@link trayImage}),
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
 * `quitApp`, `hasUpcomingWork`, `residencyReason`), so the service never imports
 * the boot module that creates them.
 */

import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage
} from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'node:fs'
import { join } from 'node:path'
import type { AppConfig, BackgroundMode, InstanceRole } from '../../lib/types'
import type { UpdaterStatus } from '../../lib/ipc-contract'
import {
  trayCountCells,
  trayCountLabel,
  trayCountMetrics,
  type TrayCountScale
} from '../../lib/tray-count-art'
import { getConfigRoot, isBackgroundRegistrationDisabled } from '../../lib/utils'
import { isShippedBuild } from '../bootstrap/app-resources'
import { APP_ID, APP_NAME } from '../../lib/brand'
import { Logger } from './logger'
import { forceRestartMenuItem } from './force-restart'
import { instanceRegistry } from './instance-registry'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { StorageEngine } from '../storage/storage-engine'
import type { BootstrapState } from '../bootstrap/bootstrap-state'
import type { ResidencyReason } from './background-work-state'

/** How long the renderer gets to persist its own state before the window dies. */
const PARK_GRACE_MS = 350

/** How often the activation directory is re-read between watcher events. */
const ACTIVATION_POLL_MS = 2_000

/** Activation requests older than this are leftovers from a crashed instance. */
const ACTIVATION_TTL_MS = 60_000

/**
 * How long a windowless process waits after its last reason to stay drains
 * before it quits.
 *
 * A run that has just settled, a retry that has just fired and a slot that has
 * just been recorded each pass through a moment where nothing is pending yet, and
 * an exit taken inside that moment would cut the settlement short. The wait is
 * also what keeps a flapping predicate (work, no work, work) from quitting.
 */
const RESIDENCY_DRAIN_GRACE_MS = 15_000

/**
 * How long thread-update bursts are coalesced before the icon is recomputed.
 * A turn settles many thread updates in a row (status, read flag, messages),
 * and the icon only ever needs the final state, so the predicates run once per
 * burst instead of once per update.
 */
const ATTENTION_REFRESH_DEBOUNCE_MS = 150

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
  /**
   * Why the process still has to outlive its window, or null when nothing does.
   * Read at every close decision and again while parked, so it must stay cheap.
   */
  residencyReason: () => ResidencyReason | null
  /** Something needs the user: a parked gate or an unread failure. */
  computeAttention: () => boolean
  /**
   * How many threads are producing work right now, for the menu bar figure.
   * Read on the database worker, because it is refreshed from thread-update
   * paths and so must not hold the main thread on SQLite.
   */
  countWorkingThreads: () => Promise<number>
  /** Called when this instance becomes the owner of scheduled work. */
  onBecameOwner: () => void
  /** Absolute path to platform tray art, using the Windows taskbar theme. */
  resolveTrayIcon: (attention: boolean, darkTaskbar?: boolean) => string
  /**
   * Absolute paths to the menu bar working-figure strip: the plain resolution
   * and the Retina one. The strip holds every figure as one cell; the service
   * cuts the cell it needs out of it.
   */
  resolveTrayCountStrip: () => { base: string; retina: string }
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
  /**
   * How many threads are working right now. The macOS menu bar shows this as
   * the figure beside the mark, and it wins the slot over the attention
   * exclamation: a number is the more useful thing to read while runs are in
   * flight, and the exclamation returns the moment the last one settles.
   */
  private workingCount = 0
  /** Serial number of the newest count read, so a slow one cannot win. */
  private workingCountRequest = 0
  /** Decoded figure strips, so a count change never re-decodes the art. */
  private countStrips: { base: NativeImage; retina: NativeImage } | null = null
  /** The figure last built, so repeatedly landing on the same count is free. */
  private countImage: { count: number; image: NativeImage } | null = null
  /** Pending coalesced attention recompute, or null when none is scheduled. */
  private attentionRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private activationWatcher: FSWatcher | null = null
  private activationTimer: ReturnType<typeof setInterval> | null = null
  /** When the window last closed, or null while one is open (and at boot). */
  private windowlessSince: number | null = null
  /** The armed "nothing left to preserve" quit, or null when none is pending. */
  private residencyTimer: ReturnType<typeof setTimeout> | null = null
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
    this.refreshActivationWatch()
    this.broadcastRole()
    // A launch can inherit problems from the last one: a run that failed
    // overnight, a thread still parked on an approval gate. The icon states
    // that from the first frame instead of waiting for the next event.
    this.refreshTrayState()
  }

  stop(): void {
    this.stopped = true
    if (this.attentionRefreshTimer !== null) {
      clearTimeout(this.attentionRefreshTimer)
      this.attentionRefreshTimer = null
    }
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers.length = 0
    this.updaterUnsubscribe?.()
    this.updaterUnsubscribe = null
    this.activationWatcher?.close()
    this.activationWatcher = null
    this.clearActivationPoll()
    this.clearResidencyQuit()
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
   * quitting.
   *
   * Parking is not free: it holds SQLite, the menu bar icon, the schedule and a
   * live main process. The mode is therefore only half the answer, and the other
   * half is {@link BackgroundLifecycleDeps.residencyReason}: a process with
   * nothing left to run or to hold has no reason to outlive its window, so
   * closing it quits like any other app. With work still pending it parks exactly
   * as before, and {@link evaluateResidency} takes the exit once that work drains.
   *
   * A secondary instance parks nothing: it owns no schedule, so closing it quits
   * that process and leaves the owner alone. A probe launch opted out of
   * registration outright, so closing its window closes the process.
   */
  shouldPark(): boolean {
    if (this.stopped || this.optedOut || this.mode === 'off') return false
    if (this.currentRole().role !== 'owner') return false
    return this.deps.residencyReason() !== null
  }

  /** Why the process still has to exist, for a log line or a diagnosis. */
  residencyReason(): ResidencyReason | null {
    return this.deps.residencyReason()
  }

  /** Apply a config change without a restart. */
  async applyConfig(config: AppConfig): Promise<void> {
    this.config = config
    this.mode = config.backgroundMode
    this.applyLoginItem(config)
    this.syncTray()
    this.refreshActivationWatch()
    this.broadcastRole()
  }

  /** A window now exists: restore the Dock icon and push the current role. */
  onWindowOpened(window: BrowserWindow): void {
    // A window on screen is the user being here: the process is not parked, and
    // an exit armed before this was never taken anyway.
    this.windowlessSince = null
    this.clearResidencyQuit()
    this.showDock()
    // Reconcile the menu bar icon here too, so a window that opens after the
    // process lost its icon (a role change, a missed event) brings it straight
    // back instead of waiting for the next periodic tick.
    this.syncTray()
    this.pushRoleTo(window)
    this.refreshTrayState()
    // With a visible window there is nothing to activate, so the drain stops.
    this.refreshActivationWatch()
  }

  /** The window is gone: menu-bar-only while background mode is on. */
  onWindowClosed(): void {
    this.windowlessSince = Date.now()
    if (this.mode !== 'off' && !this.optedOut) this.hideDock()
    this.syncTray()
    this.refreshTrayState()
    // Windowless is the one state the drain exists for.
    this.refreshActivationWatch()
  }

  /**
   * Recompute the icon's whole state   what needs the user, and how many
   * threads are working   and update the icon.
   *
   * Safe to call for every state change: the menu bar only ever shows the
   * latest truth, so it is enough to run the predicates once however many
   * changes landed. Callers that must be reflected immediately (a config
   * change, a window opening) use this directly; the per-update hooks use
   * {@link requestTrayRefresh}.
   */
  refreshTrayState(): void {
    // Every state change the icon reacts to is also one that can drain the last
    // reason to stay: a run settling, a retry firing, an assistant being paused.
    // Deciding here means the residency exit happens on the change rather than at
    // the next launch. It costs nothing while a window is on screen.
    this.evaluateResidency()
    if (this.attentionRefreshTimer !== null) {
      clearTimeout(this.attentionRefreshTimer)
      this.attentionRefreshTimer = null
    }
    let attention = false
    try {
      attention = this.deps.computeAttention()
    } catch (error) {
      Logger.error('Background attention check failed', error)
    }
    // The figure is read on the database worker, so it lands a moment after the
    // attention state does and redraws the icon when it arrives.
    void this.refreshWorkingCount()
    if (attention === this.attention && this.tray) return
    this.attention = attention
    this.updateTrayAppearance()
  }

  /**
   * Re-read the working count, and redraw the icon when it moved.
   *
   * The read is asynchronous, so two can overlap (a burst of thread updates, a
   * run settling while another starts). Only the newest answer is applied, which
   * is what stops a slow earlier read from overwriting a newer count.
   */
  private async refreshWorkingCount(): Promise<void> {
    const request = ++this.workingCountRequest
    let count = 0
    try {
      count = await this.deps.countWorkingThreads()
    } catch (error) {
      Logger.error('Working-thread count failed', error)
    }
    if (this.stopped || request !== this.workingCountRequest) return
    if (count === this.workingCount) return
    this.workingCount = count
    this.updateTrayAppearance()
  }

  /**
   * Ask for an icon recompute, coalescing a burst into one pass. Wired to
   * every persisted thread update and to the retry scheduler, which is what
   * makes the icon clear itself   and the figure fall   the moment a run
   * settles.
   */
  requestTrayRefresh(): void {
    if (this.stopped || this.attentionRefreshTimer !== null) return
    this.attentionRefreshTimer = setTimeout(() => {
      this.attentionRefreshTimer = null
      this.refreshTrayState()
    }, ATTENTION_REFRESH_DEBOUNCE_MS)
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
   * Make this instance the main instance that owns scheduled work, at the user's
   * request. A secondary's "Make this the main instance" action asks for it,
   * which is the escape hatch when the elected owner is a stale window, or a
   * crashed process still in the registry, and the user wants the schedule where
   * they are working. The choice is durable: it is remembered for this app, so a
   * later launch of it reclaims the schedule after a restart. The previous owner
   * steps down through the same ownership notification and shows the secondary
   * notice instead.
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
    // Worth a line: "why is this app still sitting in the menu bar?" is otherwise
    // unanswerable from the outside, and the reason is the whole decision.
    Logger.info('Parking in the background', { reason: this.deps.residencyReason() })
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
    // Parked: the drain takes over as the only way back to a window.
    this.refreshActivationWatch()
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
      this.tray = new Tray(this.trayImage())
      this.tray.setToolTip(this.trayTooltip())
      this.tray.setContextMenu(this.buildContextMenu())
      // A left click on the icon opens the app, matching every other menu bar app.
      this.tray.on('click', () => this.deps.openWindow())
      if (process.platform === 'win32') {
        nativeTheme.on('updated', this.refreshWindowsTray)
        screen.on('display-metrics-changed', this.refreshWindowsTray)
        screen.on('display-added', this.refreshWindowsTray)
        screen.on('display-removed', this.refreshWindowsTray)
      }
    } catch (error) {
      Logger.error('Could not create the menu bar icon', error)
      this.tray = null
    }
  }

  private destroyTray(): void {
    if (process.platform === 'win32' && this.tray) {
      nativeTheme.removeListener('updated', this.refreshWindowsTray)
      screen.removeListener('display-metrics-changed', this.refreshWindowsTray)
      screen.removeListener('display-added', this.refreshWindowsTray)
      screen.removeListener('display-removed', this.refreshWindowsTray)
    }
    this.tray?.destroy()
    this.tray = null
    // The strips and the figure are only worth holding for an icon that exists.
    this.countStrips = null
    this.countImage = null
  }

  private updateTrayAppearance(): void {
    if (!this.tray) return
    try {
      this.tray.setImage(this.trayImage())
      this.tray.setToolTip(this.trayTooltip())
    } catch (error) {
      Logger.error('Could not update the menu bar icon', error)
    }
  }

  private readonly refreshWindowsTray = (): void => {
    this.updateTrayAppearance()
  }

  /**
   * The image for the icon's current state.
   *
   * The working figure owns the slot the attention exclamation uses   the same
   * slot, because the two answer the same question about the same icon   but
   * only on macOS: the Windows notification area draws every icon into a fixed
   * small square, so an appended figure there would be scaled down along with
   * the mark. Windows therefore keeps its plain and attention states, and its
   * tooltip still reports the count.
   */
  private trayImage(): NativeImage | string {
    if (this.workingCount > 0 && process.platform === 'darwin') {
      const image = this.workingCountImage()
      if (image) return image
    }
    return this.loadTrayImage(this.attention)
  }

  /**
   * Cut the current figure out of the shipped strip, cached per count.
   *
   * The strip holds every figure as one cell per resolution, so the icon is a
   * crop rather than a hundred committed templates. Both resolutions go into
   * one image, which is what gives a Retina menu bar the sharp one.
   *
   * Returns null when the art cannot be read, so the caller falls back to the
   * plain mark rather than leaving the user without an icon.
   */
  private workingCountImage(): NativeImage | null {
    if (this.countImage?.count === this.workingCount) return this.countImage.image
    const label = trayCountLabel(this.workingCount)
    if (label === null) return null
    try {
      const strips = this.countStrips ?? this.loadCountStrips()
      if (!strips) return null
      const scales: readonly TrayCountScale[] = [1, 2]
      let image: NativeImage | null = null
      for (const scale of scales) {
        const metrics = trayCountMetrics(scale)
        const cell = trayCountCells(scale).find((entry) => entry.label === label)
        if (!cell) continue
        const strip = scale === 1 ? strips.base : strips.retina
        const cropped = strip
          .crop({ x: cell.x, y: 0, width: cell.width, height: metrics.height })
          .toBitmap()
        if (!image) {
          image = nativeImage.createFromBitmap(cropped, {
            width: cell.width,
            height: metrics.height,
            scaleFactor: scale
          })
        } else {
          image.addRepresentation({
            scaleFactor: scale,
            width: cell.width,
            height: metrics.height,
            buffer: cropped
          })
        }
      }
      if (!image || image.isEmpty()) return null
      image.setTemplateImage(true)
      this.countImage = { count: this.workingCount, image }
      return image
    } catch (error) {
      Logger.error('Could not build the menu bar working-thread figure', error)
      return null
    }
  }

  /**
   * Decode the figure strips once and keep them.
   *
   * Read as buffers rather than paths on purpose: a path lets Electron pair a
   * `@2x` sibling in automatically, and the two resolutions have to stay
   * separate here because the cell grid is computed per resolution.
   */
  private loadCountStrips(): { base: NativeImage; retina: NativeImage } | null {
    try {
      const paths = this.deps.resolveTrayCountStrip()
      const base = nativeImage.createFromBuffer(readFileSync(paths.base))
      const retina = nativeImage.createFromBuffer(readFileSync(paths.retina))
      if (base.isEmpty() || retina.isEmpty()) return null
      this.countStrips = { base, retina }
      return this.countStrips
    } catch (error) {
      Logger.error('Could not read the menu bar working-thread strip', error)
      return null
    }
  }

  private loadTrayImage(attention: boolean): NativeImage | string {
    if (process.platform === 'win32') {
      // Keep the ICO path intact so Electron loads the native HICON at the
      // Windows small-icon metric, choosing from all embedded resolutions.
      // App theme and taskbar theme can differ on Windows.
      return this.deps.resolveTrayIcon(
        attention,
        nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
      )
    }
    const image = nativeImage.createFromPath(this.deps.resolveTrayIcon(attention))
    if (process.platform === 'darwin') image.setTemplateImage(true)
    return image
  }

  private trayTooltip(): string {
    if (this.workingCount > 0) {
      const threads = this.workingCount === 1 ? 'thread' : 'threads'
      return this.attention
        ? `${APP_NAME} is working ${this.workingCount} ${threads}, and one needs your attention`
        : `${APP_NAME} is working ${this.workingCount} ${threads}`
    }
    if (this.attention) return `${APP_NAME} has a thread that needs your attention`
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
      forceRestartMenuItem(() => this.deps.quitApp()),
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
      new Notification({ groupId: APP_ID, title, body }).show()
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
    // The icon's presence is half of what the drain watches, and a role change
    // is one of the two ways it can appear or vanish.
    this.refreshActivationWatch()
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
    if (!isShippedBuild()) return
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
    this.drainActivationRequests()
  }

  /**
   * Arm or clear the backstop poll over the activation directory.
   *
   * The poll covers two things a watch event cannot: a request file written by
   * another instance that the event never reported, and a menu bar icon that
   * failed to appear. Both only matter while this process has no window, because
   * a visible window is the user already being here: there is nothing to bring
   * forward, and whatever opened that window has just reconciled the icon. The
   * watcher itself stays armed either way, so an arriving request is still
   * delivered by its own event.
   */
  private refreshActivationWatch(): void {
    if (this.stopped) return
    const window = this.deps.state.mainWindow
    const hasWindow = window !== null && !window.isDestroyed() && window.isVisible()
    if (this.backgroundEnabled && (!hasWindow || this.tray === null)) this.armActivationPoll()
    else this.clearActivationPoll()
  }

  private armActivationPoll(): void {
    if (this.activationTimer) return
    this.activationTimer = setInterval(() => this.drainActivationRequests(), ACTIVATION_POLL_MS)
    this.activationTimer.unref()
    // Read once now rather than up to two seconds from now: a request that landed
    // while the poll was off, or an icon that is still missing, is handled here.
    this.drainActivationRequests()
  }

  private clearActivationPoll(): void {
    if (!this.activationTimer) return
    clearInterval(this.activationTimer)
    this.activationTimer = null
  }

  // ----------------------------------------------------------- residency ----

  /**
   * Decide whether a windowless process may exit, and arm the quit when it may.
   *
   * A parked process is a scheduler: it exists for the work it still has to do or
   * to hold, and once that drains there is nothing left to preserve, so it goes
   * instead of sitting in the menu bar. The decision is taken again on every state
   * change (see `refreshTrayState`) and on the drain tick below, so a drain is
   * acted on when it happens rather than at the next launch.
   *
   * Free while a window is on screen: a visible window is the user being here, so
   * the whole check is skipped instead of being run and discarded.
   */
  private evaluateResidency(): void {
    if (this.stopped || !this.isWindowlessAndRegistered()) {
      this.clearResidencyQuit()
      return
    }
    if (this.deps.residencyReason() !== null) {
      // A reason to stay is back, so a quit that was already armed is spent.
      this.clearResidencyQuit()
      return
    }
    if (this.residencyTimer !== null) return
    this.residencyTimer = setTimeout(() => {
      this.residencyTimer = null
      this.quitWhenDrained()
    }, RESIDENCY_DRAIN_GRACE_MS)
    this.residencyTimer.unref?.()
  }

  /** Take the exit, unless a reason to stay arrived inside the grace window. */
  private quitWhenDrained(): void {
    if (this.stopped || !this.isWindowlessAndRegistered()) return
    if (this.deps.residencyReason() !== null) return
    Logger.info('Nothing left to preserve: quitting instead of parking', {
      windowlessForMs: this.windowlessSince === null ? 0 : Date.now() - this.windowlessSince
    })
    this.deps.quitApp()
  }

  /**
   * Whether this process is the background one: registered, and with no window of
   * its own. `windowlessSince` is what keeps this false until a window has really
   * closed, so the first window, which does not exist yet during startup, is never
   * mistaken for a parked process.
   */
  private isWindowlessAndRegistered(): boolean {
    if (!this.backgroundEnabled || this.windowlessSince === null) return false
    const window = this.deps.state.mainWindow
    return window === null || window.isDestroyed() || !window.isVisible()
  }

  private clearResidencyQuit(): void {
    if (this.residencyTimer === null) return
    clearTimeout(this.residencyTimer)
    this.residencyTimer = null
  }

  private drainActivationRequests(): void {
    if (this.stopped) return
    // Self-heal the menu bar icon. It is created on startup, on a config
    // change, on an ownership/membership change, and on a window open, but any
    // of those can be missed or coalesced, and a process that owns the schedule
    // must never sit with an empty menu bar. A healed icon is also the end of
    // one of the two reasons this drain runs at all, so the poll is re-decided
    // before anything else (see `refreshActivationWatch`).
    if (!this.tray) {
      this.syncTray()
      this.refreshActivationWatch()
    }
    // The drain tick is the one thing that runs for as long as a windowless
    // process is parked, so it is also where the residency decision is re-taken
    // between state changes: the last reason to stay can drain without an event
    // that says so (a retry expiring, a run settling its final write).
    this.evaluateResidency()
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
        groupId: APP_ID,
        title: `${APP_NAME} is still running`,
        body: 'It stays in the menu bar so your schedules keep firing. Quit it from the menu bar icon.'
      })
      notification.show()
    } catch (error) {
      Logger.dev('Background notice could not be shown (non-fatal):', error)
    }
  }
}
