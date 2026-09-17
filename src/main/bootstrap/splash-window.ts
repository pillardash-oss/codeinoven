import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

declare const __CODEINOVEN_APP_VERSION__: string

/**
 * Frameless splash shown as soon as Electron permits a window, the app `ready`
 * event (a window simply cannot exist before that in Electron). Shown
 * immediately rather than gated on `ready-to-show`; the matching
 * `backgroundColor` means the Obsidian surface paints the instant the window
 * exists, then the logo/spinner layer on top. Closed once the main window
 * paints.
 */
export type SplashVisualOutcome = 'ready' | 'closed' | 'load-failed' | 'timeout'

const SPLASH_VISUAL_TIMEOUT_MS = 5_000

/**
 * The splash is owned entirely by this module: it is the only consumer of the
 * handle, so the closure over `splashWindow` never has to leave the file.
 */
let splashWindow: BrowserWindow | null = null

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

export function createSplashWindow(
  mainBundleDirectory: string,
  isProduction: boolean
): {
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

  const applicationVersion = __CODEINOVEN_APP_VERSION__
  const loading =
    !isProduction && is.dev && process.env['ELECTRON_RENDERER_URL']
      ? (() => {
          const splashUrl = new URL(`${process.env['ELECTRON_RENDERER_URL']}/splash.html`)
          splashUrl.searchParams.set('version', applicationVersion)
          return splash.loadURL(splashUrl.toString())
        })()
      : splash.loadFile(join(mainBundleDirectory, '../renderer/splash.html'), {
          query: { version: applicationVersion }
        })
  // `did-fail-load` resolves the visual barrier as `load-failed`; consume the
  // matching navigation rejection so it cannot become an unhandled promise.
  void loading.catch(() => undefined)

  splash.once('closed', () => {
    if (splashWindow === splash) splashWindow = null
  })
  return { splash, visualReady }
}

export function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
  }
  splashWindow = null
}
