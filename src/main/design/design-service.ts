import { DESIGN_OUTPUT_ROOT } from '../../lib/design-skill'
import type {
  DesignEntry,
  DesignOpenResult,
  DesignThumbnail,
  ThreadDesignState
} from '../../lib/ipc/design'
import { requireLocalProject } from '../../lib/project-artifacts'
import type { BrowserService } from '../browser/browser-service'
import type { Database } from '../database/database'
import { AgentMessageRepo } from '../database/repositories/agent-message-repo'
import { DesignRepo } from '../database/repositories/design-repo'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { isCioDesignRequest } from '../utilities/cio-design-prompt'
import { listProjectDesigns } from './design-listing'
import { openDesignPreview } from './design-preview-session'

/**
 * What the app knows about a thread's design, and how the user gets back to it.
 *
 * A design session is started by the user with `@cio-design` and rendered by the
 * agent into `.cio/designs/<name>/`. Three facts have to survive a restart for
 * the coordinator to be useful:
 *
 *   - that the thread is a design session (the tag, read from the persisted
 *     messages, exactly as the chat engine decides it);
 *   - which design folder the thread is working on (the `thread_designs` row,
 *     written on every preview);
 *   - what designs exist at all (a listing of the project's `.cio/designs`).
 *
 * The first is derived, the second is remembered, the third is read from disk.
 * Nothing here decides anything about the design itself.
 */

/** Ceiling on the thumbnail width a caller may ask for. */
const MIN_THUMBNAIL_WIDTH = 160
const MAX_THUMBNAIL_WIDTH = 1_200

/** Identifier validation for the two ids every call carries. */
function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

export interface DesignServiceOptions {
  database: Database
  previews: DirectoryPreviewService
  browser: () => BrowserService | null
}

export class DesignService {
  private readonly designs: DesignRepo
  private readonly messages: AgentMessageRepo

  constructor(private readonly options: DesignServiceOptions) {
    this.designs = new DesignRepo(options.database)
    this.messages = new AgentMessageRepo(options.database)
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
  }

  /** Forget a thread's design record when the thread itself is gone. */
  forgetThread(threadId: string): void {
    this.designs.deleteThread(threadId)
  }

  /**
   * Remember the folder a preview showed.
   *
   * The design capability calls this after every preview, so the agent's choice
   * of folder is what a restarted app restores. A thread is on one design at a
   * time, so a later preview re-points the row instead of adding a second one.
   */
  recordPreview(input: {
    projectId: string
    threadId: string
    directory: string
    entry: string | null
  }): void {
    this.designs.upsert(input)
  }

  forgetProject(projectId: string): void {
    this.designs.deleteProject(projectId)
  }

  /**
   * Everything a coordinator renders for one thread.
   *
   * `active` is true when the thread has ever opened a design session, whether
   * or not it has previewed anything yet: the user typed the tag, so the design
   * work exists even before the first screen is written, and the coordinator's
   * preview button has to be there to open it.
   */
  async stateFor(projectId: string, threadId: string): Promise<ThreadDesignState> {
    const project = requireLocalProject(this.options.database, projectId)
    const designs = await this.listDesigns(project.path)
    const current = this.designs.forThread(threadId)
    return {
      projectId,
      threadId,
      active: current !== null || this.hasDesignTag(threadId),
      current,
      designs,
      defaultDirectory: current?.directory ?? designs[0]?.directory ?? DESIGN_OUTPUT_ROOT
    }
  }

  /**
   * Show a design in the thread's browser tab at the user's request.
   *
   * The folder is validated and the browser opens it in the background, then the
   * tab is revealed: revealing is one mechanism, not two, so an existing tab and
   * a brand-new one behave the same way for the user.
   */
  async open(
    projectId: string,
    threadId: string,
    directory: unknown,
    entry: unknown,
    reveal: boolean
  ): Promise<DesignOpenResult> {
    const project = requireLocalProject(this.options.database, projectId)
    const result = await openDesignPreview(
      { previews: this.options.previews, browser: this.options.browser },
      {
        projectPath: project.path,
        projectId,
        threadId,
        directory,
        entry,
        attention: 'background',
        reveal
      }
    )
    this.designs.upsert({
      projectId,
      threadId,
      directory: result.directory,
      entry: result.entry
    })
    if (!result.tabId) {
      throw new Error('The design opened without a browser tab to show it in.')
    }
    return {
      directory: result.directory,
      entry: result.entry,
      url: result.url,
      tabId: result.tabId
    }
  }

  /**
   * A small picture of a design, for the coordinator's preview.
   *
   * The design is shown in the thread's own tab, off screen, then captured. That
   * is deliberate: the capture has to come from a page the app is actually
   * rendering, and a hidden tab is the same page the user would see, at the same
   * size, without a second browser and without stealing focus.
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
    const result = await openDesignPreview(
      { previews: this.options.previews, browser: this.options.browser },
      {
        projectPath: project.path,
        projectId,
        threadId,
        directory,
        // The entry is passed through so the picture is the page the user is
        // actually looking at, not always the folder's index file.
        entry,
        attention: 'background',
        reveal: false
      }
    )
    if (!browser || !result.tabId) {
      return { directory: result.directory, dataUrl: null, width: 0, height: 0 }
    }
    await browser.waitForTabLoad(result.tabId)
    const captured = await browser.captureThumbnail(
      result.tabId,
      Math.min(MAX_THUMBNAIL_WIDTH, Math.max(MIN_THUMBNAIL_WIDTH, Math.round(width)))
    )
    return captured
      ? { directory: result.directory, ...captured }
      : { directory: result.directory, dataUrl: null, width: 0, height: 0 }
  }

  /**
   * Every design folder in a project, newest first.
   *
   * The folder listing is the registry of designs: `.cio/designs/<name>/` is the
   * documented layout, so a design another thread wrote is found here without
   * anything having registered it.
   */
  async listDesigns(projectPath: string): Promise<DesignEntry[]> {
    return listProjectDesigns(projectPath)
  }

  /**
   * Whether the thread ever opened a design session.
   *
   * Read from the persisted messages rather than kept in memory, so it survives a
   * restart and is undone by an edit or rollback that removes the tag. This is
   * the same rule the chat engine applies when it decides a turn's session mode.
   */
  private hasDesignTag(threadId: string): boolean {
    return this.messages
      .loadUserMessagesByThread(threadId)
      .some((message) => isCioDesignRequest(message.content))
  }
}
