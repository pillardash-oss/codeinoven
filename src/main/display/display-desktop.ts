import {
  BrowserWindow,
  desktopCapturer,
  systemPreferences,
  type DesktopCapturerSource,
  type NativeImage
} from 'electron'
import type {
  DisplayPermissionState,
  DisplaySourceDescriptor,
  DisplaySourceKind,
  DisplaySourceListing
} from '../../lib/ipc/display'
import type { DisplayCapture } from './display-capture'

/**
 * The desktop: an entire screen, or one window.
 *
 * Electron exposes no "capture that source again" call, so every frame is one
 * `desktopCapturer.getSources` with the thumbnail sized to the demand. That makes
 * this the one adapter whose cost is a window enumeration per frame, which is why
 * its cadence is the slowest of the three and why nothing here ever runs while
 * the panel is off screen.
 *
 * macOS gates the whole thing behind Screen Recording. A denied permission still
 * lists sources, with empty thumbnails, so the listing reports the permission
 * instead of pretending the machine has no screens.
 */

/** Sources used for discovery; no thumbnails, because a listing draws none. */
const NO_THUMBNAIL = { width: 0, height: 0 }
/** One enumeration is not free; a hung capture must not hold a session forever. */
const DESKTOP_CAPTURE_TIMEOUT_MS = 5_000

/** The platform's own answer for whether the app may read the screen. */
function screenPermission(): DisplayPermissionState {
  if (process.platform !== 'darwin') return 'not-required'
  try {
    const status = systemPreferences.getMediaAccessStatus('screen')
    if (
      status === 'granted' ||
      status === 'denied' ||
      status === 'restricted' ||
      status === 'not-determined'
    ) {
      return status
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Window titles the app owns, so the panel never offers to mirror itself.
 *
 * `desktopCapturer` reports operating-system windows, which do not carry an
 * Electron id to compare against, so the titles are the honest handle available.
 */
function ownWindowTitles(): Set<string> {
  const titles = new Set<string>()
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    const title = window.getTitle()
    if (title) titles.add(title)
  }
  return titles
}

/** Every screen or window the machine can mirror right now. */
export async function listDesktopSources(
  kind: Extract<DisplaySourceKind, 'desktop-screen' | 'desktop-window'>
): Promise<DisplaySourceListing> {
  const permission = screenPermission()
  if (permission === 'denied' || permission === 'restricted') {
    return {
      kind,
      sources: [],
      permission,
      problem:
        'Screen recording is turned off for this app. Allow it in System Settings › Privacy & Security › Screen Recording, then list again.'
    }
  }
  let captured: DesktopCapturerSource[]
  try {
    captured = await withTimeout(
      desktopCapturer.getSources({
        types: kind === 'desktop-screen' ? ['screen'] : ['window'],
        thumbnailSize: NO_THUMBNAIL,
        fetchWindowIcons: false
      }),
      DESKTOP_CAPTURE_TIMEOUT_MS
    )
  } catch (error) {
    return {
      kind,
      sources: [],
      permission,
      problem: `The desktop could not be listed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const ownTitles = kind === 'desktop-window' ? ownWindowTitles() : new Set<string>()
  const sources = captured
    // A window with no title is a helper surface (a tooltip, a menu, a shadow
    // window); mirroring one is never what the user meant.
    .filter((source) => source.name.trim().length > 0 && !ownTitles.has(source.name))
    // The section already says whether these are screens or windows, so a detail
    // line repeating it would only take a row from the name.
    .map((source): DisplaySourceDescriptor => ({
      kind,
      sourceId: source.id,
      label: source.name
    }))
  return { kind, sources, permission }
}

/** A live framebuffer reader for one screen or window. */
export class DesktopDisplayCapture implements DisplayCapture {
  private disposed = false

  constructor(
    readonly kind: Extract<DisplaySourceKind, 'desktop-screen' | 'desktop-window'>,
    readonly sourceId: string,
    readonly label: string
  ) {}

  async grab(maxDimension: number): Promise<NativeImage | null> {
    if (this.disposed) return null
    const sources = await withTimeout(
      desktopCapturer.getSources({
        types: this.kind === 'desktop-screen' ? ['screen'] : ['window'],
        // The box the platform fits the capture into. Electron keeps the aspect
        // ratio, so a wide screen comes back wide rather than letterboxed.
        thumbnailSize: { width: maxDimension, height: maxDimension },
        fetchWindowIcons: false
      }),
      DESKTOP_CAPTURE_TIMEOUT_MS
    )
    if (this.disposed) return null
    const source = sources.find((candidate) => candidate.id === this.sourceId)
    // A closed window or an unplugged screen is a normal end of life for a tab:
    // the stage keeps its last frame and the session reports that it stopped.
    if (!source || source.thumbnail.isEmpty()) return null
    return source.thumbnail
  }

  dispose(): void {
    this.disposed = true
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the capture did not answer in time')),
      timeoutMs
    )
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
