/**
 * Screen sharing for the embedded browser.
 *
 * `navigator.mediaDevices.getDisplayMedia` needs a source the app hands to
 * Chromium, which Electron exposes only through `setDisplayMediaRequestHandler`.
 * Without it every screen share rejects with `NotSupportedError`, which is why
 * Google Meet's "Present now" and every other screen share failed while the
 * camera and microphone worked.
 *
 * Two pickers exist, and the system one wins where the platform has it:
 *
 *   - macOS 15+ has the native system picker (`useSystemPicker`), and Electron
 *     then never calls this handler at all. The permission *request* handler has
 *     already run and gated the call, so a remembered refusal still refuses the
 *     share before the OS picker can appear (verified on Electron 44).
 *   - Everywhere else this handler runs and asks the app renderer to show its own
 *     source picker over the page, then answers Chromium with the chosen source.
 *
 * The handler is per session, because a source is only ever handed to the jar the
 * requesting page actually runs in.
 */

import {
  desktopCapturer,
  type BrowserWindow,
  type DesktopCapturerSource,
  type DisplayMediaRequestHandlerHandlerRequest,
  type Streams,
  type WebFrameMain
} from 'electron'
import type { BrowserScreenSharePrompt, BrowserScreenShareSource } from '../../../lib/ipc/browser'
import { permissionOrigin } from '../../../lib/browser/site-permissions'
import { Logger } from '../../system/logger'
import { sendToRenderer } from '../../ipc/renderer-delivery'

/** Thumbnail size the picker draws. Bounded so a wall of screens stays cheap. */
const THUMBNAIL_SIZE = { width: 320, height: 180 }
/** The picker is a user gesture that can be abandoned; it never blocks a page
 *  forever, and a cancelled picker refuses the share. */
const CHOICE_TIMEOUT_MS = 60_000

/** The tab and jar a requesting frame belongs to. */
export interface BrowserScreenShareOwner {
  tabId: string
  projectId: string
  partition: string
}

export interface BrowserScreenShareDeps {
  window: BrowserWindow
  /** Resolve the frame a display-media request came from to its tab and jar, or
   *  null when the frame is gone or belongs to no tab. */
  resolveFrameOwner: (frame: WebFrameMain | null) => BrowserScreenShareOwner | null
  /** True when the user has remembered a refusal for this origin's screen share. */
  isScreenShareDenied: (partition: string, origin: string) => boolean
}

interface PendingChoice {
  resolve: (sourceId: string | null) => void
  timer: ReturnType<typeof setTimeout>
}

export class BrowserScreenShareService {
  private readonly pending = new Map<string, PendingChoice>()

  constructor(private readonly deps: BrowserScreenShareDeps) {}

  /**
   * Answer one display-media request: pick a source through the in-app picker and
   * hand Chromium a stream, or refuse when the origin is remembered-blocked, no
   * source exists, or the user cancels.
   */
  async handle(
    request: DisplayMediaRequestHandlerHandlerRequest,
    callback: (streams: Streams) => void
  ): Promise<void> {
    const origin = permissionOrigin(request.securityOrigin)
    const owner = this.deps.resolveFrameOwner(request.frame)
    if (!owner || !origin) {
      callback({})
      return
    }
    if (this.deps.isScreenShareDenied(owner.partition, origin)) {
      callback({})
      return
    }
    let sources: DesktopCapturerSource[]
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: THUMBNAIL_SIZE,
        fetchWindowIcons: false
      })
    } catch (error: unknown) {
      Logger.error('Browser screen-share source listing failed:', error)
      callback({})
      return
    }
    if (sources.length === 0 || this.deps.window.isDestroyed()) {
      callback({})
      return
    }
    const chosenId = await this.askRenderer(origin, sources)
    const chosen = chosenId ? sources.find((source) => source.id === chosenId) : undefined
    if (!chosen) {
      callback({})
      return
    }
    const streams: Streams = { video: { id: chosen.id, name: chosen.name } }
    // System audio is a Windows loopback feature; elsewhere a page that asked for
    // it simply gets no audio track rather than a failed share.
    if (request.audioRequested && process.platform === 'win32') streams.audio = 'loopback'
    callback(streams)
  }

  /** Resolve the pending picker with the renderer's answer. A source id that no
   *  longer exists, or null, refuses the share. */
  resolveChoice(requestId: string, sourceId: string | null): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.resolve(sourceId)
  }

  /** Refuse every picker still on screen, so a quit or a destroyed window never
   *  leaves a page waiting on a `getDisplayMedia` that can no longer be answered. */
  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve(null)
    }
    this.pending.clear()
  }

  private askRenderer(
    origin: string,
    sources: readonly DesktopCapturerSource[]
  ): Promise<string | null> {
    if (this.deps.window.isDestroyed()) return Promise.resolve(null)
    const requestId = crypto.randomUUID()
    const prompt: BrowserScreenSharePrompt = {
      requestId,
      origin,
      host: safeHost(origin),
      sources: sources.map(toPickerSource)
    }
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(null)
      }, CHOICE_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, timer })
      sendToRenderer(this.deps.window.webContents, 'browser:screenShareSources', prompt)
    })
  }
}

/** One capture source as the picker sees it. The thumbnail is a `data:` URL so
 *  the renderer draws it without a second round trip, and null when the platform
 *  gave none (a denied screen-recording permission still lists the sources). */
function toPickerSource(source: DesktopCapturerSource): BrowserScreenShareSource {
  const thumbnailDataUrl = source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL()
  return {
    id: source.id,
    name: source.name,
    thumbnailDataUrl,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window'
  }
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}
