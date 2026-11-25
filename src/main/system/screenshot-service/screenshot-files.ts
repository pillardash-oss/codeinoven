import { randomUUID } from 'node:crypto'
import { open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger } from '../logger'

/** The app's own screenshot folder: finished pictures, bounded. */

/** Kept for audit and for the fallback, bounded so the folder cannot grow. */
const MAX_RETAINED_SCREENSHOTS = 100
const MAX_SCREENSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_HEADER_BYTES = 24

/** What a selector hands back for delivery. */
export type RegionSelection =
  | {
      status: 'selected'
      path: string
      width: number
      height: number
      sourceWidth: number
      sourceHeight: number
    }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: string; title?: string }

/** A PNG's dimensions from its header, so main never decodes one to measure it. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < PNG_HEADER_BYTES) return null
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, PNG_HEADER_BYTES)
  if (!header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null
  const width = header.readUInt32BE(16)
  const height = header.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

export async function pngFileSize(path: string): Promise<{ width: number; height: number } | null> {
  const file = await open(path, 'r')
  try {
    const header = new Uint8Array(PNG_HEADER_BYTES)
    const { bytesRead } = await file.read(header, 0, PNG_HEADER_BYTES, 0)
    return pngSize(header.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}

export function pictureFilename(): string {
  return `shot-${Date.now()}-${randomUUID().slice(0, 8)}.png`
}

export async function writePicture(png: Uint8Array, directory: string): Promise<string> {
  const filename = pictureFilename()
  const target = join(directory, filename)
  const staging = join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(staging, png, { flag: 'wx', mode: 0o600 })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined)
    throw error
  }
  return target
}

/** Bound the app's own screenshot folder. Best effort: a failure here never
 *  costs the user the capture that was just taken. */
export async function pruneScreenshots(directory: string): Promise<void> {
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
