import { copyFile, mkdir, readFile, rm } from 'fs/promises'
import { extname, join } from 'path'

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
