import { requireLocalProject, requireLocalProjectViaWorker } from '../../lib/project-artifacts'
import type { AuthoredWorkKind } from '../../lib/ipc/design'
import type { BrowserService } from '../browser/browser-service'
import { openDesignPreview } from '../design/design-preview-session'
import { currentWorkRoot } from '../design/work-roots-state'
import type { Database } from '../database/database'
import type { DesignCapabilityExecutor } from '../utilities/utility-orchestration-service'
import type { DirectoryPreviewService } from './directory-preview-service'
import { readDesignContracts, writeDesignContract } from '../design/design-contract-service'
import { runDesignReview } from '../design/design-review-service'
import { executeDesignMotion } from '../design/design-motion-service'
import { extractDesignReference } from '../design/design-reference-service'
import { DesignRepo } from '../database/repositories/design-repo'

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
  checkpoint: (
    projectId: string,
    threadId: string,
    input: Record<string, unknown>
  ) => Promise<unknown>
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
    if (['motion-read', 'motion-preview', 'motion-apply', 'motion-inspect'].includes(operation))
      return executeDesignMotion(options, operation, input, context)
    if (operation === 'lint' || operation === 'critique')
      return runDesignReview(options.database, context, input, operation === 'critique')
    if (operation === 'extract-reference') return extractDesignReference(input['url'])
    if (operation === 'read-contract' || operation === 'write-contract') {
      const project = await requireLocalProjectViaWorker(options.database, context.projectId)
      return operation === 'read-contract'
        ? readDesignContracts(project.path)
        : writeDesignContract(project.path, input['markdown'])
    }
    if (operation === 'checkpoint')
      return options.checkpoint(context.projectId, context.threadId, input)
    if (operation !== 'preview') {
      throw new Error(
        `The design preview executor handles preview and checkpoint, and no operation named "${operation}".`
      )
    }
    const project = requireLocalProject(options.database, context.projectId)
    const attention = input['attention'] === 'focus' ? 'focus' : 'background'
    const result = await openDesignPreview(
      { previews: options.previews, browser: options.browser },
      {
        projectPath: project.path,
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
        defaultRoot: currentWorkRoot('design', context.projectId),
        attention,
        reveal: false,
        // The agent's own preview moves through the thread's one tab: it is the
        // work being shown, not the user choosing a canvas, and a tab per screen
        // here would leave the tag's tab strip full of the agent's steps.
        tab: 'thread'
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
