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
 * agent runs, and the design coordinator's open and capture actions, which the
 * user runs. All of them must serve the folder on the same loopback origin, show
 * it in a browser tab, and mark that tab as a design so the element inspector
 * arms. Which tab is the caller's choice (see `tab` on the request): the
 * capability's own preview and every capture move through the thread's one tab,
 * while the board's open gives each screen a tab of its own. A second copy of
 * this would let the two drift, so it lives here.
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
  /** How the capability's own open behaves when it has to create the tab. The
   *  screen path ignores it: a screen tab is always mounted offscreen and brought
   *  forward only by `reveal`, because a user who clicked a canvas asked for it. */
  attention: 'focus' | 'background'
  /** Bring the tab to the user even when it already existed. */
  reveal: boolean
  /**
   * Which tab the preview may use.
   *
   * A capture and the capability's own preview belong in the thread's single tab:
   * they are the app moving through the work, and one tab keeps that movement in
   * one place. The board's open is the user choosing a screen, so it gets a tab
   * per screen: clicking one canvas never replaces another canvas's tab, and
   * clicking the same canvas again replaces only that screen's own tab.
   */
  tab: 'thread' | 'screen'
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

/**
 * Serve one design folder and show it in a browser tab.
 *
 * Which tab is the caller's choice (`tab`), so the board's canvas clicks can
 * each keep their own while the app's own captures share the thread's; the
 * browser is the authority on whether a tab still exists, not a memo here.
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
    if (request.tab === 'screen') {
      // A screen tab reveals (and un-reveals) through the open itself: the event
      // carries the URL that was asked for, where a separate reveal would read
      // the page a moment after its load started.
      const opened = await browser.openDesignScreen({
        projectId: request.projectId,
        threadId: request.threadId,
        directory: directory.display,
        // The file the URL resolves to is the screen's identity, so a screen
        // asked for as `index.html` and a default entry that lands on it are one
        // screen with one tab.
        entry: entry === null ? null : entry.segments.join('/'),
        url,
        reveal: request.reveal
      })
      tabId = opened.tabId
      tab = opened.tab
    } else {
      // The thread's tab is the app's own preview surface, and a capture moves it
      // while the app is idle: it goes through the app-owned path rather than the
      // agent's gated `navigate` operation, which needs a live conversation.
      const shown = await browser.showThreadWorkTab({
        projectId: request.projectId,
        threadId: request.threadId,
        url,
        attention: request.attention,
        reveal: request.reveal
      })
      tabId = shown.tabId
      tab = shown.tab
    }
    if (tabId) {
      // Marking the tab is what arms the element inspector: the panel offers
      // inspection only on a tab that is rendering a design.
      browser.markDesignTab(tabId, design)
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
