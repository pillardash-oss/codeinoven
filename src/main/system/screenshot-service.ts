import { BrowserWindow, app, globalShortcut, nativeImage, type NativeImage } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fitWithin, MAX_SCREENSHOT_DIMENSION } from '../../lib/image-payload'
import type {
  ScreenshotCapture,
  ScreenshotCaptureOutcome,
  ScreenshotShortcutRegistration
} from '../../lib/types'
import { broadcastAppToast } from '../ipc/app-toast'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { Logger } from './logger'
import { ensureScreenshotPermission, screenshotPermissionState } from './screenshot-permission'

/**
 * Region screenshots for agents.
 *
 * A macOS screenshot is taken at the display's device pixels: a Retina full
 * screen is around 3000x2000, and a vision provider folds that down to the same
 * 1568px budget this module applies itself. The text the user wanted the agent
 * to read is then whatever survives that second downscale. Capturing a user
 * selected region and fitting it once, here, at the size the provider actually
 * reads, is what keeps the words legible.
 *
 * The chord belongs to the operating system, not to a window, so the capture is
 * free to start while the browser or another app owns the keyboard. The window
 * receives the finished file and attaches it to the active prompt.
 */

/** macOS's own selector: it draws the crosshair, handles window mode and writes
 *  the selection at native pixel density, which no reimplementation matches. */
const SCREEN_CAPTURE_BIN = '/usr/sbin/screencapture'

/** Folder the app owns; captures are copied into a thread's attachment folder
 *  before they are used, so pruning this one never breaks a sent prompt. */
const SCREENSHOT_DIRECTORY = 'screenshots'

/** Kept for audit and for the fallback, bounded so the folder cannot grow. */
const MAX_RETAINED_SCREENSHOTS = 100
const MAX_SCREENSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000

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
  'Command+Shift+6',
  'Command+Shift+7'
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

/** Run the platform selector; it answers when the user releases the selection.
 *  It exits 0 even when it could not write the file, so stderr comes back too. */
function runScreenCapture(path: string): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(SCREEN_CAPTURE_BIN, ['-i', '-x', '-o', '-t', 'png', path], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000)
    })
    child.once('error', rejectCapture)
    child.once('close', (code) => resolveCapture({ exitCode: code ?? 0, stderr }))
  })
}

/** Fit the selection for a vision provider: one downscale, never an upscale. */
function optimizedImage(image: NativeImage): { image: NativeImage; width: number; height: number } {
  const size = image.getSize()
  const fitted = fitWithin(size.width, size.height, MAX_SCREENSHOT_DIMENSION)
  if (fitted.width === size.width && fitted.height === size.height) {
    return { image, width: size.width, height: size.height }
  }
  const resized = image.resize({ width: fitted.width, height: fitted.height, quality: 'best' })
  return { image: resized, width: fitted.width, height: fitted.height }
}

async function writePicture(image: NativeImage, directory: string): Promise<string> {
  const filename = `shot-${Date.now()}-${randomUUID().slice(0, 8)}.png`
  const target = join(directory, filename)
  const staging = join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(staging, image.toPNG(), { flag: 'wx', mode: 0o600 })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined)
    throw error
  }
  return target
}

/** Bound the app's own screenshot folder. Best effort: a failure here never
 *  costs the user the capture that was just taken. */
async function pruneScreenshots(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory)
    const shots: { path: string; age: number; modified: number }[] = []
    for (const entry of entries) {
      if (!entry.startsWith('shot-')) continue
      const path = join(directory, entry)
      const info = await stat(path).catch(() => null)
      if (!info?.isFile()) continue
      shots.push({ path, age: Date.now() - info.mtimeMs, modified: info.mtimeMs })
    }
    shots.sort((left, right) => right.modified - left.modified)
    for (const [index, shot] of shots.entries()) {
      if (index < MAX_RETAINED_SCREENSHOTS && shot.age <= MAX_SCREENSHOT_AGE_MS) continue
      await rm(shot.path, { force: true }).catch(() => undefined)
    }
  } catch (error) {
    Logger.dev('The screenshot folder could not be pruned:', error)
  }
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
  if (process.platform !== 'darwin') {
    return failed(
      'Region screenshots use the macOS screen selector, which this platform does not provide.'
    )
  }
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
  // Never dot-prefixed: screencapture cannot write to a hidden filename.
  const rawPath = join(directory, `capture-${randomUUID()}.png`)
  try {
    await mkdir(directory, { recursive: true })
    Logger.dev('Opening the region screenshot selector', { rawPath })
    let selector: { exitCode: number; stderr: string }
    try {
      selector = await runScreenCapture(rawPath)
    } catch (error) {
      return failed(
        `The macOS screenshot selector could not start: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const rawInfo = await stat(rawPath).catch(() => null)
    if (!rawInfo || rawInfo.size === 0) {
      await rm(rawPath, { force: true }).catch(() => undefined)
      Logger.dev('The region screenshot selector wrote no file', selector)
      if (selector.stderr.includes('cannot write file')) return failed(selector.stderr.trim())
      // A selector that wrote nothing is either a cancelled selection or a
      // capture the system quietly refused. The permission state, read again
      // rather than assumed, is what tells the two apart.
      const state = screenshotPermissionState()
      if (state !== 'granted' && state !== 'not-required') {
        const refused = await ensureScreenshotPermission()
        return failed(
          refused.message ?? 'Screen Recording is not allowed for this app.',
          'Screenshot needs Screen Recording permission'
        )
      }
      return { status: 'cancelled' }
    }

    const source = nativeImage.createFromPath(rawPath)
    if (source.isEmpty()) {
      await rm(rawPath, { force: true }).catch(() => undefined)
      return failed(
        'The screenshot file was empty. Allow Screen Recording for this app, quit and reopen the app, then take the screenshot again.'
      )
    }

    const sourceSize = source.getSize()
    const fitted = optimizedImage(source)
    const path = await writePicture(fitted.image, directory)
    await rm(rawPath, { force: true }).catch(() => undefined)

    const capture: ScreenshotCapture = {
      path,
      width: fitted.width,
      height: fitted.height,
      sourceWidth: sourceSize.width,
      sourceHeight: sourceSize.height,
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
    await rm(rawPath, { force: true }).catch(() => undefined)
  }
}

/**
 * Claim the keymap's global chord, or release it when the entry is unbound.
 *
 * `globalShortcut` lives per process, so a second window publishing the same
 * effective chord is answered without touching the registration.
 */
export function setScreenshotShortcut(accelerator: string | null): ScreenshotShortcutRegistration {
  // The selector this chord opens exists only on macOS, so the other platforms
  // must not give up a system-wide key for a capture that cannot happen.
  if (process.platform !== 'darwin') return { registered: false, reason: 'unsupported-platform' }
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
  if (MAC_SCREENSHOT_ACCELERATORS.has(accelerator)) {
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
