import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import {
  DEFAULT_WORK_ROOTS,
  authoredWorkKindOf,
  workRootForKind
} from '../../lib/design/work-roots'
import type {
  AuthoredWorkKind,
  DesignEntry,
  DesignOpenResult,
  DesignScreen,
  DesignScreenShot,
  DesignThumbnail,
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
  }

  registerIpc(): void {
    ipcMain.handle('design:state', async (_event, rawProjectId, rawThreadId) =>
      this.stateFor(requireId(rawProjectId, 'project id'), requireId(rawThreadId, 'thread id'))
    )
    ipcMain.handle(
      'design:open',
      async (_event, rawProjectId, rawThreadId, rawDirectory, rawEntry, rawReveal) =>
        this.open(
          requireId(rawProjectId, 'project id'),
          requireId(rawThreadId, 'thread id'),
          rawDirectory,
          rawEntry,
          rawReveal === true
        )
    )
    ipcMain.handle(
      'design:thumbnail',
      async (_event, rawProjectId, rawThreadId, rawDirectory, rawEntry, rawWidth) =>
        this.thumbnail(
          requireId(rawProjectId, 'project id'),
          requireId(rawThreadId, 'thread id'),
          rawDirectory,
          rawEntry,
          typeof rawWidth === 'number' ? rawWidth : 480
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
    // The folders authored work is written into, and what the last change moved.
    // Read rather than pushed, because both surfaces that change a root (the
    // Design settings card and the board's own save path) ask immediately after
    // the save that caused the move.
    ipcMain.handle('design:workRootState', async () => ({
      roots: currentWorkRoots(),
      defaults: { ...DEFAULT_WORK_ROOTS },
      reports: currentWorkRootReports()
    }))
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
    void this.rememberThreadKind(input.threadId, input.kind)
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
    url: string
  ): Promise<BrowserTabMark> {
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
    // The row is left alone for the sweep and written by the navigation that puts
    // the tab back, so a gallery over a design cannot re-point the thread at
    // whichever screen happened to be captured last.
    if (!this.sweepingThreads.has(threadId)) {
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
  private async rememberThreadKind(threadId: string, kind: AuthoredWorkKind): Promise<void> {
    try {
      await this.threads.setAuthoredWorkKindViaWorker(threadId, kind)
    } catch (error) {
      Logger.dev('Authored-work kind row update failed:', error)
    }
  }

  forgetProject(projectId: string): void {
    this.designs.deleteProject(projectId)
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
    const items = await this.listWorkFolders(storedProject.path, root)
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
   * composition keeps the thread's tab, because its board holds one canvas. The
   * folder is validated and the browser opens it in the background, then the tab
   * is revealed: revealing is one mechanism, not two, so an existing tab and a
   * brand-new one behave the same way for the user.
   */
  async open(
    projectId: string,
    threadId: string,
    directory: unknown,
    entry: unknown,
    reveal: boolean
  ): Promise<DesignOpenResult> {
    const project = await requireLocalProjectViaWorker(this.options.database, projectId)
    const kind = await this.resolveKind(threadId)
    const result = await this.serveWork({
      kind,
      projectPath: project.path,
      projectId,
      threadId,
      directory,
      entry,
      attention: 'background',
      reveal,
      tab: kind === 'design' ? 'screen' : 'thread'
    })
    this.designs.upsert({
      projectId,
      threadId,
      directory: result.directory,
      entry: result.entry,
      kind
    })
    await this.rememberThreadKind(threadId, kind)
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
   * A small picture of the work, for the coordinator's preview.
   *
   * It is shown in the thread's own tab, off screen, then captured. That is
   * deliberate: the capture has to come from a page the app is actually rendering,
   * and a hidden tab is the same page the user would see, at the same size, without
   * a second browser and without stealing focus. A composition is captured as a
   * still at its opening, because a picture for a board must not start playback: a
   * frame is what the composition exists to draw, and the user asks for the moving
   * one by clicking Preview.
   */
  async thumbnail(
    projectId: string,
    threadId: string,
    directory: unknown,
    entry: unknown,
    width: number
  ): Promise<DesignThumbnail> {
    const project = await requireLocalProjectViaWorker(this.options.database, projectId)
    const browser = this.options.browser()
    const kind = await this.resolveKind(threadId)
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
      tab: 'thread',
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
      // Only the newest sweep clears the mark: an older one that is still winding
      // down must leave the suppression in place for the one that superseded it.
      if (this.sweepingThreads.get(threadId) === generation) {
        this.sweepingThreads.delete(threadId)
      }
      if (this.screenSweeps.get(threadId) === generation) {
        await this.restoreTab({
          projectId,
          threadId,
          projectPath: project.path,
          folder: folder.display,
          screens,
          before
        })
      }
    }
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
    await this.rememberThreadKind(input.threadId, input.kind)
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
     * Which tab the preview may use, design only.
     *
     * The board's open is the user choosing a screen, so every screen keeps its
     * own tab; the capability's own preview and both capture paths share the
     * thread's. A composition board holds one canvas, so it keeps the thread's
     * tab and the video path ignores this.
     */
    tab: 'thread' | 'screen'
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
      posterSeconds: input.posterSeconds,
      tab: input.tab
    }
    const result =
      input.kind === 'video'
        ? await openVideoPreview(deps, target)
        : await openDesignPreview(deps, target)
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
   * left on the design's entry file, which is what the board's own Preview button
   * would show. Writing the record happens through this navigation rather than
   * here: the sweep suppressed it for the duration, so this is the one write, and
   * it is the same guarded write any other navigation makes.
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
      await this.serveWork({
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
