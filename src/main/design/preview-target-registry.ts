import { dirname, join } from 'node:path'
import {
  previewFolderId,
  previewTargetId,
  type PreviewFolder,
  type PreviewTarget
} from '../../lib/design/preview-target'
import { ensureDir, getConfigRoot, readJson, writeJson } from '../../lib/utils'
import { Logger } from '../system/logger'

/**
 * Which browser tab and which loopback server each preview target was given,
 * remembered across a restart.
 *
 * The design panel opens a page per screen, so the same screen is clicked again
 * and again. Two things must therefore be looked up rather than created: the tab
 * that screen is already shown in, and the server its folder is already served
 * on. Both are answered from this record, which is the app's memory of a decision
 * it already made, so a click on an open screen reaches its tab instead of
 * stacking a second one, and a tab the renderer restored onto a preview origin
 * keeps finding its page.
 *
 * The record is a small JSON document under the config root, written atomically
 * and validated on read: a screen's tab is trusted only while the browser still
 * holds that tab, and a folder's port is trusted only while nothing in this
 * process is serving the folder somewhere else. Anything else is discarded
 * rather than acted on, because a stale tab id names a page the user is not
 * looking at and a stale port names an origin nothing answers on.
 */
export const PREVIEW_SESSIONS_RELATIVE_PATH = join('design', 'preview-sessions.json')

/** The shape this file is written in, so an older or newer app never guesses. */
const DOCUMENT_VERSION = 1

/**
 * Ceiling on remembered targets and folders.
 *
 * One record is a few hundred bytes, so the cap is reached only by an app that
 * has previewed hundreds of screens across many designs; past it the least
 * recently opened ones are dropped, and a dropped record costs exactly one tab
 * the app no longer recognises, never a page it cannot open.
 */
const MAX_REMEMBERED_TARGETS = 200
const MAX_REMEMBERED_FOLDERS = 64

/** Loopback ports are recorded only when they are reusable ephemeral ones. */
const MIN_REUSABLE_PORT = 1_024
const MAX_PORT = 65_535

/** Tab ids the browser service mints, and the only ones a record may name. */
const TAB_ID_PATTERN = /^browser:[a-zA-Z0-9:_-]{1,240}$/u

const MAX_ID_FIELD_LENGTH = 1_024
const MAX_ROOT_LENGTH = 4_096

/** One browser tab remembered for one preview target. */
export interface PreviewTabRecord extends PreviewTarget {
  /** The tab the target was last shown in, or '' when it has none. */
  tabId: string
  /** When the record was last written, which is what the cap drops first. */
  updatedAt: number
}

/** One loopback server remembered for one preview folder. */
export interface PreviewServerRecord extends PreviewFolder {
  /** Canonical folder the server served. */
  root: string
  /** Loopback port the folder was served on, or 0 when it is unknown. */
  port: number
  /** When the record was last written, which is what the cap drops first. */
  updatedAt: number
}

/** What this registry holds, for diagnostics and for the reuse tests. */
export interface PreviewSessionSnapshot {
  tabs: PreviewTabRecord[]
  servers: PreviewServerRecord[]
}

interface PreviewSessionDocument {
  version: number
  tabs: PreviewTabRecord[]
  servers: PreviewServerRecord[]
}

/** A bounded, non-empty string field of a design's own naming, or null. */
function idFieldOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_FIELD_LENGTH
    ? value
    : null
}

/** One folder's three identity fields, or null when any of them cannot be trusted. */
function folderOf(value: Record<string, unknown>): PreviewFolder | null {
  const projectId = idFieldOf(value['projectId'])
  const threadId = idFieldOf(value['threadId'])
  const directory = idFieldOf(value['directory'])
  if (projectId === null || threadId === null || directory === null) return null
  return { projectId, threadId, directory }
}

/** The entry field, which is a path or null for the folder listing. */
function entryFieldOf(value: unknown): { entry: string | null } | null {
  if (value === null) return { entry: null }
  const entry = idFieldOf(value)
  return entry === null ? null : { entry }
}

function timestampOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function tabIdOf(value: unknown): string | null {
  if (value === '') return ''
  return typeof value === 'string' && TAB_ID_PATTERN.test(value) ? value : null
}

function portOf(value: unknown): number | null {
  if (value === 0) return 0
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_REUSABLE_PORT &&
    value <= MAX_PORT
    ? value
    : null
}

function rootOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ROOT_LENGTH
    ? value
    : null
}

/** One stored target, or null when any field of it cannot be trusted. */
function parseTabRecord(value: unknown): PreviewTabRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const folder = folderOf(record)
  const entry = entryFieldOf(record['entry'])
  const tabId = tabIdOf(record['tabId'])
  const updatedAt = timestampOf(record['updatedAt'])
  if (folder === null || entry === null || tabId === null || updatedAt === null) return null
  return { ...folder, ...entry, tabId, updatedAt }
}

/** One stored folder, or null when any field of it cannot be trusted. */
function parseServerRecord(value: unknown): PreviewServerRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const folder = folderOf(record)
  const root = rootOf(record['root'])
  const port = portOf(record['port'])
  const updatedAt = timestampOf(record['updatedAt'])
  if (folder === null || root === null || port === null || updatedAt === null) return null
  return { ...folder, root, port, updatedAt }
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** The entry an id names, from a list too large to keep whole. */
function oldestEntry<T extends { updatedAt: number }>(records: Map<string, T>): [string, T] | null {
  let oldest: [string, T] | null = null
  for (const entry of records) {
    if (oldest === null || entry[1].updatedAt < oldest[1].updatedAt) oldest = entry
  }
  return oldest
}

export class PreviewTargetRegistry {
  private readonly tabs = new Map<string, PreviewTabRecord>()
  private readonly servers = new Map<string, PreviewServerRecord>()
  /** The one restore attempt; repeated reads must not re-parse the file. */
  private restore: Promise<void> | null = null
  /** Serializes writes, so two opens can never interleave partial file states. */
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string = join(getConfigRoot(), PREVIEW_SESSIONS_RELATIVE_PATH)
  ) {}

  /** Read the record once. Never throws: a lost file only costs one new tab. */
  async ready(): Promise<void> {
    this.restore ??= this.load()
    await this.restore
  }

  /**
   * The tab remembered for one target, when the browser still holds it.
   *
   * The browser is the authority on whether a tab exists, so a record naming a
   * tab the user closed, or one the renderer did not restore, is dropped here
   * instead of being handed back as if it were on screen.
   */
  async tabFor(target: PreviewTarget, isLive: (tabId: string) => boolean): Promise<string | null> {
    await this.ready()
    const id = previewTargetId(target)
    const record = this.tabs.get(id)
    if (record === undefined || record.tabId === '') return null
    if (isLive(record.tabId)) return record.tabId
    this.tabs.delete(id)
    await this.persist()
    Logger.dev('A remembered design preview tab is gone, so its record was dropped')
    return null
  }

  /**
   * The port remembered for one folder, when it is still the folder's own.
   *
   * A folder served by this process on another port has moved on from what was
   * remembered, so the live port wins and the record is simply not trusted; the
   * open that follows writes the port it ended up on.
   */
  async portFor(
    folder: PreviewFolder,
    livePort: (root: string) => number | null
  ): Promise<number | null> {
    await this.ready()
    const record = this.servers.get(previewFolderId(folder))
    if (record === undefined || record.port === 0) return null
    const live = livePort(record.root)
    return live === null || live === record.port ? record.port : null
  }

  /** Remember the tab one target is now shown in. */
  async rememberTab(target: PreviewTarget, tabId: string): Promise<void> {
    if (tabId === '' || !TAB_ID_PATTERN.test(tabId)) return
    await this.ready()
    const id = previewTargetId(target)
    const existing = this.tabs.get(id)
    if (existing?.tabId === tabId) return
    this.tabs.set(id, { ...target, tabId, updatedAt: Date.now() })
    this.trim(this.tabs, MAX_REMEMBERED_TARGETS)
    await this.persist()
  }

  /** Remember the server one folder is now served on. */
  async rememberServer(
    folder: PreviewFolder,
    server: { root: string; port: number }
  ): Promise<void> {
    if (server.port === 0 || server.root === '') return
    await this.ready()
    const id = previewFolderId(folder)
    const existing = this.servers.get(id)
    if (existing?.root === server.root && existing.port === server.port) return
    this.servers.set(id, { ...folder, ...server, updatedAt: Date.now() })
    this.trim(this.servers, MAX_REMEMBERED_FOLDERS)
    await this.persist()
  }

  /** Forget one thread's targets, answering the folders no record names any more. */
  async forgetThread(threadId: string): Promise<string[]> {
    return this.forget((record) => record.threadId === threadId)
  }

  /** Forget one project's targets, answering the folders no record names any more. */
  async forgetProject(projectId: string): Promise<string[]> {
    return this.forget((record) => record.projectId === projectId)
  }

  /** Forget one folder's targets, after a rename or a move made them stale. */
  async forgetFolder(projectId: string, directory: string): Promise<string[]> {
    return this.forget(
      (record) =>
        record.projectId === projectId &&
        (record.directory === directory || record.directory.startsWith(`${directory}/`))
    )
  }

  /** Everything remembered, for diagnostics and for the reuse tests. */
  async snapshot(): Promise<PreviewSessionSnapshot> {
    await this.ready()
    return { tabs: [...this.tabs.values()], servers: [...this.servers.values()] }
  }

  private async forget(
    matches: (record: PreviewTarget | PreviewFolder) => boolean
  ): Promise<string[]> {
    await this.ready()
    const roots: string[] = []
    let dropped = false
    for (const [id, record] of [...this.tabs]) {
      if (!matches(record)) continue
      this.tabs.delete(id)
      dropped = true
    }
    for (const [id, record] of [...this.servers]) {
      if (!matches(record)) continue
      roots.push(record.root)
      this.servers.delete(id)
      dropped = true
    }
    if (!dropped) return []
    await this.persist()
    return this.abandonedRoots(roots)
  }

  /**
   * The folders nothing names any more.
   *
   * A server belongs to a folder rather than to a screen, so forgetting one
   * screen must never stop it. Only a folder no remaining record names is one
   * the app has finished with, and only then does the caller stop its server.
   */
  private abandonedRoots(roots: readonly string[]): string[] {
    const stillNamed = new Set([...this.servers.values()].map((record) => record.root))
    return [...new Set(roots)].filter((root) => root !== '' && !stillNamed.has(root))
  }

  private async persist(): Promise<void> {
    const write = this.writes.then(() => this.writeDocument())
    this.writes = write.catch(() => undefined)
    await write
  }

  private async writeDocument(): Promise<void> {
    const document: PreviewSessionDocument = {
      version: DOCUMENT_VERSION,
      tabs: [...this.tabs.values()],
      servers: [...this.servers.values()]
    }
    try {
      await ensureDir(dirname(this.filePath))
      await writeJson(this.filePath, document)
    } catch (error) {
      Logger.error('The design preview session records could not be written', error)
    }
  }

  private async load(): Promise<void> {
    let raw: unknown
    try {
      raw = await readJson<unknown>(this.filePath)
    } catch (error) {
      // A file this app cannot parse is a record it cannot trust, so the app
      // starts with none and writes a clean one on the next open.
      Logger.error('The design preview session records could not be read', error)
      return
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
    const document = raw as Record<string, unknown>
    if (document['version'] !== DOCUMENT_VERSION) return
    for (const value of listOf(document['tabs'])) {
      const record = parseTabRecord(value)
      if (record !== null) this.tabs.set(previewTargetId(record), record)
    }
    for (const value of listOf(document['servers'])) {
      const record = parseServerRecord(value)
      if (record !== null) this.servers.set(previewFolderId(record), record)
    }
    this.trim(this.tabs, MAX_REMEMBERED_TARGETS)
    this.trim(this.servers, MAX_REMEMBERED_FOLDERS)
  }

  private trim<T extends { updatedAt: number }>(records: Map<string, T>, limit: number): void {
    while (records.size > limit) {
      const oldest = oldestEntry(records)
      if (oldest === null) return
      records.delete(oldest[0])
    }
  }
}
