import { readdir, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { DesignEntry } from '../../lib/ipc/design'
import { SERVED_FOLDER_ENTRY_FILE } from '../preview/served-folder'

/** Folder metadata shared by canonical-root discovery and exact registry checks. */

/** Most files scanned for a folder's latest modification time. */
const MAX_SCANNED_FILES = 50

/**
 * When a folder was made and when it was last touched, so the board can show a
 * design's age next to its name without a second filesystem pass.
 *
 * A volume that records no birth time (some network and virtual filesystems
 * report zero) stands its change time in, which is the closest thing to a
 * creation stamp it has.
 */
async function folderStamps(directory: string): Promise<{ createdAt: number; updatedAt: number }> {
  const info = await stat(directory).catch(() => null)
  let newest = info?.mtimeMs ?? 0
  const createdAt = info && info.birthtimeMs > 0 ? info.birthtimeMs : (info?.ctimeMs ?? 0)
  const files = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const file of files.slice(0, MAX_SCANNED_FILES)) {
    if (!file.isFile()) continue
    const fileInfo = await stat(resolve(directory, file.name)).catch(() => null)
    if (fileInfo && fileInfo.mtimeMs > newest) newest = fileInfo.mtimeMs
  }
  return { createdAt: Math.round(createdAt), updatedAt: Math.round(newest) }
}

/**
 * Every folder under `root` in a project, newest first.
 *
 * `root` is project-relative and forward-slashed (`.cio/designs`, `.cio/videos`),
 * and is also how each folder's `directory` is spelled back to the caller.
 */
export async function listProjectWorkFolders(
  projectPath: string,
  root: string
): Promise<DesignEntry[]> {
  const absoluteRoot = resolve(projectPath, root)
  const entries = await readdir(absoluteRoot, { withFileTypes: true }).catch(() => [])
  const folders: DesignEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const absolute = resolve(absoluteRoot, entry.name)
    const indexFile = await stat(resolve(absolute, SERVED_FOLDER_ENTRY_FILE)).catch(() => null)
    const stamps = await folderStamps(absolute)
    folders.push({
      directory: `${root}/${entry.name}`,
      name: entry.name,
      hasEntry: indexFile?.isFile() === true,
      createdAt: stamps.createdAt,
      updatedAt: stamps.updatedAt,
      // Disk knows nothing about which thread wrote the folder; main merges the
      // recorded creator in after the listing.
      creatorThreadId: null
    })
  }
  return folders.sort((left, right) => right.updatedAt - left.updatedAt)
}

/** Inspect exactly one registered folder, without enumerating its siblings. */
export async function readWorkFolder(
  projectPath: string,
  directory: string
): Promise<DesignEntry | null> {
  const absolute = resolve(projectPath, directory)
  const info = await stat(absolute).catch((error: unknown) => {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return null
    throw error
  })
  if (!info?.isDirectory()) return null
  const entry = await stat(resolve(absolute, SERVED_FOLDER_ENTRY_FILE)).catch(() => null)
  const stamps = await folderStamps(absolute)
  return {
    directory,
    name: basename(directory),
    hasEntry: entry?.isFile() === true,
    ...stamps,
    creatorThreadId: null,
    missing: false
  }
}
