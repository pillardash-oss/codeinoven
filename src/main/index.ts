import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { is } from '@electron-toolkit/utils'
import { APP_ID, APP_NAME } from '../lib/brand'
import { Logger } from './logger'
import { Database } from './database/database'
import { ThreadRepo } from './database/repositories/thread-repo'
import { ProjectRepo } from './database/repositories/project-repo'
import { StorageEngine } from './storage-engine'
import { UpdaterService } from './updater-service'
import { registerIpcHandlers } from './ipc-handlers'
import { registerProviderAccountIpc } from './provider-account-ipc'
import { registerBaseUrlProviderIpc } from './base-url-provider-ipc'
import { registerUtilityIpc } from './utility-ipc'
import { PtyService } from './pty-service'
import { ProviderConnectionService } from './provider-connection'
import { HarnessUpdateService } from './harness-update-service'
import { HarnessInstallService } from './harness-install-service'
import { ChatEngine } from './chat-engine'
import { ComputerUsePipService } from './computer-use-pip-service'
import { ProjectManager } from '../lib/engines/project-manager'
import { ProjectFilesService } from './project-files-service'
import { installFilePreviewProtocol, registerFilePreviewScheme } from './file-preview-protocol'
import { RestartRecoveryService } from './restart-recovery-service'
import { WindowStateService } from './window-state'
import { NotificationService } from './notification-service'
import { setNotificationService, setPowerWakeService } from './thread-events'
import { PowerWakeService } from './power-wake-service'
import {
  installProductionApplicationMenu,
  lockDownProductionWindow
} from './production-housekeeping'
import type { CloseConfirmationProject, ThreadClickedPayload } from '../lib/ipc-contract'

const mainBundleDirectory = dirname(fileURLToPath(import.meta.url))

app.setName(APP_NAME)
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

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let quitCleanupStarted = false

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
    const active = threadRepo
      .listAll()
      .filter((t) => !t.archived && (t.status === 'planning' || t.status === 'executing'))
    if (active.length === 0) return []
    const byProject = new Map<string, CloseConfirmationProject>()
    for (const thread of active) {
      const entry = byProject.get(thread.projectId)
      if (entry) {
        entry.threadCount++
      } else {
        const project = projectRepo.get(thread.projectId)
        byProject.set(thread.projectId, {
          projectId: thread.projectId,
          projectName: project?.name ?? thread.projectId,
          threadCount: 1
        })
      }
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
 */
function requestCloseConfirmation(): void {
  if (quitCleanupStarted || quitConfirmed) return
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    quitConfirmed = true
    app.quit()
    return
  }
  const working = getActiveThreadProjects()
  if (working.length === 0) {
    quitConfirmed = true
    app.quit()
    return
  }
  window.webContents.send('window:confirmClose', { projects: working })
}

ipcMain.handle('app:confirmClose', () => {
  // The user approved the forced close while threads are working.
  quitConfirmed = true
  app.quit()
})
const isProduction = app.isPackaged || process.env['NODE_ENV'] === 'production'
const storage = new StorageEngine()
const windowStateService = new WindowStateService(storage)
const database = new Database()
const ptyService = new PtyService(storage, database)
const providerConnection = new ProviderConnectionService()
const harnessUpdateService = new HarnessUpdateService(providerConnection)
const harnessInstallService = new HarnessInstallService(providerConnection)
const computerUsePipService = new ComputerUsePipService(storage)
const chatEngine = new ChatEngine(storage, database, computerUsePipService)
const notificationService = new NotificationService(storage, database, openThreadFromNotification)
const updaterService = new UpdaterService(storage)
const powerWakeService = new PowerWakeService(storage, database)

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
function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 420,
    height: 320,
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
      sandbox: false,
      devTools: false
    }
  })
  splashWindow = splash

  if (!isProduction && is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void splash.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/splash.html`)
  } else {
    void splash.loadFile(join(mainBundleDirectory, '../renderer/splash.html'))
  }

  splash.once('closed', () => {
    if (splashWindow === splash) splashWindow = null
  })
  return splash
}

function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
  }
  splashWindow = null
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...windowStateService.getWindowOptions(),
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: APP_NAME,
    icon: getAppIconPath(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required',
      preload: getPreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !isProduction,
      // Built-in Chromium PDF plugin (PDFium-backed viewer, annotations,
      // forms, search) — available in Electron 29+.
      plugins: true
    }
  })
  mainWindow = window

  if (isProduction) {
    lockDownProductionWindow(window)
  }

  window.on('ready-to-show', () => {
    // Restore the maximized state before the first paint so the window never
    // flashes at its restored size while the splash is closing.
    if (windowStateService.shouldRestoreMaximized() && !window.isMaximized()) {
      window.maximize()
    }
    window.show()
  })

  window.on('close', (event) => {
    // Gate the close while threads are working — ask the renderer to confirm
    // before letting the window (and with it the app) go away.
    if (quitConfirmed || quitCleanupStarted) return
    event.preventDefault()
    requestCloseConfirmation()
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  ptyService.attach(window.webContents)
  windowStateService.attach(window)

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
    window.webContents.send('notification:threadClicked', payload)
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
    // Show the splash before any awaited work so the app feels instant.
    createSplashWindow()

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
    await Promise.all([storage.initialize(), database.init()])
    await windowStateService.load()
    Logger.initialize(storage.resolve('logs/main.jsonl'))
    Logger.info(`${APP_NAME} main process initialized`)
    await powerWakeService.start()
    setPowerWakeService(powerWakeService)
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
      }
      if (recovery.failures.length > 0) {
        Logger.error('Restart recovery completed with failures', recovery.failures)
      }
    } catch (error) {
      Logger.error('Restart recovery failed (non-fatal):', error)
    }
    updaterService.setChatEngine(chatEngine)
    const projectManager = new ProjectManager(database)
    const projectFilesService = new ProjectFilesService(projectManager)
    installFilePreviewProtocol(projectFilesService)
    registerIpcHandlers(storage, database, updaterService, chatEngine, {
      projectManager,
      projectFilesService,
      powerWakeService
    })
    registerProviderAccountIpc()
    registerBaseUrlProviderIpc(storage)
    registerUtilityIpc(storage, undefined, undefined, undefined, computerUsePipService)
    ptyService.register()
    providerConnection.register()
    harnessUpdateService.register()
    harnessInstallService.register()
    providerConnection.warmUp()
    chatEngine.register()
    notificationService.start()
    setNotificationService(notificationService)
    updaterService.start()

    const window = createWindow()

    // Failsafe: never let the splash outlive the app even if the renderer
    // never paints (e.g. a script error) — dismiss it on ready or on close.
    const splashFailsafe = setTimeout(closeSplash, 15_000)
    window.once('ready-to-show', () => {
      clearTimeout(splashFailsafe)
      closeSplash()
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
  .catch((error: unknown) => {
    closeSplash()
    const message = error instanceof Error ? error.message : String(error)
    Logger.error(`${APP_NAME} startup failed`, error)
    dialog.showErrorBox(
      `${APP_NAME} could not start`,
      `${message}\n\nRestart ${APP_NAME}. If the problem continues, export diagnostics after the app opens.`
    )
  })

app.on('window-all-closed', () => {
  // No platform keeps running without a window: closing the last window
  // (traffic-light close button) fully quits the app. Cmd+Q follows the
  // same path through before-quit → shutdown pipeline → will-quit, so the
  // app never lingers in the Dock needing a second quit.
  app.quit()
})

/**
 * Ordered disposal executed once the quit lifecycle begins.
 *
 * 1. Renderer notification + 500ms grace period
 * 2. PTY sessions destroyed
 * 3. Notification service stopped
 * 4. Chat engine / driver processes disposed
 * 5. Log buffer flushed
 * 6. app.quit() — re-enters before-quit, but the guard skips cleanup
 *    and Electron proceeds to close windows → will-quit → exit.
 */
async function runShutdownPipeline(): Promise<void> {
  // Give the renderer a moment to process window:beforeQuit.
  await new Promise<void>((resolve) => setTimeout(resolve, 500))

  try {
    updaterService.stop()
  } catch (error) {
    Logger.error('Updater service cleanup failed during shutdown:', error)
  }

  try {
    ptyService.destroyAll()
  } catch (error) {
    Logger.error('PTY cleanup failed during shutdown:', error)
  }

  try {
    notificationService.stop()
  } catch (error) {
    Logger.error('Notification service cleanup failed during shutdown:', error)
  }
  setNotificationService(null)
  setPowerWakeService(null)
  powerWakeService.stop()

  try {
    await computerUsePipService.dispose()
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

  try {
    await chatEngine.dispose()
  } catch (error) {
    Logger.error('Chat engine disposal failed during shutdown:', error)
  }

  try {
    await Logger.flush()
  } catch {
    // Logger may already be flushed; nothing more can be written.
  }

  try {
    database.close()
  } catch (error) {
    Logger.error('Database close failed during shutdown:', error)
  }

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
      win.webContents.send('window:beforeQuit')
    }
  }

  void runShutdownPipeline()
})

app.on('will-quit', () => {
  // Final synchronous cleanup — the app has committed to terminating.
  setNotificationService(null)
})
