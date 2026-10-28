import { authoredWorkRoot } from '../../design/authored-work-root'
import { createHash } from 'node:crypto'
import { videoTimecode } from '../../../lib/video/timeline'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CompositionFrameSnapshot } from '../../../lib/ipc-contract'
import { Logger } from '../../system/logger'
import { type BrowserTab } from './browser-types'
import { FRAME_RENDER_TIMEOUT_MS } from './browser-validation'
import { COMPOSITION_TRANSPORT_GLOBAL, frameSettleScript } from './browser-transport-script'
import type { BrowserService } from '../browser-service'

/**
 * Frames taken off a composition page.
 *
 * A composition renders itself in a canvas, so a frame is asked for rather than
 * screenshotted, retried while the page is still parsing, bounded in size, and written
 * into a folder named after the composition it came from.
 */

/**
 * What `browser-service-composition-frames` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface CompositionFramesHost {
  readonly activeTabId: BrowserService['activeTabId']
  readonly armCompositionTransport: BrowserService['armCompositionTransport']
  readonly db: BrowserService['db']
  readonly sendTransport: BrowserService['sendTransport']
  readonly showActiveView: BrowserService['showActiveView']
  readonly tabs: BrowserService['tabs']
}

/**
 * How many times a frame is asked for before a capture gives up on it.
 *
 * A page defines its render function while it parses, so a capture that lands on
 * the first paint asks a composition that is not ready yet. The retries are
 * bounded because a page that never defines it must answer rather than hang the
 * click that asked.
 */
export const FRAME_CAPTURE_ATTEMPTS = 4

/** Gap between frame requests, so a page still parsing gets time to define one. */
export const FRAME_CAPTURE_RETRY_MS = 150

/**
 * Ceiling on one encoded composition frame.
 *
 * A PNG of a 4K canvas is a few megabytes; past this the canvas answered with
 * something other than a frame, and writing it would waste the user's disk on a
 * picture nobody can read.
 */
export const MAX_COMPOSITION_FRAME_BASE64 = 48 * 1024 * 1024

/**
 * A readable, stable folder for one composition's captured frames.
 *
 * The leaf name is what a person recognises and the short hash is what keeps two
 * compositions called `hero` in different folders apart, which one flat scratch
 * folder would otherwise overwrite.
 */
export function frameFolderName(directory: string): string {
  const leaf = basename(directory.replace(/[\\/]+$/u, ''))
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[.-]+/u, '')
    .slice(0, 60)
  const hash = createHash('sha1').update(directory).digest('hex').slice(0, 8)
  return leaf ? `${leaf}-${hash}` : hash
}

export class BrowserServiceCompositionFrames {
  constructor(private readonly host: CompositionFramesHost) {}

  async renderTabFrame(
    tabId: string,
    seconds: number
  ): Promise<{ rendered: boolean; reason?: string }> {
    const tab = this.host.tabs.get(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) {
      return { rendered: false, reason: 'the tab is gone' }
    }
    const drawn: unknown = tab.view.webContents.executeJavaScript(`(async () => {
      const transport = globalThis.${COMPOSITION_TRANSPORT_GLOBAL};
      if (transport && typeof transport.freezeAt === 'function') {
        const state = await transport.freezeAt(${JSON.stringify(seconds)});
        if (typeof transport.settle === 'function') await transport.settle();
        const failure = state && state.error;
        return failure ? { rendered: false, reason: String(failure) } : { rendered: true };
      }
      const draw = globalThis.cioRenderFrame;
      if (typeof draw !== 'function') {
        return { rendered: false, reason: 'the page defines no cioRenderFrame function' };
      }
      try {
        await draw(${JSON.stringify(seconds)});
      } catch (error) {
        return { rendered: false, reason: String(error) };
      }
      // Bounded like the transport's own settle: a page whose frames are throttled
      // answers with the frame as drawn rather than timing the whole capture out.
      await ${frameSettleScript()};
      return { rendered: true };
    })()`)
    // Bounded, because a page that never settles, or one whose animation frames
    // are throttled because the tab is parked, would leave this outstanding and
    // hang the turn that asked for the frame.
    const expired: unique symbol = Symbol('frame-render-timeout')
    let timer: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<typeof expired>((resolve) => {
      timer = setTimeout(() => resolve(expired), FRAME_RENDER_TIMEOUT_MS)
    })
    let result: unknown
    try {
      result = await Promise.race([drawn, deadline])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
    if (result === expired) {
      return {
        rendered: false,
        reason: `the composition did not settle within ${FRAME_RENDER_TIMEOUT_MS / 1000} seconds`
      }
    }
    if (typeof result !== 'object' || result === null) return { rendered: false }
    const record = result as Record<string, unknown>
    const reason = typeof record['reason'] === 'string' ? record['reason'] : undefined
    return record['rendered'] === true
      ? { rendered: true }
      : { rendered: false, ...(reason ? { reason } : {}) }
  }

  /**
   * Keep one exact frame of a composition as a still the user can draw on.
   *
   * A composition's frame lives on screen for one repaint and nowhere on disk,
   * so a note about a moment cannot name that moment alone: the picture has to be
   * captured while it is up. The playhead is stopped first, because a frame drawn
   * while it is moving can be replaced before the capture lands and the picture
   * would then show a moment the note does not name.
   *
   * The picture is written into the project's own scratch rather than kept in
   * memory, because it outlives the click that produced it: the annotation
   * surface shows it, the composer keeps the note across a restart, and the send
   * burns the marks onto it. That is also why the second travels back with it:
   * the note names the moment, and the picture is only the evidence for it.
   */
  async captureCompositionFrame(
    tabId: string,
    seconds: number
  ): Promise<CompositionFrameSnapshot | null> {
    const tab = this.host.tabs.get(tabId)
    if (!tab || !tab.composition || tab.view.webContents.isDestroyed()) return null
    const composition = tab.composition
    const at = Math.min(
      Math.max(Number.isFinite(seconds) ? seconds : 0, 0),
      composition.duration > 0 ? composition.duration : 0
    )
    // A user action can recover a document that startup left unarmed, which is
    // the same path a Play click takes.
    if (!tab.transport) await this.host.armCompositionTransport(tabId, tab)
    await this.host.sendTransport(tabId, 'pause', 0).catch(() => null)
    let rendered = false
    let reason = 'The composition did not render the requested frame.'
    for (let attempt = 0; attempt < FRAME_CAPTURE_ATTEMPTS && !rendered; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, FRAME_CAPTURE_RETRY_MS))
      const result = await this.renderTabFrame(tabId, at).catch((cause: unknown) => ({
        rendered: false,
        reason: cause instanceof Error ? cause.message : String(cause)
      }))
      rendered = result.rendered
      if (result.reason) reason = result.reason
    }
    if (!rendered) throw new Error(`Cannot capture the frame: ${reason}`)
    const frame = await this.readCompositionFrame(tabId, tab, at)
    if (!frame) throw new Error('The composition rendered but supplied no readable frame image.')
    const { path: root } = await authoredWorkRoot(this.host.db, tab.projectId, tab.threadId)
    const folder = `video-frames/${frameFolderName(composition.directory)}`
    const relative = `.cio/work/${folder}/frame-${Math.round(at * 1000)}.png`
    const absolute = join(root, relative)
    try {
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, frame.bytes)
    } catch (error) {
      Logger.error('A composition frame could not be written:', error)
      return null
    }
    const served = relative
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    return {
      path: relative,
      url: `appfile://thread/${tab.projectId}/${tab.threadId}/${served}`,
      seconds: at,
      timecode: videoTimecode(at),
      frame: Math.round(at * (composition.fps > 0 ? composition.fps : 30)),
      fps: composition.fps,
      duration: composition.duration,
      directory: composition.directory,
      width: frame.width,
      height: frame.height
    }
  }

  /**
   * The pixels of one composition frame, from the page's own canvas.
   *
   * A picture of the native view is what the compositor happens to have on screen,
   * and that is the wrong source twice over: a view that is mid-attach, parked, or
   * covered captures blank (Chromium answers `capturePage` with `UnknownVizError`,
   * which is exactly the failure the pen reported as "this frame could not be
   * captured"), and when it does answer it is the view scaled to the window rather
   * than the frame at its own size. The composition draws into a canvas it names
   * with `CIOVideo.useCanvas`, so reading that canvas is the frame itself, at full
   * resolution, whether or not anything is on screen.
   *
   * The view capture stays as the fallback for a composition that draws only with
   * DOM and names no canvas, and every step of it is guarded: a failed capture must
   * answer null for this click, never throw out of the IPC.
   */
  async readCompositionFrame(
    tabId: string,
    tab: BrowserTab,
    at: number
  ): Promise<{ bytes: Buffer; width: number; height: number } | null> {
    const contents = tab.view.webContents
    // Re-asking for the frame guarantees the canvas holds this second, not the one
    // the transport happened to stop on.
    await contents
      .executeJavaScript(`Promise.resolve(globalThis.cioRenderFrame?.(${JSON.stringify(at)}))`)
      .catch(() => undefined)
    const encoded = await contents
      .executeJavaScript(
        `(() => {
          const named = globalThis.cioVideoCanvas;
          const canvas = named instanceof HTMLCanvasElement ? named : document.querySelector('canvas');
          if (!canvas || canvas.width < 1 || canvas.height < 1) return '';
          try { return canvas.toDataURL('image/png'); } catch { return ''; }
        })()`
      )
      .catch(() => '')
    if (typeof encoded === 'string' && encoded.startsWith('data:image/png;base64,')) {
      const base64 = encoded.slice('data:image/png;base64,'.length)
      if (base64.length > 1 && base64.length <= MAX_COMPOSITION_FRAME_BASE64) {
        const size = await contents
          .executeJavaScript(
            `(() => {
              const named = globalThis.cioVideoCanvas;
              const canvas = named instanceof HTMLCanvasElement ? named : document.querySelector('canvas');
              return canvas ? { width: canvas.width, height: canvas.height } : null;
            })()`
          )
          .catch(() => null)
        const bytes = Buffer.from(base64, 'base64')
        return {
          bytes,
          width: typeof size?.width === 'number' ? size.width : 0,
          height: typeof size?.height === 'number' ? size.height : 0
        }
      }
      Logger.dev('A composition frame canvas returned no usable image at', at)
    }
    // A view that has just changed hands can still be mid-attach, and a detached
    // view captures blank, so ask for the attach, nudge the page and retry.
    // The tab record is keyed by id and carries none, so the caller's id is the
    // only way to tell whether this view is the one that just changed hands.
    if (this.host.activeTabId === tabId) {
      this.host.showActiveView()
      contents.invalidate()
    }
    for (let attempt = 0; attempt < FRAME_CAPTURE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, FRAME_CAPTURE_RETRY_MS))
      try {
        const shot = await contents.capturePage()
        const size = shot.getSize()
        if (size.width >= 1 && size.height >= 1) {
          return { bytes: shot.toPNG(), width: size.width, height: size.height }
        }
      } catch (error) {
        Logger.dev('A composition view could not be captured:', error)
      }
    }
    return null
  }
}
