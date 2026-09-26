import { requireLocalProject } from '../../lib/project-artifacts'
import { videoClampTime } from '../../lib/video/project'
import { resolveServedFolder } from '../preview/served-folder'
import { currentWorkRoot } from '../design/work-roots-state'
import { loadCompositionManifest } from './video-manifest'
import type { BrowserService } from '../browser/browser-service'
import type { Database } from '../database/database'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import type { VideoCapabilityExecutor } from '../utilities/utility-orchestration-service'
import { openVideoPreview } from './video-preview-session'

/**
 * What the video capability's `capture` operation needs from the app.
 *
 * The browser is required rather than lazy here: a capture is a picture of a
 * rendered page, so there is no honest answer without a tab to render it in.
 * The other two dependencies serve and resolve the folder.
 */
export interface VideoCaptureExecutorOptions {
  previews: DirectoryPreviewService
  database: Database
  browser: () => BrowserService | null
}

/** How many times to ask the page to draw before giving up on it. */
const RENDER_ATTEMPTS = 5

/** Gap between render attempts, so a page still parsing gets time to define its function. */
const RENDER_RETRY_MS = 150

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Run the app-owned video capability's `capture` operation.
 *
 * The composition is loaded frozen at one second, the page is asked to draw
 * that exact frame through the render contract, the frame is captured and
 * handed back as a picture the model can look at, and then the tab is returned
 * to the moving preview so the user keeps watching the edit rather than a still.
 * The picture is the whole point: a frame that is never looked at is a frame
 * whose overflowed text, collided labels and washed-out contrast go unnoticed.
 */
export function createVideoCaptureExecutor(
  options: VideoCaptureExecutorOptions
): VideoCapabilityExecutor {
  return async (operation, input, context) => {
    if (operation !== 'capture') {
      throw new Error(
        `The video capability's "capture" executor received the operation "${operation}".`
      )
    }
    const browser = options.browser()
    if (!browser) {
      throw new Error('A frame cannot be captured while the app has no window to render it in.')
    }
    const project = requireLocalProject(options.database, context.projectId)
    const directory = resolveServedFolder(
      project.path,
      input['directory'],
      currentWorkRoot('video')
    )
    const manifest = await loadCompositionManifest(directory.absolute, directory.display)
    // Clamp before the page is loaded, so the URL and the frame drawn agree on
    // which second is being captured.
    const seconds = videoClampTime(manifest, input['time'])

    const session = await openVideoPreview(
      { previews: options.previews, browser: options.browser },
      {
        projectPath: project.path,
        projectId: context.projectId,
        threadId: context.threadId,
        directory: input['directory'],
        entry: input['entry'],
        defaultRoot: currentWorkRoot('video'),
        attention: 'background',
        reveal: false,
        captureSeconds: seconds
      }
    )
    if (!session.tabId) {
      throw new Error('No browser tab was opened, so there is nothing to capture.')
    }
    const target = { projectId: context.projectId, threadId: context.threadId }
    await browser.waitForTabLoad(session.tabId)

    try {
      let rendered = false
      let reason: string | undefined
      for (let attempt = 0; attempt < RENDER_ATTEMPTS && !rendered; attempt += 1) {
        if (attempt > 0) await delay(RENDER_RETRY_MS)
        const result = await browser.renderTabFrame(session.tabId, seconds)
        rendered = result.rendered
        reason = result.reason
      }
      if (!rendered) {
        throw new Error(
          reason
            ? `The composition could not be drawn at ${seconds.toFixed(3)}s: ${reason}.`
            : `The composition did not define window.cioRenderFrame, so there is no frame to capture.`
        )
      }

      const shot = await browser.executeUtility('screenshot', { force: true }, target)
      const picture = isRecord(shot) ? shot : {}
      return {
        directory: directory.display,
        entry: session.entry,
        time: seconds,
        duration: manifest.duration,
        frame: `${manifest.width}x${manifest.height}`,
        url: session.url,
        rendered: true,
        width: picture['width'],
        height: picture['height'],
        dataUrl: picture['dataUrl'],
        note: `Frame captured at ${seconds.toFixed(3)}s of ${manifest.duration}s, ${manifest.width}x${manifest.height}. The preview tab has been restored to the moving composition.`
      }
    } finally {
      // The moving preview comes back whatever happened, so a capture that failed
      // does not leave the user looking at a frozen frame the tab cannot play.
      await browser
        .executeUtility('navigate', { url: session.playUrl }, target)
        .catch(() => undefined)
    }
  }
}
