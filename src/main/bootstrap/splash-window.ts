import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

declare const __CODEINOVEN_APP_VERSION__: string

/**
 * Frameless splash shown as soon as Electron permits a window, the app `ready`
 * event (a window simply cannot exist before that in Electron). It is created
 * hidden and revealed on its own first painted frame, because a shown window
 * that has not painted yet presents a blank (white) surface. Closed once the main
 * window paints.
 */
export type SplashVisualOutcome = 'ready' | 'closed' | 'load-failed' | 'timeout'

const SPLASH_VISUAL_TIMEOUT_MS = 5_000

/**
 * How long the boot may stop for the splash's first frame.
 *
 * The splash window paints itself while hidden and is revealed on that frame, so
 * the boot does not need to wait for it at all: the frame only decides when the
 * window appears, never when storage starts. Waiting the full visual ceiling for
 * that logo is what once cost a slow launch up to 4,999 ms of dead time before
 * SQLite had even opened (measured in the durable startup log), so the barrier
 * gives the frame a short grace period and the boot continues without it.
 */
export const SPLASH_BARRIER_DEADLINE_MS = 250

/** What the barrier settled on: the frame, the window, or the deadline. */
export type SplashBarrierOutcome = SplashVisualOutcome | 'deadline'

/**
 * Bound the splash barrier so cosmetic work can never hold the storage chain.
 *
 * Resolves with the visual outcome when the frame wins, or `'deadline'` when the
 * boot has waited long enough. The underlying promise is not cancelled: the
 * caller can still observe the real outcome through `visualReady` itself (the
 * boot marks `splash:visualReady` when it eventually lands).
 */
export function withSplashDeadline(
  visualReady: Promise<SplashVisualOutcome>
): Promise<SplashBarrierOutcome> {
  return new Promise((resolveBarrier) => {
    let settled = false
    const finish = (outcome: SplashBarrierOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveBarrier(outcome)
    }
    const timer = setTimeout(() => finish('deadline'), SPLASH_BARRIER_DEADLINE_MS)
    void visualReady.then(finish)
  })
}

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
    // The window exists hidden so its first frame is painted before anything can
    // be on screen, and this is the reveal of that frame.
    splash.once('ready-to-show', () => {
      if (!splash.isDestroyed() && !splash.isVisible()) splash.show()
      finish('ready')
    })
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
    // Created hidden on purpose. A window that is already on screen while it waits
    // for its first frame presents the window server's blank surface, which is
    // white whatever `backgroundColor` says, so the launch screen would appear as a
    // white rectangle before its content did. `paintWhenInitiallyHidden` keeps
    // Chromium painting the hidden window, and `ready-to-show` then reveals a frame
    // that already exists.
    show: false,
    paintWhenInitiallyHidden: true,
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
