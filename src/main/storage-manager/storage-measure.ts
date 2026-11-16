import { lstat, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { StorageAreaId } from '../../lib/types'
import type { StorageAreaSpec } from './storage-areas'

/** Directories read at once. High enough to hide latency, low enough to stay polite. */
const DIRECTORY_CONCURRENCY = 8

/** Files stat-ed at once inside one directory, so a flat folder of thousands is not serial. */
const STAT_CONCURRENCY = 32

/** Bytes and files one area holds. */
export interface AreaTally {
  bytes: number
  files: number
}

/** One complete walk of the data root. */
export interface StorageMeasurement {
  totalBytes: number
  totalFiles: number
  /** Only the areas that were given paths; the caller fills in the rest. */
  areas: Map<StorageAreaId, AreaTally>
}

/** A directory still to read, and the area its own files belong to. */
interface PendingDirectory {
  path: string
  area: StorageAreaId
}

/**
 * Attribute a path to an area.
 *
 * The deepest matching area path wins, and a path outside every area belongs to
 * the catch-all (`app-data`). Matching runs upwards from the path so one map
 * lookup answers for a whole subtree without walking the tree twice.
 */
function classifyPath(path: string, owners: ReadonlyMap<string, StorageAreaId>): StorageAreaId {
  let current = resolve(path)
  for (;;) {
    const owner = owners.get(current)
    if (owner) return owner
    const parent = resolve(join(current, '..'))
    if (parent === current) return 'app-data'
    current = parent
  }
}

/** Sum a directory's own files, batched so one flat folder neither serializes nor floods. */
async function tallyFiles(
  directory: string,
  names: readonly string[],
  tally: AreaTally
): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(STAT_CONCURRENCY, names.length) }, async () => {
    for (;;) {
      const current = index++
      if (current >= names.length) return
      const name = names[current]
      if (name === undefined) return
      try {
        const info = await lstat(join(directory, name))
        if (!info.isFile()) continue
        tally.bytes += info.size
        tally.files += 1
      } catch {
        // A file removed mid-walk is not a failure, it is simply gone.
      }
    }
  })
  await Promise.all(workers)
}

/**
 * Walk a set of directories once, tallying bytes per area.
 *
 * Directories are read through a small worker pool instead of recursively, so a
 * deep tree never builds a call stack as deep as it is and eight reads are
 * always in flight. Symlinks are never followed: the walk must stay inside the
 * data root, and a link to another volume must not be counted or deleted.
 */
async function walk(
  starts: readonly PendingDirectory[],
  classify: (path: string) => StorageAreaId
): Promise<StorageMeasurement> {
  const areas = new Map<StorageAreaId, AreaTally>()
  const queue: PendingDirectory[] = [...starts]
  let totalBytes = 0
  let totalFiles = 0

  const tallyFor = (area: StorageAreaId): AreaTally => {
    const existing = areas.get(area)
    if (existing) return existing
    const created: AreaTally = { bytes: 0, files: 0 }
    areas.set(area, created)
    return created
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const pending = queue.pop()
      if (!pending) return
      let entries
      try {
        entries = await readdir(pending.path, { withFileTypes: true })
      } catch {
        continue
      }
      const tally = tallyFor(pending.area)
      const fileNames: string[] = []
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          const path = join(pending.path, entry.name)
          queue.push({ path, area: classify(path) })
          continue
        }
        if (entry.isFile()) fileNames.push(entry.name)
      }
      if (fileNames.length === 0) continue
      const before = tally.bytes
      const beforeFiles = tally.files
      await tallyFiles(pending.path, fileNames, tally)
      totalBytes += tally.bytes - before
      totalFiles += tally.files - beforeFiles
    }
  }

  await Promise.all(Array.from({ length: DIRECTORY_CONCURRENCY }, () => worker()))
  return { totalBytes, totalFiles, areas }
}

/**
 * Measure the whole data root, attributing every byte to exactly one area.
 *
 * The result is the folder's real size, so the surface can show a total it did
 * not have to compute from a sum of categories that might miss a folder.
 */
export async function measureStorageRoot(
  root: string,
  areas: readonly StorageAreaSpec[]
): Promise<StorageMeasurement> {
  const owners = new Map<string, StorageAreaId>()
  for (const area of areas) {
    for (const path of area.paths) owners.set(resolve(path), area.id)
  }
  return walk([{ path: resolve(root), area: 'app-data' }], (path) => classifyPath(path, owners))
}

/**
 * Measure one list of paths, for the size a single action will hand back.
 *
 * A path may be a file or a directory; a missing path contributes nothing.
 */
export async function measurePaths(paths: readonly string[]): Promise<AreaTally> {
  const tally: AreaTally = { bytes: 0, files: 0 }
  const directories: PendingDirectory[] = []
  const files: string[] = []

  for (const path of paths) {
    try {
      const info = await stat(path)
      if (info.isDirectory()) directories.push({ path, area: 'caches' })
      else if (info.isFile()) files.push(path)
    } catch {
      // A path that is already gone is worth nothing and needs no work.
    }
  }

  for (const file of files) {
    try {
      const info = await lstat(file)
      if (!info.isFile()) continue
      tally.bytes += info.size
      tally.files += 1
    } catch {
      // Same as above: gone is gone.
    }
  }

  if (directories.length > 0) {
    const measured = await walk(directories, () => 'caches')
    tally.bytes += measured.totalBytes
    tally.files += measured.totalFiles
  }
  return tally
}
