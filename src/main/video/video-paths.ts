import { realpath, stat, mkdir, readFile } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWrite } from '../../lib/utils'
import {
  validateVideoStudio,
  VIDEO_STUDIO_FILE,
  type VideoStudioDocument
} from '../../lib/video/studio'
import { refreshVideoEditAssetDurations } from './video-edit-asset-refresh'

export async function videoFile(root: string, raw: unknown): Promise<string> {
  if (
    typeof raw !== 'string' ||
    raw.length > 1024 ||
    !raw.trim() ||
    isAbsolute(raw) ||
    /^[a-zA-Z]:/u.test(raw)
  )
    throw new Error('source must be a project-relative file')
  const canonicalRoot = await realpath(root)
  const target = await realpath(resolve(canonicalRoot, raw))
  const inside = relative(canonicalRoot, target)
  if (
    !inside ||
    inside === '..' ||
    inside.startsWith('../') ||
    inside.startsWith('..\\') ||
    isAbsolute(inside)
  )
    throw new Error('The file must stay inside the project, including symlinks')
  if (!(await stat(target)).isFile()) throw new Error('source must be a file')
  return target
}
export async function videoFolder(root: string, raw: unknown): Promise<string> {
  if (
    typeof raw !== 'string' ||
    !raw.trim() ||
    raw.length > 1024 ||
    isAbsolute(raw) ||
    /^[a-zA-Z]:/u.test(raw)
  )
    throw new Error('directory must be a project-relative folder')
  const canonicalRoot = await realpath(root)
  const target = await realpath(resolve(root, raw))
  const inside = relative(canonicalRoot, target)
  if (
    !inside ||
    inside === '..' ||
    inside.startsWith('../') ||
    inside.startsWith('..\\') ||
    isAbsolute(inside)
  )
    throw new Error('The folder must stay inside the project, including symlinks')
  if (!(await stat(target)).isDirectory()) throw new Error('directory must be a folder')
  return target
}
export async function videoOutput(root: string, kind: string): Promise<string> {
  return createVideoDirectory(root, `.cio/work/video-${kind}`)
}
export async function videoScratch(root: string, kind: string): Promise<string> {
  return createVideoDirectory(root, `.cio/tmp/video-${kind}`)
}
/**
 * A project-relative folder a command is about to create, such as a composition.
 *
 * `videoFolder` resolves a folder that already exists; this one creates it and
 * then applies the same containment check one segment at a time, so a `.cio`
 * symlinked out of the workspace is refused before anything is written into it.
 */
export async function videoTargetFolder(root: string, raw: unknown): Promise<string> {
  if (
    typeof raw !== 'string' ||
    !raw.trim() ||
    raw.length > 1024 ||
    isAbsolute(raw) ||
    /^[a-zA-Z]:/u.test(raw)
  )
    throw new Error('directory must be a project-relative folder')
  const segments = raw
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
  if (!segments.length || segments.some((segment) => segment === '..'))
    throw new Error('directory must stay inside the project')
  for (let index = 1; index <= segments.length; index += 1) {
    const part = segments.slice(0, index).join('/')
    await mkdir(join(root, part), { recursive: true })
    await videoFolder(root, part)
  }
  return videoFolder(root, segments.join('/'))
}
async function createVideoDirectory(root: string, base: string): Promise<string> {
  return createContainedDirectory(root, `${base}/${randomUUID()}`)
}
/**
 * Create one containment-checked project-relative folder, and answer its path.
 *
 * Every parent is re-checked after creation, so a linked `.cio` folder cannot
 * escape the workspace, and the folder itself is then re-checked as a folder.
 */
async function createContainedDirectory(root: string, relativeFolder: string): Promise<string> {
  // Check each parent after creation so a linked .cio folder cannot escape the workspace.
  const segments = relativeFolder.split('/')
  for (let index = 1; index <= segments.length; index += 1) {
    const part = segments.slice(0, index).join('/')
    await mkdir(join(root, part), { recursive: true })
    await videoFolder(root, part)
  }
  return videoFolder(root, relativeFolder)
}
/**
 * The folder one composition's exports are written into, named from the
 * composition rather than minted fresh.
 *
 * The name is what makes an export findable at all. A job record lives in this
 * process and belongs to one thread, so an export named with a random id could
 * only ever be named by the thread that ran it, and only until the app quit. A
 * folder derived from the composition puts its newest export exactly where
 * anything holding that composition can look, whichever thread ran it and
 * whenever it ran.
 *
 * Re-exporting therefore replaces the previous render, which is what "this
 * composition's export" means. An interrupted run writes to its own partial name
 * first, so a failed attempt never becomes the export the app points at.
 */
export async function videoExportFolder(root: string, directory: string): Promise<string> {
  const key = createHash('sha256').update(directory).digest('hex').slice(0, 16)
  return createContainedDirectory(root, `.cio/work/video-exports/${key}`)
}
/**
 * Whether one composition already has an exported render, and where it is.
 *
 * Read rather than remembered, because the answer outlives every process: the
 * board asks this for the folder in front, so an export made in another thread or
 * before a restart is still the export that folder has.
 */
export async function videoExportFile(root: string, directory: string): Promise<string | null> {
  const folder = await videoExportFolder(root, directory)
  const file = join(folder, 'render.mp4')
  const info = await stat(file).catch(() => null)
  return info?.isFile() ? file : null
}
export async function readVideoStudio(folder: string): Promise<VideoStudioDocument> {
  let text: string
  try {
    const file = await videoFile(folder, VIDEO_STUDIO_FILE)
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('studio.json exceeds 2 MiB')
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateVideoStudio({})
    throw error
  }
  const raw: unknown = JSON.parse(text)
  // A stale asset duration is metadata drift, not corruption: the media itself is
  // asked how long it is before the document is judged, so a composition whose
  // source was re-encoded outside the editor still opens.
  await refreshVideoEditAssetDurations(folder, raw, new AbortController().signal).catch(
    () => undefined
  )
  return validateVideoStudio(raw)
}
export async function writeVideoStudio(folder: string, raw: unknown): Promise<VideoStudioDocument> {
  const document = validateVideoStudio(raw)
  // Existing links are rejected before the atomic writer is used.
  const file = join(folder, VIDEO_STUDIO_FILE)
  await videoFile(folder, VIDEO_STUDIO_FILE).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  await atomicWrite(file, JSON.stringify(document, null, 2))
  return document
}
