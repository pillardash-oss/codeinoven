import {
  WorkFolderRegistry,
  listConversationWorkFolders,
  withWorkRegistryLock
} from './work-folder-registry'
import { updateWorkDetails } from './work-details-service'
import { rename } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { DESIGN_EXPORT_FORMATS } from '../../lib/design/design-export'
import { DESIGN_REVIEW_RUBRIC } from '../../lib/design/design-review'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { DEFAULT_WORK_ROOTS, workRootForKind } from '../../lib/design/work-roots'
import type {
  AuthoredWorkKind,
  DesignEntry,
  DesignCheckpointResult,
  DesignHistoryRestoreFileResult,
  DesignHistoryState,
  DesignOpenResult,
  DesignPageHistoryState,
  DesignRevisionCause,
  DesignScreen,
  DesignScreenShot,
  DesignThumbnail,
  ProjectWorkState,
  ScreenCanvasState,
  ThreadDesignCurrent,
  ThreadDesignState,
  UpdateWorkDetails
} from '../../lib/ipc/design'
import { originOf } from '../../lib/local-development-url'
import { authoredWorkRoot, type AuthoredWorkRoot } from './authored-work-root'
import type { BrowserService } from '../browser/browser-service'
import { NO_TAB_MARK, type BrowserTabMark } from '../browser/browser-service/browser-tab-mark'
import type { Database } from '../database/database'
import { DesignRepo } from '../database/repositories/design-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import { resolveServedFolder } from '../preview/served-folder'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { Logger } from '../system/logger'
import { openVideoPreview } from '../video/video-preview-session'
import { readCompositionManifest } from '../video/video-manifest'
import { listProjectWorkFolders } from './design-listing'
import { listDesignScreens } from './design-screens'
import { readScreenCanvasState, readScreenCanvas, screenCanvasScreen } from './screen-canvas-page'
import { DesignHistoryService, type DesignHistoryTarget } from './design-history-service'
import { openDesignPreview } from './design-preview-session'
import {
  currentWorkRoot,
  currentWorkRoots,
  projectWorkRootPaths,
  forgetProjectWorkRoots
} from './work-roots-state'

/**
 * What the app knows about a thread's authored work, and how the user gets back to it.
 *
 * Two sessions have the same shape, and this is the single service behind their
 * board: a design session (`@cio-design`, written into `.cio/designs/<name>/`) and
 * a video session (`@cio-video`, written into `.cio/videos/<name>/`). Three facts
 * have to survive a restart for a coordinator to be useful:
 *
 *   - that the thread is in a session (the kind persisted on the thread row the
 *     moment the session opens, so no message scan stands behind a row marker);
 *   - which folder the thread is working in (the `thread_designs` row, written on
 *     every preview by either capability);
 *   - what folders of that kind exist at all (a listing of the session's root).
 *
 * The first is derived, the second is remembered, the third is read from disk.
 * Nothing here decides anything about the work itself, and nothing is duplicated
 * per kind: the kind is a field, not a second service.
 */

/** Ceiling on the thumbnail width a caller may ask for. */
const MIN_THUMBNAIL_WIDTH = 160
const MAX_THUMBNAIL_WIDTH = 1_200

/**
 * Most screen pictures kept between sweeps.
 *
 * A sweep renders every screen of one design, and a picture is worth keeping only
 * while the screen is unchanged, so the cache is keyed by each file's own stamp.
 * The ceiling is what stops a long session across many designs from holding every
 * picture it ever took: past it the least recently used ones are dropped and
 * captured again if they are still on screen.
 */
const MAX_CACHED_SCREEN_SHOTS = 48

/**
 * Wall-clock budget for one sweep of a design's screens.
 *
 * Each screen is a real page load, so a design with many screens, or one page
 * that never finishes, must not hold the caller until every screen has had its
 * turn: past the budget the remaining screens are reported without a picture and
 * the next sweep (or the refresh button) picks them up, because the ones already
 * captured are answered from the cache.
 */
const SCREEN_SWEEP_BUDGET_MS = 25_000

/** How long one screen is given to finish loading before it is pictured as it is. */
const SCREEN_LOAD_TIMEOUT_MS = 5_000

/**
 * The second a composition's board picture is taken at.
 *
 * The opening, because it is always a valid second for any composition: a later one
 * would need the manifest read first and could sit past a composition shorter than
 * it, turning a picture into a failure.
 */
const POSTER_SECONDS = 0

/** Identifier validation for the two ids every call carries. */
function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

/**
 * The kind a caller may force, or undefined to let the thread decide.
 *
 * A value that is neither kind is treated as absent rather than throwing: the
 * argument is the project board's own override, and a board without it is the
 * ordinary thread-scoped board.
 */
function optionalKind(value: unknown): AuthoredWorkKind | undefined {
  return value === 'design' || value === 'video' ? value : undefined
}

/**
 * Validation for a file path inside an authored-work folder.
 *
 * Longer than an id because a nested page is a real path, and NUL-free because the
 * filesystem layer must never see one. Containment is checked where the path is
 * resolved against the folder, not here.
 */
function requirePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw new TypeError('Page path is invalid')
  }
  if (value.includes('\u0000')) throw new TypeError('Page path is invalid')
  return value
}

/**
 * A screen the app has no picture of, reported by name rather than left out.
 *
 * A design gains a screen the moment its file is written, and the file exists
 * before the app has rendered it: dropping the screen would make the design look
 * smaller than it is, and the next sweep, or the refresh button, fills the
 * picture in.
 */
function emptyScreenShot(screen: DesignScreen): DesignScreenShot {
  return {
    entry: screen.entry,
    name: screen.name,
    dataUrl: null,
    width: 0,
    height: 0,
    updatedAt: screen.updatedAt
  }
}

/**
 * What makes one picture of a screen the picture of that screen.
 *
 * The project and folder say which design it belongs to, the entry says which
 * screen, the stamp says which version of the file was rendered, and the width
 * says at what size: change any of them and the earlier picture is a picture of
 * something else.
 */
function screenShotKey(
  projectId: string,
  directory: string,
  screen: DesignScreen,
  width: number
): string {
  return `${projectId}|${directory}|${screen.entry}|${screen.updatedAt}|${width}`
}

export interface DesignServiceOptions {
  database: Database
  onHistoryChanged?: (projectId: string, directory: string) => void
  onWorkRelocated?: (projectId: string, moves: Array<{ from: string; to: string }>) => void
  /**
   * Mirror a thread's authored-work kinds to live UI the moment they are recorded.
   *
   * The row is what the sidebar draws its markers from, and the agent can open a
   * design or video session on its own (a preview into a work root) with no tag,
   * so this write has to reach the renderer just like the tag path's does. The set
   * is what the markers draw, because a thread that designed something and later
   * cut a video about it has done both.
   */
  onThreadKindChanged?: (
    projectId: string,
    threadId: string,
    kind: AuthoredWorkKind,
    kinds: readonly AuthoredWorkKind[]
  ) => void
  previews: DirectoryPreviewService
  browser: () => BrowserService | null
}

/** What both serve-and-show paths report, once the kind has chosen which one runs. */
interface ServedWork {
  /** Project-relative folder, with forward slashes. */
  directory: string
  /** Entry file shown, or null for the folder listing. */
  entry: string | null
  /** The loopback URL the tab is showing. */
  url: string
  tabId: string | null
}

export class DesignService {
  private readonly designs: DesignRepo
  private readonly threads: ThreadRepo
  /** The change history behind the board's Undo and Redo, one line per folder. */
  private readonly history: DesignHistoryService
  /** Canonical spelling of a project's path per stored spelling, filled on first use. */
  private readonly canonicalProjects = new Map<string, string>()
  /** Picture per screen, keyed by project, folder, entry, the file's stamp and width. */
  private readonly screenShots = new Map<string, DesignScreenShot>()
  /** The sweep in flight per thread, so starting another one supersedes the first. */
  private readonly screenSweeps = new Map<string, number>()

  constructor(private readonly options: DesignServiceOptions) {
    this.designs = new DesignRepo(options.database)
    this.threads = new ThreadRepo(options.database)
    this.history = new DesignHistoryService(options.database)
  }

  registerIpc(): void {
    ipcMain.handle('design:rankings', async (_event, startAt, endAt) => {
      if (
        typeof startAt !== 'number' ||
        typeof endAt !== 'number' ||
        !Number.isFinite(startAt) ||
        !Number.isFinite(endAt) ||
        startAt < 0 ||
        endAt <= startAt
      )
        throw new Error('Invalid design ranking date range')
      if (!this.options.database.hasMaintenanceWorker())
        throw new Error(
          'Design rankings are temporarily unavailable while the database worker is offline'
        )
      const result = await this.options.database.queryViaWorker(
        `SELECT harness, provider, model, COUNT(*) AS samples, ROUND(AVG(score),2) AS score FROM design_reviews WHERE rubric = ? AND created_at >= ? AND created_at < ? GROUP BY rubric,harness,provider,model ORDER BY score DESC,samples DESC LIMIT 50`,
        [DESIGN_REVIEW_RUBRIC, startAt, endAt],
        50,
        { allowPrimaryFallback: false }
      )
      if (!result.ok) throw new Error(result.error ?? 'Could not read design rankings')
      return result.rows
    })
    ipcMain.handle(
      'design:export',
      async (_event, rawProjectId, rawThreadId, directory, entry, format) => {
        if (!DESIGN_EXPORT_FORMATS.some((value) => value === format))
          throw new Error('Unsupported design export format')
        const projectId = requireId(rawProjectId, 'project id')
        const scope = await authoredWorkRoot(
          this.options.database,
          projectId,
          requireId(rawThreadId, 'thread id')
        )
        const { exportDesign } = await import('./design-export-service')
        return exportDesign(
          scope.path,
          directory,
          entry,
          format,
          this.options.previews,
          currentWorkRoot('design', projectId)
        )
      }
    )
    ipcMain.handle('design:state', async (_event, rawProjectId, rawThreadId) =>
      this.stateFor(requireId(rawProjectId, 'project id'), requireId(rawThreadId, 'thread id'))
    )
    // Every folder of authored work one scope holds, by kind. Asked by the right
    // rail before any thread is chosen, so a project's designs and videos are
    // reachable whether or not a session is open, and asked with a thread for a
    // conversation container, whose workspace is the scope.
    ipcMain.handle('design:projectWork', async (_event, rawProjectId, rawThreadId) =>
      this.projectWork(
        requireId(rawProjectId, 'project id'),
        rawThreadId === undefined || rawThreadId === null
          ? undefined
          : requireId(rawThreadId, 'thread id')
      )
    )
    ipcMain.handle(
      'design:open',
      async (_event, rawProjectId, rawThreadId, rawDirectory, rawEntry, rawReveal, rawKind) =>
        this.open(
          requireId(rawProjectId, 'project id'),
          requireId(rawThreadId, 'thread id'),
          rawDirectory,
          rawEntry,
          rawReveal === true,
          optionalKind(rawKind)
        )
    )
    ipcMain.handle(
      'design:thumbnail',
      async (_event, rawProjectId, rawThreadId, rawDirectory, rawEntry, rawWidth, rawKind) =>
        this.thumbnail(
          requireId(rawProjectId, 'project id'),
          requireId(rawThreadId, 'thread id'),
          rawDirectory,
          rawEntry,
          typeof rawWidth === 'number' ? rawWidth : 480,
          optionalKind(rawKind)
        )
    )
    ipcMain.handle(
      'design:screens',
      async (_event, rawProjectId, rawThreadId, rawDirectory, rawWidth, rawForce) =>
        this.screens(
          requireId(rawProjectId, 'project id'),
          requireId(rawThreadId, 'thread id'),
          rawDirectory,
          typeof rawWidth === 'number' ? rawWidth : 480,
          rawForce === true
        )
    )
    ipcMain.handle('design:canvas', async (_event, rawProjectId, rawThreadId, rawDirectory) =>
      this.screenCanvas(
        requireId(rawProjectId, 'project id'),
        requireId(rawThreadId, 'thread id'),
        rawDirectory
      )
    )
    // The folder this project's designs and videos are written into. Read rather
    // than pushed, because the board that changed one asks immediately after the
    // save so it can name the folder the next design will land in.
    ipcMain.handle('design:workRoots', async (_event, projectId?: string) =>
      currentWorkRoots(projectId)
    )
    ipcMain.handle(
      'design:removeMissing',
      async (_event, rawProjectId, rawThreadId, rawDirectory) => {
        const projectId = requireId(rawProjectId, 'project id')
        const directory = requirePath(rawDirectory)
        const scope = await authoredWorkRoot(
          this.options.database,
          projectId,
          requireId(rawThreadId, 'thread id')
        )
        // Only the registry can remember a folder that is no longer on disk, and
        // a conversation workspace is never in it.
        if (scope.appOwned) return
        await new WorkFolderRegistry(this.options.database).removeMissing(
          projectId,
          scope.path,
          directory
        )
      }
    )
    ipcMain.handle(
      'design:updateDetails',
      async (_event, rawProjectId, rawThreadId, details: UpdateWorkDetails) => {
        const projectId = requireId(rawProjectId, 'project id')
        const threadId = requireId(rawThreadId, 'thread id')
        const scope = await authoredWorkRoot(this.options.database, projectId, threadId)
        return updateWorkDetails({
          database: this.options.database,
          projectId,
          projectPath: scope.path,
          details,
          // A project's save root is one stored setting for every design in it. A
          // conversation workspace has no such setting: its root is the workspace
          // it runs in, and every assistant task shares one project id, so writing
          // it would repoint every other assistant's designs at once.
          projectScope: !scope.appOwned,
          onRelocated: (moves) => this.options.onWorkRelocated?.(projectId, moves),
          list: async () => (await this.projectWork(projectId, threadId))[details.kind],
          relocate: async (from, to) => {
            await this.history.relocateFolder(
              projectId,
              from,
              to,
              () => rename(resolve(scope.path, from), resolve(scope.path, to)),
              () => rename(resolve(scope.path, to), resolve(scope.path, from))
            )
            try {
              await this.options.previews.relocate(
                resolve(scope.path, from),
                resolve(scope.path, to)
              )
            } catch (error) {
              await this.history.relocateFolder(
                projectId,
                to,
                from,
                () => rename(resolve(scope.path, to), resolve(scope.path, from)),
                () => rename(resolve(scope.path, from), resolve(scope.path, to))
              )
              throw error
            }
            this.options
              .browser()
              ?.relocateWorkFolder(
                projectId,
                from,
                to,
                scope.appOwned ? scope.assistantId : undefined
              )
            this.screenShots.clear()
          }
        })
      }
    )
    // The history behind Undo and Redo. Reading captures the present first, so a
    // change the app has not seen yet becomes a point the user can return to; the
    // restore is what Undo, Redo and clicking a revision all run.
    ipcMain.handle(
      'design:history',
      async (_event, rawProjectId, rawThreadId, rawDirectory, rawCause) =>
        this.historyState(
          requireId(rawProjectId, 'project id'),
          requireId(rawThreadId, 'thread id'),
          rawDirectory,
          rawCause === 'agent' || rawCause === 'initial' ? rawCause : 'user'
        )
    )
    ipcMain.handle(
      'design:historyRestore',
      async (_event, rawProjectId, rawThreadId, rawDirectory, rawRevisionId) =>
        this.historyRestore(
          requireId(rawProjectId, 'project id'),
          requireId(rawThreadId, 'thread id'),
          rawDirectory,
          requireId(rawRevisionId, 'revision id')
        )
    )
    // The page-scoped history: one file's own line, and moving that one file to a
    // point on it. The whole-folder cursor is not involved, so a page can be taken
    // back without disturbing the rest of the design.
    ipcMain.handle(
      'design:historyPage',
      async (_event, rawProjectId, rawThreadId, rawDirectory, rawPath) =>
        this.historyPage(
          requireId(rawProjectId, 'project id'),
          requireId(rawThreadId, 'thread id'),
          rawDirectory,
          requirePath(rawPath)
        )
    )
    ipcMain.handle(
      'design:historyRestoreFile',
      async (_event, rawProjectId, rawThreadId, rawDirectory, rawPath, rawRevisionId) =>
        this.historyRestoreFile(
          requireId(rawProjectId, 'project id'),
          requireId(rawThreadId, 'thread id'),
          rawDirectory,
          requirePath(rawPath),
          requireId(rawRevisionId, 'revision id')
        )
    )
  }

  /**
   * The history of the folder a directory argument names.
   *
   * The folder is resolved the same way every other design call resolves one, so a
   * history answer always belongs to a folder the app would also serve and capture.
   */
  async historyState(
    projectId: string,
    threadId: string,
    directory: unknown,
    cause: DesignRevisionCause
  ): Promise<DesignHistoryState> {
    return withWorkRegistryLock(projectId, async () => {
      const target = await this.historyTarget(projectId, threadId, directory)
      return this.history.state(target, cause)
    })
  }

  /** Move a folder to one point in its history, which is what Undo and Redo do. */
  async historyRestore(
    projectId: string,
    threadId: string,
    directory: unknown,
    revisionId: string
  ): Promise<DesignHistoryState> {
    return withWorkRegistryLock(projectId, async () => {
      const target = await this.historyTarget(projectId, threadId, directory)
      const result = await this.history.restore(target, revisionId)
      this.options.onHistoryChanged?.(projectId, target.directory)
      return result
    })
  }

  /** Agent checkpointing uses the same durable timeline as the board. */
  async checkpoint(
    projectId: string,
    threadId: string,
    input: Record<string, unknown>,
    kind: AuthoredWorkKind
  ): Promise<DesignCheckpointResult> {
    const entry = requirePath(input['entry'])
    const label = requireId(input['label'], 'checkpoint label')
    const directory = requirePath(input['directory'])
    return withWorkRegistryLock(projectId, async () => {
      const target = await this.historyTarget(projectId, threadId, directory)
      const state = await this.history.checkpoint(target, entry, label)
      this.recordPreview({ projectId, threadId, directory: target.directory, entry, kind })
      this.options.onHistoryChanged?.(projectId, target.directory)
      return {
        directory: target.directory,
        entry,
        label,
        revisionId: state.cursorId,
        checkpointed: !state.gitBacked,
        gitBacked: state.gitBacked
      }
    })
  }

  /** One page's own line through a folder's history. */
  async historyPage(
    projectId: string,
    threadId: string,
    directory: unknown,
    path: string
  ): Promise<DesignPageHistoryState> {
    return withWorkRegistryLock(projectId, async () => {
      const target = await this.historyTarget(projectId, threadId, directory)
      return this.history.pageState(target, path)
    })
  }

  /** Move one page to one point in its own history. */
  async historyRestoreFile(
    projectId: string,
    threadId: string,
    directory: unknown,
    path: string,
    revisionId: string
  ): Promise<DesignHistoryRestoreFileResult> {
    return withWorkRegistryLock(projectId, async () => {
      const target = await this.historyTarget(projectId, threadId, directory)
      const result = await this.history.restoreFile(target, revisionId, path)
      this.options.onHistoryChanged?.(projectId, target.directory)
      return result
    })
  }

  /**
   * Drop the history of authored-work folders that are no longer on disk.
   *
   * Called after a CIO Cleanup run and once at boot, so a design the sweep or the
   * user removed does not leave its timeline and bytes behind in the database.
   * Best-effort: a reconciliation that cannot read a project must not fail the
   * caller that triggered it.
   */
  async reconcileHistory(): Promise<void> {
    try {
      await this.history.reconcile()
    } catch (error) {
      Logger.dev('Design history reconciliation was skipped:', error)
    }
  }

  /** One history request resolved against the project and the thread's session kind. */
  private async historyTarget(
    projectId: string,
    threadId: string,
    directory: unknown
  ): Promise<DesignHistoryTarget> {
    const scope = await authoredWorkRoot(this.options.database, projectId, threadId)
    const kind = await this.resolveKind(threadId)
    const requested = resolveServedFolder(scope.path, directory, currentWorkRoot(kind, projectId))
    // A relocated folder is a project's own record: it exists so a project keeps
    // finding work the user moved inside its checkout. A conversation workspace
    // lists what is on disk, so there is no record to follow.
    const relocated = scope.appOwned
      ? undefined
      : await this.options.database.queryViaWorker(
          'SELECT destination FROM work_folder_relocations WHERE project_id = ? AND directory = ?',
          [projectId, requested.display],
          1
        )
    if (relocated && !relocated.ok) throw new Error('Could not resolve the current work folder')
    const destination = relocated?.rows[0] as { destination: string } | undefined
    const folder = destination
      ? resolveServedFolder(scope.path, destination.destination, currentWorkRoot(kind, projectId))
      : requested
    return {
      projectId,
      projectPath: scope.path,
      directory: folder.display,
      absolute: folder.absolute,
      // Only a project whose change tracking is Git can have the folder tracked by
      // a repository; a manual-tracking project, and a conversation's own
      // workspace, are the app's to version, always.
      gitMode: scope.gitMode
    }
  }

  /** Forget a thread's authored-work record when the thread itself is gone. */
  forgetThread(threadId: string): void {
    this.designs.deleteThread(threadId)
    // Dropping the generation is what stops a sweep still in flight for this
    // thread: its next screen finds a generation that is no longer its own.
    this.screenSweeps.delete(threadId)
  }

  /**
   * Remember the folder a preview showed, and which kind of work it holds.
   *
   * Both capabilities call this after every preview, so the agent's choice of
   * folder is what a restarted app restores. The kind is written with the folder
   * instead of being recovered from it later, so the row keeps saying the thread
   * did design or video work even when the folder is gone. A thread works on one
   * folder at a time, so a later preview re-points the row instead of adding a
   * second one.
   */
  recordPreview(input: {
    projectId: string
    threadId: string
    directory: string
    entry: string | null
    kind: AuthoredWorkKind
  }): void {
    this.designs.upsert(input)
    // The capability previews inside a session the tag already opened, but the
    // mirror is unconditional so the row's marker never depends on which of the
    // two writers happened to run first. Fire-and-forget: the folder record above
    // is the fact this method exists to persist.
    void this.rememberThreadKind(input.projectId, input.threadId, input.kind)
  }

  /**
   * What a tab is showing, recognised from the URL it is on rather than from who
   * opened it.
   *
   * The browser calls this on every committed navigation. An authored-work folder
   * is served on its own loopback origin, so the URL is enough to answer the
   * question the tab's marks ask: which folder is this page showing. Recognising it
   * this way covers the cases a record of the last preview cannot: a tab the agent
   * opened itself, a tab the renderer restored after a restart, and a page a
   * navigation inside the folder moved to.
   *
   * The two marks differ by what they arm. A design folder arms the element
   * inspector, because picking an element out of it is how a change is described. A
   * composition arms the playback transport instead, and carries the timeline its
   * manifest declares, because a page that moves is watched rather than picked
   * apart.
   *
   * Nothing here is written to the thread. Which folder a page shows is a fact about
   * the page, and a page can be showing a folder for reasons that are not this
   * thread's work at all: the user opening a design from the file explorer, the
   * preview server reloading a tab because the folder changed on disk, or a tab
   * restored onto wherever it was left. Recording authorship from a look is what put
   * a design or video marker on threads that never designed or composed anything, and
   * it also made those threads keep the session's contract forever, because the row
   * is what every later turn reads. Authorship is written where a session starts:
   * the tag at turn start, the capability's own preview and checkpoint, and the
   * board's own open of a thread's work.
   */
  async observeShownFolder(
    projectId: string,
    threadId: string,
    url: string
  ): Promise<BrowserTabMark> {
    const origin = originOf(url)
    if (origin === null) return NO_TAB_MARK
    const root = this.options.previews.rootForOrigin(origin)
    if (root === null) return NO_TAB_MARK
    const observedDirectory = this.projectRelativeFolder(
      (await authoredWorkRoot(this.options.database, projectId, threadId)).path,
      root
    )
    if (observedDirectory === null) return NO_TAB_MARK
    const kind =
      (await new WorkFolderRegistry(this.options.database).kindFor(projectId, observedDirectory)) ??
      (['design', 'video'] as const).find((kind) =>
        projectWorkRootPaths(projectId, kind).some(
          (root) => observedDirectory === root || observedDirectory.startsWith(`${root}/`)
        )
      ) ??
      null
    if (kind === null) return NO_TAB_MARK
    const directory = this.designs.resolveDirectory(projectId, observedDirectory)
    if (kind === 'design') return { design: { directory, origin }, composition: null }
    // A composition with no readable manifest has no timeline, so there is nothing
    // to play: it is shown as an ordinary page rather than driven by a guess.
    const manifest = await readCompositionManifest(
      this.options.previews.rootForOrigin(origin) ?? root
    )
    if (!manifest) return NO_TAB_MARK
    return {
      design: null,
      composition: {
        directory,
        origin,
        duration: manifest.duration,
        fps: manifest.fps,
        width: manifest.width,
        height: manifest.height
      }
    }
  }

  /**
   * A thread's persisted authored-work kind, or null when it is in no session.
   *
   * Read from the thread row, which is written the moment the thread enters a
   * session (the tag at turn start, a preview into a work root). Nothing scans
   * messages: the fact is stored when it happens and read back by id.
   */
  async authoredWorkKindFor(threadId: string): Promise<AuthoredWorkKind | null> {
    return (await this.threads.getViaWorker(threadId))?.authoredWorkKind ?? null
  }

  /**
   * Mirror a recorded work kind onto the thread row.
   *
   * The row is what the sidebar draws its markers from, and what the expert card
   * and media generation read the session from, so the folder record alone is not
   * enough. The write adds the kind to the thread's durable set as well as naming
   * the session it is in now, and the set is what comes back to be announced.
   * Best-effort: the folder record has already landed, and a failed mirror must
   * not fail the preview that triggered it. The repository guards the write, so a
   * navigation that records a kind the thread already holds churns nothing.
   */
  private async rememberThreadKind(
    projectId: string,
    threadId: string,
    kind: AuthoredWorkKind
  ): Promise<void> {
    let kinds: readonly AuthoredWorkKind[]
    try {
      kinds = (await this.threads.setAuthoredWorkKindViaWorker(threadId, kind)) ?? [kind]
    } catch (error) {
      Logger.dev('Authored-work kind row update failed:', error)
      return
    }
    // The persisted value is the fact; telling the renderer is what makes the
    // row's marker appear without a refresh, so the agent opening a session on
    // its own reads the same as the user typing the tag.
    this.options.onThreadKindChanged?.(projectId, threadId, kind, kinds)
  }

  forgetProject(projectId: string): void {
    forgetProjectWorkRoots(this.options.database, projectId)
    this.designs.deleteProject(projectId)
    this.history.forgetProject(projectId)
    for (const key of [...this.screenShots.keys()]) {
      if (key.startsWith(`${projectId}|`)) this.screenShots.delete(key)
    }
  }

  /**
   * Everything a coordinator renders for one thread.
   *
   * `active` is true when the thread has ever opened a session, whether or not it
   * has previewed anything yet: the user typed the tag, so the work exists even
   * before the first screen or the first frame is written, and the board's preview
   * button has to be there to open it. That is also what makes a session dock the
   * moment the message lands, rather than when the agent first reaches for its
   * preview operation.
   */
  async stateFor(projectId: string, threadId: string): Promise<ThreadDesignState> {
    const scope = await authoredWorkRoot(this.options.database, projectId, threadId).catch(
      () => null
    )
    if (!scope) {
      const fallbackRoot = workRootForKind(DEFAULT_WORK_ROOTS, 'design')
      return {
        projectId,
        threadId,
        kind: 'design',
        active: false,
        current: null,
        items: [],
        defaultDirectory: fallbackRoot,
        root: fallbackRoot
      }
    }
    const current = await this.designs.forThreadViaWorker(threadId)
    const thread = await this.threads.getViaWorker(threadId)
    const kind = thread?.authoredWorkKind ?? current?.kind ?? 'design'
    const root = currentWorkRoot(kind, projectId)
    // The listing reads disk, which knows nothing about authorship; the recorded
    // creators are merged in here so the board can badge a folder as the viewed
    // thread's own and send the user back to the thread that first wrote it. A
    // conversation workspace has no such record to merge: the authorship table is
    // keyed by project, and every assistant task shares one project id, so reading
    // it here would badge one assistant's design with another's thread.
    const origins = scope.appOwned
      ? new Map<string, string>()
      : await this.designs.originsViaWorker(projectId)
    const items = (await this.listProjectFolders(projectId, threadId, scope, kind)).map((item) => ({
      ...item,
      creatorThreadId: origins.get(item.directory) ?? null
    }))
    return {
      projectId,
      threadId,
      kind,
      active: current !== null || thread?.authoredWorkKind !== undefined,
      current,
      items,
      defaultDirectory: current?.directory ?? items[0]?.directory ?? root,
      root
    }
  }

  /**
   * Show a thread's work at the user's request.
   *
   * A design's screen is opened in a tab of its own, so clicking one canvas never
   * replaces another canvas's tab (see `BrowserService.openDesignScreen`); a
   * composition is played by the video board's own view, which never enters the
   * tab strip, so a user watching and editing in the board never has to open or
   * find the browser. The folder is validated and the page is loaded in the
   * background, then the tab is revealed where revealing applies: revealing is one
   * mechanism, not two, so an existing tab and a brand-new one behave the same way
   * for the user.
   */
  async open(
    projectId: string,
    threadId: string,
    directory: unknown,
    entry: unknown,
    reveal: boolean,
    /**
     * The kind to open as, when the caller is the project board rather than a
     * session. A forced kind is not recorded against the thread: the board, not
     * the thread, chose it, so the thread is not retitled by a look.
     */
    forcedKind?: AuthoredWorkKind
  ): Promise<DesignOpenResult> {
    const scope = await authoredWorkRoot(this.options.database, projectId, threadId)
    const kind = forcedKind ?? (await this.resolveKind(threadId))
    const requested = resolveServedFolder(scope.path, directory, currentWorkRoot(kind, projectId))
    directory = this.designs.resolveDirectory(projectId, requested.display)
    const result = await this.serveWork({
      kind,
      projectPath: scope.path,
      projectId,
      threadId,
      directory,
      entry,
      attention: 'background',
      reveal,
      // A composition is played by the board's own view, and only by it: the board
      // is the control surface and the picture, the browser is the same view shown
      // full screen, and a second tab would be a second player that the board's own
      // controls could not reach. A design screen keeps its own tab, and a design's
      // other routes keep the thread's.
      tab: kind === 'design' ? 'screen' : 'board'
    })
    if (forcedKind === undefined) {
      this.designs.upsert({
        projectId,
        threadId,
        directory: result.directory,
        entry: result.entry,
        kind
      })
      await this.rememberThreadKind(projectId, threadId, kind)
    }
    if (!result.tabId) {
      throw new Error('The work opened without a browser tab to show it in.')
    }
    return {
      directory: result.directory,
      entry: result.entry,
      url: result.url,
      tabId: result.tabId
    }
  }

  /**
   * Every design and composition folder one scope holds, by kind.
   *
   * The right rail asks this before any thread is chosen, so the work is
   * reachable without hunting for the thread that made it. The two roots are read
   * straight and the recorded creators merged in, exactly as the board's own
   * listing does, so a folder the app has never previewed still appears.
   *
   * A conversation container (an assistant, a chat, a browser tab) is answered
   * from the workspace its thread runs in, which is why `threadId` is part of the
   * question there: one container id covers every assistant at once.
   */
  async projectWork(projectId: string, threadId?: string): Promise<ProjectWorkState> {
    const scope = await authoredWorkRoot(this.options.database, projectId, threadId).catch(
      () => null
    )
    if (!scope) return { projectId, design: [], video: [] }
    const origins = scope.appOwned
      ? new Map<string, string>()
      : await this.designs.originsViaWorker(projectId)
    const list = async (kind: AuthoredWorkKind): Promise<DesignEntry[]> =>
      (
        await this.listProjectFolders(
          projectId,
          // A conversation scope always names a thread: its workspace is the thread's
          // (or its assistant's), so `authoredWorkRoot` refused above without one.
          threadId ?? '',
          scope,
          kind
        )
      ).map((item) => ({
        ...item,
        creatorThreadId: origins.get(item.directory) ?? null
      }))
    return { projectId, design: await list('design'), video: await list('video') }
  }

  /**
   * A small picture of the work, for the coordinator's preview.
   *
   * It is shown off screen, then captured. That is deliberate: the capture has to
   * come from a page the app is actually rendering, and a hidden page is the same
   * page the user would see, at the same size, without a second browser and
   * without stealing focus. A design is captured in the thread's tab; a
   * composition is captured in the video board's own view, which never enters the
   * tab strip, so a picture of a composition costs the user no browser tab. A
   * composition is captured as a still at its opening, because a picture for a
   * board must not start playback: a frame is what the composition exists to
   * draw, and the user asks for the moving one by watching it in the board.
   */
  async thumbnail(
    projectId: string,
    threadId: string,
    directory: unknown,
    entry: unknown,
    width: number,
    /** The project board's kind override; see `open`. */
    forcedKind?: AuthoredWorkKind
  ): Promise<DesignThumbnail> {
    const scope = await authoredWorkRoot(this.options.database, projectId, threadId)
    const browser = this.options.browser()
    const kind = forcedKind ?? (await this.resolveKind(threadId))
    const result = await this.serveWork({
      kind,
      projectPath: scope.path,
      projectId,
      threadId,
      directory,
      // The entry is passed through so the picture is the page the user is actually
      // looking at, not always the folder's index file.
      entry,
      attention: 'background',
      reveal: false,
      // Pictures browse the project without changing the thread's work link.
      tab: kind === 'video' ? 'board' : 'screen',
      // A board's picture of a composition is a still, so selecting a video thread
      // must not start playback and sound in a tab the user never asked for. The
      // design kind has no timeline to freeze, so it is unaffected.
      posterSeconds: kind === 'video' ? POSTER_SECONDS : undefined
    })
    const tabId = result.tabId
    if (!browser || !tabId) {
      return { directory: result.directory, dataUrl: null, width: 0, height: 0, tabId }
    }
    /**
     * A picture that could not be taken is a missing picture, never a failed board.
     *
     * The capture comes from Chromium's compositor, and a view the app is not
     * showing at that moment can answer with no frame at all (`UnknownVizError`)
     * instead of a picture. That is a state of the same off-screen capture the
     * screen sweep already degrades on, so this path answers the way the sweep
     * does: no picture, which the board already draws as "No frame captured yet."
     * rather than as an error the user cannot act on.
     */
    try {
      await browser.waitForTabLoad(tabId)
      const captured = await browser.captureThumbnail(
        tabId,
        Math.min(MAX_THUMBNAIL_WIDTH, Math.max(MIN_THUMBNAIL_WIDTH, Math.round(width)))
      )
      return captured
        ? { directory: result.directory, ...captured, tabId }
        : { directory: result.directory, dataUrl: null, width: 0, height: 0, tabId }
    } catch (error) {
      Logger.dev('A thumbnail could not be captured:', error)
      return { directory: result.directory, dataUrl: null, width: 0, height: 0, tabId }
    }
  }

  /**
   * Every screen of one design folder, each with a picture of it.
   *
   * A design is a product rather than a page, so the board shows its screens
   * instead of one entry file. The pictures come from the same place the single
   * thumbnail does: the thread's own tab, off screen, at a real viewport, because
   * a capture has to come from a page the app is rendering.
   *
   * That the sweep moves that tab is why three things here are deliberate. It
   * runs one screen at a time, so a design with many screens is a bounded run of
   * loads rather than a burst. It is keyed by the thread, so a second sweep
   * supersedes the first instead of driving the same tab alongside it. And it
   * leaves the tab where it found it, because a board opened over a design must
   * not change what the user is looking at.
   *
   * A sweep whose every screen is already pictured navigates nothing: pictures
   * are cached against each file's own stamp, and a sweep that never navigated
   * has nothing to put back. That is what makes this cheap enough for the board
   * to re-read its screens whenever a turn settles, which is how a screen the
   * agent has just written appears on its own.
   */
  async screens(
    projectId: string,
    threadId: string,
    directory: unknown,
    width: number,
    force: boolean
  ): Promise<DesignScreenShot[]> {
    const scope = await authoredWorkRoot(this.options.database, projectId, threadId)
    const folder = resolveServedFolder(scope.path, directory, currentWorkRoot('design', projectId))
    // The Screen Canvas is pictured with the screens, because the board shows it
    // as the canvas itself rather than as a screen inside it. It is generated
    // from the folder, so it is listed as one more entry stamped with the newest
    // screen it frames: its picture therefore goes stale exactly when the canvas
    // it pictures would have changed, with no stamp of its own to keep.
    const listed = await listDesignScreens(folder.absolute)
    const canvas =
      listed.length === 0
        ? null
        : screenCanvasScreen(
            await readScreenCanvas({ folderAbsolute: folder.absolute, screens: listed })
          )
    const screens = canvas === null ? listed : [canvas, ...listed]
    const shotWidth = Math.min(
      MAX_THUMBNAIL_WIDTH,
      Math.max(MIN_THUMBNAIL_WIDTH, Math.round(width))
    )
    if (screens.length === 0 || !this.options.browser()) {
      return screens.map(emptyScreenShot)
    }
    const generation = (this.screenSweeps.get(threadId) ?? 0) + 1
    this.screenSweeps.set(threadId, generation)
    // Read before the first navigation: this is the folder and screen the tab was
    // on, and the only honest place to put it back. A thread with no work record has
    // no folder to return to, so its tab's own page is read instead: the sweep must
    // not leave a thread that never designed anything sitting on a screen of a
    // design it only pictured.
    const before = await this.designs.forThreadViaWorker(threadId)
    const browser = this.options.browser()
    const tabBefore = browser?.agentTabFor(projectId, threadId) ?? null
    const urlBefore = tabBefore === null ? null : (browser?.tabUrl(tabBefore) ?? null)
    const shots: DesignScreenShot[] = []
    const startedAt = Date.now()
    /** Whether this sweep navigated the thread's tab, so it must put it back. */
    let moved = false
    try {
      for (const screen of screens) {
        const cached = force
          ? null
          : this.cachedScreenShot(projectId, folder.display, screen, shotWidth)
        if (cached !== null) {
          shots.push(cached)
          continue
        }
        // A newer sweep owns the tab now, so this one stops where it is rather
        // than fighting it for the same page.
        if (this.screenSweeps.get(threadId) !== generation) break
        if (Date.now() - startedAt >= SCREEN_SWEEP_BUDGET_MS) {
          shots.push(emptyScreenShot(screen))
          continue
        }
        moved = true
        const shot = await this.captureScreen({
          projectId,
          threadId,
          projectPath: scope.path,
          directory: folder.display,
          screen,
          width: shotWidth
        })
        // A newer sweep took the tab while this picture was being taken, so the page
        // it shows may no longer be this screen. The picture is dropped rather than
        // cached against a screen it may not be: the sweep that owns the tab fills
        // every screen in anyway.
        if (this.screenSweeps.get(threadId) !== generation) break
        if (shot.dataUrl !== null) {
          this.rememberScreenShot(projectId, folder.display, screen, shotWidth, shot)
        }
        shots.push(shot)
      }
      return shots
    } finally {
      if (this.screenSweeps.get(threadId) === generation && moved) {
        await this.restoreTab({
          projectId,
          threadId,
          projectPath: scope.path,
          before,
          url: urlBefore
        })
      }
    }
  }

  /**
   * The Screen Canvas of one design folder, as the board reads it.
   *
   * The canvas belongs to the app: it is generated from the folder's screens on
   * every request, so this is a read of what the folder holds and of the optional
   * `canvas.json` that arranges it. Nothing here can fall behind the design,
   * because there is no second copy of the canvas to fall behind it. `threadId`
   * is accepted for symmetry with the other handlers and read no further.
   */
  async screenCanvas(
    projectId: string,
    threadId: string,
    directory: unknown
  ): Promise<ScreenCanvasState | null> {
    const scope = await authoredWorkRoot(this.options.database, projectId, threadId)
    const folder = resolveServedFolder(scope.path, directory, currentWorkRoot('design', projectId))
    const screens = await listDesignScreens(folder.absolute)
    return readScreenCanvasState({
      folderAbsolute: folder.absolute,
      directory: folder.display,
      screens
    })
  }

  /**
   * The folders one scope's board lists.
   *
   * A checkout answers from the registry, which discovers the canonical default
   * directories and remembers every exact folder the project was pointed at. A
   * conversation's workspace answers from itself instead: its threads' records
   * stand in for the registry, because the registry is keyed by project id and
   * every assistant task shares one container id.
   */
  private async listProjectFolders(
    projectId: string,
    threadId: string,
    /**
     * The scope the board is listing: a project checkout, or a conversation's own
     * workspace. The workspace is what a conversation's records are scoped to,
     * because the workspace is the only thing that separates one assistant's work
     * from another's under the shared container id.
     */
    scope: AuthoredWorkRoot,
    kind: AuthoredWorkKind
  ): Promise<DesignEntry[]> {
    // A conversation workspace has no registry it can trust: the registry is keyed
    // by project id, and every assistant task shares one container id, so a
    // registry read there would answer for whichever assistant happened to write
    // a folder of that name first. Its threads' own records are scoped to the
    // workspace, so those stand in for the registry (see `listConversationWorkFolders`).
    if (scope.appOwned)
      return listConversationWorkFolders({
        database: this.options.database,
        projectId,
        threadId,
        assistantId: scope.assistantId,
        workspacePath: scope.path,
        kind
      })
    return new WorkFolderRegistry(this.options.database).list(projectId, scope.path, kind)
  }

  async listWorkFolders(projectPath: string, root: string): Promise<DesignEntry[]> {
    return listProjectWorkFolders(projectPath, root)
  }

  /**
   * One served root as a project-relative folder, or null when it is not inside the
   * project.
   *
   * A preview server reports the folder it serves after `realpath`, while a project
   * keeps the path the user chose, which can be a symlink: `/tmp/proj` on macOS is
   * really `/private/tmp/proj`. So the comparison is between canonical paths rather
   * than between two spellings that are usually, but not always, the same string.
   */
  private projectRelativeFolder(projectPath: string, root: string): string | null {
    const relativePath = relative(this.canonicalProjectPath(projectPath), root)
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return null
    }
    return relativePath.split(sep).join('/')
  }

  private canonicalProjectPath(projectPath: string): string {
    const cached = this.canonicalProjects.get(projectPath)
    if (cached !== undefined) return cached
    let canonical = projectPath
    try {
      // One syscall per project, ever: the answer cannot change while the app runs,
      // and this is reached only when a tab is on a folder the app is serving.
      canonical = realpathSync(projectPath)
    } catch {
      // A project whose folder is gone keeps the path it was stored with.
    }
    this.canonicalProjects.set(projectPath, canonical)
    return canonical
  }

  /**
   * Which session the thread is in.
   *
   * Read from the thread's own persisted kind, which every route into a session
   * writes (the tag at turn start, a preview into a work root). A thread recorded
   * before the column existed falls back to the folder record it kept, and an
   * unknown thread is treated as a design so a folder with no session still opens
   * on the design path.
   */
  private async resolveKind(threadId: string): Promise<AuthoredWorkKind> {
    const thread = await this.threads.getViaWorker(threadId)
    if (thread?.authoredWorkKind) return thread.authoredWorkKind
    const current = await this.designs.forThreadViaWorker(threadId)
    return current?.kind ?? 'design'
  }

  /**
   * Serve one folder of authored work and show it in a browser tab.
   *
   * The design path and the video path share every step but the folder resolver
   * and one design-only side effect (marking the tab, which is what arms the
   * element inspector), so the choice lives here rather than in each caller: the
   * capability's own preview, the board's open and the board's captures all have
   * to agree about which folder is on screen. Which tab it lands in is the one
   * thing the callers are allowed to disagree about (see `tab`).
   */
  private async serveWork(input: {
    kind: AuthoredWorkKind
    projectPath: string
    projectId: string
    threadId: string
    directory: unknown
    entry: unknown
    attention: 'focus' | 'background'
    reveal: boolean
    /**
     * Which view the work may use.
     *
     * The board's open is the user choosing a page, so every design screen keeps
     * its own tab. A composition is played by the board's own view, which is a
     * registered tab that never enters the tab strip. The capability's own
     * preview and every capture share the thread's browser tab.
     */
    tab: 'thread' | 'screen' | 'board'
    /**
     * Load a still at this second instead of the moving composition. Video only:
     * a design is shown as it is, and the design path ignores this.
     */
    posterSeconds?: number
  }): Promise<ServedWork> {
    const deps = { previews: this.options.previews, browser: this.options.browser }
    const target = {
      projectPath: input.projectPath,
      projectId: input.projectId,
      threadId: input.threadId,
      directory: input.directory,
      entry: input.entry,
      defaultRoot: currentWorkRoot(input.kind, input.projectId),
      attention: input.attention,
      reveal: input.reveal,
      posterSeconds: input.posterSeconds
    }
    const result =
      input.kind === 'video'
        ? await openVideoPreview(deps, {
            ...target,
            mode: input.tab === 'board' ? ('board' as const) : ('thread' as const)
          })
        : await openDesignPreview(deps, {
            ...target,
            tab: input.tab === 'screen' ? ('screen' as const) : ('thread' as const)
          })
    return {
      directory: result.directory,
      entry: result.entry,
      url: result.url,
      tabId: result.tabId
    }
  }

  /**
   * Picture one screen in the thread's tab, or report it without a picture.
   *
   * Every step degrades rather than throwing: one screen that cannot be served, or
   * a design whose folder is deleted while the sweep is running, is a screen
   * without a picture, never a board that fails to load.
   */
  private async captureScreen(input: {
    projectId: string
    threadId: string
    projectPath: string
    directory: string
    screen: DesignScreen
    width: number
  }): Promise<DesignScreenShot> {
    try {
      const result = await this.serveWork({
        kind: 'design',
        projectPath: input.projectPath,
        projectId: input.projectId,
        threadId: input.threadId,
        directory: input.directory,
        entry: input.screen.entry,
        attention: 'background',
        reveal: false,
        tab: 'thread'
      })
      const browser = this.options.browser()
      if (browser === null || result.tabId === null) return emptyScreenShot(input.screen)
      await browser.waitForTabLoad(result.tabId, SCREEN_LOAD_TIMEOUT_MS)
      const captured = await browser.captureThumbnail(result.tabId, input.width)
      if (captured === null) return emptyScreenShot(input.screen)
      return {
        entry: input.screen.entry,
        name: input.screen.name,
        updatedAt: input.screen.updatedAt,
        ...captured
      }
    } catch (error) {
      Logger.dev('A design screen could not be pictured:', error)
      return emptyScreenShot(input.screen)
    }
  }

  /**
   * Put the tab back where the sweep found it.
   *
   * A thread with a work record has the folder and the kind the tab was showing, so
   * the record is the target and the tab is served that work again. A thread with no
   * record has no work to return to, so the tab goes back to the page it was on when
   * the sweep started: the sweep is the board picturing a project's design, and a
   * thread that never designed anything must not be left sitting on one of its
   * screens. A thread whose tab did not exist before the sweep is left alone, because
   * there is nothing to put back.
   */
  private async restoreTab(input: {
    projectId: string
    threadId: string
    projectPath: string
    before: ThreadDesignCurrent | null
    /** The page the thread's tab was on before the sweep, or null with no tab. */
    url: string | null
  }): Promise<void> {
    const browser = this.options.browser()
    if (browser === null) return
    try {
      if (!input.before) {
        if (input.url === null) return
        const shown = await browser.showThreadWorkTab({
          projectId: input.projectId,
          threadId: input.threadId,
          url: input.url,
          attention: 'background',
          reveal: false
        })
        await browser.waitForTabLoad(shown.tabId, SCREEN_LOAD_TIMEOUT_MS)
        return
      }
      const restored = await this.serveWork({
        kind: input.before.kind,
        projectPath: input.projectPath,
        projectId: input.projectId,
        threadId: input.threadId,
        directory: input.before.directory,
        entry: input.before.entry,
        attention: 'background',
        reveal: false,
        tab: 'thread'
      })
      if (restored.tabId) {
        await browser.waitForTabLoad(restored.tabId, SCREEN_LOAD_TIMEOUT_MS)
      }
    } catch (error) {
      Logger.dev('The tab could not be put back after picturing a design:', error)
    }
  }

  /**
   * A screen's picture, when the screen has not changed since it was taken.
   *
   * Keyed by the file's own stamp, so an edit invalidates it and nothing else has
   * to notice the edit. A hit is re-inserted so the least recently used eviction
   * keeps the pictures the board is showing rather than the first ones it took.
   */
  private cachedScreenShot(
    projectId: string,
    directory: string,
    screen: DesignScreen,
    width: number
  ): DesignScreenShot | null {
    const key = screenShotKey(projectId, directory, screen, width)
    const hit = this.screenShots.get(key)
    if (hit === undefined) return null
    this.screenShots.delete(key)
    this.screenShots.set(key, hit)
    return hit
  }

  private rememberScreenShot(
    projectId: string,
    directory: string,
    screen: DesignScreen,
    width: number,
    shot: DesignScreenShot
  ): void {
    this.screenShots.set(screenShotKey(projectId, directory, screen, width), shot)
    while (this.screenShots.size > MAX_CACHED_SCREEN_SHOTS) {
      const oldest = this.screenShots.keys().next()
      if (oldest.done) break
      this.screenShots.delete(oldest.value)
    }
  }
}
