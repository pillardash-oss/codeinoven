import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { AUTHORED_WORK_ROOT_BY_KIND, authoredWorkKindOf } from '../../lib/design/authored-work'
import type {
  AuthoredWorkKind,
  DesignEntry,
  DesignOpenResult,
  DesignThumbnail,
  ThreadDesignCurrent,
  ThreadDesignState
} from '../../lib/ipc/design'
import { originOf } from '../../lib/local-development-url'
import { requireLocalProject } from '../../lib/project-artifacts'
import type { BrowserService } from '../browser/browser-service'
import { NO_TAB_MARK, type BrowserTabMark } from '../browser/browser-service/browser-tab-mark'
import type { Database } from '../database/database'
import { AgentMessageRepo } from '../database/repositories/agent-message-repo'
import { DesignRepo } from '../database/repositories/design-repo'
import { ProjectRepo } from '../database/repositories/project-repo'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { isCioDesignRequest, CIO_DESIGN_TAG } from '../utilities/cio-design-prompt'
import { isCioVideoRequest, CIO_VIDEO_TAG } from '../utilities/cio-video-prompt'
import { openVideoPreview } from '../video/video-preview-session'
import { readCompositionManifest } from '../video/video-manifest'
import { listProjectWorkFolders } from './design-listing'
import { openDesignPreview } from './design-preview-session'

/**
 * What the app knows about a thread's authored work, and how the user gets back to it.
 *
 * Two sessions have the same shape, and this is the single service behind their
 * board: a design session (`@cio-design`, written into `.cio/designs/<name>/`) and
 * a video session (`@cio-video`, written into `.cio/videos/<name>/`). Three facts
 * have to survive a restart for a coordinator to be useful:
 *
 *   - that the thread is in a session (the tag, read from the persisted messages,
 *     exactly as the chat engine decides it);
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
 * The second a composition's board picture is taken at.
 *
 * The opening, because it is always a valid second for any composition: a later one
 * would need the manifest read first and could sit past a composition shorter than
 * it, turning a picture into a failure.
 */
const POSTER_SECONDS = 0

/** The later of a thread's two session tags. */
interface SessionTag {
  kind: AuthoredWorkKind
  /** When it was typed (ms), so a previewed folder can be weighed against it. */
  at: number
}

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
 * Ceiling on how many threads one marker read may name.
 *
 * A list of thread rows is bounded by what the sidebar draws, so this is a guard on
 * the boundary rather than a limit the app reaches: it stops a malformed or hostile
 * call from asking for the whole history in one query.
 */
const MAX_MARKER_THREADS = 400

/** Identifier-list validation for the batched marker read. */
function requireThreadIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_MARKER_THREADS) {
    throw new TypeError('thread ids are invalid')
  }
  return value.map((entry) => requireId(entry, 'thread id'))
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
  private readonly messages: AgentMessageRepo
  /** Canonical spelling of a project's path per stored spelling, filled on first use. */
  private readonly canonicalProjects = new Map<string, string>()

  constructor(private readonly options: DesignServiceOptions) {
    this.designs = new DesignRepo(options.database)
    this.messages = new AgentMessageRepo(options.database)
  }

  registerIpc(): void {
    ipcMain.handle('design:state', async (_event, rawProjectId, rawThreadId) =>
      this.stateFor(requireId(rawProjectId, 'project id'), requireId(rawThreadId, 'thread id'))
    )
    ipcMain.handle('design:kinds', async (_event, rawProjectId, rawThreadIds) =>
      this.sessionKinds(requireId(rawProjectId, 'project id'), requireThreadIds(rawThreadIds))
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
  }

  /** Forget a thread's authored-work record when the thread itself is gone. */
  forgetThread(threadId: string): void {
    this.designs.deleteThread(threadId)
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
      requireLocalProject(this.options.database, projectId).path,
      root
    )
    if (directory === null) return NO_TAB_MARK
    const kind = authoredWorkKindOf(directory)
    if (kind === null) return NO_TAB_MARK
    this.rememberShownFolder({
      projectId,
      threadId,
      directory,
      entry: entryWithinOrigin(url, origin),
      kind
    })
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
   * Which authored-work session each of these threads is in, for a list of thread rows.
   *
   * The same two facts {@link stateFor} weighs, read for many threads at once: the
   * folder a thread last previewed and the session tags it typed. The caller draws the
   * ids from the rows on screen, so the cost follows the list rather than the project's
   * history, and the answer is the app's own notion of a session rather than a second
   * one that could disagree with the coordinator board.
   *
   * A thread in neither is left out instead of defaulting to a design: the caller's
   * fallback is its own evidence, and answering "design" here would put a marker on an
   * ordinary thread.
   */
  sessionKinds(projectId: string, threadIds: readonly string[]): Record<string, AuthoredWorkKind> {
    const project = new ProjectRepo(this.options.database).get(projectId)
    if (!project || project.source !== 'local' || !project.path) return {}
    const ids = [...new Set(threadIds)]
    const kinds: Record<string, AuthoredWorkKind> = {}
    if (ids.length === 0) return kinds
    const folders = this.designs.forThreads(projectId, ids)
    const tags = this.latestSessionTags(projectId, ids)
    for (const threadId of ids) {
      const folder = folders.get(threadId) ?? null
      const tag = tags.get(threadId) ?? null
      if (folder === null && tag === null) continue
      kinds[threadId] = this.kindFor(folder, tag)
    }
    return kinds
  }

  /**
   * The later session tag of each thread, read for many threads in one query.
   *
   * The same rule as {@link latestSessionTag}, applied to a batched read: video wins a
   * same-timestamp tie so a compound invocation reads the same way every time, and
   * otherwise the later message wins. The rows come back with only the messages whose
   * stored parts mention a tag, so the exact detectors still decide.
   */
  private latestSessionTags(
    projectId: string,
    threadIds: readonly string[]
  ): Map<string, SessionTag> {
    const latest = new Map<string, SessionTag>()
    const messages = this.messages.loadUserMessagesMentioning(projectId, threadIds, [
      CIO_DESIGN_TAG,
      CIO_VIDEO_TAG
    ])
    for (const message of messages) {
      const found = latest.get(message.threadId)
      if (
        isCioVideoRequest(message.content) &&
        (found === undefined || message.createdAt >= found.at)
      ) {
        latest.set(message.threadId, { kind: 'video', at: message.createdAt })
        continue
      }
      if (
        isCioDesignRequest(message.content) &&
        (found === undefined || message.createdAt > found.at)
      ) {
        latest.set(message.threadId, { kind: 'design', at: message.createdAt })
      }
    }
    return latest
  }

  forgetProject(projectId: string): void {
    this.designs.deleteProject(projectId)
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
    const storedProject = new ProjectRepo(this.options.database).get(projectId)
    if (!storedProject || storedProject.source !== 'local' || !storedProject.path) {
      return {
        projectId,
        threadId,
        kind: 'design',
        active: false,
        current: null,
        items: [],
        defaultDirectory: AUTHORED_WORK_ROOT_BY_KIND.design
      }
    }
    const project = requireLocalProject(this.options.database, projectId)
    const current = this.designs.forThread(threadId)
    const tagged = this.latestSessionTag(threadId)
    const kind = this.kindFor(current, tagged)
    const root = AUTHORED_WORK_ROOT_BY_KIND[kind]
    const items = await this.listWorkFolders(project.path, root)
    return {
      projectId,
      threadId,
      kind,
      active: current !== null || tagged !== null,
      current,
      items,
      defaultDirectory: current?.directory ?? items[0]?.directory ?? root
    }
  }

  /**
   * Show a thread's work in its browser tab at the user's request.
   *
   * The folder is validated and the browser opens it in the background, then the
   * tab is revealed: revealing is one mechanism, not two, so an existing tab and a
   * brand-new one behave the same way for the user.
   */
  async open(
    projectId: string,
    threadId: string,
    directory: unknown,
    entry: unknown,
    reveal: boolean
  ): Promise<DesignOpenResult> {
    const project = requireLocalProject(this.options.database, projectId)
    const kind = this.resolveKind(threadId)
    const result = await this.serveWork({
      kind,
      projectPath: project.path,
      projectId,
      threadId,
      directory,
      entry,
      attention: 'background',
      reveal
    })
    this.designs.upsert({
      projectId,
      threadId,
      directory: result.directory,
      entry: result.entry,
      kind
    })
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
    const project = requireLocalProject(this.options.database, projectId)
    const browser = this.options.browser()
    const kind = this.resolveKind(threadId)
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
   * unconditionally would also keep refreshing `updated_at`, which is what the kind
   * is weighed against, so a folder left open in a tab would outrank a tag typed
   * afterwards.
   */
  private rememberShownFolder(input: {
    projectId: string
    threadId: string
    directory: string
    entry: string | null
    kind: AuthoredWorkKind
  }): void {
    const current = this.designs.forThread(input.threadId)
    if (
      current &&
      current.directory === input.directory &&
      current.entry === input.entry &&
      current.kind === input.kind
    ) {
      return
    }
    this.designs.upsert(input)
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

  /** Which session the thread is in, from the record and the persisted tags. */
  private resolveKind(threadId: string): AuthoredWorkKind {
    return this.kindFor(this.designs.forThread(threadId), this.latestSessionTag(threadId))
  }

  /**
   * Which session a thread is in, from the two facts that say so.
   *
   * A thread can move between the sessions, so the newest evidence wins: the folder
   * it last previewed when that folder is newer than either tag, otherwise the tag
   * typed last. The folder is what makes the board follow the agent from a design
   * into a composition (or back) without a reload, and the tags are what make it
   * appear before the agent has previewed anything at all. The folder's kind is the
   * one recorded with it, so this answer does not depend on the folder still
   * sitting where the app expects it.
   */
  private kindFor(
    current: ThreadDesignCurrent | null,
    tagged: SessionTag | null
  ): AuthoredWorkKind {
    if (current && (tagged === null || current.updatedAt >= tagged.at)) return current.kind
    return tagged?.kind ?? 'design'
  }

  /**
   * The later of the thread's two session tags, or null when it opened neither.
   *
   * Read from the persisted messages rather than kept in memory, so it survives a
   * restart and is undone by an edit or rollback that removes the tag. This is the
   * same rule the chat engine applies when it decides a turn's session mode.
   */
  private latestSessionTag(threadId: string): SessionTag | null {
    let latest: SessionTag | null = null
    for (const message of this.messages.loadUserMessagesByThread(threadId)) {
      // One message carrying both tags is a video session: the narrower tag wins
      // the tie, so a compound invocation reads the same way every time.
      if (
        isCioVideoRequest(message.content) &&
        (latest === null || message.createdAt >= latest.at)
      ) {
        latest = { kind: 'video', at: message.createdAt }
        continue
      }
      if (
        isCioDesignRequest(message.content) &&
        (latest === null || message.createdAt > latest.at)
      ) {
        latest = { kind: 'design', at: message.createdAt }
      }
    }
    return latest
  }

  /**
   * Serve one folder of authored work and put it in the thread's browser tab.
   *
   * The design path and the video path share every step but the folder resolver
   * and one design-only side effect (marking the tab, which is what arms the
   * element inspector), so the choice lives here rather than in each caller: the
   * capability's own preview, the board's open and the board's thumbnail all have
   * to agree about which folder is on screen.
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
      attention: input.attention,
      reveal: input.reveal,
      posterSeconds: input.posterSeconds
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
}
