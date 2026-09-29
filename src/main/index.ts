import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { is } from '@electron-toolkit/utils'
import { APP_ID, APP_NAME, brandUserAgent } from '../lib/brand'
import { isLocalDevelopmentUrl } from '../lib/local-development-url'
import { Logger } from './system/logger'
import { LOGS_DIRECTORY } from './system/log-paths'
import { Database } from './database/database'
import { StorageEngine } from './storage/storage-engine'
import { registerGlobalBrowserIpcHandlers } from './ipc/global-browser-ipc'
import { registerHydrationIpcHandlers } from './ipc/hydration-ipc'
import { registerFilePreviewScheme } from './editor/file-preview-protocol'
import { WindowStateService } from './system/window-state'
import { setNotificationService } from './chat/thread-events'
import {
  installProductionApplicationMenu,
  lockDownProductionWindow
} from './system/production-housekeeping'
import { getTrafficLightArg, warmTrafficLightDetection } from './system/titlebar'
import { PrivilegedIpcValidator } from './ipc/ipc-validation'
import type { ThreadClickedPayload } from '../lib/ipc-contract'
import { startupTelemetry } from './system/startup-telemetry'
import { installProcessCrashDiagnostics } from './system/lifecycle-diagnostics'
import { ThreadCreationCoordinator } from './chat/thread-creation-coordinator'
import { ThreadDeletionCoordinator } from './chat/thread-deletion-coordinator'
import { appRendererNavigationTargets, trustedIpcMain as ipcMain } from './ipc/trusted-ipc-main'
import { PACKAGED_SMOKE_OUTPUT_ENV, writePackagedSmokeProof } from './system/packaged-smoke'
import { sendToRenderer } from './ipc/renderer-delivery'
import { hasNativeSplashHandoff, signalNativeSplashReady } from './system/native-splash-handoff'
import { instanceRegistry } from './system/instance-registry'
import { createBootstrapState } from './bootstrap/bootstrap-state'
import { configureLinuxElectronDataRoot, logConfiguredDataRoot } from './bootstrap/data-root'
import { createSplashWindow, closeSplash } from './bootstrap/splash-window'
import { isCloseShortcut, isNewTerminalShortcut } from './bootstrap/keyboard-shortcuts'
import {
  armQuitFailsafe,
  flushSessionStorage,
  requestCloseConfirmation
} from './bootstrap/quit-lifecycle'
import { flushOpenedPathsToRenderer, installOpenWithHandling } from './bootstrap/open-with'
import { bootPostPaintServices, attachWindowServices } from './bootstrap/post-paint-services'
import { runShutdownPipeline } from './bootstrap/shutdown-pipeline'
import { BackgroundLifecycleService } from './system/background-lifecycle-service'
import { consumeBackgroundRelaunchMarker } from './notifications/updater-relaunch'
import { computeAttention, hasUpcomingWork } from './system/background-work-state'
import { handleFatalStartup } from './bootstrap/fatal-startup'
import {
  installAppFilePreviewProtocol,
  installRendererSessionGuards
} from './bootstrap/session-guards'

declare const __CODEINOVEN_PROTOTYPE_PREVIEW_ORIGIN__: string | undefined
declare const __CODEINOVEN_APP_VERSION__: string

const mainBundleDirectory = dirname(fileURLToPath(import.meta.url))

app.setName(APP_NAME)
// Naming the app is not enough on its own: Chromium still advertises
// `Electron/<version>` to every site, so the fallback every web contents
// inherits is rewritten here, before the first window exists.
app.userAgentFallback = brandUserAgent(app.userAgentFallback, __CODEINOVEN_APP_VERSION__)

configureLinuxElectronDataRoot()
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
      Logger.info(`Received ${signal}   shutting down`)
      // OS-level signals always force the quit   no confirmation gate.
      state.quitConfirmed = true
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
// unhandled rejections are logged and never exit the process   a failed
// background operation must never kill the app on the user's behalf.
installProcessCrashDiagnostics()

const state = createBootstrapState()

installOpenWithHandling(state)

ipcMain.handle('app:confirmClose', async () => {
  // The user approved the forced close while threads are working. When another
  // live instance exists it can continue those threads, so this instance just
  // walks away without SIGTERM'ing the shared harness processes. Otherwise
  // terminate every still-streaming harness connection so no agent keeps
  // working after the app exits, then proceed.
  state.quitConfirmed = true
  try {
    if (state.chatEngine && !instanceRegistry.hasOtherLiveInstance()) {
      await state.chatEngine.terminateActiveConnections()
    }
  } catch (error) {
    Logger.error('Could not terminate active harness connections on close', error)
  }
  app.quit()
})

// Park, not quit: the renderer approved closing the window while background mode
// keeps the backend alive in the menu bar.
ipcMain.handle('app:parkWindow', async () => {
  await state.backgroundLifecycle?.park()
})

/** This process's role against the shared backend, for renderer hydration. */
ipcMain.handle(
  'app:instanceRole',
  () =>
    state.backgroundLifecycle?.currentRole() ?? { role: 'owner' as const, ownerPid: process.pid }
)

/** A secondary asks the elected owner to bring its window forward. */
ipcMain.handle(
  'app:openInstanceOwner',
  () => state.backgroundLifecycle?.requestOwnerActivation() ?? false
)

/** A secondary takes over ownership of scheduled work from the current owner. */
ipcMain.handle(
  'app:transferInstanceControl',
  () => state.backgroundLifecycle?.takeOverControl() ?? false
)

/** Track when a terminal in the renderer holds focus (Windows shortcut routing). */
ipcMain.on('terminal:focusState', (_event, focused: unknown) => {
  state.terminalFocused = focused === true
})

/** Guard so the renderer's readiness signal is timestamped at most once. */
const featuresReadyPromise = new Promise<void>((resolve) => {
  state.resolveFeaturesReady = resolve
})

/**
 * A packaged smoke pass proves more than script execution: the document must
 * load, Electron must report a rendered visual frame, and application
 * hydration must complete. The guard makes concurrent milestone callbacks
 * converge on one atomic proof and one clean shutdown.
 */
function markWorkspaceReadyIfInteractive(): void {
  if (!state.rendererReadyReported || !state.featuresReady) return
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

  if (!state.startupTelemetryReported) {
    state.startupTelemetryReported = true
    startupTelemetry.stopEventLoopMonitor()
    startupTelemetry.report()
  }

  if (!output || state.packagedSmokeProofStarted) return
  state.packagedSmokeProofStarted = true
  try {
    await writePackagedSmokeProof(output, startupTelemetry.snapshot())
    // A smoke pass must really exit; it is not the user closing a window, so it
    // bypasses the background park path.
    setImmediate(() => {
      state.quitConfirmed = true
      app.quit()
    })
  } catch (error) {
    Logger.error('Could not write packaged startup proof', error)
    app.exit(1)
  }
}

/** Sticky readiness query: unlike an event subscription, callers that mount
 * after post-paint registration still observe feature availability. */
ipcMain.handle('app:waitForFeatures', () =>
  state.featuresReady ? undefined : featuresReadyPromise
)

/**
 * The renderer reports when its initial hydration is done (visible projects,
 * selected project, recent active threads). Timestamps the final startup
 * phases so the boot telemetry spans the whole chain from process entry to an
 * interactive workspace. Idempotent: repeated signals (e.g. renderer reload)
 * never re-record phases or re-emit the report.
 */
ipcMain.handle('app:rendererReady', async () => {
  if (state.rendererReadyReported) return
  state.rendererReadyReported = true
  startupTelemetry.mark('renderer:hydrated')
  markWorkspaceReadyIfInteractive()
  await completeStartupIfReady()
})

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

const threadCreation = new ThreadCreationCoordinator()
const threadDeletion = new ThreadDeletionCoordinator()

/** Resolve the app icon   static dir in dev, bundled renderer assets in production. */
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
 * Menu bar template art. macOS derives the tint from the alpha channel of a
 * `...Template.png` file, so the attention variant is a second asset rather
 * than a second colour.
 */
function getTrayIconPath(attention: boolean): string {
  const name = attention ? 'trayAttentionTemplate.png' : 'trayTemplate.png'
  return !isProduction && is.dev
    ? join(app.getAppPath(), 'src/renderer/static/macos', name)
    : join(mainBundleDirectory, '../renderer/macos', name)
}

/**
 * Whether this launch came from the OS login item. A login launch starts
 * windowless in background mode: the whole point is a backend that keeps the
 * schedule without a renderer.
 */
function wasOpenedAtLogin(): boolean {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return false
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true
  } catch {
    return false
  }
}

/**
 * Background lifecycle: the stay-alive decision, the menu bar icon, window
 * attach/teardown, the instance role, and headless boot. Its callbacks close
 * over the window helpers below, which is why it is constructed here in the
 * composition root rather than inside the boot module.
 */
const backgroundLifecycle = new BackgroundLifecycleService({
  state,
  storage,
  openWindow: () => openMainWindow(),
  destroyWindow: () => {
    const window = state.mainWindow
    if (window && !window.isDestroyed()) window.destroy()
  },
  quitApp: () => {
    state.quitConfirmed = true
    app.quit()
  },
  persistWindowState: () => windowStateService.persistNow(state.mainWindow),
  releaseWindowServices: () => {
    // The renderer is about to die with the window; tear down everything in
    // main that would otherwise keep running page content or a shell with no
    // visible window.
    try {
      state.browserService?.dispose()
      state.browserService = null
    } catch (error) {
      Logger.error('Browser teardown while parking failed', error)
    }
    try {
      state.ptyService?.detach()
    } catch (error) {
      Logger.error('PTY detach while parking failed', error)
    }
  },
  hasUpcomingWork: () => hasUpcomingWork(state, database),
  computeAttention: () => computeAttention(database),
  onBecameOwner: () => {
    // A survivor that inherited the schedule picks up the slots missed while
    // nobody owned the scheduler.
    void state.routineScheduler
      ?.runPendingMisses()
      .catch((error) => Logger.error('Take-over catch-up failed:', error))
  },
  resolveTrayIcon: (attention) => getTrayIconPath(attention)
})
state.backgroundLifecycle = backgroundLifecycle

/** Create the window, or bring the existing one forward. */
function openMainWindow(): void {
  const existing = state.mainWindow
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    if (!existing.isVisible()) existing.show()
    existing.focus()
    return
  }
  createWindow()
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
      // Chromium throttles a hidden or occluded window by default, and that is
      // left on deliberately: this window is occluded whenever the user works
      // in another app, which is most of a long agent run, and an unthrottled
      // renderer spends that whole time at full timer rate for nothing. The one
      // behaviour that flag used to buy (the off-app notification alert playing
      // promptly) is preserved at its own call site instead, which lifts
      // throttling for the moment the alert is dispatched
      // (see NotificationService.dispatchNotificationSound).
      preload: getPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
      // The preload resolves the platform traffic-light layout from this flag
      // so the renderer never flashes a wrong inset on first paint.
      additionalArguments: [getTrafficLightArg()],
      // Built-in Chromium PDF plugin (PDFium-backed viewer, annotations,
      // forms, search)   available in Electron 29+.
      plugins: true
    }
  })
  state.mainWindow = window

  if (isProduction) {
    lockDownProductionWindow(window)
  }

  window.once('ready-to-show', () => {
    // Restore the maximized state before revealing the first rendered frame so
    // the window never flashes at its restored size while the splash closes.
    if (windowStateService.shouldRestoreMaximized() && !window.isMaximized()) {
      window.maximize()
    }
    window.show()
  })

  window.on('close', (event) => {
    // Background mode parks instead of quitting: the window and its renderer are
    // destroyed, the backend keeps running in the menu bar. Everything else
    // closes the app. Either way the renderer still owns the unsaved-file gate,
    // so the same confirmation round-trip runs   marked as a park when it is one.
    if (state.quitConfirmed || state.quitCleanupStarted) return
    event.preventDefault()
    const park = state.backgroundLifecycle?.shouldPark() ?? false
    requestCloseConfirmation({ state, database, window: state.mainWindow, park })
  })

  window.on('closed', () => {
    if (state.mainWindow === window) state.mainWindow = null
    state.parkingForBackground = false
    state.backgroundLifecycle?.onWindowClosed()
  })

  if (state.ptyService) {
    state.ptyService.attach(window.webContents)
  }
  windowStateService.attach(window)

  // Restore the persisted UI zoom level before the first paint of the page so
  // the app never flashes at 100% for users with a custom zoom setting.
  void storage
    .getConfig()
    .then((cfg) => {
      if (!window.isDestroyed() && cfg.zoomLevel !== 1) {
        window.webContents.setZoomFactor(cfg.zoomLevel)
      }
    })
    .catch(() => {
      // defaults already applied
    })

  window.webContents.on('before-input-event', (event, input) => {
    // A key pressed while a browser toolbar holds focus arrives here, not on the
    // native page view. Claim the browser's own chords first, so a page-scoped
    // key acts on the page instead of on the app around it (Cmd/Ctrl+R would
    // otherwise reload the whole app, and Cmd/Ctrl+W would close its window).
    if (state.browserService?.consumeChromeShortcut(event, input)) return
    // Cmd/Ctrl+W is handled by the renderer ("close the active surface": modal,
    // settings page, or thread). Prevent the default here so the macOS
    // application menu's "Close Window" accelerator never closes the window
    // before the renderer can decide what should actually close.
    //
    // On non-mac platforms, when a terminal is focused, Ctrl+W is the shell's
    // delete-word binding   leave it alone so it reaches the shell.
    if (isCloseShortcut(input) && !(state.terminalFocused && process.platform !== 'darwin')) {
      event.preventDefault()
      sendToRenderer(window.webContents, 'window:closeShortcut')
    }
    // Cmd/Ctrl+T while a terminal is focused opens a new terminal tab in the
    // renderer. Intercept here so ghostty-web never swallows the key and feeds
    // its WASM-encoded sequence to the shell.
    if (isNewTerminalShortcut(input) && state.terminalFocused) {
      event.preventDefault()
      sendToRenderer(window.webContents, 'window:newTerminalShortcut')
    }
  })

  // External links leave the app through the default browser only when they
  // are safe web URLs. Every popup is denied regardless   the renderer never
  // spawns a second window. A link is routed into the in-app browser when the
  // matching preference is on: local development links keep their own
  // preference, every other link follows the general one. The renderer falls
  // back to the system browser when no project thread can own the tab, so
  // sending the request is never a dead end.
  window.webContents.setWindowOpenHandler((details) => {
    try {
      const safeUrl = windowBoundaryValidator.validateExternalUrl(details.url)
      const local = isLocalDevelopmentUrl(safeUrl)
      void storage
        .getConfig()
        .then((config) => {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return
          const openInCioBrowser =
            (local && config.openLocalhostInCioBrowser) ||
            (!local && config.openAllLinksInCioBrowser)
          if (openInCioBrowser) {
            sendToRenderer(window.webContents, 'browser:openRequested', safeUrl)
          } else {
            void shell.openExternal(safeUrl)
          }
        })
        .catch((error: unknown) => Logger.error('External link routing failed:', error))
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

  // Mouse side buttons (back/forward). Windows and Linux deliver them as app
  // commands; the renderer walks its own in-app navigation history because the
  // single-page window has no native browser history to navigate. On macOS no
  // app-command is emitted   the renderer handles the raw buttons directly.
  window.on('app-command', (_event, command) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    if (command === 'browser-backward') {
      sendToRenderer(window.webContents, 'window:historyBack')
    } else if (command === 'browser-forward') {
      sendToRenderer(window.webContents, 'window:historyForward')
    }
  })

  // On macOS, Logitech Options can map the mouse's side buttons to native
  // swipe gestures instead of renderer mouse events. Electron exposes those
  // gestures on the window; a left swipe goes back and a right swipe goes
  // forward through the app's navigation history.
  window.on('swipe', (_event, direction) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    if (direction === 'left') {
      sendToRenderer(window.webContents, 'window:historyBack')
    } else if (direction === 'right') {
      sendToRenderer(window.webContents, 'window:historyForward')
    }
  })

  // Renderer freeze/crash diagnostics. On a slow machine (e.g. M1) the renderer
  // can seize up or be torn down in ways that never surface as a JS exception
  // the OS shows "not responding" while nothing lands in the log. These
  // webContents lifecycle events record the freeze/crash deterministically even
  // though the renderer's own JS can no longer run to log it.
  window.webContents.on('unresponsive', () => {
    Logger.error('Renderer became unresponsive (UI frozen; check renderer main-thread work)')
  })
  window.webContents.on('responsive', () => {
    Logger.info('Renderer recovered after being unresponsive')
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    Logger.error('Renderer process terminated', {
      reason: details.reason,
      exitCode: details.exitCode
    })
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    Logger.error('Renderer preload script failed', {
      preloadPath,
      error: error instanceof Error ? error.message : String(error)
    })
  })

  if (!isProduction && is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(mainBundleDirectory, '../renderer/index.html'))
  }

  // A window exists again: restore the Dock icon and let the menu bar reflect
  // the current state. On a reopen after parking this also rebuilds the
  // window-bound services (browser, PTY) the previous window owned.
  state.backgroundLifecycle?.onWindowOpened(window)
  void attachWindowServices(state, window).catch((error) =>
    Logger.error('Window service attach failed', error)
  )

  return window
}

function openThreadFromNotification(payload: ThreadClickedPayload): void {
  // A quit is already in progress   never spawn a window mid-shutdown.
  if (state.quitCleanupStarted) return
  const window =
    state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : createWindow()

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
    // A login launch in background mode starts windowless: no splash, no window,
    // no renderer process. Everything below still runs   the whole point is a
    // backend that keeps the schedule without a UI. A relaunch that followed a
    // menu bar update is the same: the update must not pop a window at the user.
    const startHidden = wasOpenedAtLogin() || consumeBackgroundRelaunchMarker()
    // This is the first post-ready action. Construct and show the native splash
    // immediately, then yield the main event loop until Chromium presents its
    // first frame. Synchronous SQLite/schema work cannot begin before this
    // barrier, so low-end devices always get visual feedback first.
    let splashOutcome = 'skipped'
    if (!startHidden) {
      const { visualReady: splashVisualReady } = createSplashWindow(
        mainBundleDirectory,
        isProduction
      )
      startupTelemetry.mark('splash:created')
      splashOutcome = await splashVisualReady
      if (splashOutcome === 'ready') {
        startupTelemetry.mark('splash:visualReady')
      }
    }
    // A launcher must never remain topmost forever if the Chromium splash
    // fails. The normal path releases it after the first rendered frame; the
    // bounded failure path releases it after the splash barrier resolves. A
    // headless launch has no splash to release.
    signalNativeSplashReady()

    // Only after the splash is visibly rendered, wire the durable log sink
    // before any fallible startup work. The error
    // dialog tells the user to "export diagnostics after the app opens", which
    // only works if startup failures are actually persisted   so the log path
    // must be known before `database.init()` can abort the startup chain. The
    // logger owns the per-day folder under it and creates it on first write.
    mkdirSync(storage.resolve(LOGS_DIRECTORY), { recursive: true })
    Logger.initialize(storage.resolve(LOGS_DIRECTORY))
    logConfiguredDataRoot()
    if (!startHidden && splashOutcome !== 'ready') {
      Logger.error('Splash did not reach visual readiness before startup continued', {
        outcome: splashOutcome
      })
    }

    if (isProduction) {
      installProductionApplicationMenu(APP_NAME)
    }

    // In dev the raw Electron binary lacks a bundled icon   set it explicitly.
    // Cosmetic: must never abort the startup chain if the artwork is missing.
    if (process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(getMacIconPath())
      } catch (error) {
        Logger.error('dock icon setup failed (non-fatal):', error)
      }
    }

    // Storage and database warm-up are independent   run them concurrently.
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
    // Load the background preferences, apply the login item, and publish the
    // instance role before any window exists.
    await backgroundLifecycle.start()
    Logger.info(`${APP_NAME} main process initialized`)

    // The renderer invokes its first config/project/scope/thread reads while
    // its document evaluates. Register that bounded surface before navigation;
    // the feature graph remains dynamically imported after first paint.
    registerHydrationIpcHandlers(storage, database)
    // The global browser's tab list is durable app state, not browser runtime:
    // the renderer hydrates it while its document evaluates, so it is registered
    // here with the other pre-navigation handlers.
    registerGlobalBrowserIpcHandlers()

    // The trusted top-level renderer may capture microphone audio for local
    // dictation. Camera, subframes, foreign documents, and every unrelated
    // permission remain denied, and renderer downloads are denied outright.
    installRendererSessionGuards({
      validator: windowBoundaryValidator,
      getMainWindow: () => state.mainWindow
    })

    // Install the `appfile://` preview protocol before the renderer loads: the
    // packaged renderer requests preview images as soon as it hydrates, and if
    // the handler is not yet registered Chromium rejects those early requests
    // with `net::ERR_UNKNOWN_URL_SCHEME`, leaving file-tree images permanently
    // broken. The file service is resolved lazily from bootPostPaintServices.
    installAppFilePreviewProtocol({
      getProjectFiles: () => state.appfileProjectFiles,
      getScopedPathResolver: () => state.appfileScopedPathResolver
    })

    const bootContext = {
      state,
      storage,
      database,
      isProduction,
      threadCreation,
      threadDeletion,
      onThreadClicked: openThreadFromNotification,
      onFeaturesReady: markWorkspaceReadyIfInteractive
    }

    if (startHidden) {
      // Headless launch: no splash, no window, no renderer. The core service
      // graph boots directly so the scheduler, chat engine, and notifications
      // are live. Window-bound services (browser, PTY) attach the first time a
      // window is opened, from the menu bar or a notification click.
      void bootPostPaintServices(bootContext).catch((error) => {
        Logger.error('Headless service boot failed; background work is degraded', error)
      })
      app.on('activate', () => {
        if (state.quitCleanupStarted) return
        if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
      })
      return
    }

    const window = createWindow()
    startupTelemetry.mark('window:created')

    // Failsafe: never let the splash outlive the app even if the renderer
    // never paints (e.g. a script error)   dismiss it after the bounded budget.
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
      // A failure here degrades the app instead of killing it: the window and
      // already-registered services stay alive, and the failure is fully
      // logged for diagnosis. A background feature failing must never exit
      // the whole app on the user's behalf.
      void bootPostPaintServices(bootContext).catch((error) => {
        Logger.error('Post-paint service boot failed; app continues with degraded features', error)
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
      // A hand-off that landed while the renderer was still loading could not
      // be pushed (its listeners did not exist yet) and was not drained either
      // (its mount-time drain had already run). Deliver it now.
      flushOpenedPathsToRenderer(state)
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
      // A dock click opens the window when none is open   in background mode that
      // is the normal way back from the menu bar.
      if (state.quitCleanupStarted) return
      if (BrowserWindow.getAllWindows().length === 0) {
        openMainWindow()
      }
    })
  })
  .catch(async (error: unknown) => {
    // Deterministically close resources and quit with a nonzero diagnostic
    // code so a failed boot never leaves a headless process.
    await handleFatalStartup(error, { state, database })
  })

app.on('window-all-closed', () => {
  // Background mode keeps the backend alive in the menu bar; the only real quit
  // is the menu bar's Quit item (or OS logout). Everything else quits as before.
  if (state.backgroundLifecycle?.shouldPark()) return
  // Closing the last window (traffic-light close button) fully quits the app.
  // Cmd+Q follows the same path through before-quit → shutdown pipeline →
  // will-quit.
  app.quit()
})

app.on('before-quit', (event) => {
  if (state.quitCleanupStarted) return

  // Cmd+Q parks in background mode instead of quitting. Only the menu bar's
  // Quit item (or OS logout) sets `quitConfirmed` and reaches the real shutdown.
  if (!state.quitConfirmed && state.backgroundLifecycle?.shouldPark()) {
    event.preventDefault()
    const window = state.mainWindow
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      // The renderer still owns the unsaved-file gate, so the same confirmation
      // round-trip runs   marked as a park, and answered with `app:parkWindow`.
      requestCloseConfirmation({ state, database, window, park: true })
    }
    return
  }

  event.preventDefault()

  // Hard failsafe: a wedged renderer must never hold quit hostage. Arm it on
  // every before-quit so the process is guaranteed to converge on exit even
  // when the confirmation round-trip never completes.
  armQuitFailsafe(state)

  // If the user hasn't explicitly approved a force close, gate the quit on the
  // close-confirmation flow (which proceeds immediately when nothing is working).
  if (!state.quitConfirmed) {
    requestCloseConfirmation({ state, database, window: state.mainWindow })
    return
  }
  state.quitCleanupStarted = true

  // Notify every window that the application is shutting down so the
  // renderer can unsubscribe from IPC events and release resources.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      sendToRenderer(win.webContents, 'window:beforeQuit')
    }
  }

  void runShutdownPipeline({ state, windowStateService, database }).finally(() => {
    if (state.shutdownFailsafe) {
      clearTimeout(state.shutdownFailsafe)
      state.shutdownFailsafe = null
    }
  })

  // Failsafe: if any disposal step hangs, force the process to exit so the app
  // never lingers in the Dock with a stale icon after the user chose to close.
  state.shutdownFailsafe = setTimeout(() => {
    Logger.error('Shutdown pipeline timed out   forcing exit')
    flushSessionStorage()
    app.exit(0)
  }, 15_000)
})

app.on('will-quit', () => {
  // Final synchronous cleanup   the app has committed to terminating. Commit
  // any pending renderer storage here as the last line of defense against a
  // force-exit losing the session's localStorage writes.
  flushSessionStorage()
  setNotificationService(null)
})
