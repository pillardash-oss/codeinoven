import { authoredWorkRootSync } from '../design/authored-work-root'
import type { AuthoredWorkKind } from '../../lib/ipc/design'
import { workFolderNote } from '../../lib/design/work-roots'
import type { BrowserService } from '../browser/browser-service'
import type { Database } from '../database/database'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import type { VideoCapabilityExecutor } from '../utilities/utility-orchestration-service'
import { currentWorkRoot, projectWorkRootPaths } from '../design/work-roots-state'
import { openVideoPreview } from './video-preview-session'
import { DesignRepo } from '../database/repositories/design-repo'
import { runDesignReview } from '../design/design-review-service'

/**
 * What the video capability's `preview` operation needs from the app.
 *
 * The browser is supplied as a getter because the service exists only while the
 * app has a window to host tabs in. Serving the folder must still work without
 * one, so a missing browser degrades to a URL rather than a failure.
 */
export interface VideoPreviewExecutorOptions {
  studio?: VideoCapabilityExecutor
  previews: DirectoryPreviewService
  database: Database
  checkpoint: (
    projectId: string,
    threadId: string,
    input: Record<string, unknown>
  ) => Promise<unknown>
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
    if (operation === 'critique')
      return runDesignReview(options.database, context, input, true, 'video')
    if (operation !== 'preview' && operation !== 'checkpoint' && options.studio)
      return options.studio(operation, input, context)
    if (operation === 'checkpoint')
      return options.checkpoint(context.projectId, context.threadId, input)
    if (operation !== 'preview') {
      throw new Error(
        `The video capability's "preview" executor received the operation "${operation}".`
      )
    }
    const scope = authoredWorkRootSync(options.database, context.projectId, context.threadId)
    const attention = input['attention'] === 'focus' ? 'focus' : 'background'
    const result = await openVideoPreview(
      { previews: options.previews, browser: options.browser },
      {
        projectPath: scope.path,
        projectId: context.projectId,
        threadId: context.threadId,
        directory:
          typeof input['directory'] === 'string'
            ? new DesignRepo(options.database).resolveDirectory(
                context.projectId,
                input['directory']
              )
            : input['directory'],
        entry: input['entry'],
        defaultRoot: currentWorkRoot('video', context.projectId),
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

    const folderNote = workFolderNote(
      'video',
      result.directory,
      projectWorkRootPaths(context.projectId, 'video'),
      currentWorkRoot('video', context.projectId)
    )
    const tabNote = result.tab
      ? 'The tab keeps itself current: it refreshes shortly after a file changes, so you do not re-preview after every edit. Use the `capture` operation to freeze an exact frame and look at it.'
      : 'No browser tab was opened, so this URL is for the user to open while the app is running.'
    return {
      url: result.url,
      directory: result.directory,
      entry: result.entry,
      served: result.served,
      attention,
      tab: result.tab,
      note: [folderNote, tabNote].filter(Boolean).join(' ')
    }
  }
}
