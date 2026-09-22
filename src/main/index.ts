import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { is } from '@electron-toolkit/utils'
import { APP_ID, APP_NAME } from '../lib/brand'
import { isLocalDevelopmentUrl } from '../lib/local-development-url'
import { Logger } from './system/logger'
import { Database } from './database/database'
import { StorageEngine } from './storage/storage-engine'
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
import { armQuitFailsafe, requestCloseConfirmation } from './bootstrap/quit-lifecycle'
import { flushOpenedPathsToRenderer, installOpenWithHandling } from './bootstrap/open-with'
import { bootPostPaintServices } from './bootstrap/post-paint-services'
import { runShutdownPipeline } from './bootstrap/shutdown-pipeline'
import { handleFatalStartup } from './bootstrap/fatal-startup'
import {
  installAppFilePreviewProtocol,
  installRendererSessionGuards
} from './bootstrap/session-guards'

declare const __CODEINOVEN_PROTOTYPE_PREVIEW_ORIGIN__: string | undefined
declare const __CODEINOVEN_APP_VERSION__: string

const mainBundleDirectory = dirname(fileURLToPath(import.meta.url))

app.setName(APP_NAME)

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
    setImmediate(() => app.quit())
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
    // Closing the window always closes the app   nothing is kept alive in the
    // Tray. Gate the close while threads are working   ask the renderer to
    // confirm before letting the window (and with it the app) go away. During
    // an approved quit the flags below let the close pass straight through.
    if (state.quitConfirmed || state.quitCleanupStarted) return
    event.preventDefault()
    requestCloseConfirmation({ state, database, window: state.mainWindow })
  })

  window.on('closed', () => {
    if (state.mainWindow === window) state.mainWindow = null
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
    // This is the first post-ready action. Construct and show the native splash
    // immediately, then yield the main event loop until Chromium presents its
    // first frame. Synchronous SQLite/schema work cannot begin before this
    // barrier, so low-end devices always get visual feedback first.
    const { visualReady: splashVisualReady } = createSplashWindow(mainBundleDirectory, isProduction)
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
    // only works if startup failures are actually persisted   so the log path
    // must be known before `database.init()` can abort the startup chain.
    mkdirSync(dirname(storage.resolve('logs/main.jsonl')), { recursive: true })
    Logger.initialize(storage.resolve('logs/main.jsonl'))
    logConfiguredDataRoot()
    if (splashOutcome !== 'ready') {
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
    Logger.info(`${APP_NAME} main process initialized`)

    // The renderer invokes its first config/project/scope/thread reads while
    // its document evaluates. Register that bounded surface before navigation;
    // the feature graph remains dynamically imported after first paint.
    registerHydrationIpcHandlers(storage, database)

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
      void bootPostPaintServices({
        state,
        storage,
        database,
        isProduction,
        threadCreation,
        threadDeletion,
        onThreadClicked: openThreadFromNotification,
        onFeaturesReady: markWorkspaceReadyIfInteractive
      }).catch((error) => {
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
      // The app always quits when its last window closes, so a dock click
      // can only land during the shutdown grace period   ignore it then.
      if (state.quitCleanupStarted) return
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
  .catch(async (error: unknown) => {
    // Deterministically close resources and quit with a nonzero diagnostic
    // code so a failed boot never leaves a headless process.
    await handleFatalStartup(error, { state, database })
  })

app.on('window-all-closed', () => {
  // Closing the last window (traffic-light close button) fully quits the app.
  // Cmd+Q follows the same path through before-quit → shutdown pipeline →
  // will-quit. Nothing is kept alive in the Dock or Tray after the user closes.
  app.quit()
})

app.on('before-quit', (event) => {
  if (state.quitCleanupStarted) return
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
    app.exit(0)
  }, 15_000)
})

app.on('will-quit', () => {
  // Final synchronous cleanup   the app has committed to terminating.
  setNotificationService(null)
})
