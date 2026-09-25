import { requireLocalProject } from '../../lib/project-artifacts'
import type { AuthoredWorkKind } from '../../lib/ipc/design'
import type { BrowserService } from '../browser/browser-service'
import { openDesignPreview } from '../design/design-preview-session'
import type { Database } from '../database/database'
import type { DesignCapabilityExecutor } from '../utilities/utility-orchestration-service'
import type { DirectoryPreviewService } from './directory-preview-service'

/**
 * What the design capability needs from the app.
 *
 * The browser is supplied as a getter because the service exists only while the
 * app has a window to host tabs in. Serving the folder must still work without
 * one, so a missing browser degrades to a URL rather than a failure.
 *
 * `record` is how the preview becomes durable: the folder the agent chose is
 * written to the design registry, which is what lets a restarted app put the
 * user back on their design instead of leaving them with no way to find it.
 */
export interface DesignPreviewExecutorOptions {
  previews: DirectoryPreviewService
  database: Database
  browser: () => BrowserService | null
  record: (input: {
    projectId: string
    threadId: string
    directory: string
    entry: string | null
    kind: AuthoredWorkKind
  }) => void
}

/**
 * Run the app-owned design capability's `preview` operation.
 *
 * The service behind this is the same loopback static host the file explorer
 * uses for "Open in browser" (`src/main/preview/directory-preview-server.ts`),
 * so a design renders with its own scripts and stylesheets running and with no
 * content security policy of its own. What the agent gets back is the URL, plus
 * the thread's browser tab showing it, and then the in-app browser capability's
 * `screenshot`, `viewport`, `snapshot` and `console` operations apply to that
 * tab without any new machinery here.
 *
 * The showing itself lives in `design-preview-session.ts`, because the design
 * coordinator's open and thumbnail actions do the same thing on the user's
 * behalf; a second copy here would be a second thing to keep in step.
 */
export function createDesignPreviewExecutor(
  options: DesignPreviewExecutorOptions
): DesignCapabilityExecutor {
  return async (operation, input, context) => {
    if (operation !== 'preview') {
      throw new Error(
        `The design capability exposes one operation, "preview", and no operation named "${operation}".`
      )
    }
    const project = requireLocalProject(options.database, context.projectId)
    const attention = input['attention'] === 'background' ? 'background' : 'focus'
    const result = await openDesignPreview(
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
      kind: 'design'
    })

    return {
      url: result.url,
      directory: result.directory,
      entry: result.entry,
      served: result.served,
      attention,
      tab: result.tab,
      note: result.tab
        ? 'Activate the in-app browser capability to screenshot this tab, change its viewport, or read its console.'
        : 'No browser tab was opened, so this URL is for the user to open while the app is running.'
    }
  }
}
