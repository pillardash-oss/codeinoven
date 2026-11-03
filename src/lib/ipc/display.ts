import type { Contract } from './contract-helpers'

/**
 * The display panel's contract: the targets the app can mirror, and the frames
 * it mirrors them with.
 *
 * The panel shows a live, still-frame preview of whatever an agent is driving:
 * an Android target reachable over adb (an emulator with no window, or a phone
 * on a cable), a booted iOS Simulator, or the desktop itself. Every target is a
 * tab, and the panel is only ever a viewer: it never boots a device, never
 * touches the app it shows, and never speaks for the agent.
 *
 * A frame is a JPEG `data:` URL because the app's renderer CSP already admits
 * `data:` images and because the computer-use preview proved that path (see
 * `src/main/utilities/computer-use-pip-service.ts`). Frames are always a
 * downscale of the source, sized by the demand the stage reports, so nothing
 * here ever ships a native-resolution capture across the process boundary.
 */

/** Where a preview comes from. Each kind owns exactly one capture adapter. */
export type DisplaySourceKind = 'android' | 'ios' | 'desktop-screen' | 'desktop-window'

/** Every kind, in the order the source picker lists them. */
export const DISPLAY_SOURCE_KINDS: readonly DisplaySourceKind[] = [
  'android',
  'ios',
  'desktop-screen',
  'desktop-window'
]

export function isDisplaySourceKind(value: unknown): value is DisplaySourceKind {
  return typeof value === 'string' && (DISPLAY_SOURCE_KINDS as readonly string[]).includes(value)
}

/** One selectable target: an adb serial, a simulator udid, or a capture id. */
export interface DisplaySourceDescriptor {
  kind: DisplaySourceKind
  /** Stable identity for the tab and for the capture that follows it. */
  sourceId: string
  /** What the user picks: "Pixel 8 · emulator-5554". */
  label: string
  /** Supporting line: the device state, the runtime, or the screen's role. */
  detail?: string
  /**
   * The mark the target itself wears, as a small data URL.
   *
   * A window belongs to an application, and the application's own icon is what
   * tells two Finder windows from a Mail window at a glance. The platform hands
   * it over with the window, so the row and the tab wear it instead of a generic
   * window outline.
   */
  iconUrl?: string
}

/**
 * A platform's own screen-recording answer, kept in the platform's wording.
 *
 * `not-required` is the honest answer on Windows and Linux, where listing and
 * capturing a screen needs no grant, and it is what keeps the panel from asking
 * for a permission the machine does not have.
 */
export type DisplayPermissionState =
  'granted' | 'denied' | 'restricted' | 'not-determined' | 'not-required' | 'unknown'

/** What one kind can currently offer, and why it can offer nothing. */
export interface DisplaySourceListing {
  kind: DisplaySourceKind
  sources: DisplaySourceDescriptor[]
  /** Only the desktop kinds can be refused by the operating system. */
  permission?: DisplayPermissionState
  /** A sentence the panel can show instead of an unexplained empty list. */
  problem?: string
}

/**
 * One preview tab's capture request.
 *
 * `sessionId` is minted by the renderer per tab and is what `demand` and `stop`
 * address, so a tab that closes and reopens can never be confused with the
 * session it replaced. `tabId` rides back on every frame so a frame that lands
 * after its tab closed is dropped rather than painted into another tab.
 */
export interface DisplaySessionRequest {
  sessionId: string
  tabId: string
  kind: DisplaySourceKind
  sourceId: string
}

/**
 * How big and how active the stage is.
 *
 * Both fields exist to keep an idle panel free: `visible` pauses capture
 * without tearing the session down (switching tabs, collapsing the dock, or
 * hiding the window all send false), and `maxDimension` is what the capture is
 * downscaled to, quantized by the renderer so a pixel of layout jitter does not
 * re-encode every frame at a new size.
 */
export interface DisplayFrameDemand {
  maxDimension: number
  visible: boolean
}

/** One captured frame, already downscaled and JPEG-encoded. */
export interface DisplayFrame {
  sessionId: string
  tabId: string
  dataUrl: string
  width: number
  height: number
  timestamp: number
}

/**
 * Where a session is: `live` once it has painted a frame, `retrying` while it
 * backs off after a failure, `failed` when the target cannot be captured at all.
 * The stage shows the last frame it has through every phase, so a device mid
 * reboot never blanks the panel.
 */
export type DisplayCapturePhase = 'starting' | 'live' | 'retrying' | 'failed'

export interface DisplayCaptureState {
  sessionId: string
  phase: DisplayCapturePhase
  /** Human sentence for `retrying` and `failed`; absent while healthy. */
  detail?: string
}

/**
 * A control the panel can press on the target itself.
 *
 * A phone preview without its buttons is a picture, and the point of this panel
 * is to let a person work the device the agent is on without reaching for it (an
 * emulator with no window has nothing to reach for). The set is per kind, because
 * it says what the platform can actually do: adb injects hardware key events, and
 * a booted simulator answers only for its own appearance.
 */
export type DisplayControlAction =
  'home' | 'back' | 'recents' | 'volume-up' | 'volume-down' | 'power' | 'appearance'

/** What each kind can be asked to do, in the order the rail lists it. */
export const DISPLAY_CONTROLS_BY_KIND: Record<DisplaySourceKind, readonly DisplayControlAction[]> =
  {
    android: ['home', 'back', 'recents', 'volume-up', 'volume-down', 'power'],
    ios: ['appearance'],
    'desktop-screen': [],
    'desktop-window': []
  }

export function isDisplayControlAction(value: unknown): value is DisplayControlAction {
  return (
    value === 'home' ||
    value === 'back' ||
    value === 'recents' ||
    value === 'volume-up' ||
    value === 'volume-down' ||
    value === 'power' ||
    value === 'appearance'
  )
}

/**
 * Whether the panel should exist at all.
 *
 * The display panel is not a tool the user browses to: it is a window into work
 * an agent started on its own (an emulator, a simulator, a screen it is driving).
 * Until an agent does that, the app holds nothing: no rail item, no service, no
 * polling. `available` is what turns the rail item on, and `since` is when the app
 * first noticed, so a surface can say "an agent started this" without guessing.
 */
export interface DisplayAvailability {
  available: boolean
  /** When the app first saw an agent start or attach to a display target. */
  since?: number
}

export const invokeDisplayContract = {
  /**
   * Enumerate one kind's targets.
   *
   * Read-only and cheap enough to run whenever the picker opens, but never on a
   * timer: Android and iOS discovery each cost a child process, and a desktop
   * listing costs a window enumeration.
   */
  'display:listSources': {} as Contract<[kind: DisplaySourceKind], DisplaySourceListing>,
  /** Begin mirroring one target. Replaces any session with the same id. */
  'display:start': {} as Contract<[request: DisplaySessionRequest], void>,
  /** Report the stage's size and whether it is on screen at all. */
  'display:demand': {} as Contract<[sessionId: string, demand: DisplayFrameDemand], void>,
  /** Stop mirroring and release the target. Safe to call for an unknown session. */
  'display:stop': {} as Contract<[sessionId: string], void>,
  /**
   * Press one of the target's own buttons. Refused for an action the target's
   * kind does not advertise in `DISPLAY_CONTROLS_BY_KIND`, so the UI and the
   * boundary agree without a second copy of the rule.
   */
  'display:control': {} as Contract<[sessionId: string, action: DisplayControlAction], void>,
  /** Read the presence flag. One call restores the rail item after a reload. */
  'display:presence': {} as Contract<[], DisplayAvailability>,
  /**
   * Tell main that an agent is working right now, or stopped.
   *
   * Presence costs one process-table read, so it only ever runs while this is
   * true: an idle app never looks for a device.
   */
  'display:noteAgentWorking': {} as Contract<[working: boolean], void>
}
