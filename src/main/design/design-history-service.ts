import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type {
  DesignHistoryState,
  DesignRevisionCause,
  DesignRevisionSummary
} from '../../lib/ipc/design'
import type { Database } from '../database/database'
import {
  DesignRevisionRepo,
  type DesignRevisionFile,
  type StoredDesignRevision
} from '../database/repositories/design-revision-repo'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import type { CheckpointFile, ProjectCheckpoint } from '../git/change-tracking-service'
import { ChangeTrackingService } from '../git/change-tracking-service'
import { Logger } from '../system/logger'
import { DesignHistoryBlobStore } from './design-history-blobs'

/**
 * The changes a design or composition has been through, and how the user walks them.
 *
 * A design is iterated, and iteration needs a way back: undo and redo over the whole
 * folder, the way Git gives a project, but with no repository, no commits and no
 * ceremony. This is that, and it reuses the mechanism the app already has for a
 * project Git is not tracking: the content-addressed checkpoint tracker. Every
 * revision is a real snapshot of the folder, so going back is exact even after the
 * revisions around it are pruned, and identical files cost one blob no matter how
 * many revisions hold them.
 *
 * Two facts decide almost everything here. First, the folder is the unit of history:
 * a design and a composition each have their own line, shared by every thread that
 * worked on them. Second, Git wins ties: a folder a repository already tracks is the
 * user's to version, so the app records nothing and the board offers nothing, instead
 * of keeping a second timeline that would disagree with the one they use.
 *
 * Capturing is idempotent by content. A read compares the folder to what the folder
 * is currently checked out at and only writes a revision when something really
 * changed, which is what lets the board read (and the turn settle) as often as it
 * likes without growing the timeline.
 */

/**
 * How many revisions one folder keeps.
 *
 * A design is iterated for a long time, so the ceiling is generous but real: past it
 * the oldest revisions are dropped and their blobs collected, because a history that
 * grows without bound is a disk that fills without warning. The cursor is never
 * dropped, so a folder parked in its own past stays parked.
 */
const MAX_REVISIONS_PER_FOLDER = 200

/** Ceiling on the entries one blob collection pass reads, so it stays bounded. */
const MAX_BLOB_PRUNE_ENTRIES = 5_000

/** How long git is given to answer whether it tracks a folder. */
const GIT_DETECT_TIMEOUT_MS = 4_000

/** One folder of authored work, resolved by the caller into everything history needs. */
export interface DesignHistoryTarget {
  projectId: string
  /** Absolute project root, which is where git is asked about the folder. */
  projectPath: string
  /** Project-relative folder with forward slashes, which is the history's key. */
  directory: string
  /** Absolute folder path on disk. */
  absolute: string
  /** Whether the project tracks changes with Git at all. */
  gitMode: boolean
}

/** Run git once and report its exit code, so `check-ignore`'s 0/1 answer is readable. */
function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolveCommand) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        env: buildProcessEnvironment(),
        timeout: timeoutMs
      },
      (error, stdout) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : -1
          resolveCommand({ code, stdout: stdout ?? '' })
          return
        }
        resolveCommand({ code: 0, stdout: stdout ?? '' })
      }
    )
  })
}

/**
 * Whether a repository already versions this folder.
 *
 * A folder git ignores is the app's to track, which is the common case because the
 * default roots live under `.cio/`, itself ignored. A folder git does not ignore is
 * one the user chose to keep in the repository, so git already gives them the undo
 * they want and a second timeline would only diverge from it. Anything git cannot
 * answer is treated as untracked: the user keeps the history they asked for rather
 * than losing it to a git that could not be reached.
 */
async function folderIsGitBacked(
  projectPath: string,
  directory: string,
  gitMode: boolean
): Promise<boolean> {
  if (!gitMode) return false
  const insideRepository = await runGit(
    ['rev-parse', '--show-toplevel'],
    projectPath,
    GIT_DETECT_TIMEOUT_MS
  )
  if (insideRepository.code !== 0 || insideRepository.stdout.trim() === '') return false
  const ignored = await runGit(
    ['check-ignore', '-q', '--', directory],
    projectPath,
    GIT_DETECT_TIMEOUT_MS
  )
  if (ignored.code === 0) return false
  if (ignored.code === 1) return true
  return false
}

/** A digest of a snapshot's file map, so an unchanged folder matches by value. */
function digestOfFiles(files: Record<string, DesignRevisionFile>): string {
  const hash = createHash('sha256')
  for (const path of Object.keys(files).sort()) {
    const file = files[path]
    hash.update(path)
    hash.update('\u0000')
    hash.update(file?.hash ?? '')
    hash.update('\n')
  }
  return hash.digest('hex')
}

/** How many files differ between two snapshots, counting adds, edits, and deletes. */
function countChanges(
  before: Record<string, DesignRevisionFile>,
  after: Record<string, DesignRevisionFile>
): number {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  let changed = 0
  for (const path of paths) {
    if (before[path]?.hash !== after[path]?.hash) changed += 1
  }
  return changed
}

/** A snapshot's files as the durable shape the app stores, keyed by relative path. */
function revisionFilesOf(checkpoint: ProjectCheckpoint): Record<string, DesignRevisionFile> {
  const files: Record<string, DesignRevisionFile> = {}
  for (const [path, file] of Object.entries(checkpoint.files)) {
    files[path] = { path, hash: file.hash, size: file.size, binary: file.binary }
  }
  return files
}

/** A stored revision as the checkpoint shape the tracker restores from. */
function checkpointOf(revision: StoredDesignRevision, projectRoot: string): ProjectCheckpoint {
  const files: Record<string, CheckpointFile> = {}
  for (const [path, file] of Object.entries(revision.files)) {
    files[path] = { path, hash: file.hash, size: file.size, binary: file.binary }
  }
  return {
    id: revision.id,
    projectRoot,
    createdAt: revision.createdAt,
    files,
    ...(revision.skippedFiles.length > 0 ? { skippedFiles: revision.skippedFiles } : {}),
    ...(revision.unavailableFiles.length > 0 ? { unavailableFiles: revision.unavailableFiles } : {})
  }
}
export class DesignHistoryService {
  private readonly revisions: DesignRevisionRepo
  /** One tracker per folder, because the blob store it writes through is per folder. */
  private readonly trackers = new Map<string, ChangeTrackingService>()
  /** One task at a time per folder, so a capture and a restore cannot interleave. */
  private readonly queues = new Map<string, Promise<unknown>>()
  /** Whether a repository already versions a folder, answered once per folder. */
  private readonly gitBacked = new Map<string, boolean>()

  constructor(database: Database) {
    this.revisions = new DesignRevisionRepo(database)
  }

  /**
   * A folder's history, with the present captured first.
   *
   * Reading is what makes the current state a point to return to, so a change the
   * app has not seen yet becomes a revision before the timeline is answered. The
   * capture is idempotent by content, so reading repeatedly without an edit adds
   * nothing.
   */
  async state(
    target: DesignHistoryTarget,
    cause: DesignRevisionCause
  ): Promise<DesignHistoryState> {
    return this.runExclusive(target, async () => {
      if (await this.isGitBacked(target)) return this.gitBackedState(target)
      await this.capture(target, cause)
      return this.readState(target)
    })
  }

  /**
   * Move a folder to one point in its history.
   *
   * Undo, Redo and clicking a revision are all this: the folder on disk is rewritten
   * to hold exactly the revision's files, and the cursor follows. The content written
   * is what the tracker restores from the blob store, so a file this revision does not
   * hold is removed rather than left behind as a stale copy.
   */
  async restore(target: DesignHistoryTarget, revisionId: string): Promise<DesignHistoryState> {
    return this.runExclusive(target, async () => {
      if (await this.isGitBacked(target)) return this.gitBackedState(target)
      const wanted = await this.revisions.getViaWorker(
        target.projectId,
        target.directory,
        revisionId
      )
      if (!wanted) throw new Error('That point in the history is gone.')
      const cursorId = await this.revisions.cursorIdViaWorker(target.projectId, target.directory)
      const cursor = cursorId
        ? await this.revisions.getViaWorker(target.projectId, target.directory, cursorId)
        : null
      if (cursor?.id !== wanted.id) {
        // The folder has to exist for the tracker to resolve its root, and a folder
        // emptied by an earlier revision is a folder the user may have removed.
        await mkdir(target.absolute, { recursive: true })
        const before = checkpointOf(wanted, target.absolute)
        const after = cursor
          ? checkpointOf(cursor, target.absolute)
          : await this.snapshotOrEmpty(target)
        await this.trackerFor(target).restoreBefore(before, after)
        this.revisions.setCursor(target.projectId, target.directory, wanted.id)
      }
      return this.readState(target)
    })
  }

  forgetProject(projectId: string): void {
    this.revisions.deleteProject(projectId)
    for (const key of [...this.trackers.keys()]) {
      if (key.startsWith(`${projectId}\u0000`)) this.trackers.delete(key)
    }
    for (const key of [...this.gitBacked.keys()]) {
      if (key.startsWith(`${projectId}\u0000`)) this.gitBacked.delete(key)
    }
  }

  forgetFolder(projectId: string, directory: string): void {
    this.revisions.deleteFolder(projectId, directory)
    this.trackers.delete(`${projectId}\u0000${directory}`)
    this.gitBacked.delete(`${projectId}\u0000${directory}`)
  }

  /** Capture the folder if it changed, so the timeline includes the present. */
  private async capture(target: DesignHistoryTarget, cause: DesignRevisionCause): Promise<void> {
    let checkpoint: ProjectCheckpoint
    try {
      checkpoint = await this.trackerFor(target).snapshot(target.absolute)
    } catch (error) {
      // A folder that does not exist yet, or cannot be read, has no present to
      // capture: the history it already has is kept rather than erased.
      Logger.dev('A design history capture was skipped:', error)
      return
    }
    const files = revisionFilesOf(checkpoint)
    const digest = digestOfFiles(files)
    // A folder that now matches a revision already in its history is that revision,
    // not a new one: this is what lets a restored folder be read without recording
    // the restore itself as an edit, and a manual redo by hand land on the redo.
    const match = await this.revisions.findByDigestViaWorker(
      target.projectId,
      target.directory,
      digest
    )
    if (match) {
      const cursorId = await this.revisions.cursorIdViaWorker(target.projectId, target.directory)
      if (cursorId !== match.id)
        this.revisions.setCursor(target.projectId, target.directory, match.id)
      return
    }
    const count = await this.revisions.countViaWorker(target.projectId, target.directory)
    const cursorId = await this.revisions.cursorIdViaWorker(target.projectId, target.directory)
    const cursor = cursorId
      ? await this.revisions.getViaWorker(target.projectId, target.directory, cursorId)
      : count > 0
        ? await this.revisions.getLatestViaWorker(target.projectId, target.directory)
        : null
    // A new edit made while the folder sits behind the tip cuts the steps ahead of
    // it away, the way editing after an undo does anywhere else.
    if (cursor) this.revisions.deleteAfter(target.projectId, target.directory, cursor.sequence)
    const revision: StoredDesignRevision = {
      id: randomUUID(),
      projectId: target.projectId,
      directory: target.directory,
      sequence: (cursor?.sequence ?? 0) + 1,
      parentId: cursor?.id ?? null,
      cause,
      digest,
      files,
      skippedFiles: checkpoint.skippedFiles ?? [],
      unavailableFiles: checkpoint.unavailableFiles ?? [],
      changedFiles: cursor ? countChanges(cursor.files, files) : Object.keys(files).length,
      fileCount: Object.keys(files).length,
      totalBytes: Object.values(files).reduce((total, file) => total + file.size, 0),
      createdAt: Date.now()
    }
    this.revisions.insert(revision)
    this.revisions.setCursor(target.projectId, target.directory, revision.id)
    await this.prune(target, revision.id)
  }

  /** Keep a folder's history under its ceiling, and collect the blobs it drops. */
  private async prune(target: DesignHistoryTarget, cursorId: string): Promise<void> {
    const count = await this.revisions.countViaWorker(target.projectId, target.directory)
    const excess = count - MAX_REVISIONS_PER_FOLDER
    if (excess <= 0) return
    this.revisions.pruneOldest(target.projectId, target.directory, excess, cursorId)
    try {
      const kept = await this.revisions.listViaWorker(
        target.projectId,
        target.directory,
        MAX_REVISIONS_PER_FOLDER + 1
      )
      const referenced = new Set<string>()
      for (const revision of kept) {
        for (const file of Object.values(revision.files)) referenced.add(file.hash)
      }
      await new DesignHistoryBlobStore(target.projectId, target.directory).prune(
        referenced,
        MAX_BLOB_PRUNE_ENTRIES
      )
    } catch (error) {
      // Collection is housekeeping; a failure to collect must never fail the edit
      // that triggered it.
      Logger.dev('Design history blob collection was skipped:', error)
    }
  }

  /** The folder as it is now, or an empty snapshot when there is nothing to read. */
  private async snapshotOrEmpty(target: DesignHistoryTarget): Promise<ProjectCheckpoint> {
    try {
      return await this.trackerFor(target).snapshot(target.absolute)
    } catch {
      return { id: 'empty', projectRoot: target.absolute, createdAt: Date.now(), files: {} }
    }
  }

  /** Read a folder's timeline and where it currently sits. */
  private async readState(target: DesignHistoryTarget): Promise<DesignHistoryState> {
    const stored = await this.revisions.listSummariesViaWorker(
      target.projectId,
      target.directory,
      MAX_REVISIONS_PER_FOLDER + 1
    )
    const revisions: DesignRevisionSummary[] = stored.map((revision) => ({
      id: revision.id,
      sequence: revision.sequence,
      cause: revision.cause,
      createdAt: revision.createdAt,
      changedFiles: revision.changedFiles,
      fileCount: revision.fileCount,
      totalBytes: revision.totalBytes
    }))
    const cursorId = await this.revisions.cursorIdViaWorker(target.projectId, target.directory)
    const cursorIndex = cursorId === null ? -1 : revisions.findIndex((item) => item.id === cursorId)
    return {
      directory: target.directory,
      gitBacked: false,
      revisions,
      cursorId,
      cursorIndex,
      canUndo: cursorIndex > 0,
      canRedo: cursorIndex >= 0 && cursorIndex < revisions.length - 1
    }
  }

  /** The history of a folder a repository already versions: none, and it says so. */
  private gitBackedState(target: DesignHistoryTarget): DesignHistoryState {
    return {
      directory: target.directory,
      gitBacked: true,
      revisions: [],
      cursorId: null,
      cursorIndex: -1,
      canUndo: false,
      canRedo: false
    }
  }

  private async isGitBacked(target: DesignHistoryTarget): Promise<boolean> {
    const key = `${target.projectId}\u0000${target.directory}`
    const cached = this.gitBacked.get(key)
    if (cached !== undefined) return cached
    const answer = await folderIsGitBacked(target.projectPath, target.directory, target.gitMode)
    this.gitBacked.set(key, answer)
    return answer
  }

  private trackerFor(target: DesignHistoryTarget): ChangeTrackingService {
    const key = `${target.projectId}\u0000${target.directory}`
    let tracker = this.trackers.get(key)
    if (!tracker) {
      tracker = new ChangeTrackingService(
        new DesignHistoryBlobStore(target.projectId, target.directory)
      )
      this.trackers.set(key, tracker)
    }
    return tracker
  }

  /** Run one task at a time per folder, so a capture and a restore cannot interleave. */
  private runExclusive<T>(target: DesignHistoryTarget, task: () => Promise<T>): Promise<T> {
    const key = `${target.projectId}\u0000${target.directory}`
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(
      key,
      next.catch(() => undefined)
    )
    return next
  }
}
