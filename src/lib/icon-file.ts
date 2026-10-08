import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm } from 'fs/promises'
import { extname, join } from 'path'
import { getConfigRoot } from './utils'

/** MIME types for stored icon images, keyed by lowercase file extension. */
export const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

/** Whether an icon file extension can be stored and served back to the renderer. */
export function isSupportedIconExtension(extension: string): boolean {
  return extension.toLowerCase() in ICON_MIME
}

/**
 * Copy `sourcePath` into `dir` as `icon<ext>`, replacing any previous icon file.
 * Returns the stored filename. Extension validation is the caller's concern so
 * the auto-detected-icon path can keep its best-effort behaviour.
 */
export async function storeIconFile(
  dir: string,
  sourcePath: string,
  previousIcon?: string
): Promise<string> {
  if (previousIcon) await removeIconFile(dir, previousIcon)
  const iconFile = `icon${(extname(sourcePath) || '.png').toLowerCase()}`
  await mkdir(dir, { recursive: true })
  await copyFile(sourcePath, join(dir, iconFile))
  return iconFile
}

/** Best-effort removal of a stored icon file. */
export async function removeIconFile(dir: string, iconFile: string): Promise<void> {
  try {
    await rm(join(dir, iconFile))
  } catch {
    // best-effort
  }
}

/** Read a stored icon as a data URL, or null when it cannot be read. */
export async function readIconDataUrl(dir: string, iconFile: string): Promise<string | null> {
  try {
    const buffer = await readFile(join(dir, iconFile))
    const mime = ICON_MIME[extname(iconFile).toLowerCase()] ?? 'image/png'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * The one app-owned directory holding appearance images: the picked icon of a
 * browser tab, group, box or bookmark, and of a sticky note.
 *
 * These entities persist the image path in a record that outlives the process,
 * so the path they persist has to be one the app owns and can still read on the
 * next launch. A picked path is authorized only while the process lives, so it
 * cannot be the one they keep. The directory is registered as an artifact root,
 * which is what makes the copy readable later.
 */
export function appearanceImagesDirectory(): string {
  return join(getConfigRoot(), 'appearance-images')
}

/**
 * Copy a picked appearance image into {@link appearanceImagesDirectory} and
 * return the stored path.
 *
 * Nothing is deleted here. A pick is not a save, so the image the entity wears
 * right now has to stay readable until the record pointing at it changes: a
 * replaced copy is left behind rather than risk an icon that disappears because
 * a modal was closed without saving.
 */
export async function storeAppearanceImage(sourcePath: string): Promise<string> {
  const extension = extname(sourcePath).toLowerCase()
  if (!isSupportedIconExtension(extension)) {
    throw new TypeError(`Unsupported icon format: ${extension || '(none)'}`)
  }
  const directory = appearanceImagesDirectory()
  await mkdir(directory, { recursive: true })
  const storedPath = join(directory, `${randomUUID()}${extension}`)
  await copyFile(sourcePath, storedPath)
  return storedPath
}
