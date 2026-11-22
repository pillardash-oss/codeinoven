import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fitWithin, MAX_SCREENSHOT_DIMENSION } from '../../../lib/image-payload'
import { Logger } from '../logger'
import { ensureScreenshotPermission, screenshotPermissionState } from '../screenshot-permission'
import { pictureFilename, pngFileSize, type RegionSelection } from './screenshot-files'

/** The macOS selector, fitted by the system's own tool in a child process. */

/** macOS's own selector: it draws the crosshair, handles window mode and writes
 *  the selection at native pixel density, which no reimplementation matches. */
const SCREEN_CAPTURE_BIN = '/usr/sbin/screencapture'
/** Decodes, resizes and encodes outside the app, so main never holds the pixels. */
const SIPS_BIN = '/usr/bin/sips'
const RESIZE_TIMEOUT_MS = 15_000

const run = promisify(execFile)

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

export async function selectRegionOnMac(directory: string): Promise<RegionSelection> {
  // Never dot-prefixed: screencapture cannot write to a hidden filename.
  const rawPath = join(directory, `capture-${randomUUID()}.png`)
  try {
    Logger.dev('Opening the region screenshot selector', { rawPath })
    let selector: { exitCode: number; stderr: string }
    try {
      selector = await runScreenCapture(rawPath)
    } catch (error) {
      return {
        status: 'failed',
        reason: `The macOS screenshot selector could not start: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    const rawInfo = await stat(rawPath).catch(() => null)
    if (!rawInfo || rawInfo.size === 0) {
      Logger.dev('The region screenshot selector wrote no file', selector)
      if (selector.stderr.includes('cannot write file')) {
        return { status: 'failed', reason: selector.stderr.trim() }
      }
      // A selector that wrote nothing is either a cancelled selection or a
      // capture the system quietly refused. The permission state, read again
      // rather than assumed, is what tells the two apart.
      const state = screenshotPermissionState()
      if (state !== 'granted' && state !== 'not-required') {
        const refused = await ensureScreenshotPermission()
        return {
          status: 'failed',
          title: 'Screenshot needs Screen Recording permission',
          reason: refused.message ?? 'Screen Recording is not allowed for this app.'
        }
      }
      return { status: 'cancelled' }
    }

    const source = await pngFileSize(rawPath)
    if (!source) {
      return {
        status: 'failed',
        reason:
          'The screenshot file was empty. Allow Screen Recording for this app, quit and reopen the app, then take the screenshot again.'
      }
    }

    const size = fitWithin(source.width, source.height, MAX_SCREENSHOT_DIMENSION)
    if (size.width !== source.width || size.height !== source.height) {
      // `-z` takes the height first.
      await run(SIPS_BIN, ['-z', String(size.height), String(size.width), rawPath], {
        timeout: RESIZE_TIMEOUT_MS
      })
    }
    await chmod(rawPath, 0o600)
    const path = join(directory, pictureFilename())
    await rename(rawPath, path)
    return {
      status: 'selected',
      path,
      ...size,
      sourceWidth: source.width,
      sourceHeight: source.height
    }
  } finally {
    await rm(rawPath, { force: true }).catch(() => undefined)
  }
}
