import { BrowserWindow, app, globalShortcut } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type {
  ScreenshotCapture,
  ScreenshotCaptureOutcome,
  ScreenshotShortcutRegistration
} from '../../lib/types'
import { broadcastAppToast } from '../ipc/app-toast'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from './logger'
import { ensureScreenshotPermission, screenshotPermissionState } from './screenshot-permission'
import { pruneScreenshots } from './screenshot-service/screenshot-files'
import { selectRegionOnMac } from './screenshot-service/screenshot-mac'
import { selectRegionWithOverlay } from './screenshot-service/screenshot-overlay'
import {
  screenshotSelector,
  unsupportedScreenshotReason
} from './screenshot-service/screenshot-platform'

/**
 * Region screenshots for agents.
 *
 * A screenshot is taken at the display's device pixels: a Retina full
 * screen is around 3000x2000, and a vision provider folds that down to the same
 * 1568px budget this module applies itself. The text the user wanted the agent
 * to read is then whatever survives that second downscale. Capturing a user
 * selected region and fitting it once, here, at the size the provider actually
 * reads, is what keeps the words legible.
 *
 * The chord belongs to the operating system, not to a window, so the capture is
 * free to start while the browser or another app owns the keyboard. The window
 * receives the finished file and attaches it to the active prompt.
 *
 * macOS uses the system's selector, Windows and X11 use the app's overlay. Both
 * decode and encode outside the main process.
 */

/** Folder the app owns; captures are copied into a thread's attachment folder
 *  before they are used, so pruning this one never breaks a sent prompt. */
const SCREENSHOT_DIRECTORY = 'screenshots'

/** A second trigger landing while the selector is open would start a second
 *  selector; the fallback keydown path and the global chord are debounced. */
const TRIGGER_DEBOUNCE_MS = 400

let activeAccelerator: string | null = null
let capturing = false
let lastTriggerAt = 0
let pending: ScreenshotCapture[] = []

/** macOS answers its own screenshot chords even when Electron reports the
 *  registration as successful, so main refuses them as well as the renderer. */
const MAC_SCREENSHOT_ACCELERATORS: ReadonlySet<string> = new Set([
  'Command+Shift+3',
  'Command+Shift+4',
  'Command+Shift+5',
  'Command+Shift+6'
])

function screenshotsDirectory(): string {
  return join(app.getPath('userData'), SCREENSHOT_DIRECTORY)
}

/** A failure is always a toast with the reason kept readable behind Copy. */
function failed(
  reason: string,
  title = 'Screenshot could not be captured'
): ScreenshotCaptureOutcome {
  broadcastAppToast({ message: title, type: 'error', details: reason })
  return { status: 'failed', reason }
}

function deliver(capture: ScreenshotCapture): void {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
  let delivered = false
  for (const window of windows) {
    delivered = sendToRenderer(window.webContents, 'screenshot:captured', capture) || delivered
  }
  if (!delivered) {
    // A shortcut claimed by the process still works with the window parked in
    // the menu bar, so the capture is held until a renderer asks for it.
    pending = [...pending.slice(-9), capture]
  }
}

/** Capture a user-selected region now and hand the optimized file to the app. */
export async function captureScreenshotForAgent(): Promise<ScreenshotCaptureOutcome> {
  const selector = screenshotSelector()
  if (!selector) return failed(unsupportedScreenshotReason())
  const now = Date.now()
  if (capturing || now - lastTriggerAt < TRIGGER_DEBOUNCE_MS) return { status: 'busy' }
  lastTriggerAt = now

  // The grant is the operating system's to give: ask it the way it answers, and
  // when it has already refused, put the person in front of the pane instead of
  // opening a selector that would silently capture nothing.
  Logger.dev('Region screenshot permission checked', { state: screenshotPermissionState() })
  const permission = await ensureScreenshotPermission()
  if (!permission.granted) {
    Logger.dev('Region screenshot refused: screen recording is not granted', {
      state: permission.state
    })
    return failed(
      permission.message ?? 'Screen Recording is not allowed for this app.',
      'Screenshot needs Screen Recording permission'
    )
  }

  capturing = true
  const directory = screenshotsDirectory()
  try {
    await mkdir(directory, { recursive: true })
    const selection =
      selector === 'macos'
        ? await selectRegionOnMac(directory)
        : await selectRegionWithOverlay(directory)
    if (selection.status === 'cancelled') return { status: 'cancelled' }
    if (selection.status === 'failed') return failed(selection.reason, selection.title)

    const capture: ScreenshotCapture = {
      path: selection.path,
      width: selection.width,
      height: selection.height,
      sourceWidth: selection.sourceWidth,
      sourceHeight: selection.sourceHeight,
      capturedAt: Date.now()
    }
    Logger.dev('Region screenshot captured', {
      width: capture.width,
      height: capture.height,
      sourceWidth: capture.sourceWidth,
      sourceHeight: capture.sourceHeight
    })
    deliver(capture)
    void pruneScreenshots(directory)
    return { status: 'captured', capture }
  } catch (error) {
    Logger.error('Region screenshot failed:', error)
    return failed(error instanceof Error ? error.message : String(error))
  } finally {
    capturing = false
  }
}

/**
 * Claim the keymap's global chord, or release it when the entry is unbound.
 *
 * `globalShortcut` lives per process, so a second window publishing the same
 * effective chord is answered without touching the registration.
 */
export function setScreenshotShortcut(accelerator: string | null): ScreenshotShortcutRegistration {
  // A session with no selector (Wayland, for now) must not give up a system-wide
  // key for a capture that cannot happen.
  if (!screenshotSelector()) return { registered: false, reason: 'unsupported-platform' }
  if (accelerator === activeAccelerator) {
    if (!accelerator) return { registered: false, reason: 'unbound' }
    if (globalShortcut.isRegistered(accelerator)) return { registered: true }
  }
  if (activeAccelerator) {
    try {
      globalShortcut.unregister(activeAccelerator)
    } catch (error) {
      Logger.dev('The previous screenshot chord could not be released:', error)
    }
    activeAccelerator = null
  }
  if (!accelerator) return { registered: false, reason: 'unbound' }
  if (process.platform === 'darwin' && MAC_SCREENSHOT_ACCELERATORS.has(accelerator)) {
    return { registered: false, reason: 'reserved' }
  }
  try {
    const registered = globalShortcut.register(accelerator, () => {
      void captureScreenshotForAgent()
    })
    if (!registered) {
      Logger.dev('The screenshot chord is already claimed by the system', { accelerator })
      return { registered: false, reason: 'in-use' }
    }
    activeAccelerator = accelerator
    Logger.dev('The region screenshot chord is registered', { accelerator })
    return { registered: true }
  } catch (error) {
    Logger.error('The screenshot chord is not a valid accelerator:', error)
    return { registered: false, reason: 'invalid' }
  }
}

/** Captures taken while no window existed, handed over once on reopen. */
export function takePendingScreenshots(): ScreenshotCapture[] {
  const held = pending
  pending = []
  return held
}

/**
 * Copy one of the app's own captures into a thread's attachment folder.
 *
 * Only a path inside the app's screenshot folder is accepted: the renderer never
 * names a file the capture path could not have produced, so this cannot become a
 * general copy-any-file channel.
 */
export async function retainScreenshot(
  sourcePath: string,
  destinationDirectory: string
): Promise<string | null> {
  const directory = screenshotsDirectory()
  const absolute = resolve(sourcePath)
  const inside = relative(directory, absolute)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null
  const info = await stat(absolute).catch(() => null)
  if (!info?.isFile() || info.size === 0) return null

  await mkdir(destinationDirectory, { recursive: true })
  const filename = `screenshot-${new Date()
    .toISOString()
    .replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}.png`
  const target = join(destinationDirectory, filename)
  const staging = join(destinationDirectory, `.${filename}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await copyFile(absolute, staging)
    await rename(staging, target)
    return target
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined)
    throw error
  }
}
