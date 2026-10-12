/**
 * Bounded measurement of what a project directory holds.
 *
 * `stat` on a directory reports only the directory's own inode, so the bytes a
 * user means by "folder size" have to be summed from the files below it. That
 * walk is unbounded in principle (a repository can hold hundreds of thousands of
 * files under `node_modules`), so it is capped twice: by entries visited and by
 * wall clock. A capped walk still answers, and says so through `truncated`.
 *
 * Nothing here blocks: each step awaits the filesystem, several directories are
 * read at a time so metadata requests overlap instead of queueing one by one,
 * and only directory paths are held in memory rather than the whole tree.
 */

import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import type { ProjectDirectorySize } from '../../../lib/types'

/** Entries (files plus directories) visited before a measurement stops. */
export const MAX_MEASURED_ENTRIES = 150_000

/** How long one measurement may run before it reports what it has. */
export const MAX_MEASUREMENT_MS = 10_000

/** Directories read concurrently, and file sizes requested together per batch.
 *  Both are deliberately small: enough requests in flight to keep the disk busy,
 *  few enough that a measurement never floods the thread pool or the event loop
 *  that has to serve the rest of the app. */
const DIRECTORY_READ_CONCURRENCY = 8
const SIZE_BATCH = 64

interface DirectoryListing {
  path: string
  entries: Dirent[] | null
}

export interface DirectorySizeLimits {
  maxEntries?: number
  maxDurationMs?: number
}

/**
 * Total bytes, files and directories below `directory`.
 *
 * Read failures inside the tree (a permission denied, a directory removed while
 * it was being walked) skip that entry and keep the measurement going: a partial
 * answer for a tree that is changing under the walk is more useful than a
 * rejected dialog. Only the root itself is required to be readable.
 */
export async function measureDirectorySize(
  directory: string,
  limits: DirectorySizeLimits = {}
): Promise<ProjectDirectorySize> {
  const maxEntries = limits.maxEntries ?? MAX_MEASURED_ENTRIES
  const maxDurationMs = limits.maxDurationMs ?? MAX_MEASUREMENT_MS
  const deadline = Date.now() + maxDurationMs

  let bytes = 0
  let files = 0
  let directories = 0
  let visited = 0
  let truncated = false
  const pending: string[] = [directory]

  while (pending.length > 0 && !truncated) {
    const listings = await readDirectories(pending.splice(0, DIRECTORY_READ_CONCURRENCY))
    const filePaths: string[] = []
    for (const listing of listings) {
      if (!listing.entries) continue
      for (const entry of listing.entries) {
        // Symlinks are neither followed nor counted: a link out of the project
        // would otherwise inflate the folder with bytes that live elsewhere,
        // and a link back up the tree would never terminate.
        if (entry.isSymbolicLink()) continue
        const isDirectory = entry.isDirectory()
        if (!isDirectory && !entry.isFile()) continue
        visited += 1
        if (visited > maxEntries || Date.now() > deadline) {
          truncated = true
          break
        }
        if (isDirectory) {
          directories += 1
          pending.push(join(listing.path, entry.name))
          continue
        }
        files += 1
        filePaths.push(join(listing.path, entry.name))
      }
      if (truncated) break
    }
    bytes += await totalFileBytes(filePaths)
  }

  return { bytes, files, directories, truncated }
}

async function readDirectories(paths: string[]): Promise<DirectoryListing[]> {
  return await Promise.all(
    paths.map(async (path) => {
      try {
        return { path, entries: await readdir(path, { withFileTypes: true }) }
      } catch {
        return { path, entries: null }
      }
    })
  )
}

async function totalFileBytes(paths: string[]): Promise<number> {
  let total = 0
  for (let start = 0; start < paths.length; start += SIZE_BATCH) {
    const sizes = await Promise.all(
      paths.slice(start, start + SIZE_BATCH).map(async (path) => {
        try {
          return (await lstat(path)).size
        } catch {
          return 0
        }
      })
    )
    for (const size of sizes) total += size
  }
  return total
}
