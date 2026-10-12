import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { extname, join } from 'path'
import { nativeImage } from 'electron'
import { getConfigRoot } from './utils'
import { isWebpImage, MAX_CUSTOM_ICON_BYTES, type CustomIconImage } from './custom-icon'

/** MIME types for stored icon images, keyed by lowercase file extension. */
export const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

/**
 * The largest square an auto-detected project icon is kept at.
 *
 * Icons are drawn at 12 to 24 px, so 256 covers every slot on a retina display
 * with room to spare. A project's own logo can ship at any size, and an
 * unbounded one is read back into a data URL that every panel carrying it holds,
 * so the copy is bounded once, at the one path that takes an arbitrary file.
 */
const MAX_STORED_ICON_EDGE = 256

/**
 * Re-encode an oversized icon at a bounded square, or null when the source is
 * already small enough or is a format this process cannot decode (an SVG, an
 * .ico). The caller keeps the original copy in that case, so bounding a picked
 * icon can never lose it.
 */
function boundedIconPng(source: Buffer): Buffer | null {
  try {
    const image = nativeImage.createFromBuffer(source)
    if (image.isEmpty()) return null
    const size = image.getSize()
    const edge = Math.max(size.width, size.height)
    if (edge <= MAX_STORED_ICON_EDGE) return null
    const scale = MAX_STORED_ICON_EDGE / edge
    return image
      .resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale))
      })
      .toPNG()
  } catch {
    return null
  }
}

/**
 * Copy `sourcePath` into `dir` as `icon<ext>`, replacing any previous icon file.
 *
 * This is the **auto-detected** path only (a project's own bundled icon found at
 * add time). Every user-picked image goes through the renderer's custom-icon
 * pipeline and lands through `storeCustomIconFile` instead, already cropped,
 * scaled and WebP-encoded, so nothing the user chooses keeps its original size.
 * An auto-detected icon is bounded here when it decodes and would otherwise be
 * stored at full size.
 */
export async function storeIconFile(
  dir: string,
  sourcePath: string,
  previousIcon?: string
): Promise<string> {
  if (previousIcon) await removeIconFile(dir, previousIcon)
  await mkdir(dir, { recursive: true })
  const bounded = boundedIconPng(await readFile(sourcePath))
  if (bounded) {
    await writeFile(join(dir, 'icon.png'), bounded)
    return 'icon.png'
  }
  const iconFile = `icon${(extname(sourcePath) || '.png').toLowerCase()}`
  await copyFile(sourcePath, join(dir, iconFile))
  return iconFile
}

/**
 * Validate the bytes the renderer's pipeline produced.
 *
 * The renderer is the only WebP encoder, so the main process trusts the shape it
 * promises and re-checks it here rather than the format: a payload that is not a
 * bounded WebP is a bug or a forgery, and it never reaches disk.
 */
function requireCustomIconBytes(image: CustomIconImage): Buffer {
  const bytes = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CUSTOM_ICON_BYTES || !isWebpImage(bytes)) {
    throw new TypeError('Icon image must be a WebP no larger than 512 KB')
  }
  return bytes
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

/** The filename every pipelined entity icon takes inside its own directory. */
export const CUSTOM_ICON_FILE = 'icon.webp'

/**
 * Write a pipelined icon image into an entity's own directory.
 *
 * The entity keeps the filename, so the variant, colour and markup beside it can
 * all change while the image stays one known path. A previous icon is removed
 * unless it is already this path.
 */
export async function storeCustomIconFile(
  dir: string,
  image: CustomIconImage,
  previousIcon?: string
): Promise<string> {
  const bytes = requireCustomIconBytes(image)
  if (previousIcon && previousIcon !== CUSTOM_ICON_FILE) await removeIconFile(dir, previousIcon)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, CUSTOM_ICON_FILE), bytes)
  return CUSTOM_ICON_FILE
}

/**
 * Write a pipelined icon image into the shared appearance directory.
 *
 * Browser tabs, groups, boxes, bookmarks and sticky notes all wear an image from
 * this one directory, each under its own id, so a replaced copy is left behind
 * rather than risk an icon that disappears because a modal was closed unsaved.
 */
export async function storeCustomAppearanceImage(image: CustomIconImage): Promise<string> {
  const bytes = requireCustomIconBytes(image)
  const directory = appearanceImagesDirectory()
  await mkdir(directory, { recursive: true })
  const storedPath = join(directory, `${randomUUID()}.webp`)
  await writeFile(storedPath, bytes)
  return storedPath
}
