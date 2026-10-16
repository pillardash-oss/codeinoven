import { designScreenName, isDesignScreenEntry } from '../../lib/design/screens'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat, rename } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type {
  DesignHistoryFile,
  DesignHistoryRestoreFileResult,
  DesignHistoryState,
  DesignPageHistoryState,
  DesignPageRevision,
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
import {
  DesignHistoryBlobStore,
  designHistoryBlobDirectory,
  destroyDesignHistoryProjectBlobs
} from './design-history-blobs'

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

/**
 * Ceiling on the folders one reconciliation pass examines. A machine with more
 * authored work than this is cleaned in waves across passes rather than in one
 * unbounded sweep that would hold the caller.
 */
const MAX_RECONCILE_FOLDERS = 2_000

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

/** How many files differ between two snapshots, as the paths that changed. */
function changedPathsOf(
  before: Record<string, DesignRevisionFile>,
  after: Record<string, DesignRevisionFile>
): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const path of [...paths].sort()) {
    if (before[path]?.hash !== after[path]?.hash) changed.push(path)
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

  constructor(private readonly database: Database) {
    this.revisions = new DesignRevisionRepo(database)
  }

  /** Keep undo/redo and blob stores attached when a work folder moves. */
  async relocateFolder(
    projectId: string,
    from: string,
    to: string,
    move: () => Promise<void>,
    undo: () => Promise<void>
  ): Promise<void> {
    await this.runExclusive({ projectId, directory: from }, () =>
      this.runExclusive({ projectId, directory: to }, async () => {
        await move()
        const oldBlobs = designHistoryBlobDirectory(projectId, from)
        const newBlobs = designHistoryBlobDirectory(projectId, to)
        const exists = await stat(oldBlobs).catch(() => null)
        let blobsMoved = false
        try {
          if (exists) {
            await rename(oldBlobs, newBlobs)
            blobsMoved = true
          }
          const result = await this.database.transactionViaWorker(
            ['design_revisions', 'design_history_heads', 'design_history_page_heads'].map(
              (table) => ({
                sql: `UPDATE ${table} SET directory = ? WHERE project_id = ? AND directory = ?`,
                params: [to, projectId, from]
              })
            )
          )
          if (!result.ok) {
            throw new Error(result.error ?? 'Could not move work history')
          }
        } catch (error) {
          if (blobsMoved) await rename(newBlobs, oldBlobs)
          await undo()
          throw error
        }
        this.trackers.delete(`${projectId}\u0000${from}`)
        this.trackers.delete(`${projectId}\u0000${to}`)
      })
    )
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
      // A folder that is gone has no history left to stand on: a design deleted by
      // CIO Cleanup or by the user is dropped here, so the database does not keep a
      // timeline for something no longer on disk.
      if (!(await this.isDirectory(target.absolute))) {
        const count = await this.revisions.countViaWorker(target.projectId, target.directory)
        if (count > 0) {
          await this.dropFolder(target.projectId, target.directory)
          return this.readState(target, false)
        }
      }
      const exact = await this.capture(target, cause)
      return this.readState(target, !exact)
    })
  }

  /** Explicit agent step, saved before moving to the next section or scene. */
  async checkpoint(
    target: DesignHistoryTarget,
    entry: string,
    label: string
  ): Promise<DesignHistoryState> {
    if (!isDesignScreenEntry(entry) || !this.resolvePagePath(target, entry))
      throw new Error('Checkpoint requires a screen')
    if (!label.trim() || label.length > 160)
      throw new Error('Checkpoint requires a short step name')
    return this.runExclusive(target, async () => {
      if (await this.isGitBacked(target)) return this.gitBackedState(target)
      const exact = await this.capture(target, 'agent', {
        entry,
        label: label.replace(/\s+/gu, ' ').trim()
      })
      return this.readState(target, !exact)
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
      await this.capture(target, 'user')
      const wanted = await this.revisions.getViaWorker(
        target.projectId,
        target.directory,
        revisionId
      )
      if (!wanted) throw new Error('That point in the history is gone.')
      {
        // The folder has to exist for the tracker to resolve its root, and a folder
        // emptied by an earlier revision is a folder the user may have removed.
        await mkdir(target.absolute, { recursive: true })
        const before = checkpointOf(wanted, target.absolute)
        const after = await this.snapshotOrEmpty(target)
        await this.trackerFor(target).restoreBefore(before, after)
        this.revisions.clearPageCursors(target.projectId, target.directory)
        this.revisions.setCursor(target.projectId, target.directory, wanted.id)
      }
      return this.readState(target, false)
    })
  }

  /**
   * One page's own line through the folder's history.
   *
   * A design is iterated a page at a time, and a whole-folder undo is too blunt
   * when only one page needs to go back. The line is read from the folder's own
   * revisions. A durable page cursor distinguishes repeated content states; the
   * current file hash verifies that cursor against disk, which is what
   * lets a page-scoped undo stay put after the folder cursor is left alone.
   */
  async pageState(target: DesignHistoryTarget, path: string): Promise<DesignPageHistoryState> {
    if (!isDesignScreenEntry(path) || !this.resolvePagePath(target, path))
      throw new Error('History requires a screen')
    return this.runExclusive(target, async () => {
      if (await this.isGitBacked(target))
        return {
          directory: target.directory,
          path,
          gitBacked: true,
          revisions: [],
          cursorIndex: -1,
          modified: false,
          canUndo: false,
          canRedo: false
        }
      if (!(await this.isDirectory(target.absolute))) {
        await this.dropFolder(target.projectId, target.directory)
        return this.readPageState(target, path)
      }
      await this.capture(target, 'user')
      return this.readPageState(target, path)
    })
  }

  /**
   * Move one page to one point in its own history.
   *
   * Undo and Redo for a single page are both this: exactly one file is rewritten to
   * the revision's content, or removed when the revision did not hold it, and every
   * other page stays where it is. The folder's cursor is deliberately not moved, so
   * the whole design's timeline is not mistaken for having stepped; a capture that
   * finds the folder holding a mixture of states the timeline already knows records
   * no new revision and marks the folder modified instead.
   */
  async restoreFile(
    target: DesignHistoryTarget,
    revisionId: string,
    path: string
  ): Promise<DesignHistoryRestoreFileResult> {
    return this.runExclusive(target, async () => {
      if (!isDesignScreenEntry(path) || !this.resolvePagePath(target, path)) {
        throw new Error('That page is not part of this design.')
      }
      if (await this.isGitBacked(target)) {
        return {
          history: this.gitBackedState(target),
          page: {
            directory: target.directory,
            path,
            gitBacked: true,
            revisions: [],
            cursorIndex: -1,
            modified: false,
            canUndo: false,
            canRedo: false
          }
        }
      }
      await this.capture(target, 'user')
      const wanted = await this.revisions.getViaWorker(
        target.projectId,
        target.directory,
        revisionId
      )
      if (!wanted) throw new Error('That point in the history is gone.')
      await mkdir(target.absolute, { recursive: true })
      const before = checkpointOf(wanted, target.absolute)
      const after = await this.snapshotOrEmpty(target)
      await this.trackerFor(target).restoreBefore(before, after, new Set([path]))
      this.revisions.setPageCursor(target.projectId, target.directory, path, wanted.id)
      const exact = await this.capture(target, 'user', undefined, wanted)
      return {
        history: await this.readState(target, !exact),
        page: await this.readPageState(target, path)
      }
    })
  }

  /**
   * Drop the history of folders that no longer exist.
   *
   * A design deleted by CIO Cleanup, by the user, or with its project leaves rows
   * and blobs nothing can reach. Reading the folders the app kept and checking each
   * against the disk is what keeps the database from growing one orphan at a time; a
   * project that is gone takes every folder under it with it. Bounded, so a machine
   * with a lot of authored work is cleaned in waves instead of one long sweep.
   */
  async reconcile(): Promise<void> {
    let afterProject = ''
    let afterDirectory = ''
    const projectCache = new Map<string, { local: boolean; path: string | null }>()
    while (true) {
      const folders = await this.revisions.listFoldersAllViaWorker(
        MAX_RECONCILE_FOLDERS,
        afterProject,
        afterDirectory
      )
      if (folders.length === 0) break
      for (const folder of folders) {
        afterProject = folder.projectId
        afterDirectory = folder.directory
        let project = projectCache.get(folder.projectId)
        if (!project) {
          const result = await this.database.queryViaWorker(
            'SELECT source, path FROM projects WHERE id = ?',
            [folder.projectId],
            1
          )
          if (!result.ok) throw new Error('Design history project lookup failed')
          const record = result.rows[0] as { source: string; path: string | null } | undefined
          project = {
            local: record?.source === 'local' && typeof record.path === 'string',
            path: record?.path ?? null
          }
          projectCache.set(folder.projectId, project)
        }
        if (project.local && project.path) {
          const absolute = resolve(project.path, folder.directory)
          const rel = relative(project.path, absolute)
          const inside = rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`)
          try {
            if (inside && (await this.isDirectory(absolute))) continue
          } catch (error) {
            Logger.dev('Unreadable design history folder left intact:', error)
            continue
          }
        }
        const target = {
          projectId: folder.projectId,
          directory: folder.directory
        }
        await this.runExclusive(target, async () => {
          if (
            project?.local &&
            project.path &&
            (await this.isDirectory(resolve(project.path, folder.directory)))
          )
            return
          await this.dropFolder(folder.projectId, folder.directory)
        })
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  forgetProject(projectId: string): void {
    this.revisions.deleteProject(projectId)
    for (const key of [...this.trackers.keys()]) {
      if (key.startsWith(`${projectId}\u0000`)) this.trackers.delete(key)
    }
    // A project's own folder goes with it; this covers the case where the caller
    // drops the history without removing the config directory.
    void destroyDesignHistoryProjectBlobs(projectId).catch((error) =>
      Logger.dev('Design history project blob collection was skipped:', error)
    )
  }

  forgetFolder(projectId: string, directory: string): void {
    void this.dropFolder(projectId, directory).catch((error) =>
      Logger.dev('Design history cleanup failed:', error)
    )
  }

  /**
   * Capture the folder if it changed, so the timeline includes the present.
   *
   * Answers whether the folder now matches a revision exactly. It does after a
   * restore, an unchanged read, or a fresh edit that became a new revision. It does
   * not when the folder holds a mixture of states the timeline already knows, which
   * is what a page-scoped undo leaves behind: recording that as a new revision would
   * cut away the very states the page is stepping through, so the folder is marked
   * modified and the timeline is left whole.
   */
  private async capture(
    target: DesignHistoryTarget,
    cause: DesignRevisionCause,
    step?: { entry: string; label: string },
    preferredRevision?: StoredDesignRevision
  ): Promise<boolean> {
    let checkpoint: ProjectCheckpoint
    try {
      checkpoint = await this.trackerFor(target).snapshot(target.absolute)
    } catch (error) {
      // A folder that does not exist yet, or cannot be read, has no present to
      // capture: the history it already has is kept rather than erased.
      if (step) throw error
      Logger.dev('A design history capture was skipped:', error)
      return true
    }
    const files = revisionFilesOf(checkpoint)
    if (step && !files[step.entry])
      throw new Error('Checkpoint screen is missing or cannot be captured')
    const digest = digestOfFiles(files)
    // A folder that now matches a revision already in its history is that revision,
    // not a new one: this is what lets a restored folder be read without recording
    // the restore itself as an edit, and a manual redo by hand land on the redo.
    const presentCursor = await this.revisions.cursorIdViaWorker(target.projectId, target.directory)
    const currentRevision =
      preferredRevision?.digest === digest
        ? preferredRevision
        : presentCursor
          ? await this.revisions.getViaWorker(target.projectId, target.directory, presentCursor)
          : null
    // A named sequence can revisit the same content. Keep the explicitly restored
    // cursor rather than jumping to the newest revision with identical bytes.
    const match =
      currentRevision?.digest === digest
        ? currentRevision
        : step
          ? null
          : await this.revisions.findByDigestViaWorker(target.projectId, target.directory, digest)
    if (match && (!step || match.id === presentCursor)) {
      if (step)
        this.revisions.labelCheckpoint(
          target.projectId,
          target.directory,
          match.id,
          step.label,
          step.entry
        )
      const cursorId = await this.revisions.cursorIdViaWorker(target.projectId, target.directory)
      if (cursorId !== match.id)
        this.revisions.setCursor(target.projectId, target.directory, match.id)
      return true
    }
    // Not a whole-folder match, but every file may still be a state the timeline
    // already holds: a page-scoped undo, or a hand edit that reverted a file. Keep
    // the timeline as it is and let the board say the folder is modified.
    if (!step && (await this.isExplainedByTimeline(target, files))) return false
    const count = await this.revisions.countViaWorker(target.projectId, target.directory)
    const cursor =
      currentRevision ??
      (count > 0
        ? await this.revisions.getLatestViaWorker(target.projectId, target.directory)
        : null)
    // A new edit made while the folder sits behind the tip cuts the steps ahead of
    // it away, the way editing after an undo does anywhere else.
    if (cursor) this.revisions.deleteAfter(target.projectId, target.directory, cursor.sequence)
    const changedPaths = cursor ? changedPathsOf(cursor.files, files) : Object.keys(files).sort()
    const revision: StoredDesignRevision = {
      id: randomUUID(),
      projectId: target.projectId,
      directory: target.directory,
      sequence: (cursor?.sequence ?? 0) + 1,
      parentId: cursor?.id ?? null,
      cause,
      label: step?.label,
      checkpointEntry: step?.entry,
      digest,
      files,
      skippedFiles: checkpoint.skippedFiles ?? [],
      unavailableFiles: checkpoint.unavailableFiles ?? [],
      changedFiles: changedPaths.length,
      changedPaths,
      fileCount: Object.keys(files).length,
      totalBytes: Object.values(files).reduce((total, file) => total + file.size, 0),
      createdAt: Date.now()
    }
    this.revisions.clearPageCursors(target.projectId, target.directory)
    this.revisions.insert(revision)
    this.revisions.setCursor(target.projectId, target.directory, revision.id)
    await this.prune(target, revision.id)
    return true
  }

  /**
   * Whether every file state in `files` is one the folder's timeline already holds.
   *
   * Read only when a capture found no whole-folder match, so the cost stands beside
   * the edit that triggered it rather than on every read. An addition with content
   * the timeline never saw is what makes a snapshot genuinely new; a reverted file, a
   * page-scoped undo, or a deleted file that was added and later removed are all
   * described by states the timeline already answers for.
   */
  private async isExplainedByTimeline(
    target: DesignHistoryTarget,
    files: Record<string, DesignRevisionFile>
  ): Promise<boolean> {
    const matches = new Set<string>()
    let presentInAll: Set<string> | null = null
    let found = false
    for await (const revision of this.revisionBatches(target)) {
      found = true
      const paths = new Set(Object.keys(revision.files))
      if (presentInAll === null) presentInAll = paths
      else for (const path of presentInAll) if (!paths.has(path)) presentInAll.delete(path)
      for (const [path, file] of Object.entries(files)) {
        if (revision.files[path]?.hash === file.hash) matches.add(path)
      }
    }
    if (!found || Object.keys(files).some((path) => !matches.has(path))) return false
    for (const path of presentInAll ?? []) if (!files[path]) return false
    return true
  }

  /** Bound the snapshots resident in memory and yield between batches. */
  private async *revisionBatches(
    target: DesignHistoryTarget
  ): AsyncGenerator<StoredDesignRevision> {
    let sequence = 0
    while (true) {
      const revisions = await this.revisions.listViaWorker(
        target.projectId,
        target.directory,
        8,
        sequence
      )
      if (revisions.length === 0) return
      for (const revision of revisions) {
        sequence = revision.sequence
        yield revision
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  /** Remove one folder's rows, caches, and bytes. */
  private async dropFolder(projectId: string, directory: string): Promise<void> {
    await new DesignHistoryBlobStore(projectId, directory).destroy()
    await this.revisions.deleteFolder(projectId, directory)
    this.trackers.delete(`${projectId}\u0000${directory}`)
  }

  /** Whether a path names a directory on disk, treating an unreadable one as gone. */
  private async isDirectory(absolute: string): Promise<boolean> {
    try {
      return (await stat(absolute)).isDirectory()
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      )
        return false
      throw error
    }
  }

  /** Keep a folder's history under its ceiling, and collect the blobs it drops. */
  private async prune(target: DesignHistoryTarget, cursorId: string): Promise<void> {
    const count = await this.revisions.countViaWorker(target.projectId, target.directory)
    const excess = count - MAX_REVISIONS_PER_FOLDER
    if (excess <= 0) return
    this.revisions.pruneOldest(target.projectId, target.directory, excess, cursorId)
    try {
      const referenced = new Set<string>()
      for await (const revision of this.revisionBatches(target)) {
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
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      return { id: 'empty', projectRoot: target.absolute, createdAt: Date.now(), files: {} }
    }
  }

  /** Read a folder's timeline and where it currently sits. */
  private async readState(
    target: DesignHistoryTarget,
    modified: boolean
  ): Promise<DesignHistoryState> {
    const stored = await this.revisions.listSummariesViaWorker(
      target.projectId,
      target.directory,
      MAX_REVISIONS_PER_FOLDER + 1
    )
    const revisions: DesignRevisionSummary[] = stored.map((revision) => ({
      id: revision.id,
      sequence: revision.sequence,
      cause: revision.cause,
      label: revision.label,
      checkpointEntry: revision.checkpointEntry,
      createdAt: revision.createdAt,
      changedFiles: revision.changedFiles,
      changedPaths: revision.changedPaths,
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
      modified,
      files: await this.listFiles(target),
      canUndo: modified || cursorIndex > 0,
      canRedo: cursorIndex >= 0 && cursorIndex < revisions.length - 1
    }
  }

  /** Every file the timeline has touched, for the page scope picker. */
  private async listFiles(target: DesignHistoryTarget): Promise<DesignHistoryFile[]> {
    const counts = new Map<string, number>()
    const seen = new Set<string>()
    let latest: StoredDesignRevision | undefined
    for await (const revision of this.revisionBatches(target)) {
      latest = revision
      for (const path of Object.keys(revision.files)) if (isDesignScreenEntry(path)) seen.add(path)
      for (const path of revision.changedPaths)
        if (isDesignScreenEntry(path)) counts.set(path, (counts.get(path) ?? 0) + 1)
    }
    const present = new Set(latest ? Object.keys(latest.files) : [])
    const paths = new Set<string>([...counts.keys(), ...seen, ...present])
    return [...paths]
      .filter(isDesignScreenEntry)
      .sort()
      .map((path) => ({
        path,
        name: designScreenName(path),
        changeCount: counts.get(path) ?? 0,
        present: present.has(path)
      }))
  }

  /**
   * One page's line, with the page's current on-disk content matched to it.
   *
   * The states are the distinct contents the file held, oldest first. The page's
   * position is derived from what is on disk rather than stored, which is what keeps
   * a page-scoped undo working after the folder cursor is left where the design as a
   * whole sits.
   */
  private async readPageState(
    target: DesignHistoryTarget,
    path: string
  ): Promise<DesignPageHistoryState> {
    const stored = await this.revisions.fileStatesViaWorker(
      target.projectId,
      target.directory,
      path,
      MAX_REVISIONS_PER_FOLDER + 1
    )
    const states: DesignPageRevision[] = []
    const hashes: (string | null)[] = []
    let previous: string | null | undefined
    for (const revision of stored) {
      const hash = revision.hash
      if (previous !== undefined && hash === previous) continue
      states.push({
        revisionId: revision.id,
        sequence: revision.sequence,
        createdAt: revision.createdAt,
        label: revision.checkpointEntry === path ? (revision.label ?? undefined) : undefined,
        present: hash !== null
      })
      hashes.push(hash)
      previous = hash
    }
    const currentHash = await this.hashOfPage(target, path)
    let cursorIndex = -1
    let modified = false
    if (states.length === 0) {
      modified = currentHash !== null
    } else {
      const saved = await this.revisions.pageCursorViaWorker(
        target.projectId,
        target.directory,
        path
      )
      const folderCursor = saved
        ? null
        : await this.revisions.cursorIdViaWorker(target.projectId, target.directory)
      const savedRevision =
        stored.find((revision) => revision.id === (saved ?? folderCursor)) ?? null
      const savedIndex = savedRevision
        ? states.findLastIndex((state) => state.sequence <= savedRevision.sequence)
        : -1
      const index =
        savedIndex >= 0 && hashes[savedIndex] === currentHash
          ? savedIndex
          : hashes.lastIndexOf(currentHash)
      if (index >= 0) {
        cursorIndex = index
      } else {
        // Unknown content: a hand edit the timeline does not hold. The page sits past
        // the tip, so Undo still has the newest known state to return to.
        modified = true
        cursorIndex = states.length
      }
    }
    return {
      directory: target.directory,
      path,
      gitBacked: false,
      revisions: states,
      cursorIndex,
      modified,
      canUndo: cursorIndex > 0,
      canRedo: cursorIndex >= 0 && cursorIndex < states.length - 1
    }
  }

  /** The hash of one page's current content, or null when it is not there to read. */
  private async hashOfPage(target: DesignHistoryTarget, path: string): Promise<string | null> {
    const absolute = this.resolvePagePath(target, path)
    if (!absolute) return null
    try {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(absolute)) hash.update(chunk)
      return hash.digest('hex')
    } catch {
      return null
    }
  }

  /** One page's absolute path, or null when it is not safely inside the folder. */
  private resolvePagePath(target: DesignHistoryTarget, path: string): string | null {
    if (!path || path.includes('\u0000')) return null
    const absolute = resolve(target.absolute, path)
    const rel = relative(target.absolute, absolute)
    if (
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      rel.split(sep).join('/') !== path
    )
      return null
    return absolute
  }

  /** The history of a folder a repository already versions: none, and it says so. */
  private gitBackedState(target: DesignHistoryTarget): DesignHistoryState {
    return {
      directory: target.directory,
      gitBacked: true,
      revisions: [],
      cursorId: null,
      cursorIndex: -1,
      modified: false,
      files: [],
      canUndo: false,
      canRedo: false
    }
  }

  private async isGitBacked(target: DesignHistoryTarget): Promise<boolean> {
    return folderIsGitBacked(target.projectPath, target.directory, target.gitMode)
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
  private runExclusive<T>(
    target: Pick<DesignHistoryTarget, 'projectId' | 'directory'>,
    task: () => Promise<T>
  ): Promise<T> {
    const key = `${target.projectId}\u0000${target.directory}`
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(key, settled)
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    })
    return next
  }
}
