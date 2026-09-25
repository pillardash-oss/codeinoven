import type { BrowserService } from '../browser/browser-service'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import { resolveServedEntry, servedFileUrl } from '../preview/served-folder'
import { videoCaptureUrl } from '../../lib/video/project'
import { resolveVideoDirectory } from './video-paths'

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
}

export interface VideoPreviewResult {
  /** Project-relative folder, with forward slashes. */
  directory: string
  /** Entry file shown, or null for the folder listing. */
  entry: string | null
  /** The URL a viewing loads: the composition moving. */
  playUrl: string
  /** The URL actually loaded: `playUrl`, or its frozen form for a capture. */
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
  const directory = resolveVideoDirectory(request.projectPath, request.directory)
  const registration = await deps.previews.open(directory.absolute).catch((error: unknown) => {
    throw new Error(
      `The composition folder "${directory.display}" is not there yet. Write the composition into it first, or name a folder that exists. Underlying error: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  const entry = await resolveServedEntry(directory.absolute, request.entry)
  const playUrl = servedFileUrl(registration.url, entry)
  const url =
    request.captureSeconds === undefined
      ? playUrl
      : videoCaptureUrl(playUrl, request.captureSeconds)
  const origin = new URL(registration.url).origin

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
    // The capability's own open reveals; a reused tab does not, so a composition
    // the user asked for again is brought forward explicitly.
    if (tabId && request.reveal) browser.revealTab(tabId)
  }

  return {
    directory: directory.display,
    entry: entry?.requested ?? null,
    playUrl,
    url,
    origin,
    served: entry ? 'file' : 'folder listing',
    tab,
    tabId
  }
}
