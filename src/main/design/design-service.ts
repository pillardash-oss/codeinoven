import { realpathSync } from 'node:fs'
import { DESIGN_EXPORT_FORMATS } from '../../lib/design/design-export'
import { isAbsolute, relative, sep } from 'node:path'
import {
  DEFAULT_WORK_ROOTS,
  authoredWorkKindOf,
  workRootForKind
} from '../../lib/design/work-roots'
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
  ThreadDesignState
} from '../../lib/ipc/design'
import { originOf } from '../../lib/local-development-url'
import { requireLocalProjectViaWorker } from '../../lib/project-artifacts'
import type { BrowserService } from '../browser/browser-service'
import { NO_TAB_MARK, type BrowserTabMark } from '../browser/browser-service/browser-tab-mark'
import type { Database } from '../database/database'
import { DesignRepo } from '../database/repositories/design-repo'
import { ProjectRepo } from '../database/repositories/project-repo'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import { resolveServedFolder } from '../preview/served-folder'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { Logger } from '../system/logger'
import { openVideoPreview } from '../video/video-preview-session'
import { readCompositionManifest } from '../video/video-manifest'
import { listProjectWorkFolders } from './design-listing'
import { listDesignScreens } from './design-screens'
import { readScreenCanvasState } from './screen-canvas-state'
import { DesignHistoryService, type DesignHistoryTarget } from './design-history-service'
import { openDesignPreview } from './design-preview-session'
import { currentWorkRoot, currentWorkRootReports, currentWorkRoots } from './work-roots-state'

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

/** The part of a served URL under its origin, decoded, or null when it names no file. */
function entryWithinOrigin(url: string, origin: string): string | null {
  const withoutQuery = url.slice(origin.length).split(/[?#]/u)[0] ?? ''
  const path = withoutQuery.replace(/^\/+/u, '')
  if (path.length === 0) return null
  try {
    return decodeURIComponent(path)
  } catch {
    // A URL the browser accepted can still hold a malformed escape; its raw form
    // is still the file that was asked for.
    return path
  }
}

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
  return { entry: screen.entry, name: screen.name, dataUrl: null, width: 0, height: 0 }
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
  /**
   * Mirror a thread's authored-work kind to live UI the moment it is recorded.
   *
   * The row is what the sidebar draws its marker from, and the agent can open a
   * design or video session on its own (a preview into a work root) with no tag,
   * so this write has to reach the renderer just like the tag path's does.
   */
  onThreadKindChanged?: (projectId: string, threadId: string, kind: AuthoredWorkKind) => void
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
  /** Threads whose tab a sweep is moving, and the newest sweep doing it there. */
  private readonly sweepingThreads = new Map<string, number>()

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
        `SELECT harness, provider, model, COUNT(*) AS samples, ROUND(AVG(score),2) AS score FROM design_reviews WHERE created_at >= ? AND created_at < ? GROUP BY rubric,harness,provider,model ORDER BY score DESC,samples DESC LIMIT 50`,
        [startAt, endAt],
        50,
        { allowPrimaryFallback: false }
      )
      if (!result.ok) throw new Error(result.error ?? 'Could not read design rankings')
      return result.rows
    })
    ipcMain.handle('design:export', async (_event, rawProjectId, directory, entry, format) => {
      if (!DESIGN_EXPORT_FORMATS.some((value) => value === format))
        throw new Error('Unsupported design export format')
      const project = await requireLocalProjectViaWorker(
        this.options.database,
        requireId(rawProjectId, 'project id')
      )
      const { exportDesign } = await import('./design-export-service')
      return exportDesign(project.path, directory, entry, format, this.options.previews)
    })
    ipcMain.handle('design:state', async (_event, rawProjectId, rawThreadId) =>
      this.stateFor(requireId(rawProjectId, 'project id'), requireId(rawThreadId, 'thread id'))
    )
    // Every folder of authored work one project holds, by kind. Asked by the
    // right rail before any thread is chosen, so the project's designs and videos
    // are reachable whether or not a session is open.
    ipcMain.handle('design:projectWork', async (_event, rawProjectId) =>
      this.projectWork(requireId(rawProjectId, 'project id'))
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
    // The folders authored work is written into, and what the last change moved.
    // Read rather than pushed, because both surfaces that change a root (the
    // Design settings card and the board's own save path) ask immediately after
    // the save that caused the move.
    ipcMain.handle('design:workRootState', async () => ({
      roots: currentWorkRoots(),
      defaults: { ...DEFAULT_WORK_ROOTS },
      reports: currentWorkRootReports()
    }))
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
    const target = await this.historyTarget(projectId, threadId, directory)
    return this.history.state(target, cause)
  }

  /** Move a folder to one point in its history, which is what Undo and Redo do. */
  async historyRestore(
    projectId: string,
    threadId: string,
    directory: unknown,
    revisionId: string
  ): Promise<DesignHistoryState> {
    const target = await this.historyTarget(projectId, threadId, directory)
    const result = await this.history.restore(target, revisionId)
    this.options.onHistoryChanged?.(projectId, target.directory)
    return result
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
  }

  /** One page's own line through a folder's history. */
  async historyPage(
    projectId: string,
    threadId: string,
    directory: unknown,
    path: string
  ): Promise<DesignPageHistoryState> {
    const target = await this.historyTarget(projectId, threadId, directory)
    return this.history.pageState(target, path)
  }

  /** Move one page to one point in its own history. */
  async historyRestoreFile(
    projectId: string,
    threadId: string,
    directory: unknown,
    path: string,
    revisionId: string
  ): Promise<DesignHistoryRestoreFileResult> {
    const target = await this.historyTarget(projectId, threadId, directory)
    const result = await this.history.restoreFile(target, revisionId, path)
    this.options.onHistoryChanged?.(projectId, target.directory)
    return result
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
    const project = await requireLocalProjectViaWorker(this.options.database, projectId)
    const kind = await this.resolveKind(threadId)
    const folder = resolveServedFolder(project.path, directory, currentWorkRoot(kind))
    return {
      projectId,
      projectPath: project.path,
      directory: folder.display,
      absolute: folder.absolute,
      // Only a project whose change tracking is Git can have the folder tracked by
      // a repository; a manual-tracking project is the app's to version, always.
      gitMode: project.changeTrackingMode === 'git'
    }
  }

  /** Forget a thread's authored-work record when the thread itself is gone. */
  forgetThread(threadId: string): void {
    this.designs.deleteThread(threadId)
    // Dropping the generation is what stops a sweep still in flight for this
    // thread: its next screen finds a generation that is no longer its own.
    this.screenSweeps.delete(threadId)
    this.sweepingThreads.delete(threadId)
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
   * opened it, and recorded so the board follows.
   *
   * The browser calls this on every committed navigation. An authored-work folder
   * is served on its own loopback origin, so the URL is enough to answer the
   * question the board asks: which folder is this thread working in. Recognising it
   * this way covers the two cases a record of the last preview cannot: a tab the
   * agent opened itself, and a tab the renderer restored after a restart.
   *
   * The two marks differ by what they arm. A design folder arms the element
   * inspector, because picking an element out of it is how a change is described. A
   * composition arms the playback transport instead, and carries the timeline its
   * manifest declares, because a page that moves is watched rather than picked
   * apart. Either way the folder is recorded for the board.
   */
  async observeShownFolder(
    projectId: string,
    threadId: string,
    url: string,
    recordThread = true
  ): Promise<BrowserTabMark> {
    // Capture this before asynchronous reads: a gallery navigation stays a
    // capture even if its recognition finishes after the sweep has ended.
    const remember = recordThread && !this.sweepingThreads.has(threadId)
    const origin = originOf(url)
    if (origin === null) return NO_TAB_MARK
    const root = this.options.previews.rootForOrigin(origin)
    if (root === null) return NO_TAB_MARK
    const directory = this.projectRelativeFolder(
      (await requireLocalProjectViaWorker(this.options.database, projectId)).path,
      root
    )
    if (directory === null) return NO_TAB_MARK
    const kind = authoredWorkKindOf(directory, currentWorkRoots())
    if (kind === null) return NO_TAB_MARK
    // A screen sweep moves the tab through every screen of one design, which is
    // the app taking pictures rather than the agent or the user choosing a folder.
    // Both capture and restoration leave the row alone, so browsing the
    // gallery cannot replace the thread's own folder.
    if (remember) {
      await this.rememberShownFolder({
        projectId,
        threadId,
        directory,
        entry: entryWithinOrigin(url, origin),
        kind
      })
    }
    if (kind === 'design') return { design: { directory, origin }, composition: null }
    // A composition with no readable manifest has no timeline, so there is nothing
    // to play: it is shown as an ordinary page rather than driven by a guess.
    const manifest = await readCompositionManifest(root)
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
   * The row is what the sidebar draws its marker from, and what the expert card
   * and media generation read the session from, so the folder record alone is not
   * enough. Best-effort: the folder record has already landed, and a failed mirror
   * must not fail the preview that triggered it. The repository guards the write,
   * so a navigation that records the same kind churns nothing.
   */
  private async rememberThreadKind(
    projectId: string,
    threadId: string,
    kind: AuthoredWorkKind
  ): Promise<void> {
    try {
      await this.threads.setAuthoredWorkKindViaWorker(threadId, kind)
    } catch (error) {
      Logger.dev('Authored-work kind row update failed:', error)
      return
    }
    // The persisted value is the fact; telling the renderer is what makes the
    // row's marker appear without a refresh, so the agent opening a session on
    // its own reads the same as the user typing the tag.
    this.options.onThreadKindChanged?.(projectId, threadId, kind)
  }

  forgetProject(projectId: string): void {
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
    const storedProject = await new ProjectRepo(this.options.database).getViaWorker(projectId)
    if (!storedProject || storedProject.source !== 'local' || !storedProject.path) {
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
    const root = currentWorkRoot(kind)
    // The listing reads disk, which knows nothing about authorship; the recorded
    // creators are merged in here so the board can badge a folder as the viewed
    // thread's own and send the user back to the thread that first wrote it.
    const origins = await this.designs.originsViaWorker(projectId)
    const items = (await this.listWorkFolders(storedProject.path, root)).map((item) => ({
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
    const project = await requireLocalProjectViaWorker(this.options.database, projectId)
    const kind = forcedKind ?? (await this.resolveKind(threadId))
    const result = await this.serveWork({
      kind,
      projectPath: project.path,
      projectId,
      threadId,
      directory,
      entry,
      attention: 'background',
      reveal,
      // A composition is played by the board's own view, never the thread's
      // browser tab: that is what lets a user watch and edit without opening the
      // browser. A design screen keeps its own tab, and a design's other routes
      // keep the thread's.
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
   * Every design and composition folder one project holds, by kind.
   *
   * The right rail asks this before any thread is chosen, so the project's work
   * is reachable without hunting for the thread that made it. The two roots are
   * read straight and the recorded creators merged in, exactly as the board's own
   * listing does, so a folder the app has never previewed still appears.
   */
  async projectWork(projectId: string): Promise<ProjectWorkState> {
    const project = await new ProjectRepo(this.options.database).getViaWorker(projectId)
    if (!project || project.source !== 'local' || !project.path) {
      return { projectId, design: [], video: [] }
    }
    const path = project.path
    const origins = await this.designs.originsViaWorker(projectId)
    const list = async (kind: AuthoredWorkKind): Promise<DesignEntry[]> =>
      (await this.listWorkFolders(path, currentWorkRoot(kind))).map((item) => ({
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
    const project = await requireLocalProjectViaWorker(this.options.database, projectId)
    const browser = this.options.browser()
    const kind = forcedKind ?? (await this.resolveKind(threadId))
    const result = await this.serveWork({
      kind,
      projectPath: project.path,
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
    await browser.waitForTabLoad(tabId)
    const captured = await browser.captureThumbnail(
      tabId,
      Math.min(MAX_THUMBNAIL_WIDTH, Math.max(MIN_THUMBNAIL_WIDTH, Math.round(width)))
    )
    return captured
      ? { directory: result.directory, ...captured, tabId }
      : { directory: result.directory, dataUrl: null, width: 0, height: 0, tabId }
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
   */
  async screens(
    projectId: string,
    threadId: string,
    directory: unknown,
    width: number,
    force: boolean
  ): Promise<DesignScreenShot[]> {
    const project = await requireLocalProjectViaWorker(this.options.database, projectId)
    const folder = resolveServedFolder(project.path, directory, currentWorkRoot('design'))
    // The Screen Canvas is pictured with the screens: the board shows it as the
    // first entry of its screens grid, and that entry is a picture like the rest.
    // It is one more load in the sweep, cached against the file like every other
    // screen until the canvas is written again.
    const screens = await listDesignScreens(folder.absolute)
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
    // on, and the only honest place to put it back.
    const before = await this.designs.forThreadViaWorker(threadId)
    const shots: DesignScreenShot[] = []
    const startedAt = Date.now()
    this.sweepingThreads.set(threadId, generation)
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
        const shot = await this.captureScreen({
          projectId,
          threadId,
          projectPath: project.path,
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
      try {
        if (this.screenSweeps.get(threadId) === generation && before?.kind === 'design') {
          await this.restoreTab({
            projectId,
            threadId,
            projectPath: project.path,
            folder: folder.display,
            screens,
            before
          })
        }
      } finally {
        if (this.sweepingThreads.get(threadId) === generation) {
          this.sweepingThreads.delete(threadId)
        }
      }
    }
  }

  /**
   * The Screen Canvas of one design folder, if it has one.
   *
   * The board asks before it offers to create or update a canvas: the answer
   * says whether the folder has one, and if so which of its screens are missing
   * from it or newer than it. The canvas is a file in the folder rather than a
   * per-thread record, so `threadId` is accepted for symmetry with the other
   * handlers and read no further.
   */
  async screenCanvas(
    projectId: string,
    threadId: string,
    directory: unknown
  ): Promise<ScreenCanvasState | null> {
    const project = await requireLocalProjectViaWorker(this.options.database, projectId)
    const folder = resolveServedFolder(project.path, directory, currentWorkRoot('design'))
    const screens = await listDesignScreens(folder.absolute)
    return readScreenCanvasState({
      folderAbsolute: folder.absolute,
      directory: folder.display,
      screens
    })
  }

  /**
   * Every folder of one project under `root`, newest first.
   *
   * The folder listing is the registry: `.cio/designs/<name>/` and
   * `.cio/videos/<name>/` are the documented layouts, so a folder another thread
   * wrote is found here without anything having registered it.
   */
  async listWorkFolders(projectPath: string, root: string): Promise<DesignEntry[]> {
    return listProjectWorkFolders(projectPath, root)
  }

  /**
   * Record a folder recognised from a tab, so the board follows the tab.
   *
   * Guarded on the stored row because this runs on every navigation: a page the
   * thread already has open must not write the row again, and a folder that changed
   * must, because re-pointing the row is the whole point of having it. Writing
   * unconditionally would also keep refreshing `updated_at`, the stamp the board
   * reads as when the folder was last shown.
   */
  private async rememberShownFolder(input: {
    projectId: string
    threadId: string
    directory: string
    entry: string | null
    kind: AuthoredWorkKind
  }): Promise<void> {
    const current = await this.designs.forThreadViaWorker(input.threadId)
    if (
      current &&
      current.directory === input.directory &&
      current.entry === input.entry &&
      current.kind === input.kind
    ) {
      return
    }
    this.designs.upsert(input)
    await this.rememberThreadKind(input.projectId, input.threadId, input.kind)
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
      defaultRoot: currentWorkRoot(input.kind),
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
      return { entry: input.screen.entry, name: input.screen.name, ...captured }
    } catch (error) {
      Logger.dev('A design screen could not be pictured:', error)
      return emptyScreenShot(input.screen)
    }
  }

  /**
   * Put the tab back where the sweep found it.
   *
   * The thread's own record is the target, whatever kind of work it holds, because
   * that record is what the tab was showing. A thread that has no record yet is
   * left without a restoration request. Restoration stays inside the sweep's
   * recording suppression, so browsing another folder cannot rewrite the link.
   */
  private async restoreTab(input: {
    projectId: string
    threadId: string
    projectPath: string
    folder: string
    screens: DesignScreen[]
    before: ThreadDesignCurrent | null
  }): Promise<void> {
    const target =
      input.before?.kind === 'design'
        ? { directory: input.before.directory, entry: input.before.entry }
        : { directory: input.folder, entry: input.screens[0]?.entry ?? null }
    try {
      const restored = await this.serveWork({
        kind: 'design',
        projectPath: input.projectPath,
        projectId: input.projectId,
        threadId: input.threadId,
        directory: target.directory,
        entry: target.entry,
        attention: 'background',
        reveal: false,
        tab: 'thread'
      })
      if (restored.tabId) {
        await this.options.browser()?.waitForTabLoad(restored.tabId, SCREEN_LOAD_TIMEOUT_MS)
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
