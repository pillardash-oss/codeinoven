import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DESIGN_OUTPUT_ROOT } from '../../lib/design-skill'
import type { DesignEntry } from '../../lib/ipc/design'
import { DESIGN_ENTRY_FILE } from './design-preview-session'

/**
 * Reading the project's designs from disk.
 *
 * `.cio/designs/<name>/` is the documented layout, so the folder listing *is*
 * the registry: a design another thread wrote is found here with nothing having
 * registered it, and a design the user deleted stops appearing. Kept apart from
 * `design-service.ts`, which talks to the database and to IPC, so the listing
 * can be exercised on its own.
 */

/** Most files scanned for a folder's latest modification time. */
const MAX_SCANNED_FILES = 50

/** The newest modification time in a folder, so the design you just touched sorts first. */
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

/** Every design folder in a project, newest first. */
export async function listProjectDesigns(projectPath: string): Promise<DesignEntry[]> {
  const root = resolve(projectPath, DESIGN_OUTPUT_ROOT)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const designs: DesignEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const absolute = resolve(root, entry.name)
    const indexFile = await stat(resolve(absolute, DESIGN_ENTRY_FILE)).catch(() => null)
    designs.push({
      directory: `${DESIGN_OUTPUT_ROOT}/${entry.name}`,
      name: entry.name,
      hasEntry: indexFile?.isFile() === true,
      updatedAt: Math.round(await latestModifiedAt(absolute))
    })
  }
  return designs.sort((left, right) => right.updatedAt - left.updatedAt)
}
