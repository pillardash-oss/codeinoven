import { app, BrowserWindow, dialog, nativeTheme, screen, session, shell } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { is } from '@electron-toolkit/utils'
import { APP_ID, APP_NAME } from '../lib/brand'
import { isLocalDevelopmentUrl } from '../lib/local-development-url'
import { Logger } from './system/logger'
import { Database } from './database/database'
import { ThreadRepo } from './database/repositories/thread-repo'
import { ProjectRepo } from './database/repositories/project-repo'
import { AccountProfileRepo } from './database/repositories/account-profile-repo'
import { loadDeviceIdentity } from './account/device-identity'
import { readMemorySyncState } from './remote/memory-sync-state'
import { StorageEngine } from './storage/storage-engine'
import { registerHydrationIpcHandlers } from './ipc/hydration-ipc'
import {
  installFilePreviewProtocol,
  registerFilePreviewScheme
} from './editor/file-preview-protocol'
import { WindowStateService } from './system/window-state'
import {
  setNotificationService,
  setPowerWakeService,
  broadcastThreadUpdate
} from './chat/thread-events'
import { installProductionApplicationMenu } from './system/production-housekeeping'
import { getTrafficLightArg, warmTrafficLightDetection } from './system/titlebar'
import { PrivilegedIpcValidator } from './ipc/ipc-validation'
import type { CloseConfirmationProject, ThreadClickedPayload } from '../lib/ipc-contract'
import { startupTelemetry } from './system/startup-telemetry'
import {
  handleFatalStartupFailure,
  installProcessCrashDiagnostics
} from './system/lifecycle-diagnostics'
import type { ChatEngine } from './chat/chat-engine'
import type { HarnessManifestService } from './agents/harness-manifest-service'
import type { ComputerUsePipService } from './utilities/computer-use-pip-service'
import type { UpdaterService } from './notifications/updater-service'
import type { PowerWakeService } from './system/power-wake-service'
import type { RetrySchedulerService } from './system/retry-scheduler-service'
import { ModelPricingService } from './providers/model-pricing-service'
import { ThreadCreationCoordinator } from './chat/thread-creation-coordinator'
import type { PtyService } from './system/pty-service'
import type { ProviderConnectionService } from './providers/provider-connection'
import type { HarnessUpdateService } from './agents/harness-update-service'
import type { HarnessAutoUpdateService } from './agents/harness-auto-update-service'
import type { HarnessInstallService } from './agents/harness-install-service'
import type { NotificationService } from './notifications/notification-service'
import type { RemoteModeController } from './remote/remote-mode'
import type { DeviceCredentialService } from './remote/device-credential-service'
import { appRendererNavigationTargets, trustedIpcMain as ipcMain } from './ipc/trusted-ipc-main'
import { PACKAGED_SMOKE_OUTPUT_ENV, writePackagedSmokeProof } from './system/packaged-smoke'
import { sendToRenderer } from './ipc/renderer-delivery'
import { hasNativeSplashHandoff, signalNativeSplashReady } from './system/native-splash-handoff'
import { instanceRegistry } from './system/instance-registry'
import { BrowserService } from './browser/browser-service'

const mainBundleDirectory = dirname(fileURLToPath(import.meta.url))

app.setName(APP_NAME)
// Enforce Chromium's OS-level renderer sandbox globally before `ready`; the
// per-window preferences below remain explicit so future windows inherit the
// secure expectation even when reviewed in isolation.
app.enableSandbox()
// Custom scheme must be registered as privileged before the app is ready so
// Chromium recognizes it when the renderer frames `appfile://` previews.
registerFilePreviewScheme()
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID)
}
if (app.isPackaged) {
  process.env['NODE_ENV'] = 'production'
}

/** Map OS termination signals into Electron's quit lifecycle so that every
 *  exit path (Cmd+Q, Dock menu, `kill`, system shutdown) converges into the
 *  same `before-quit` → disposal pipeline → `will-quit` sequence. */
function registerSignalHandlers(): void {
  const signals = ['SIGTERM', 'SIGINT'] as const
  for (const signal of signals) {
    process.on(signal, () => {
      Logger.info(`Received ${signal} — shutting down`)
      // OS-level signals always force the quit — no confirmation gate.
      quitConfirmed = true
      app.quit()
    })
  }
}
registerSignalHandlers()

// Start event-loop delay tracking as early as the process allows so the
// telemetry histogram captures the whole boot window, including module
// evaluation and Electron's ready handshake.
startupTelemetry.startEventLoopMonitor()
// Packaged launches record that the dependency-free parent already painted;
// direct Electron launches intentionally begin at process entry instead.
if (hasNativeSplashHandoff()) startupTelemetry.mark('nativeSplash:active')
// Electron process entry is marked exactly once at module scope.
startupTelemetry.mark('process:entry')
// Privacy-preserving process-wide crash policy: uncaught exceptions and
// unhandled rejections are logged and exit nonzero instead of leaving a
// headless or silently-hung process.
installProcessCrashDiagnostics()

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let browserService: BrowserService | null = null
let quitCleanupStarted = false
let shutdownFailsafe: ReturnType<typeof setTimeout> | null = null

/**
 * Close-confirmation gate. When the user closes the window (traffic-light
 * button) or quits (Cmd+Q / Dock) while threads are still working, the close
 * is intercepted and the renderer is asked to confirm. `quitConfirmed`
 * records that the user approved the forced close so the subsequent
 * close/quit passes straight through.
 */
let quitConfirmed = false

/** Projects that still have threads being worked on, most active first. */
function getActiveThreadProjects(): CloseConfirmationProject[] {
  try {
    const threadRepo = new ThreadRepo(database)
    const projectRepo = new ProjectRepo(database)
    const active = threadRepo.listActive()
    if (active.length === 0) return []
    const byProject = new Map<string, CloseConfirmationProject>()
    for (const thread of active) {
      let entry = byProject.get(thread.projectId)
      if (!entry) {
        const project = projectRepo.get(thread.projectId)
        entry = {
          projectId: thread.projectId,
          projectName: project?.name ?? thread.projectId,
          threadCount: 0,
          threads: []
        }
        byProject.set(thread.projectId, entry)
      }
      entry.threadCount++
      entry.threads.push({
        threadId: thread.id,
        title: thread.title,
        status: thread.status
      })
    }
    return [...byProject.values()].sort((a, b) => b.threadCount - a.threadCount)
  } catch (error) {
    Logger.error('Could not query active threads for close confirmation', error)
    return []
  }
}

/**
 * Decide whether a close/quit can proceed. With nothing working (or no window
 * to ask) the quit continues immediately; otherwise the renderer is prompted
 * and the quit pauses until `app:confirmClose` arrives.
 *
 * The renderer is always asked — it owns the unsaved-file editor state, which
 * also gates the close. It replies through `app:confirmClose` immediately when
 * nothing is pending, or shows the confirmation modal otherwise.
 */
function requestCloseConfirmation(): void {
  if (quitCleanupStarted || quitConfirmed) return
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    quitConfirmed = true
    app.quit()
    return
  }
  // When another live instance can keep a project's threads running, working
  // threads don't need to gate this instance's close — a surviving instance can
  // continue them. The renderer still owns the unsaved-file gate, which is
  // reported separately, so closing never silently drops unsaved editor state.
  const working = instanceRegistry.hasOtherLiveInstance() ? [] : getActiveThreadProjects()
  sendToRenderer(window.webContents, 'window:confirmClose', { projects: working, files: [] })
}

ipcMain.handle('app:confirmClose', async () => {
  // The user approved the forced close while threads are working. When another
  // live instance exists it can continue those threads, so this instance just
  // walks away without SIGTERM'ing the shared harness processes. Otherwise
  // terminate every still-streaming harness connection so no agent keeps
  // working after the app exits, then proceed.
  quitConfirmed = true
  try {
    if (chatEngine && !instanceRegistry.hasOtherLiveInstance()) {
      await chatEngine.terminateActiveConnections()
    }
  } catch (error) {
    Logger.error('Could not terminate active harness connections on close', error)
  }
  app.quit()
})

/**
 * Close the main window on the renderer's request (Cmd/Ctrl+W with nothing
 * active). Goes through the same `close` gate as the traffic-light button, so
 * working threads still get the close-confirmation prompt.
 */
ipcMain.handle('app:requestClose', () => {
  const window = mainWindow
  if (window && !window.isDestroyed()) {
    window.close()
  }
})

/** Track when a terminal in the renderer holds focus (Windows shortcut routing). */
ipcMain.on('terminal:focusState', (_event, focused: unknown) => {
  terminalFocused = focused === true
})

/** Guard so the renderer's readiness signal is timestamped at most once. */
let rendererReadyReported = false
let packagedSmokeProofStarted = false
let startupTelemetryReported = false
let featuresReady = false
let resolveFeaturesReady: (() => void) | null = null
const featuresReadyPromise = new Promise<void>((resolve) => {
  resolveFeaturesReady = resolve
})

/**
 * A packaged smoke pass proves more than script execution: the document must
 * load, Electron must report a rendered visual frame, and application
 * hydration must complete. The guard makes concurrent milestone callbacks
 * converge on one atomic proof and one clean shutdown.
 */
function markWorkspaceReadyIfInteractive(): void {
  if (!rendererReadyReported || !featuresReady) return
  startupTelemetry.mark('workspace:ready')
  void completeStartupIfReady()
}

async function completeStartupIfReady(): Promise<void> {
  const output = app.isPackaged ? process.env[PACKAGED_SMOKE_OUTPUT_ENV] : undefined
  if (
    !startupTelemetry.hasMarked('workspace:ready') ||
    !startupTelemetry.hasMarked('renderer:documentLoaded') ||
    !startupTelemetry.hasMarked('window:visualReady')
  ) {
    return
  }

  if (!startupTelemetryReported) {
    startupTelemetryReported = true
    startupTelemetry.stopEventLoopMonitor()
    startupTelemetry.report()
  }

  if (!output || packagedSmokeProofStarted) return
  packagedSmokeProofStarted = true
  try {
    await writePackagedSmokeProof(output, startupTelemetry.snapshot())
    setImmediate(() => app.quit())
  } catch (error) {
    Logger.error('Could not write packaged startup proof', error)
    app.exit(1)
  }
}

/** Sticky readiness query: unlike an event subscription, callers that mount
 * after post-paint registration still observe feature availability. */
ipcMain.handle('app:waitForFeatures', () => (featuresReady ? undefined : featuresReadyPromise))

/**
 * The renderer reports when its initial hydration is done (visible projects,
 * selected project, recent active threads). Timestamps the final startup
 * phases so the boot telemetry spans the whole chain from process entry to an
 * interactive workspace. Idempotent: repeated signals (e.g. renderer reload)
 * never re-record phases or re-emit the report.
 */
ipcMain.handle('app:rendererReady', async () => {
  if (rendererReadyReported) return
  rendererReadyReported = true
  startupTelemetry.mark('renderer:hydrated')
  markWorkspaceReadyIfInteractive()
  await completeStartupIfReady()
})

/**
 * Whether a terminal in the renderer currently holds focus. While true, the
 * shell owns keys that would otherwise be app shortcuts: Ctrl+W is left to
 * the shell's delete-word binding, and Cmd/Ctrl+T opens a new terminal tab.
 */
let terminalFocused = false

/**
 * Whether the shortcut closes the active surface. macOS only treats Cmd+W as
 * close (Ctrl+W must never close anything there); other platforms use Ctrl+W.
 */
function isCloseShortcut(input: Electron.Input): boolean {
  return (
    input.type === 'keyDown' &&
    !input.isAutoRepeat &&
    (process.platform === 'darwin' ? input.meta : input.control) &&
    !input.alt &&
    input.key.toLowerCase() === 'w'
  )
}

/**
 * Whether the shortcut opens a new terminal tab while a terminal is focused.
 * macOS uses Cmd+T; other platforms use Ctrl+T.
 */
function isNewTerminalShortcut(input: Electron.Input): boolean {
  return (
    input.type === 'keyDown' &&
    !input.isAutoRepeat &&
    (process.platform === 'darwin' ? input.meta : input.control) &&
    !input.alt &&
    input.key.toLowerCase() === 't'
  )
}
const isProduction = app.isPackaged || process.env['NODE_ENV'] === 'production'

/**
 * Window/session boundary validator. It guards external window creation,
 * navigation, permission requests, and downloads against unsafe schemes and
 * foreign documents; file-path scoping lives in `ipc-handlers.ts`.
 */

const windowBoundaryValidator = new PrivilegedIpcValidator({
  navigationTargets: appRendererNavigationTargets(),
  allowDevelopmentHttp: !isProduction
})

const storage = new StorageEngine()
const windowStateService = new WindowStateService(storage)
const database = new Database()

/**
 * Optional services constructed after the primary window paints (see
 * `bootOptionalServices`). Module evaluation only declares the bindings so the
 * heavy service graph (chat engine, PTY, harness, remote mode, …) never blocks
 * the splash or the first window. Every consumer guards for `null`.
 */
let chatEngine: ChatEngine | null = null
let ptyService: PtyService | null = null
let providerConnection: ProviderConnectionService | null = null
let harnessUpdateService: HarnessUpdateService | null = null
let harnessAutoUpdateService: HarnessAutoUpdateService | null = null
let harnessInstallService: HarnessInstallService | null = null
let harnessManifestService: HarnessManifestService | null = null
let computerUsePipService: ComputerUsePipService | null = null
let notificationService: NotificationService | null = null
let updaterService: UpdaterService | null = null
let powerWakeService: PowerWakeService | null = null
let retryScheduler: RetrySchedulerService | null = null
let remoteCredentials: DeviceCredentialService | null = null
let remoteMode: RemoteModeController | null = null
let modelPricingService: ModelPricingService | null = null
/**
 * Resolved lazily so the `appfile://` preview protocol can be installed before
 * the main window loads (its renderer requests previews as soon as it hydrates).
 * Populated in {@link bootPostPaintServices} once the file service exists.
 */
let appfileProjectFiles: import('./editor/project-files-service').ProjectFilesService | null = null
const threadCreation = new ThreadCreationCoordinator()

/** Resolve the app icon — static dir in dev, bundled renderer assets in production. */
function getAppIconPath(): string {
  return !isProduction && is.dev
    ? join(app.getAppPath(), 'src/renderer/static/icon.png')
    : join(mainBundleDirectory, '../renderer/icon.png')
}

/** macOS-specific icon artwork, sized per Apple guidelines. */
function getMacIconPath(): string {
  return !isProduction && is.dev
    ? join(app.getAppPath(), 'src/renderer/static/macos/AppIcon512.png')
    : join(mainBundleDirectory, '../renderer/macos/AppIcon512.png')
}

/**
 * Resolve the preload script path. electron-vite's output extension varies
 * across versions (.js / .mjs / .cjs depending on module settings), so probe
 * for whichever file was actually emitted instead of hardcoding one.
 */
function getPreloadPath(): string {
  const dir = join(mainBundleDirectory, '../preload')
  for (const name of ['index.mjs', 'index.js', 'index.cjs']) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return join(dir, 'index.js')
}

/**
 * Frameless splash shown as soon as Electron permits a window — the app `ready`
 * event (a window simply cannot exist before that in Electron). Shown
 * immediately rather than gated on `ready-to-show`; the matching
 * `backgroundColor` means the Obsidian surface paints the instant the window
 * exists, then the logo/spinner layer on top. Closed once the main window
 * paints.
 */
type SplashVisualOutcome = 'ready' | 'closed' | 'load-failed' | 'timeout'

const SPLASH_VISUAL_TIMEOUT_MS = 5_000

function waitForSplashVisual(splash: BrowserWindow): Promise<SplashVisualOutcome> {
  return new Promise((resolveVisual) => {
    let settled = false
    const finish = (outcome: SplashVisualOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveVisual(outcome)
    }
    const timeout = setTimeout(() => finish('timeout'), SPLASH_VISUAL_TIMEOUT_MS)
    splash.once('ready-to-show', () => finish('ready'))
    splash.once('closed', () => finish('closed'))
    splash.webContents.once('did-fail-load', () => finish('load-failed'))
  })
}

function createSplashWindow(): {
  splash: BrowserWindow
  visualReady: Promise<SplashVisualOutcome>
} {
  const width = 420
  const height = 320
  const displayBounds = screen.getPrimaryDisplay().bounds
  const splash = new BrowserWindow({
    width,
    height,
    x: Math.round(displayBounds.x + (displayBounds.width - width) / 2),
    y: Math.round(displayBounds.y + (displayBounds.height - height) / 2),
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    }
  })
  splashWindow = splash
  const visualReady = waitForSplashVisual(splash)

  const loading =
    !isProduction && is.dev && process.env['ELECTRON_RENDERER_URL']
      ? splash.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/splash.html`)
      : splash.loadFile(join(mainBundleDirectory, '../renderer/splash.html'))
  // `did-fail-load` resolves the visual barrier as `load-failed`; consume the
  // matching navigation rejection so it cannot become an unhandled promise.
  void loading.catch(() => undefined)

  splash.once('closed', () => {
    if (splashWindow === splash) splashWindow = null
  })
  return { splash, visualReady }
}

function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
  }
  splashWindow = null
}

/**
 * Construct and register the optional service graph after the primary window
 * has painted. Dynamic imports keep the heavy modules (PTY, harness services,
 * provider connection, remote mode, notifications, …) out of the
 * module-evaluation path so first paint is never blocked by their construction.
 * Hydration IPC (config/project/bounded-thread/scope reads plus `app:*`) is
 * registered before navigation. Feature IPC, chat, provider catalog, file
 * preview, and optional services are registered here after first paint.
 */
async function bootPostPaintServices(): Promise<void> {
  if (updaterService) return
  const [
    { registerIpcHandlers },
    { ProjectManager },
    { ProjectFilesService },
    { ChatEngine },
    { HarnessManifestService },
    { ComputerUsePipService },
    { UpdaterService },
    { PowerWakeService },
    { RetrySchedulerService }
  ] = await Promise.all([
    import('./ipc/ipc-handlers'),
    import('../lib/engines/project-manager'),
    import('./editor/project-files-service'),
    import('./chat/chat-engine'),
    import('./agents/harness-manifest-service'),
    import('./utilities/computer-use-pip-service'),
    import('./notifications/updater-service'),
    import('./system/power-wake-service'),
    import('./system/retry-scheduler-service')
  ])

  const projectManager = new ProjectManager(database)
  const projectFilesService = new ProjectFilesService(projectManager)
  appfileProjectFiles = projectFilesService
  computerUsePipService = new ComputerUsePipService(storage)
  harnessManifestService = new HarnessManifestService(storage)
  modelPricingService = new ModelPricingService(storage)
  chatEngine = new ChatEngine(
    storage,
    database,
    computerUsePipService,
    harnessManifestService,
    threadCreation,
    join(app.getPath('userData'), 'owned-processes.json')
  )
  // Merge the app-managed lean opencode agents into the machine-wide global
  // config. Idempotent, additive-only and non-fatal; runs after first paint
  // so it never blocks the workspace, and logs a dev-only summary.
  const { syncOpenCodeLeanAgents } = await import('./opencode/opencode-agent-service')
  await syncOpenCodeLeanAgents().catch((error) =>
    Logger.dev('opencode lean-agent sync failed (non-fatal):', error)
  )
  updaterService = new UpdaterService(storage)
  powerWakeService = new PowerWakeService(storage, database)
  retryScheduler = new RetrySchedulerService(storage)
  if (mainWindow && !mainWindow.isDestroyed()) {
    const service = new BrowserService(mainWindow)
    browserService = service
    service.register()
    chatEngine.setBrowserUtilityExecutor((operation, input, context) =>
      service.executeUtility(operation, input, context)
    )
  }
  // Keep the device awake while a scheduled auto-retry is due within the wake
  // window, so a usage-limit reset fires even when the user is away.
  powerWakeService.attachRetryScheduler(retryScheduler)
  retryScheduler.attachChangeListener(() => powerWakeService?.onRetryScheduleChanged())
  updaterService.setChatEngine(chatEngine)
  // Reap any harness processes orphaned by an unclean previous run before the
  // first session can spawn fresh servers, so leftover dev servers/ports are
  // reclaimed without ever touching a harness the user runs outside the app.
  try {
    const reaped = await chatEngine.reapOrphanProcesses()
    if (reaped.killed.length > 0 || reaped.skipped.length > 0) {
      Logger.info('Reaped orphaned harness processes from an unclean shutdown', {
        killed: reaped.killed,
        skipped: reaped.skipped
      })
    }
  } catch (error) {
    Logger.error('Orphaned harness process reaping failed at startup:', error)
  }
  registerIpcHandlers(storage, database, updaterService, chatEngine, {
    projectManager,
    projectFilesService,
    powerWakeService,
    retryScheduler,
    harnessManifestService,
    threadCreation,
    hydrationHandlersRegistered: true
  })
  chatEngine.register()
  harnessManifestService.register()
  chatEngine.attachRetryScheduler(retryScheduler)
  featuresReady = true
  startupTelemetry.mark('features:ready')
  markWorkspaceReadyIfInteractive()
  resolveFeaturesReady?.()
  resolveFeaturesReady = null
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    sendToRenderer(mainWindow.webContents, 'app:featuresReady')
  }

  void (async () => {
    const [
      { PtyService },
      { ProviderConnectionService },
      { HarnessUpdateService },
      { HarnessInstallService },
      { HarnessAutoUpdateService },
      { RemoteModeController, DEFAULT_LAN_PORT, remoteEnvInt, remotePeerSecret },
      { RemoteRpcDispatcher },
      { DeviceCredentialService },
      { HarnessUsageRepo },
      { MemoryService },
      { NotificationService },
      { RestartRecoveryService }
    ] = await Promise.all([
      import('./system/pty-service'),
      import('./providers/provider-connection'),
      import('./agents/harness-update-service'),
      import('./agents/harness-install-service'),
      import('./agents/harness-auto-update-service'),
      import('./remote/remote-mode'),
      import('./remote/remote-rpc'),
      import('./remote/device-credential-service'),
      import('./database/repositories/harness-usage-repo'),
      import('./chat/memory-service'),
      import('./notifications/notification-service'),
      import('./system/restart-recovery-service')
    ])

    ptyService = new PtyService(storage, database)
    providerConnection = new ProviderConnectionService()
    harnessUpdateService = new HarnessUpdateService(providerConnection)
    harnessAutoUpdateService = new HarnessAutoUpdateService(storage)
    harnessInstallService = new HarnessInstallService(providerConnection)
    notificationService = new NotificationService(storage, database, openThreadFromNotification)

    /** Keep-alive remote mode: Tray + LAN gateway + quit interception. */
    remoteCredentials = new DeviceCredentialService(database)
    const accountProfileRepo = new AccountProfileRepo(database)
    const accountUsage = new HarnessUsageRepo(database)
    const accountMemory = new MemoryService(storage)
    remoteMode = new RemoteModeController({
      lanPort: remoteEnvInt('LAN_PORT', DEFAULT_LAN_PORT),
      localPort: remoteEnvInt('LAN_LOCAL_PORT', DEFAULT_LAN_PORT + 1),
      peerSecret: remotePeerSecret(),
      staticRoot: join(mainBundleDirectory, '../renderer'),
      iconPath: getAppIconPath(),
      rpc: new RemoteRpcDispatcher({
        database,
        chatEngine: chatEngine!,
        storage,
        credentials: remoteCredentials
      }),
      storage,
      credentials: remoteCredentials,
      accountProfileRepo,
      loadAccountProfileData: async () => {
        const identity = await loadDeviceIdentity(storage)
        const analytics = await accountUsage.profileSummary()
        const globalMemories = (await accountMemory.getEntries()).filter(
          (entry) => entry.scope === 'global'
        )
        const syncState = await readMemorySyncState(storage)
        return {
          deviceId: identity.deviceId,
          deviceLabel: identity.deviceLabel,
          platform: identity.platform,
          usage: {
            deviceId: identity.deviceId,
            deviceLabel: identity.deviceLabel,
            platform: identity.platform,
            messageCount: analytics.messageCount,
            costUsd: analytics.costUsd,
            tokens: analytics.tokens,
            durationMs: analytics.durationMs,
            activeDays: analytics.activityDays.length,
            projects: await accountUsage.projectUsageSummary(),
            updatedAt: Date.now()
          },
          globalMemories,
          globalMemoryTombstones: syncState?.tombstones ?? []
        }
      },
      applyGlobalMemories: async (entries) => {
        // The server returns the tombstone-filtered union of every device's
        // memories, so replacing the local list is what propagates deletions.
        await accountMemory.saveEntries(entries.filter((entry) => entry.scope === 'global'))
      },
      onSessionActiveChange: (active) => powerWakeService?.setRemoteSessionActive(active)
    })

    // Optional IPC — registered only after the services exist.
    if (updaterService) {
      updaterService.addActivitySource({
        activeSessionCount: () => ptyService?.activeSessionCount() ?? 0
      })
      updaterService.addActivitySource({
        activeSessionCount: () => (remoteMode?.status.blockedQuit ? 1 : 0)
      })
    }
    remoteMode.registerIpc()
    ptyService.register()
    providerConnection.register()
    harnessUpdateService.register()
    harnessAutoUpdateService.register()
    harnessInstallService.register()

    const { registerProviderAccountIpc } = await import('./ipc/provider-account-ipc')
    const { registerBaseUrlProviderIpc } = await import('./providers/base-url-provider-ipc')
    const { registerUtilityIpc } = await import('./ipc/utility-ipc')
    registerProviderAccountIpc()
    registerBaseUrlProviderIpc(storage)
    registerUtilityIpc(storage, undefined, undefined, undefined, computerUsePipService ?? undefined)

    // Wire PTY to the window now that it exists.
    if (mainWindow && !mainWindow.isDestroyed()) {
      ptyService.attach(mainWindow.webContents)
    }

    try {
      await powerWakeService?.start()
      if (powerWakeService) setPowerWakeService(powerWakeService)
    } catch (error) {
      Logger.error('Power wake startup failed (non-fatal):', error)
    }

    try {
      await retryScheduler?.start()
    } catch (error) {
      Logger.error('Retry scheduler startup failed (non-fatal):', error)
    }

    try {
      modelPricingService?.start()
    } catch (error) {
      Logger.error('Model pricing startup failed (non-fatal):', error)
    }

    try {
      const recovery = await new RestartRecoveryService(database).recover()
      if (recovery.recovered.length > 0) {
        Logger.info('Recovered interrupted threads', {
          inspected: recovery.inspected,
          recovered: recovery.recovered.map((thread) => ({
            projectId: thread.projectId,
            threadId: thread.id
          }))
        })
        // The renderer's thread list was hydrated before recovery ran, so its
        // in-memory rows still hold the stale planning/executing status. Push
        // the corrected snapshots so sidebar indicators flip to "interrupted"
        // immediately instead of lingering on "working" until the thread is
        // reopened. `interrupted` is not a notifiable status, so this cannot
        // fire spurious OS notifications.
        for (const thread of recovery.recovered) {
          broadcastThreadUpdate(thread)
        }
      }
      // Threads whose turns demonstrably completed before the stop are finalized
      // as `completed`, never resumed. Broadcast their corrected status too so the
      // sidebar doesn't linger on the stale "working" indicator.
      if (recovery.completed.length > 0) {
        Logger.info('Finalized completed interrupted threads', {
          inspected: recovery.inspected,
          completed: recovery.completed.map((thread) => ({
            projectId: thread.projectId,
            threadId: thread.id
          }))
        })
        for (const thread of recovery.completed) {
          broadcastThreadUpdate(thread)
        }
      }
      if (recovery.failures.length > 0) {
        Logger.error('Restart recovery completed with failures', recovery.failures)
      }
      await chatEngine?.resumePendingWork()
      // Resume the interrupted threads themselves (regular + Sr. Engineer),
      // gated by the "Resume work on restart" setting. Each resumed thread
      // broadcasts a working status so the sidebar flips immediately.
      if (recovery.recovered.length > 0) {
        await chatEngine?.resumeRecoveredThreads(recovery.recovered)
      }
    } catch (error) {
      Logger.error('Restart recovery failed (non-fatal):', error)
    }

    // Restore remote mode after paint so users can see app UI while the LAN
    // stack spins up in the background.
    void remoteMode
      .restoreRemoteMode()
      .catch((error) => Logger.error('Remote mode restore failed (non-fatal):', error))

    try {
      notificationService.start()
      setNotificationService(notificationService)
      updaterService?.start()
    } catch (error) {
      Logger.error('Update/notification startup failed (non-fatal):', error)
    }
  })()
}

/**
 * First-paint colour for the main window, matched to the renderer's resolved
 * theme (mirrors `--color-app` from app.css). Without it the window can flash
 * the default white body while the bundle boots on a slow machine.
 */
function getStartupBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0b0b0d' : '#f7f6f2'
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...windowStateService.getWindowOptions(),
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: getStartupBackground(),
    title: APP_NAME,
    icon: getAppIconPath(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required',
      // Keep the renderer responsive when the window is hidden or occluded so
      // background events (e.g. the notification alert played from the
      // renderer) are handled the moment they arrive instead of after Chromium
      // throttles the backgrounded page.
      backgroundThrottling: false,
      preload: getPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
      // The preload resolves the platform traffic-light layout from this flag
      // so the renderer never flashes a wrong inset on first paint.
      additionalArguments: [getTrafficLightArg()],
      // Built-in Chromium PDF plugin (PDFium-backed viewer, annotations,
      // forms, search) — available in Electron 29+.
      plugins: true
    }
  })
  mainWindow = window

  window.once('ready-to-show', () => {
    // Restore the maximized state before revealing the first rendered frame so
    // the window never flashes at its restored size while the splash closes.
    if (windowStateService.shouldRestoreMaximized() && !window.isMaximized()) {
      window.maximize()
    }
    window.show()
  })

  window.on('close', (event) => {
    // Closing the window always closes the app — nothing is kept alive in the
    // Tray. Gate the close while threads are working — ask the renderer to
    // confirm before letting the window (and with it the app) go away. During
    // an approved quit the flags below let the close pass straight through.
    if (quitConfirmed || quitCleanupStarted) return
    event.preventDefault()
    requestCloseConfirmation()
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  if (ptyService) {
    ptyService.attach(window.webContents)
  }
  windowStateService.attach(window)

  window.webContents.on('before-input-event', (event, input) => {
    // Cmd/Ctrl+W is handled by the renderer ("close the active surface": modal,
    // settings page, or thread). Prevent the default here so the macOS
    // application menu's "Close Window" accelerator never closes the window
    // before the renderer can decide what should actually close.
    //
    // On non-mac platforms, when a terminal is focused, Ctrl+W is the shell's
    // delete-word binding — leave it alone so it reaches the shell.
    if (isCloseShortcut(input) && !(terminalFocused && process.platform !== 'darwin')) {
      event.preventDefault()
      sendToRenderer(window.webContents, 'window:closeShortcut')
    }
    // Cmd/Ctrl+T while a terminal is focused opens a new terminal tab in the
    // renderer. Intercept here so ghostty-web never swallows the key and feeds
    // its WASM-encoded sequence to the shell.
    if (isNewTerminalShortcut(input) && terminalFocused) {
      event.preventDefault()
      sendToRenderer(window.webContents, 'window:newTerminalShortcut')
    }
  })

  // External links leave the app through the default browser only when they
  // are safe web URLs. Every popup is denied regardless — the renderer never
  // spawns a second window.
  window.webContents.setWindowOpenHandler((details) => {
    try {
      const safeUrl = windowBoundaryValidator.validateExternalUrl(details.url)
      if (isLocalDevelopmentUrl(safeUrl)) {
        void storage
          .getConfig()
          .then((config) => {
            if (window.isDestroyed() || window.webContents.isDestroyed()) return
            if (config.openLocalhostInCioBrowser) {
              sendToRenderer(window.webContents, 'browser:openRequested', safeUrl)
            } else {
              void shell.openExternal(safeUrl)
            }
          })
          .catch((error: unknown) => Logger.error('Local link routing failed:', error))
      } else {
        void shell.openExternal(safeUrl)
      }
    } catch (error) {
      Logger.error('Window open rejected unsafe URL:', error)
    }
    return { action: 'deny' }
  })

  // The renderer is a single-page application: never let the main frame
  // navigate away from the app's own renderer URL (exact match in production,
  // same-origin to the dev server in development).
  window.webContents.on('will-navigate', (event, url) => {
    if (!windowBoundaryValidator.isTrustedNavigation(url)) {
      event.preventDefault()
    }
  })

  if (!isProduction && is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(mainBundleDirectory, '../renderer/index.html'))
  }

  return window
}

function openThreadFromNotification(payload: ThreadClickedPayload): void {
  // A quit is already in progress — never spawn a window mid-shutdown.
  if (quitCleanupStarted) return
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()

  const revealAndSend = (): void => {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
    sendToRenderer(window.webContents, 'notification:threadClicked', payload)
  }

  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', revealAndSend)
    return
  }
  revealAndSend()
}

void app
  .whenReady()
  .then(async () => {
    startupTelemetry.mark('electron:ready')
    // Register this process in the instance registry before any window exists so
    // the close gate can later tell whether other live instances can keep a
    // project's threads running.
    instanceRegistry.start()
    // This is the first post-ready action. Construct and show the native splash
    // immediately, then yield the main event loop until Chromium presents its
    // first frame. Synchronous SQLite/schema work cannot begin before this
    // barrier, so low-end devices always get visual feedback first.
    const { visualReady: splashVisualReady } = createSplashWindow()
    startupTelemetry.mark('splash:created')
    const splashOutcome = await splashVisualReady
    if (splashOutcome === 'ready') {
      startupTelemetry.mark('splash:visualReady')
    }
    // A launcher must never remain topmost forever if the Chromium splash
    // fails. The normal path releases it after the first rendered frame; the
    // bounded failure path releases it after the splash barrier resolves.
    signalNativeSplashReady()

    // Only after the splash is visibly rendered, wire the durable log sink
    // before any fallible startup work. The error
    // dialog tells the user to "export diagnostics after the app opens", which
    // only works if startup failures are actually persisted — so the log path
    // must be known before `database.init()` can abort the startup chain.
    mkdirSync(dirname(storage.resolve('logs/main.jsonl')), { recursive: true })
    Logger.initialize(storage.resolve('logs/main.jsonl'))
    if (splashOutcome !== 'ready') {
      Logger.error('Splash did not reach visual readiness before startup continued', {
        outcome: splashOutcome
      })
    }

    if (isProduction) {
      installProductionApplicationMenu(APP_NAME)
    }

    // In dev the raw Electron binary lacks a bundled icon — set it explicitly.
    // Cosmetic: must never abort the startup chain if the artwork is missing.
    if (process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(getMacIconPath())
      } catch (error) {
        Logger.error('dock icon setup failed (non-fatal):', error)
      }
    }

    // Storage and database warm-up are independent — run them concurrently.
    await Promise.all([
      storage.initialize(),
      database.init(),
      // Windows/macOS resolve instantly; Linux reads GTK settings. Starting it
      // here guarantees the flag is ready before `createWindow()` runs without
      // serializing behind the heavier startup work.
      warmTrafficLightDetection()
    ])
    startupTelemetry.mark('storage:ready')
    startupTelemetry.mark('database:ready')
    await windowStateService.load()
    Logger.info(`${APP_NAME} main process initialized`)

    // The renderer invokes its first config/project/scope/thread reads while
    // its document evaluates. Register that bounded surface before navigation;
    // the feature graph remains dynamically imported after first paint.
    registerHydrationIpcHandlers(storage, database, threadCreation)

    // Deny every permission request from the renderer (camera, microphone,
    // notifications, geolocation, fullscreen, etc.). No desktop feature relies
    // on web permission grants.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    // Deny all downloads initiated from the renderer; exports always use the
    // native save dialog in the main process.
    session.defaultSession.on('will-download', (event) => {
      event.preventDefault()
    })

    // Install the `appfile://` preview protocol before the renderer loads: the
    // packaged renderer requests preview images as soon as it hydrates, and if
    // the handler is not yet registered Chromium rejects those early requests
    // with `net::ERR_UNKNOWN_URL_SCHEME`, leaving file-tree images permanently
    // broken. The file service is resolved lazily from bootPostPaintServices.
    installFilePreviewProtocol(() => appfileProjectFiles)

    const window = createWindow()
    startupTelemetry.mark('window:created')

    // Failsafe: never let the splash outlive the app even if the renderer
    // never paints (e.g. a script error) — dismiss it after the bounded budget.
    // The budget is generous (60s) because on a low-end machine the renderer
    // legitimately takes a long time to boot; closing early would drop the
    // user onto a bare window while it still loads.
    let documentLoaded = false
    let visualReady = false
    let postVisualServicesStarted = false

    const startPostVisualServices = (force = false): void => {
      if (postVisualServicesStarted || (!force && (!documentLoaded || !visualReady))) return
      postVisualServicesStarted = true
      // All feature service graphs are imported and constructed only after
      // the primary window has both loaded and rendered. This includes the IPC
      // graph, so optional engines never compete with the visible workspace.
      void bootPostPaintServices().catch((error) => {
        void handleFatalStartupFailure({
          error,
          appName: APP_NAME,
          resources: [{ name: 'database', close: () => database.close() }],
          showErrorBox: dialog.showErrorBox,
          quit: (code) => app.exit(code),
          telemetry: startupTelemetry
        })
      })
    }

    const splashFailsafe = setTimeout(() => {
      closeSplash()
      if (!window.isDestroyed() && !window.isVisible()) window.show()
      if (!postVisualServicesStarted) {
        Logger.error(
          'Visual startup milestone timed out; starting optional services in fallback mode'
        )
        startPostVisualServices(true)
      }
    }, 60_000)
    window.webContents.once('did-finish-load', () => {
      documentLoaded = true
      startupTelemetry.mark('renderer:documentLoaded')
      startPostVisualServices()
      void completeStartupIfReady()
    })
    window.once('ready-to-show', () => {
      visualReady = true
      startupTelemetry.mark('window:visualReady')
      clearTimeout(splashFailsafe)
      closeSplash()
      startPostVisualServices()
      void completeStartupIfReady()
    })
    window.once('closed', () => {
      clearTimeout(splashFailsafe)
      closeSplash()
    })

    app.on('activate', () => {
      // The app always quits when its last window closes, so a dock click
      // can only land during the shutdown grace period — ignore it then.
      if (quitCleanupStarted) return
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
  .catch(async (error: unknown) => {
    closeSplash()
    // Deterministically close resources and quit with a nonzero diagnostic
    // code so a failed boot never leaves a headless process. Logs, flushes the
    // durable log, closes the database (and any other initialized resource),
    // shows the error box, then exits(1) — falling back to process.exit if the
    // Electron quit callback throws.
    await handleFatalStartupFailure({
      error,
      appName: APP_NAME,
      resources: [
        {
          name: 'database',
          close: () => database.close()
        },
        {
          name: 'chatEngine',
          close: () => void chatEngine?.dispose()
        },
        {
          name: 'remoteMode',
          close: () => void remoteMode?.dispose()
        },
        {
          name: 'ptyService',
          close: () => ptyService?.destroyAll()
        },
        {
          name: 'updaterService',
          close: () => updaterService?.stop()
        },
        {
          name: 'notificationService',
          close: () => notificationService?.stop()
        },
        {
          name: 'powerWakeService',
          close: () => powerWakeService?.stop()
        },
        {
          name: 'retryScheduler',
          close: () => retryScheduler?.dispose()
        }
      ],
      showErrorBox: (title, message) => dialog.showErrorBox(title, message),
      quit: (code) => app.exit(code),
      telemetry: startupTelemetry
    })
  })

app.on('window-all-closed', () => {
  // Closing the last window (traffic-light close button) fully quits the app.
  // Cmd+Q follows the same path through before-quit → shutdown pipeline →
  // will-quit. Nothing is kept alive in the Dock or Tray after the user closes.
  app.quit()
})

/**
 * Ordered disposal executed once the quit lifecycle begins.
 *
 * 1. Renderer notification + 500ms grace period
 * 2. Remote mode torn down (gateway, Tray, keep-alive, event forwarder)
 * 3. PTY sessions destroyed
 * 4. Notification service stopped
 * 5. Chat engine / driver processes disposed
 * 6. Log buffer flushed
 * 7. app.quit() — re-enters before-quit, but the guard skips cleanup
 *    and Electron proceeds to close windows → will-quit → exit.
 */
async function runShutdownPipeline(): Promise<void> {
  // Give the renderer a moment to process window:beforeQuit.
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  // Close the phone gateway, destroy the Tray, and disarm keep-alive first so
  // closing the app disconnects every remote session and leaves nothing behind.
  try {
    await remoteMode?.dispose()
  } catch (error) {
    Logger.error('Remote mode cleanup failed during shutdown:', error)
  }

  try {
    updaterService?.stop()
  } catch (error) {
    Logger.error('Updater service cleanup failed during shutdown:', error)
  }

  try {
    ptyService?.destroyAll()
  } catch (error) {
    Logger.error('PTY cleanup failed during shutdown:', error)
  }

  try {
    notificationService?.stop()
  } catch (error) {
    Logger.error('Notification service cleanup failed during shutdown:', error)
  }
  setNotificationService(null)
  setPowerWakeService(null)
  try {
    powerWakeService?.stop()
  } catch (error) {
    Logger.error('Power-wake cleanup failed during shutdown:', error)
  }

  try {
    retryScheduler?.dispose()
  } catch (error) {
    Logger.error('Retry scheduler cleanup failed during shutdown:', error)
  }

  try {
    modelPricingService?.stop()
  } catch (error) {
    Logger.error('Model pricing cleanup failed during shutdown:', error)
  }

  try {
    browserService?.dispose()
    browserService = null
  } catch (error) {
    Logger.error('Browser service cleanup failed during shutdown:', error)
  }

  try {
    await computerUsePipService?.dispose()
  } catch (error) {
    Logger.error('Computer-use PiP service cleanup failed during shutdown:', error)
  }

  // Persist the final window geometry so the next launch restores size, position,
  // and maximized state exactly as the user left them.
  try {
    await windowStateService.persistNow(mainWindow)
  } catch (error) {
    Logger.error('Window state flush failed during shutdown:', error)
  }

  // When another live instance can continue the project's threads, this
  // instance exits without disposing the chat engine — disposal kills every
  // agent-owned harness process, which would destroy threads the surviving
  // instance is still working on. The threads' durable state lives in the
  // shared DB, so the other instance resumes them seamlessly.
  if (!instanceRegistry.hasOtherLiveInstance()) {
    try {
      await chatEngine?.dispose()
    } catch (error) {
      Logger.error('Chat engine disposal failed during shutdown:', error)
    }
  }

  try {
    await Logger.flush()
  } catch {
    // Logger may already be flushed; nothing more can be written.
  }

  try {
    // Await the graceful database close (typed worker shutdown acknowledged +
    // primary connection closed) so app.quit() never races the storage teardown.
    await database.close()
  } catch (error) {
    Logger.error('Database close failed during shutdown:', error)
  }

  instanceRegistry.stop()

  app.quit()
}

app.on('before-quit', (event) => {
  if (quitCleanupStarted) return
  event.preventDefault()

  // If the user hasn't explicitly approved a force close, gate the quit on the
  // close-confirmation flow (which proceeds immediately when nothing is working).
  if (!quitConfirmed) {
    requestCloseConfirmation()
    return
  }
  quitCleanupStarted = true

  // Notify every window that the application is shutting down so the
  // renderer can unsubscribe from IPC events and release resources.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      sendToRenderer(win.webContents, 'window:beforeQuit')
    }
  }

  void runShutdownPipeline().finally(() => {
    if (shutdownFailsafe) {
      clearTimeout(shutdownFailsafe)
      shutdownFailsafe = null
    }
  })

  // Failsafe: if any disposal step hangs, force the process to exit so the app
  // never lingers in the Dock with a stale icon after the user chose to close.
  shutdownFailsafe = setTimeout(() => {
    Logger.error('Shutdown pipeline timed out — forcing exit')
    app.exit(0)
  }, 15_000)
})

app.on('will-quit', () => {
  // Final synchronous cleanup — the app has committed to terminating.
  setNotificationService(null)
})
