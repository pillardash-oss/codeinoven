import { requireLocalProject } from '../../lib/project-artifacts'
import type { AuthoredWorkKind } from '../../lib/ipc/design'
import type { BrowserService } from '../browser/browser-service'
import type { Database } from '../database/database'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import type { VideoCapabilityExecutor } from '../utilities/utility-orchestration-service'
import { openVideoPreview } from './video-preview-session'

/**
 * What the video capability's `preview` operation needs from the app.
 *
 * The browser is supplied as a getter because the service exists only while the
 * app has a window to host tabs in. Serving the folder must still work without
 * one, so a missing browser degrades to a URL rather than a failure.
 */
export interface VideoPreviewExecutorOptions {
  previews: DirectoryPreviewService
  database: Database
  browser: () => BrowserService | null
  /**
   * How the preview becomes durable: the composition folder the agent chose is
   * written to the thread's authored-work row, the same one the design capability
   * writes. That is what makes the coordinator follow the agent into a video
   * session live, and what puts a restarted user back on their composition.
   */
  record: (input: {
    projectId: string
    threadId: string
    directory: string
    entry: string | null
    kind: AuthoredWorkKind
  }) => void
}

/**
 * Run the app-owned video capability's `preview` operation.
 *
 * The service behind this is the same loopback static host the file explorer and
 * the design capability use, so a composition renders with its own scripts and
 * stylesheets running and with no content security policy of its own, and the
 * tab refreshes itself as the agent writes because the preview server watches
 * the served folder. What the agent gets back is the URL, plus the thread's
 * browser tab showing it.
 */
export function createVideoPreviewExecutor(
  options: VideoPreviewExecutorOptions
): VideoCapabilityExecutor {
  return async (operation, input, context) => {
    if (operation !== 'preview') {
      throw new Error(
        `The video capability's "preview" executor received the operation "${operation}".`
      )
    }
    const project = requireLocalProject(options.database, context.projectId)
    const attention = input['attention'] === 'background' ? 'background' : 'focus'
    const result = await openVideoPreview(
      { previews: options.previews, browser: options.browser },
      {
        projectPath: project.path,
        projectId: context.projectId,
        threadId: context.threadId,
        directory: input['directory'],
        entry: input['entry'],
        attention,
        reveal: false
      }
    )
    options.record({
      projectId: context.projectId,
      threadId: context.threadId,
      directory: result.directory,
      entry: result.entry,
      kind: 'video'
    })

    return {
      url: result.url,
      directory: result.directory,
      entry: result.entry,
      served: result.served,
      attention,
      tab: result.tab,
      note: result.tab
        ? 'The tab keeps itself current: it refreshes shortly after a file changes, so you do not re-preview after every edit. Use the `capture` operation to freeze an exact frame and look at it.'
        : 'No browser tab was opened, so this URL is for the user to open while the app is running.'
    }
  }
}
