import { realpath, stat, mkdir, readFile } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite } from '../../lib/utils'
import {
  validateVideoStudio,
  VIDEO_STUDIO_FILE,
  type VideoStudioDocument
} from '../../lib/video/studio'

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
async function createVideoDirectory(root: string, base: string): Promise<string> {
  // Check each parent after creation so a linked .cio folder cannot escape the workspace.
  const relativeFolder = `${base}/${randomUUID()}`
  const segments = base.split('/')
  for (let index = 1; index <= segments.length; index += 1) {
    const part = segments.slice(0, index).join('/')
    await mkdir(join(root, part), { recursive: true })
    await videoFolder(root, part)
  }
  await mkdir(join(root, relativeFolder))
  return videoFolder(root, relativeFolder)
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
  return validateVideoStudio(JSON.parse(text))
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
