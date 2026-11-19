import { randomUUID } from 'node:crypto'
import {
  isUnsupportedWorkspaceOperation,
  type OvenFile,
  type OvenWorkspaceRequest,
  type OvenWorkspaceResult
} from '../../lib/ovens'
import type { PiHandoffStorage } from '../drivers/pi/pi-driver-cio-files'
import { Logger } from '../system/logger'

/**
 * The slice of the Oven client a remote Pi handoff store needs.
 *
 * `OvenService` already satisfies it: the same warm request channel that lists a
 * checkout and reads a file carries these calls.
 */
export interface OvenPiStorageService {
  workspace(id: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult>
}

/**
 * One write chunk the Oven's file API accepts.
 *
 * The Oven refuses a larger request, so a handoff file bigger than one turn's
 * system prompt is written and read back as a sequence of these.
 */
export const OVEN_PI_STORAGE_CHUNK_BYTES = 128 * 1024

/** A handoff file is read by the harness process on the Oven only. */
const FILE_MODE = 0o600

/** Where a removal parks a file when the Oven cannot delete; see `pruneOvenTrash`. */
const TRASH_DIRECTORY = '.trash'

/**
 * How many parked files one `.trash` directory keeps.
 *
 * A bundle that cannot delete is the only machine that parks anything, so this
 * is the whole bound between that machine and a full disk: a handful of the
 * newest discarded files stay recoverable on the Oven, and everything older is
 * released by the next removal.
 */
export const OVEN_PI_TRASH_KEEP = 8

/** One workspace call, plus the action its failure should name. */
export type OvenPiWorkspaceRequest = (
  input: OvenWorkspaceRequest,
  action: string
) => Promise<OvenWorkspaceResult>

/** What a removal did: deleted the file, parked it, or found nothing to do. */
export type OvenPiRemoveOutcome = 'deleted' | 'parked' | 'missing'

/**
 * The app-owned handoff files a pi session reads, held on a remote Oven.
 *
 * A pi session on an Oven needs exactly what a local one reads through
 * `StorageEngine`: its composed extension's per-turn handoffs (system prompt,
 * history recap, allowed tools, gateway endpoint, stop flag, compaction
 * context). This implements that same file surface over the Oven's workspace
 * API, so the driver publishes and reads them without knowing which machine
 * holds them.
 *
 * `root` must be an app-owned directory on the Oven, never a checkout: these
 * files are application state, and nothing here deletes something it did not
 * write.
 */
export class OvenPiStorage implements PiHandoffStorage {
  private readonly service: OvenPiStorageService
  private readonly ovenId: string
  private readonly root: string
  /**
   * One tail promise per file path.
   *
   * A multi-chunk write is a sequence of requests, so two writers of the same
   * file would otherwise interleave chunks into one another's staging file and
   * publish a mixture of both. Reads and removals queue behind the same tail so
   * a caller never observes a file mid-publish.
   */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(input: { service: OvenPiStorageService; ovenId: string; root: string }) {
    this.service = input.service
    this.ovenId = input.ovenId
    this.root = ovenRootPath(input.root)
  }

  /** The absolute Oven path a storage-relative handoff path names. */
  resolve(relativePath: string): string {
    return joinOvenPath(this.root, relativePathOf(relativePath))
  }

  /** The handoff file's text, or null when nothing was published at that path. */
  async readRaw(relativePath: string): Promise<string | null> {
    const path = relativePathOf(relativePath)
    return this.enqueue(path, () => this.read(path))
  }

  /** Publish a whole handoff file, replacing whatever the path held. */
  async writeRaw(relativePath: string, content: string): Promise<void> {
    const path = relativePathOf(relativePath)
    return this.enqueue(path, () => this.write(path, content))
  }

  /**
   * Take a handoff file out of its path.
   *
   * The file is deleted on the Oven. An Oven still running a service bundle
   * older than this app has no delete, so there the file is parked in `.trash`
   * instead and that directory is kept to a few entries. A file that is already
   * gone is not an error: clearing a handoff twice is routine, and the caller
   * only cares that nothing is there afterwards.
   */
  async remove(relativePath: string): Promise<void> {
    const path = relativePathOf(relativePath)
    return this.enqueue(path, async () => {
      await removeOvenWorkspaceFile((input, action) => this.request(input, action), {
        root: this.root,
        path
      })
    })
  }

  /** Read every chunk of one file, or null when the file does not exist. */
  private async read(path: string): Promise<string | null> {
    const chunks: Buffer[] = []
    let offset = 0
    for (;;) {
      let result: OvenWorkspaceResult
      try {
        result = await this.request(
          { operation: 'read', root: this.root, path, offset },
          `read ${path}`
        )
      } catch (error) {
        // A handoff that was never published (or was cleared) reads as absent,
        // exactly as the local engine reports it. A later chunk failing is a
        // real failure: a truncated read would hand pi half a system prompt.
        if (offset === 0 && isMissing(error)) return null
        throw error
      }
      const bytes = Buffer.from(result.data ?? '', 'base64')
      if (!bytes.length) break
      chunks.push(bytes)
      offset += bytes.length
      // A short chunk is the last one; `size` ends the walk without the extra
      // request a file whose length is an exact multiple of the chunk needs.
      if (bytes.length < OVEN_PI_STORAGE_CHUNK_BYTES) break
      if (typeof result.size === 'number' && offset >= result.size) break
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /**
   * Ensure the session root exists, once per storage lifetime.
   *
   * `ensure` is the one workspace operation that creates the root itself
   * (recursive, parents included), where `mkdir` only creates subdirectories
   * under a root that already realpath's. A failure is not cached: the next
   * write tries again, because a session whose root could not be created must
   * fail loudly at that write, not silently forever.
   */
  private ensureRoot(): Promise<void> {
    this.rootReady ??= this.request(
      { operation: 'ensure', root: this.root },
      `create the session root ${this.root}`
    ).then(
      () => undefined,
      (error: unknown) => {
        this.rootReady = null
        throw error
      }
    )
    return this.rootReady
  }

  /** Tail of the one-time root ensure, shared by every write. */
  private rootReady: Promise<void> | null = null

  /**
   * Write one file whole, in chunks, and publish it in a single step.
   *
   * Chunks go to a staging file beside the destination and a rename publishes
   * it, so pi never reads a half-written handoff: the old content stays visible
   * until the last chunk has landed.
   */
  private async write(path: string, content: string): Promise<void> {
    const bytes = Buffer.from(content, 'utf8')
    // The session root must exist before anything under it can be written: the
    // workspace API realpath's the root first, so a session root nobody created
    // fails every write with ENOENT before the subdirectory mkdir ever runs.
    // Extensions ensure their own tree and transcripts live in pi's own
    // directory, which left this root as the one part of an Oven session that
    // nothing created, and a fresh session's very first handoff write failed.
    await this.ensureRoot()
    const directory = parentOf(path)
    if (directory)
      await this.request(
        { operation: 'mkdir', root: this.root, path: directory },
        `create the directory for ${path}`
      )
    const staged = `${path}.${randomUUID()}.next`
    try {
      for (
        let offset = 0;
        offset < bytes.length || offset === 0;
        offset += OVEN_PI_STORAGE_CHUNK_BYTES
      ) {
        await this.request(
          {
            operation: 'write',
            root: this.root,
            path: staged,
            offset,
            data: bytes.subarray(offset, offset + OVEN_PI_STORAGE_CHUNK_BYTES).toString('base64'),
            exclusive: offset === 0,
            mode: FILE_MODE
          },
          `write ${path}`
        )
      }
      await this.request(
        { operation: 'replace', root: this.root, path, staged, mode: FILE_MODE },
        `publish ${path}`
      )
    } catch (error) {
      // The staged file is invisible to pi either way; deleting it keeps the
      // session directory from collecting one leftover per failed write.
      await removeOvenWorkspaceFile((input, action) => this.request(input, action), {
        root: this.root,
        path: staged
      }).catch(() => undefined)
      throw error
    }
  }

  /** One request, with a failure that names the operation and the path only. */
  private async request(input: OvenWorkspaceRequest, action: string): Promise<OvenWorkspaceResult> {
    try {
      return await this.service.workspace(this.ovenId, input)
    } catch (error) {
      const failure = new Error(`Could not ${action} on the Oven: ${messageOf(error)}`, {
        cause: error
      })
      throw isMissing(error) ? Object.assign(failure, { code: 'ENOENT' }) : failure
    }
  }

  /** Run one file operation after every earlier operation on the same path. */
  private enqueue<T>(path: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(path) ?? Promise.resolve()
    const result = previous.then(run, run)
    const tail = result.catch(() => undefined)
    this.queues.set(path, tail)
    void tail.then(() => {
      if (this.queues.get(path) === tail) this.queues.delete(path)
    })
    return result
  }
}

/**
 * Delete one file on an Oven, parking it only when the Oven cannot delete.
 *
 * `remove` is the operation this app wants: the file is gone, so a machine that
 * edits and discards turns collects no leftovers at all. A service bundle older
 * than this app answers "Unsupported workspace operation.", and on that machine
 * the file is moved into a `.trash` directory beside it instead of failing work
 * the Oven can still do. Any other failure (permissions, a directory) belongs to
 * the caller and is rethrown unchanged.
 *
 * Every removal then bounds that `.trash` directory, whichever path it took. The
 * parking path needs it so an old bundle cannot fill the disk, and the deleting
 * path needs it because a machine that could not delete until this version
 * already holds everything it parked.
 */
export async function removeOvenWorkspaceFile(
  request: OvenPiWorkspaceRequest,
  input: { root: string; path: string }
): Promise<OvenPiRemoveOutcome> {
  const { root, path } = input
  const trash = trashDirectoryOf(path)
  let outcome: OvenPiRemoveOutcome = 'deleted'
  try {
    await request({ operation: 'remove', root, path }, `remove ${path}`)
  } catch (error) {
    if (isMissing(error)) return 'missing'
    // Only one answer sends a removal down the compatibility path. A timeout, a
    // dropped channel, or a refused file says nothing about which bundle is
    // running, and parking a file this app meant to delete would hide a failure
    // the person needs to see.
    if (!isUnsupportedWorkspaceOperation(error)) throw error
    outcome = await parkOvenWorkspaceFile(request, { root, path, trash })
    if (outcome === 'missing') return outcome
  }
  await pruneOvenTrash(request, { root, directory: trash }).catch((error: unknown) => {
    // The file is already out of its own path, so a bound that cannot be applied
    // is reported and never fails the removal it followed.
    Logger.dev('Could not bound a parked Oven file directory:', error)
  })
  return outcome
}

/**
 * Move one file into the `.trash` directory beside it.
 *
 * This is the compatibility path: a bundle with no delete can still take a file
 * out of the path pi reads, which is all the caller needs.
 */
async function parkOvenWorkspaceFile(
  request: OvenPiWorkspaceRequest,
  input: { root: string; path: string; trash: string }
): Promise<OvenPiRemoveOutcome> {
  try {
    await request(
      {
        operation: 'move',
        root: input.root,
        path: input.path,
        to: joinOvenPath(input.trash, randomUUID())
      },
      `remove ${input.path}`
    )
    return 'parked'
  } catch (error) {
    if (isMissing(error)) return 'missing'
    throw error
  }
}

/**
 * Keep one `.trash` directory to the newest few entries.
 *
 * The bound is paid for with what the Oven in front of us can do. `remove`
 * deletes an over-cap entry outright, which is what empties a directory an
 * earlier bundle filled. A bundle with no `remove` has no delete at all, so an
 * entry's bytes are released the only other way that bundle allows: an empty
 * file is published over it, which empties the payload while the name stays. A
 * bundle with neither operation (nothing this app has shipped) cannot be
 * bounded; the entries stay as they are and the failure reaches the developer
 * log, because pretending to have cleaned up would be worse than saying so.
 *
 * At most `OVEN_PI_TRASH_KEEP` entries are released per removal, so one discard
 * never costs as much as the whole directory: each removal adds one entry and
 * each prune takes up to eight away, which catches up on any backlog without a
 * burst of requests on the first one.
 */
async function pruneOvenTrash(
  request: OvenPiWorkspaceRequest,
  input: { root: string; directory: string }
): Promise<void> {
  const parked = await listParkedEntries(request, input)
  const overCap = [...parked]
    // A name with no bytes left is already released, so it is never visited again.
    .filter((entry) => entry.kind !== 'directory' && entry.size > 0)
    .sort((first, second) => second.modifiedAt - first.modifiedAt)
    .slice(OVEN_PI_TRASH_KEEP, OVEN_PI_TRASH_KEEP * 2)
  for (const entry of overCap)
    await releaseParkedEntry(request, { root: input.root, path: entry.path })
}

/** Every entry one `.trash` directory holds, across the Oven's list pages. */
async function listParkedEntries(
  request: OvenPiWorkspaceRequest,
  input: { root: string; directory: string }
): Promise<OvenFile[]> {
  const parked: OvenFile[] = []
  let after: string | undefined
  for (;;) {
    let page: OvenWorkspaceResult
    try {
      page = await request(
        {
          operation: 'list',
          root: input.root,
          path: input.directory,
          ...(after ? { after } : {})
        },
        `list ${input.directory}`
      )
    } catch (error) {
      // Nothing has been parked beside this path yet, so there is nothing to bound.
      if (isMissing(error)) return parked
      throw error
    }
    // The Oven reports each entry relative to the request's root, which is the
    // same form `remove` and `replace` take back.
    for (const file of page.files ?? []) parked.push(file)
    if (!page.after) return parked
    after = page.after
  }
}

/** Delete one parked entry, or empty it when the Oven's service cannot delete. */
async function releaseParkedEntry(
  request: OvenPiWorkspaceRequest,
  input: { root: string; path: string }
): Promise<void> {
  try {
    await request(
      { operation: 'remove', root: input.root, path: input.path },
      `remove ${input.path}`
    )
    return
  } catch (error) {
    if (isMissing(error)) return
    if (!isUnsupportedWorkspaceOperation(error)) throw error
  }
  const staged = `${input.path}.${randomUUID()}.empty`
  await request(
    {
      operation: 'write',
      root: input.root,
      path: staged,
      offset: 0,
      data: '',
      exclusive: true,
      mode: FILE_MODE
    },
    `empty ${input.path}`
  )
  await request(
    { operation: 'replace', root: input.root, path: input.path, staged, mode: FILE_MODE },
    `empty ${input.path}`
  )
}

/** The `.trash` directory beside one normalised relative path. */
function trashDirectoryOf(path: string): string {
  const directory = parentOf(path)
  return directory ? `${directory}/${TRASH_DIRECTORY}` : TRASH_DIRECTORY
}

/**
 * An absolute Oven directory in the forward-slash form every Oven path uses.
 *
 * A root that is not absolute would make every handoff path a guess on a machine
 * this app cannot see, so it is refused here rather than at the first write.
 */
function ovenRootPath(value: string): string {
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value))
    throw new Error('The Pi handoff root must be an absolute Oven path.')
  const normalized = value.replace(/\\/gu, '/')
  if (!/^(?:\/|[A-Za-z]:\/)/u.test(normalized))
    throw new Error(`The Pi handoff root must be an absolute Oven path, not "${value}".`)
  return normalized.replace(/\/+$/u, '') || '/'
}

/**
 * A storage-relative handoff path, normalised to forward slashes.
 *
 * The paths arrive from `path.join` on this machine, which is backslash-
 * separated on Windows, while the Oven may run any platform. An absolute path,
 * a drive letter, or a `..` segment is refused rather than repaired: these files
 * belong to one app-owned directory, and a path that leaves it is a bug.
 */
function relativePathOf(value: string): string {
  if (typeof value !== 'string' || !value.length)
    throw new Error('A Pi handoff file needs a relative path.')
  if (/[\0\r\n]/u.test(value))
    throw new Error(`A Pi handoff path cannot contain control characters: ${JSON.stringify(value)}`)
  if (/^(?:[/\\]|[A-Za-z]:)/u.test(value))
    throw new Error(`Refusing an absolute Pi handoff path: ${value}`)
  const segments = value.split(/[\\/]+/u).filter((segment) => segment.length && segment !== '.')
  for (const segment of segments)
    if (segment === '..')
      throw new Error(`Refusing a Pi handoff path that leaves its root: ${value}`)
  if (!segments.length) throw new Error(`Refusing an empty Pi handoff path: ${value}`)
  return segments.join('/')
}

/** One path joined onto another with the Oven's separator, never doubled. */
function joinOvenPath(base: string, path: string): string {
  return base.endsWith('/') ? `${base}${path}` : `${base}/${path}`
}

/** The directory part of a normalised relative path, empty at the root. */
function parentOf(path: string): string {
  return path.split('/').slice(0, -1).join('/')
}

/** Missing paths are answers here (`does this file exist?`), not failures. */
function isMissing(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return true
  return error instanceof Error && /\bENOENT\b/u.test(error.message)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
