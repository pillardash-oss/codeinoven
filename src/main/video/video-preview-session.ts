import type { BrowserService } from '../browser/browser-service'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import { resolveServedEntry, resolveServedFolder, servedFileUrl } from '../preview/served-folder'
import { videoCaptureUrl } from '../../lib/video/project'

/**
 * One way to put a composition on screen.
 *
 * Two callers need it: the video capability's `preview` operation, which the
 * agent runs to watch the work, and its `capture` operation, which loads the
 * same folder frozen at one second. Both must serve the folder on the same
 * loopback origin and show it in the same thread tab, so the serve-and-show
 * path lives here and the two cannot drift.
 *
 * A viewing and a capture differ by one query parameter. The project reads
 * `cio-capture` and `cio-time` to know it should draw a single frame and start
 * no animation loop, so the app can load the same page either way. That is
 * `src/lib/video/project.ts`'s contract, and this is the one place the app
 * builds the URL that expresses it.
 */

export interface VideoPreviewDeps {
  previews: DirectoryPreviewService
  /** Read lazily: the service exists only while the app has a window to host tabs. */
  browser: () => BrowserService | null
}

export interface VideoPreviewRequest {
  projectPath: string
  projectId: string
  threadId: string
  /**
   * Project-relative folder, as the caller spelled it. Validated here rather
   * than at each call site, so a model-written argument and any other caller go
   * through one check.
   */
  directory: unknown
  /** Project-relative entry inside the folder, or null/undefined for the default. */
  entry: unknown
  /**
   * The folder to default to when the caller names none, which is the user's
   * configured composition root.
   */
  defaultRoot: string
  /** How the capability's own open behaves when it has to create the tab. */
  attention: 'focus' | 'background'
  /** Bring the tab to the user even when it already existed. */
  reveal: boolean
  /**
   * When set, the tab loads the composition frozen at this second instead of
   * moving. The caller still draws the frame itself before capturing; this only
   * stops the page racing the capture while it settles.
   */
  captureSeconds?: number
  /**
   * When set, a tab that is not already watching this composition loads it frozen
   * at this second instead of moving.
   *
   * A picture for the coordinator's board is a still, so opening a board must not
   * start the composition playing and sounding in a tab the user never asked for.
   * That is the whole difference between this and `captureSeconds`: a capture is
   * the agent asking for one exact frame, while a poster is the board asking for
   * something to look at. A poster therefore leaves a composition that is already
   * moving alone, because that page is one the user asked for.
   */
  posterSeconds?: number
}

export interface VideoPreviewResult {
  /** Project-relative folder, with forward slashes. */
  directory: string
  /** Entry file shown, or null for the folder listing. */
  entry: string | null
  /** The URL a viewing loads: the composition moving. */
  playUrl: string
  /**
   * The URL the tab actually holds when this returns.
   *
   * Usually the URL that was asked for, and its frozen form for a capture or a
   * poster. It is `playUrl` when an already-watching tab was left alone, so a
   * caller is never told a page was loaded that was not.
   */
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
 * Serve one composition folder and show it in the project and thread's browser tab.
 *
 * The thread has one agent tab, so a preview of a folder the thread already has
 * open navigates that tab instead of stacking a second one; the browser is the
 * authority on whether it still exists, not a memo here.
 */
export async function openVideoPreview(
  deps: VideoPreviewDeps,
  request: VideoPreviewRequest
): Promise<VideoPreviewResult> {
  const directory = resolveServedFolder(request.projectPath, request.directory, request.defaultRoot)
  const registration = await deps.previews.open(directory.absolute).catch((error: unknown) => {
    throw new Error(
      `The composition folder "${directory.display}" is not there yet. Write the composition into it first, or name a folder that exists. Underlying error: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  const entry = await resolveServedEntry(directory.absolute, request.entry)
  const playUrl = servedFileUrl(registration.url, entry)
  // The frozen form of the playing page is built here, so a capture and a poster
  // cannot disagree about how one composition is asked for.
  const posterUrl =
    request.posterSeconds === undefined ? null : videoCaptureUrl(playUrl, request.posterSeconds)
  const url =
    request.captureSeconds === undefined
      ? (posterUrl ?? playUrl)
      : videoCaptureUrl(playUrl, request.captureSeconds)
  const origin = new URL(registration.url).origin

  const browser = deps.browser()
  let tab: 'reused' | 'opened' | null = null
  let tabId: string | null = null
  // What the tab holds when this returns, which is not always what was asked for:
  // a tab already watching this composition is left on the moving page.
  let loaded = url
  if (browser) {
    const target = { projectId: request.projectId, threadId: request.threadId }
    const existing = browser.agentTabFor(request.projectId, request.threadId)
    if (existing) {
      tabId = existing
      tab = 'reused'
      const showing = browser.tabUrl(tabId)
      // A composition the user is already watching is theirs, so a poster request
      // must not replace the moving page with a still under their eyes. The page
      // already on screen is also the one being asked for again, so nothing is
      // reloaded then either: a refresh here means a fresh picture, not a new load.
      const watching = posterUrl !== null && showing === playUrl
      if (watching) {
        loaded = playUrl
      } else if (showing !== url) {
        tabId = tabIdOf(await browser.executeUtility('navigate', { url }, target)) ?? tabId
      }
    } else {
      tabId = tabIdOf(
        await browser.executeUtility('open', { url, attention: request.attention }, target)
      )
      tab = 'opened'
    }
    // The capability's own open reveals; a reused tab does not, so a composition
    // the user asked for again is brought forward explicitly.
    if (tabId && request.reveal) browser.revealTab(tabId)
  }

  return {
    directory: directory.display,
    entry: entry?.requested ?? null,
    playUrl,
    url: loaded,
    origin,
    served: entry ? 'file' : 'folder listing',
    tab,
    tabId
  }
}
