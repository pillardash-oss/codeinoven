import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { UpdateFileInfo, UpdateInfo } from 'builder-util-runtime'
import type { SelectedUpdateArtifact } from './updater-download'

/**
 * Where the service records the build it has fully downloaded.
 *
 * The update itself lives in electron-updater's own pending cache, which is the
 * only place its installer reads from. This file only names that build, so an
 * offline launch can offer the download it already has instead of asking the
 * feed (and the internet) whether an update exists.
 */
export const CACHED_UPDATE_FILE = 'updater/cached-update.json'

/** The build sitting in the updater cache, as the feed described it. */
export interface CachedUpdateInfo {
  version: string
  files: UpdateFileInfo[]
  path: string
  sha512: string
  releaseName: string | null
  releaseDate: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Read one feed file entry, keeping only the fields an install actually uses.
 * An entry without a stable URL or hash cannot be verified, so it is dropped.
 */
function toUpdateFileInfo(value: unknown): UpdateFileInfo | null {
  const entry = asRecord(value)
  if (entry === null) return null
  if (typeof entry.url !== 'string' || entry.url.length === 0) return null
  if (typeof entry.sha512 !== 'string' || entry.sha512.length === 0) return null
  return {
    url: entry.url,
    sha512: entry.sha512,
    ...(typeof entry.size === 'number' && Number.isFinite(entry.size) ? { size: entry.size } : {}),
    ...(entry.isAdminRightsRequired === true ? { isAdminRightsRequired: true } : {})
  }
}

/**
 * Validate a persisted cached-update record.
 *
 * Returns null for anything the installer could not verify, so a half-written
 * or stale record never turns into an offer for a build that is not on disk.
 */
export function toCachedUpdateInfo(value: unknown): CachedUpdateInfo | null {
  const record = asRecord(value)
  if (record === null || typeof record.version !== 'string' || !Array.isArray(record.files)) {
    return null
  }
  const files: UpdateFileInfo[] = []
  for (const entry of record.files) {
    const file = toUpdateFileInfo(entry)
    if (file !== null) files.push(file)
  }
  if (files.length === 0) return null
  const first = files[0]
  return {
    version: record.version,
    files,
    path: typeof record.path === 'string' ? record.path : first.url,
    sha512: typeof record.sha512 === 'string' ? record.sha512 : first.sha512,
    releaseName: typeof record.releaseName === 'string' ? record.releaseName : null,
    releaseDate: typeof record.releaseDate === 'string' ? record.releaseDate : ''
  }
}

/** The shape electron-updater's own check expects from a feed lookup. */
export function toUpdateInfo(cached: CachedUpdateInfo): UpdateInfo {
  return {
    version: cached.version,
    files: cached.files,
    path: cached.path,
    sha512: cached.sha512,
    releaseName: cached.releaseName,
    releaseDate: cached.releaseDate
  }
}

/**
 * Whether the cached artifact is fully on disk.
 *
 * A partial download is never offered as an update: its bytes can only be
 * resumed by a real download, and an install must never start from a truncated
 * payload. When the feed did not publish a size, the file only has to exist;
 * electron-updater verifies its sha512 before installing it either way.
 */
export async function cachedArtifactReady(
  selection: SelectedUpdateArtifact,
  pendingDir: string
): Promise<boolean> {
  const file = path.join(pendingDir, selection.fileName)
  const bytes = await stat(file)
    .then((info) => (info.isFile() ? info.size : 0))
    .catch(() => 0)
  if (bytes <= 0) return false
  return selection.size <= 0 || bytes === selection.size
}
