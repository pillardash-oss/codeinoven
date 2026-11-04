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
 * hiding the window all send false), and `maxDimension` is the size a source that
 * *can* capture small is asked for (the desktop one), quantized by the renderer so
 * a pixel of layout jitter does not ask for a new size every frame. A device is
 * never re-encoded to fit it: its PNG is painted at whatever the browser scales it
 * to.
 */
export interface DisplayFrameDemand {
  maxDimension: number
  visible: boolean
}

/**
 * One captured frame, exactly as the target encoded it.
 *
 * `bytes` is the target's own file (a device PNG), never a re-encode: the main
 * process reads it and forwards it, so no frame is ever decoded, resized, encoded
 * or turned into text on the main thread. The renderer paints it from a blob URL
 * and lets the browser do the scaling.
 */
export interface DisplayFrame {
  sessionId: string
  tabId: string
  bytes: Uint8Array<ArrayBuffer>
  /** What those bytes are, so the renderer can hand them to a blob untouched. */
  mime: string
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
  /** True when this target accepts touch and typing from the panel. */
  input: boolean
  /** Why this target cannot be worked from the panel, when it cannot. */
  inputProblem?: string
}

/**
 * One act of touch, in fractions of the target's own screen.
 *
 * Fractions and not pixels: the panel paints a downscaled JPEG and never learns
 * the device's resolution, while the adapter that owns the device knows exactly
 * what to multiply by. A tap at `0.5, 0.5` is the middle of any screen, which is
 * the only coordinate both sides agree on without a second round trip.
 */
export type DisplayInputGesture =
  | { type: 'tap'; x: number; y: number }
  | { type: 'long-press'; x: number; y: number }
  | { type: 'swipe'; fromX: number; fromY: number; toX: number; toY: number; durationMs: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: DisplayInputKey }

/** The keys the panel can press on a target beyond letters and digits. */
export type DisplayInputKey =
  'enter' | 'backspace' | 'tab' | 'escape' | 'up' | 'down' | 'left' | 'right'

const DISPLAY_INPUT_KEYS: readonly DisplayInputKey[] = [
  'enter',
  'backspace',
  'tab',
  'escape',
  'up',
  'down',
  'left',
  'right'
]

/** Longest text one gesture may carry, so a paste cannot become a device flood. */
const DISPLAY_INPUT_TEXT_LIMIT = 256

/** Whether a gesture is inside the contract, checked at the IPC boundary. */
export function isDisplayInputGesture(value: unknown): value is DisplayInputGesture {
  if (typeof value !== 'object' || value === null) return false
  const gesture = value as Record<string, unknown>
  const fraction = (entry: unknown): entry is number =>
    typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 && entry <= 1
  switch (gesture.type) {
    case 'tap':
    case 'long-press':
      return fraction(gesture.x) && fraction(gesture.y)
    case 'swipe':
      return (
        fraction(gesture.fromX) &&
        fraction(gesture.fromY) &&
        fraction(gesture.toX) &&
        fraction(gesture.toY) &&
        typeof gesture.durationMs === 'number' &&
        Number.isFinite(gesture.durationMs) &&
        gesture.durationMs >= 0 &&
        gesture.durationMs <= 3000
      )
    case 'text':
      return (
        typeof gesture.text === 'string' &&
        gesture.text.length > 0 &&
        gesture.text.length <= DISPLAY_INPUT_TEXT_LIMIT
      )
    case 'key':
      return (
        typeof gesture.key === 'string' &&
        (DISPLAY_INPUT_KEYS as readonly string[]).includes(gesture.key)
      )
    default:
      return false
  }
}

/**
 * Whether this machine lets the app work another application's window.
 *
 * Working a simulator means posting real clicks and keystrokes at its window,
 * which every desktop OS gates behind a grant: macOS asks for it once in System
 * Settings, Windows and Linux do not ask at all. The answer is read on demand,
 * never cached beyond a request, because a person who grants it while the panel
 * is open must see the panel come alive without restarting the app.
 */
export interface DisplayInputPermission {
  granted: boolean
  /** The platform the answer came from, so the walkthrough can speak its language. */
  platform: 'darwin' | 'win32' | 'linux' | 'other'
  /** Whether the app itself can raise the system prompt for this grant. */
  canPrompt: boolean
  /** What the person must do, in order. Empty once granted. */
  steps: string[]
  /** What the operating system calls this pane, in its own words. */
  settingsName?: string
  /** A deep link that opens exactly that pane, when the platform has one. */
  settingsUrl?: string
}

/**
 * A control the panel can press on the target itself.
 *
 * A phone preview without its buttons is a picture, and the point of this panel
 * is to let a person work the device the agent is on without reaching for it (an
 * emulator with no window has nothing to reach for). The set is per kind, because
 * it says what the platform can actually do: adb injects a full hardware key set,
 * and a booted simulator takes the buttons it really has (home, the side button,
 * Siri) plus its left-edge back gesture. Volume is not on the simulator's channel
 * at all, so the rail does not pretend otherwise.
 */
export type DisplayControlAction =
  'home' | 'back' | 'recents' | 'volume-up' | 'volume-down' | 'power' | 'siri' | 'appearance'

/** What each kind can be asked to do, in the order the rail lists it. */
export const DISPLAY_CONTROLS_BY_KIND: Record<DisplaySourceKind, readonly DisplayControlAction[]> =
  {
    android: ['home', 'back', 'recents', 'volume-up', 'volume-down', 'power'],
    // The simulator's own buttons, in the order a hand finds them. `back` is the
    // system edge swipe, `power` the side button (lock and wake), and `appearance`
    // the light/dark switch, which only `simctl` can make.
    ios: ['home', 'back', 'power', 'siri', 'appearance'],
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
    value === 'siri' ||
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
  /** Threads currently wearing the "driving a display target" mark. */
  threads: string[]
}

/**
 * One thread started or stopped using a display target.
 *
 * Pushed so a thread row can wear the same kind of mark computer use gets while it
 * is happening, instead of the user having to open the panel to find out.
 */
export interface DisplayThreadActivity {
  threadId: string
  active: boolean
  /** When this state began, so the row's indicator slot can order it. */
  at: number
}

/** One target the panel should mirror, pushed when a device shows up. */
export interface DisplayTargetOffer {
  target: DisplaySourceDescriptor
  /** The thread whose work started it, when an agent started it. */
  threadId?: string
  at: number
}

/** The device one display tab is mirroring, as the watch needs to know it. */
export interface DisplayPanelTarget {
  kind: DisplaySourceKind
  sourceId: string
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
  /**
   * Work the target's own screen: tap, press, swipe, type.
   *
   * Refused for a session whose capture reports `input: false`, so a target that
   * cannot be touched says so once and the panel never fires into nothing.
   */
  'display:input': {} as Contract<[sessionId: string, gesture: DisplayInputGesture], void>,
  /**
   * Read whether this machine lets the app post input into another window.
   *
   * Asked before the panel offers control of a simulator, so a target that would
   * silently ignore every tap says what is missing instead.
   */
  'display:inputPermission': {} as Contract<[], DisplayInputPermission>,
  /**
   * Ask the operating system for that grant, and report what it answered.
   *
   * This is the app raising the system's own prompt, never a simulated one: on
   * macOS it is the sheet that offers the settings pane, and a platform without
   * such a prompt simply answers with its current state.
   */
  'display:requestInputPermission': {} as Contract<[], DisplayInputPermission>,
  /** Open the settings pane that owns this grant, when the platform has one. */
  'display:openInputSettings': {} as Contract<[], void>,
  /** Read the presence flag. One call restores the rail item after a reload. */
  'display:presence': {} as Contract<[], DisplayAvailability>,
  /**
   * Report the target the panel is mirroring, or null when it shows none.
   *
   * This is what stops the watch: while a device is on screen there is nothing to
   * find, and the offer that put it there must never be repeated.
   */
  'display:notePanel': {} as Contract<[mirrored: DisplayPanelTarget | null], void>
}
