import type { BrowserDesignTab } from '../../lib/ipc/browser'
import type { BrowserService } from '../browser/browser-service'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import {
  SERVED_FOLDER_ENTRY_FILE,
  resolveServedEntry,
  resolveServedFolder,
  servedFileUrl
} from '../preview/served-folder'

/**
 * One way to put a design on screen.
 *
 * Two callers need it: the design capability's `preview` operation, which the
 * agent runs, and the design coordinator's open and thumbnail actions, which the
 * user runs. Both must serve the folder on the same loopback origin, show it in
 * the same thread tab, and mark that tab as a design so the element inspector
 * arms. A second copy of this would let the two drift, so it lives here.
 */

/** File the folder is expected to hold, and the one a preview falls back to. */
export const DESIGN_ENTRY_FILE = SERVED_FOLDER_ENTRY_FILE

export interface DesignPreviewDeps {
  previews: DirectoryPreviewService
  /** Read lazily: the service exists only while the app has a window to host tabs. */
  browser: () => BrowserService | null
}

export interface DesignPreviewRequest {
  projectPath: string
  projectId: string
  threadId: string
  /**
   * Project-relative folder, as the caller spelled it. Validated here rather
   * than at each call site, so the agent's untrusted input and the coordinator's
   * IPC argument go through one check.
   */
  directory: unknown
  /**
   * Project-relative entry inside the folder, or null/undefined for the default.
   */
  entry: unknown
  /**
   * The folder to default to when the caller names none, which is the user's
   * configured design root.
   */
  defaultRoot: string
  /** How the capability's own open behaves when it has to create the tab. */
  attention: 'focus' | 'background'
  /** Bring the tab to the user even when it already existed. */
  reveal: boolean
}

export interface DesignPreviewResult {
  /** Project-relative folder, with forward slashes. */
  directory: string
  /** Entry file shown, or null for the folder listing. */
  entry: string | null
  url: string
  origin: string
  served: 'file' | 'folder listing'
  tab: 'reused' | 'opened' | null
  tabId: string | null
}

/** The tab id an in-app browser operation reported, or null when it reported none. */
function tabIdOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const tabId = (result as Record<string, unknown>)['tabId']
  return typeof tabId === 'string' && tabId.length > 0 ? tabId : null
}

/**
 * Serve one design folder and show it in the project and thread's browser tab.
 *
 * The thread has one agent tab, so a preview of a folder the thread already has
 * open navigates that tab instead of stacking a second one; the browser is the
 * authority on whether it still exists, not a memo here.
 */
export async function openDesignPreview(
  deps: DesignPreviewDeps,
  request: DesignPreviewRequest
): Promise<DesignPreviewResult> {
  const directory = resolveServedFolder(request.projectPath, request.directory, request.defaultRoot)
  const registration = await deps.previews.open(directory.absolute).catch((error: unknown) => {
    throw new Error(
      `The design folder "${directory.display}" is not there yet. Write the design into it first, or name a folder that exists. Underlying error: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  const entry = await resolveServedEntry(directory.absolute, request.entry)
  const url = servedFileUrl(registration.url, entry)
  const origin = new URL(registration.url).origin
  const design: BrowserDesignTab = { directory: directory.display, origin }

  const browser = deps.browser()
  let tab: 'reused' | 'opened' | null = null
  let tabId: string | null = null
  if (browser) {
    const target = { projectId: request.projectId, threadId: request.threadId }
    if (browser.agentTabFor(request.projectId, request.threadId)) {
      tabId = tabIdOf(await browser.executeUtility('navigate', { url }, target))
      tab = 'reused'
    } else {
      tabId = tabIdOf(
        await browser.executeUtility('open', { url, attention: request.attention }, target)
      )
      tab = 'opened'
    }
    if (tabId) {
      // Marking the tab is what arms the element inspector: the panel offers
      // inspection only on a tab that is rendering a design.
      browser.markDesignTab(tabId, design)
      // The capability's own open reveals; a reused tab does not, so a design the
      // user asked for again is brought forward explicitly.
      if (request.reveal) browser.revealTab(tabId)
    }
  }

  return {
    directory: directory.display,
    entry: entry?.requested ?? null,
    url,
    origin,
    served: entry ? 'file' : 'folder listing',
    tab,
    tabId
  }
}
