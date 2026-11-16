/**
 * The thread that measures and clears the app's data root.
 *
 * Every byte the Storage manager reports is counted here, and every folder it
 * deletes is removed here, so neither job ever runs on the Electron main
 * process. Measuring a multi-gigabyte root is hundreds of thousands of `stat`
 * calls, and removing one is a recursive unlink of the same size: both belong
 * on a worker that can take as long as it needs without touching a frame, an
 * IPC reply, or a keystroke.
 *
 * The worker owns no state between requests. It is spawned by the first
 * request, released when the lane goes idle, and every request carries the
 * data root it applies to.
 */
import { lstat, mkdir, rm, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { parentPort } from 'node:worker_threads'
import type {
  StorageArea,
  StorageAreaId,
  StorageClearResult,
  StorageClearTarget,
  StorageUsage
} from '../../lib/types'
import { storageAreaSpecs } from './storage-areas'
import { measurePaths, measureStorageRoot } from './storage-measure'
import type { StorageUsageWorkerRequest } from './storage-usage-protocol'

const port = parentPort

port?.on('message', (request: StorageUsageWorkerRequest) => {
  void handle(request).then(
    (value) => port.postMessage({ value }),
    (error: unknown) =>
      port.postMessage({ error: error instanceof Error ? error.message : String(error) })
  )
})

async function handle(request: StorageUsageWorkerRequest): Promise<unknown> {
  if (request.kind === 'usage') return measureUsage(request.root)
  if (request.kind === 'clear') return clearArea(request.root, request.target)
  return revealPath(request.root, request.area)
}

/**
 * The path a reveal should open, or null when the area holds nothing yet.
 *
 * Only a path that exists is returned: an area whose folder has never been
 * created has nothing to show in the file manager, and a path computed from a
 * name is not a path the user can be sent to.
 */
async function revealPath(
  configRoot: string,
  area: StorageAreaId | 'root'
): Promise<{ path: string | null }> {
  const root = resolve(configRoot)
  if (area === 'root') return { path: root }
  const specs = await storageAreaSpecs(root)
  const spec = specs.find((candidate) => candidate.id === area)
  if (!spec) return { path: null }
  for (const path of spec.paths) {
    try {
      const info = await lstat(path)
      if (!info.isSymbolicLink()) return { path }
    } catch {
      // Try the area's next path; a row can name a folder that is not there.
    }
  }
  return { path: null }
}

/** Measure the whole root and reduce it to the rows the surface renders. */
async function measureUsage(configRoot: string): Promise<StorageUsage> {
  const root = resolve(configRoot)
  const specs = await storageAreaSpecs(root)
  const measurement = await measureStorageRoot(root, specs)
  const areas: StorageArea[] = specs.map((spec) => {
    const tally = measurement.areas.get(spec.id)
    return {
      id: spec.id,
      label: spec.label,
      detail: spec.detail,
      bytes: tally?.bytes ?? 0,
      files: tally?.files ?? 0,
      action: spec.action,
      actionLabel: spec.actionLabel
    }
  })
  const reclaimableBytes = areas.reduce(
    (total, area) => (area.action === 'delete' ? total + area.bytes : total),
    0
  )
  return {
    totalBytes: measurement.totalBytes,
    reclaimableBytes,
    areas,
    measuredAt: Date.now()
  }
}

/**
 * Remove one area the user confirmed.
 *
 * The folders are recreated empty right after removal, so a running speech or
 * logging writer finds the directory it expects instead of failing its next
 * write. What was handed back is measured before anything is removed, which is
 * the only moment the size is still readable.
 */
async function clearArea(
  configRoot: string,
  target: StorageClearTarget
): Promise<StorageClearResult> {
  const root = resolve(configRoot)
  const specs = await storageAreaSpecs(root)
  const spec = specs.find((candidate) => candidate.id === target)
  if (!spec) throw new Error(`Unknown storage area: ${target}`)
  if (spec.action !== 'delete') throw new Error(`Storage area cannot be cleared: ${target}`)

  const paths = clearablePaths(root, spec.clearance)
  if (paths.length === 0) return { target, freedBytes: 0, removedFiles: 0 }

  const directories: string[] = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (info.isDirectory()) directories.push(path)
    } catch {
      // Already gone: removal is a no-op and there is nothing to recreate.
    }
  }

  const before = await measurePaths(paths)
  for (const path of paths) {
    await rm(path, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  }
  for (const directory of directories) {
    await mkdir(directory, { recursive: true }).catch(() => undefined)
  }

  return { target, freedBytes: before.bytes, removedFiles: before.files }
}

/**
 * The paths one clear may touch, filtered to what is provably inside the root.
 *
 * The list already comes from the area table, so this is the second lock rather
 * than the only one: no resolved path, and no path equal to the data root
 * itself, ever reaches `rm`.
 */
function clearablePaths(root: string, clearance: readonly string[]): string[] {
  const accepted: string[] = []
  for (const path of clearance) {
    const resolved = resolve(path)
    if (resolved === root) continue
    if (!resolved.startsWith(`${root}${sep}`)) continue
    if (accepted.includes(resolved)) continue
    accepted.push(resolved)
  }
  return accepted
}
