/**
 * Durable records for the embedded browser's downloads.
 *
 * A download outlives the run that started it: the file is on the user's disk,
 * and what the download manager knows about it (where it was saved, how far it
 * got, what the server said about resuming it) has to survive quitting and
 * reopening the app, or the user is left with an invisible half-written file and
 * no way to continue it.
 *
 * File contents are untrusted input: a truncated, corrupt or unrecognized entry
 * must never make the manager touch a path or claim a resumable download, so
 * every field is validated and bounded on load and every dropped entry is simply
 * absent from the result.
 *
 * Each launch keeps its own file (packaged prod vs unpackaged dev), so a
 * write re-reads only its own file and merges this instance's records over
 * it by id instead of replacing another launch's downloads with this one's
 * view.
 */

import type { BrowserDownloadState } from '../../../lib/ipc-contract'
import { isUnpackagedElectronLaunch } from '../../../lib/utils'
import { Logger } from '../../system/logger'

/** Minimal persistence surface this store needs (a `StorageEngine` satisfies it
 *  structurally); paths are relative to the app config root. */
export interface DownloadPersistence {
  read<T>(relativePath: string): Promise<T | null>
  write(relativePath: string, data: unknown): Promise<void>
}

export const BROWSER_DOWNLOADS_FILE = 'browser/downloads.json'

/**
 * Where this launch reads and writes download records. Dev uses a `-dev`
 * variant so its records never merge with prod's. Prod keeps the file.
 */
export function resolveBrowserDownloadsFile(): string {
  if (isUnpackagedElectronLaunch()) {
    return BROWSER_DOWNLOADS_FILE.replace(/\.json$/, '-dev.json')
  }
  return BROWSER_DOWNLOADS_FILE
}

const STORE_VERSION = 1
/** Ceiling on the file's records. A downloads list is a working surface, not an
 *  archive, and each entry costs a few hundred bytes of the user's config. */
const MAX_PERSISTED_DOWNLOADS = 200
const MAX_URL_LENGTH = 2_048
const MAX_FILE_NAME_LENGTH = 512
const MAX_PATH_LENGTH = 4_096
const MAX_MIME_TYPE_LENGTH = 256
const MAX_ERROR_LENGTH = 512
const MAX_LAST_MODIFIED_LENGTH = 128
const MAX_ETAG_LENGTH = 256
const MAX_URL_CHAIN_LENGTH = 16

const DOWNLOAD_STATES: readonly BrowserDownloadState[] = [
  'progressing',
  'interrupted',
  'completed',
  'cancelled'
]

/** One download as the store keeps it: what the renderer is shown, plus the
 *  facts a later run needs to resume or restart it. */
export interface PersistedBrowserDownload {
  id: string
  tabId: string
  projectId: string
  fileName: string
  url: string
  /** Every URL the download was redirected through, in order. Chromium needs the
   *  chain, not just the final URL, to resume a redirected download. */
  urlChain: string[]
  mimeType: string
  receivedBytes: number
  totalBytes: number
  progress: number
  state: BrowserDownloadState
  paused: boolean
  /** Where the file is (or will be), as the save dialog answered it. */
  savePath: string
  /** Where this download's kept bytes are while it is not running, when they were
   *  moved out of Chromium's reach. Empty when there are none. */
  stagedPath: string
  /** `Last-Modified` of the response, one of the two headers Chromium validates
   *  a resumed range request against. */
  lastModified: string
  /** `ETag` of the response, the other validator; Chromium prefers a strong one
   *  over `Last-Modified` when both are known. */
  eTag: string
  error: string
  startedAt: number
  /** When this record was last written; the tie-breaker when two instances share
   *  the file. */
  updatedAt: number
}

interface PersistedDownloadsFile {
  version?: number
  downloads?: unknown
}

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.length > maxLength ? value.slice(0, maxLength) : value
  return trimmed
}

function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

function readTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}

function readState(value: unknown): BrowserDownloadState | null {
  return DOWNLOAD_STATES.includes(value as BrowserDownloadState)
    ? (value as BrowserDownloadState)
    : null
}

function readUrlChain(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const chain: string[] = []
  for (const entry of value) {
    const url = readString(entry, MAX_URL_LENGTH)
    if (url === null || url.length === 0) continue
    chain.push(url)
    if (chain.length >= MAX_URL_CHAIN_LENGTH) break
  }
  return chain
}

/** One entry as a record, or null when it is not complete enough to trust. */
function readRecord(value: unknown): PersistedBrowserDownload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const id = readString(source['id'], 64)
  const projectId = readString(source['projectId'], 240)
  const fileName = readString(source['fileName'], MAX_FILE_NAME_LENGTH)
  const url = readString(source['url'], MAX_URL_LENGTH)
  const state = readState(source['state'])
  const receivedBytes = readCount(source['receivedBytes'])
  const totalBytes = readCount(source['totalBytes'])
  const updatedAt = readTimestamp(source['updatedAt'])
  if (!id || !projectId || !url || fileName === null || !state) return null
  if (receivedBytes === null || totalBytes === null || updatedAt === null) return null
  return {
    id,
    tabId: readString(source['tabId'], 240) ?? '',
    projectId,
    fileName,
    url,
    urlChain: readUrlChain(source['urlChain']),
    mimeType: readString(source['mimeType'], MAX_MIME_TYPE_LENGTH) ?? '',
    receivedBytes,
    totalBytes,
    progress: readCount(source['progress']) ?? 0,
    state,
    paused: source['paused'] === true,
    savePath: readString(source['savePath'], MAX_PATH_LENGTH) ?? '',
    stagedPath: readString(source['stagedPath'], MAX_PATH_LENGTH) ?? '',
    lastModified: readString(source['lastModified'], MAX_LAST_MODIFIED_LENGTH) ?? '',
    eTag: readString(source['eTag'], MAX_ETAG_LENGTH) ?? '',
    error: readString(source['error'], MAX_ERROR_LENGTH) ?? '',
    startedAt: readTimestamp(source['startedAt']) ?? updatedAt,
    updatedAt
  }
}

/** Keep at most `max` records: the newest ones, and an unfinished download before
 *  any finished one, so trimming can never drop what the user still needs to
 *  resume. Input order is preserved. */
export function boundDownloadRecords(
  records: readonly PersistedBrowserDownload[],
  max: number = MAX_PERSISTED_DOWNLOADS
): PersistedBrowserDownload[] {
  if (records.length <= max) return [...records]
  const newestFirst = [...records].sort((left, right) => right.updatedAt - left.updatedAt)
  const kept = new Set<PersistedBrowserDownload>()
  for (const record of newestFirst) {
    if (record.state !== 'progressing') continue
    if (kept.size >= max) break
    kept.add(record)
  }
  for (const record of newestFirst) {
    if (record.state === 'progressing') continue
    if (kept.size >= max) break
    kept.add(record)
  }
  return records.filter((record) => kept.has(record))
}

export class BrowserDownloadStore {
  constructor(private readonly persistence: DownloadPersistence) {}

  /** Every valid record in the file, newest first. */
  async load(): Promise<PersistedBrowserDownload[]> {
    const file = await this.readFile()
    if (file === null) return []
    return boundDownloadRecords(file).sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * Merge this instance's records over the file, by id, newest write wins, and
   * keep every record this instance is not writing (another instance's
   * downloads, in its own projects).
   *
   * `removedIds` are the records this instance deleted   a download the user
   * cleared from the list, or one trimmed away. They have to be removed from the
   * file as well, or a merge that only ever adds would bring them back at the
   * next launch. A tombstone wins over both sides of the merge, including this
   * instance's own records: a snapshot taken before the deletion still carries
   * the record, and it must not be able to put it back.
   */
  async save(
    records: readonly PersistedBrowserDownload[],
    removedIds: ReadonlySet<string> = new Set()
  ): Promise<void> {
    const existing = (await this.readFile()) ?? []
    const merged = new Map<string, PersistedBrowserDownload>()
    for (const record of existing) {
      if (removedIds.has(record.id)) continue
      merged.set(record.id, record)
    }
    for (const record of records) {
      if (removedIds.has(record.id)) continue
      const known = merged.get(record.id)
      if (known && known.updatedAt > record.updatedAt) continue
      merged.set(record.id, record)
    }
    await this.writeFile(boundDownloadRecords([...merged.values()]))
  }

  private async readFile(): Promise<PersistedBrowserDownload[] | null> {
    const raw = await this.readRaw()
    if (raw === null || typeof raw !== 'object') return null
    const entries = (raw as PersistedDownloadsFile).downloads
    if (!Array.isArray(entries)) return null
    const records: PersistedBrowserDownload[] = []
    for (const entry of entries) {
      const record = readRecord(entry)
      if (record) records.push(record)
    }
    return records
  }

  /** The file's parsed body, or null when it cannot be read at all. A file that
   *  cannot be read is "no records", never an error the caller has to handle. */
  private async readRaw(): Promise<unknown> {
    try {
      return await this.persistence.read<unknown>(resolveBrowserDownloadsFile())
    } catch (error: unknown) {
      Logger.error('Browser download records could not be read:', error)
      return null
    }
  }

  private async writeFile(records: readonly PersistedBrowserDownload[]): Promise<void> {
    try {
      await this.persistence.write(resolveBrowserDownloadsFile(), {
        version: STORE_VERSION,
        downloads: records
      })
    } catch (error: unknown) {
      Logger.error('Browser download records could not be written:', error)
      // The caller has to know the write failed: a record it removed is only
      // really gone once a write without it landed.
      throw error
    }
  }
}
