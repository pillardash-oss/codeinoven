import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DesignEntry } from '../../lib/ipc/design'
import { SERVED_FOLDER_ENTRY_FILE } from '../preview/served-folder'

/**
 * Reading a project's authored work from disk.
 *
 * `.cio/designs/<name>/` and `.cio/videos/<name>/` are the documented layouts, so
 * the folder listing *is* the registry: a folder another thread wrote is found
 * here with nothing having registered it, and a folder the user deleted stops
 * appearing. The root is a parameter because a design session and a video session
 * list identically, down to the `index.html` entry file both contracts use.
 *
 * Kept apart from `design-service.ts`, which talks to the database and to IPC, so
 * the listing can be exercised on its own.
 */

/** Most files scanned for a folder's latest modification time. */
const MAX_SCANNED_FILES = 50

/** The newest modification time in a folder, so the one you just touched sorts first. */
async function latestModifiedAt(directory: string): Promise<number> {
  const info = await stat(directory).catch(() => null)
  let newest = info?.mtimeMs ?? 0
  const files = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const file of files.slice(0, MAX_SCANNED_FILES)) {
    if (!file.isFile()) continue
    const fileInfo = await stat(resolve(directory, file.name)).catch(() => null)
    if (fileInfo && fileInfo.mtimeMs > newest) newest = fileInfo.mtimeMs
  }
  return newest
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
    folders.push({
      directory: `${root}/${entry.name}`,
      name: entry.name,
      hasEntry: indexFile?.isFile() === true,
      updatedAt: Math.round(await latestModifiedAt(absolute))
    })
  }
  return folders.sort((left, right) => right.updatedAt - left.updatedAt)
}
