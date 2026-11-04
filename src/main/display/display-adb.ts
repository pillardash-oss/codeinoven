import type { NativeImage } from 'electron'
import type {
  DisplayControlAction,
  DisplayInputGesture,
  DisplayInputKey,
  DisplaySourceDescriptor,
  DisplaySourceListing
} from '../../lib/ipc/display'
import { type DisplayCapture, decodeDisplayImage } from './display-capture'
import { resolveAdb } from './display-adb-paths'
import { captureCommand, captureText } from './display-exec'

/** Discovery timeout. First call starts the adb server, which is the slow one. */
const ADB_LIST_TIMEOUT_MS = 15_000
/** One framebuffer read. A healthy device answers in 100-250 ms, but a busy
 *  emulator mid-boot can hold the pipe far longer than a healthy one ever does,
 *  and a frame that arrives late is worth more than an error shown in its place. */
const ADB_CAPTURE_TIMEOUT_MS = 15_000
/** One injected gesture. An `input` command is a single event away. */
const ADB_INPUT_TIMEOUT_MS = 10_000

/** One attached target, as `adb devices -l` describes it. */
interface AdbTarget {
  serial: string
  state: string
  model: string | null
  /** True when the device is on the cable rather than on the network. */
  usb: boolean
}

/** Parse the `adb devices -l` table into the targets worth offering. */
function parseAdbDevices(output: string): AdbTarget[] {
  const targets: AdbTarget[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('List of devices')) continue
    if (trimmed.startsWith('*')) continue
    const [serial, state, ...properties] = trimmed.split(/\s+/u)
    if (!serial || !state) continue
    // `offline`, `unauthorized` and `no permissions` are real states a user can
    // fix, so they are listed with their state rather than hidden.
    const modelProperty = properties.find((entry) => entry.startsWith('model:'))
    targets.push({
      serial,
      state,
      model: modelProperty ? modelProperty.slice('model:'.length).replace(/_/gu, ' ') : null,
      usb: properties.some((entry) => entry.startsWith('usb:'))
    })
  }
  return targets
}

/** Every Android target the machine can mirror right now. */
export async function listAndroidSources(): Promise<DisplaySourceListing> {
  const adb = resolveAdb()
  if (!adb) {
    return {
      kind: 'android',
      sources: [],
      problem: 'adb was not found. Install Android platform-tools or set ANDROID_HOME.'
    }
  }
  let output: string
  try {
    output = await captureText(adb, ['devices', '-l'], ADB_LIST_TIMEOUT_MS)
  } catch (error) {
    return {
      kind: 'android',
      sources: [],
      problem: `Android devices could not be listed: ${errorMessage(error)}`
    }
  }
  const sources = parseAdbDevices(output).map((target): DisplaySourceDescriptor => {
    const emulator = target.serial.startsWith('emulator-')
    const name = target.model ?? (emulator ? 'Android emulator' : target.serial)
    // A phone on the cable and a phone on the network are the same target with a
    // different way in, and the way in is worth saying: a wireless device drops
    // when it leaves the network, a cabled one does not.
    const link = target.usb ? 'USB' : target.serial.includes(':') ? 'Wireless' : null
    const state =
      target.state === 'device'
        ? [emulator ? 'Emulator' : 'Connected', link].filter(Boolean).join(' · ')
        : target.state
    return {
      kind: 'android',
      sourceId: target.serial,
      label: `${name} · ${target.serial}`,
      detail: state
    }
  })
  return { kind: 'android', sources }
}

/**
 * The hardware keys adb can inject, by the panel's own action names.
 *
 * These are the Linux input key codes Android's `input keyevent` takes, not a
 * screen coordinate: pressing HOME goes home whatever the app is showing, which
 * is why the rail can offer a device's buttons over a channel this thin.
 */
const ANDROID_KEY_CODES: Partial<Record<DisplayControlAction, number>> = {
  home: 3,
  back: 4,
  recents: 187,
  'volume-up': 24,
  'volume-down': 25,
  power: 26
}

/**
 * The keys a panel can send beside a hardware button, by Android's own key codes.
 *
 * These are what a soft keyboard's own keys are: enter, delete, tab, escape and
 * the four arrows, which is what typing into a device without a keyboard needs.
 */
const ANDROID_INPUT_KEY_CODES: Record<DisplayInputKey, number> = {
  enter: 66,
  backspace: 67,
  tab: 61,
  escape: 111,
  up: 19,
  down: 20,
  left: 21,
  right: 22
}

/** What a device answers when it will not describe its own screen. 1080x2400 is
 *  the phone profile Android's emulators ship with, and a tap still lands near
 *  enough to be useful rather than doing nothing at all. */
const ANDROID_FALLBACK_SIZE = { width: 1080, height: 2400 }

/**
 * Escape one string for `adb shell input text`.
 *
 * `adb shell` joins its arguments into one command line for the device's own
 * shell, so a space ends the command and a quote opens a string. The device's
 * `input` command understands `%s` for a space, and everything else survives a
 * backslash: that pair of rules is the whole escape, and it is why a typed
 * sentence reaches the device as a sentence instead of as its first word.
 */
function escapeInputText(text: string): string {
  let escaped = ''
  for (const character of text) {
    if (character === ' ') {
      escaped += '%s'
      continue
    }
    if (/[\w@.,:+=/-]/u.test(character)) {
      escaped += character
      continue
    }
    escaped += `\\${character}`
  }
  return escaped
}

/** "Physical size: 1080x2400" or "Override size: ..." → the pixels input uses. */
function parseScreenSize(output: string): { width: number; height: number } | null {
  const override = /Override size:\s*(\d+)x(\d+)/u.exec(output)
  const physical = /Physical size:\s*(\d+)x(\d+)/u.exec(output)
  const match = override ?? physical
  if (!match?.[1] || !match[2]) return null
  const width = Number.parseInt(match[1], 10)
  const height = Number.parseInt(match[2], 10)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

/** A live framebuffer reader for one adb target. */
export class AndroidDisplayCapture implements DisplayCapture {
  readonly kind = 'android' as const
  private cancelled: (() => void) | null = null
  private disposed = false
  /** The device's own pixel size, asked once and kept for every gesture. */
  private size: { width: number; height: number } | null = null
  private sizeRequest: Promise<{ width: number; height: number }> | null = null

  constructor(
    readonly sourceId: string,
    readonly label: string,
    private readonly adb: string
  ) {}

  async grab(_maxDimension: number): Promise<NativeImage | null> {
    if (this.disposed) return null
    // `exec-out` is what keeps a PNG from being mangled by the device shell's
    // line endings; the bytes arrive exactly as `screencap` wrote them.
    const command = captureCommand(
      this.adb,
      ['-s', this.sourceId, 'exec-out', 'screencap', '-p'],
      ADB_CAPTURE_TIMEOUT_MS
    )
    this.cancelled = command.cancel
    try {
      const bytes = await command.promise
      if (this.disposed) return null
      return decodeDisplayImage(bytes)
    } finally {
      this.cancelled = null
    }
  }

  async control(action: DisplayControlAction): Promise<void> {
    const keyCode = ANDROID_KEY_CODES[action]
    if (keyCode === undefined) {
      throw new Error(`An Android target has no "${action}" control`)
    }
    await captureCommand(
      this.adb,
      ['-s', this.sourceId, 'shell', 'input', 'keyevent', String(keyCode)],
      ADB_CAPTURE_TIMEOUT_MS
    ).promise
  }

  dispose(): void {
    this.disposed = true
    this.cancelled?.()
    this.cancelled = null
  }

  /**
   * Work the device's screen.
   *
   * Everything here is one `adb shell input` command, which is the device's own
   * injector: the same tool the agent uses, with no accessibility node lookup and
   * no window in the way. A gesture therefore costs one child process and lands
   * where a finger would, whatever app is in front.
   */
  async input(gesture: DisplayInputGesture): Promise<void> {
    if (this.disposed) throw new Error('That display session is closed')
    switch (gesture.type) {
      case 'tap':
      case 'long-press': {
        const { x, y } = await this.pixels(gesture.x, gesture.y)
        if (gesture.type === 'tap') {
          await this.inject(['tap', String(x), String(y)])
          return
        }
        // Android's injector has no long-press verb: a drag that starts and ends
        // on the same pixel for the same duration is the event a long press is.
        await this.inject(['swipe', String(x), String(y), String(x), String(y), '650'])
        return
      }
      case 'swipe': {
        const from = await this.pixels(gesture.fromX, gesture.fromY)
        const to = await this.pixels(gesture.toX, gesture.toY)
        await this.inject([
          'swipe',
          String(from.x),
          String(from.y),
          String(to.x),
          String(to.y),
          String(Math.max(1, Math.round(gesture.durationMs)))
        ])
        return
      }
      case 'text':
        await this.inject(['text', escapeInputText(gesture.text)])
        return
      case 'key':
        await this.inject(['keyevent', String(ANDROID_INPUT_KEY_CODES[gesture.key])])
        return
    }
  }

  /** One `input` command on the device's own injector. */
  private async inject(args: string[]): Promise<void> {
    await captureCommand(
      this.adb,
      ['-s', this.sourceId, 'shell', 'input', ...args],
      ADB_INPUT_TIMEOUT_MS
    ).promise
  }

  /** A fraction of the screen as the device's own pixels. */
  private async pixels(x: number, y: number): Promise<{ x: number; y: number }> {
    const size = await this.screenSize()
    return {
      x: Math.min(size.width - 1, Math.max(0, Math.round(x * size.width))),
      y: Math.min(size.height - 1, Math.max(0, Math.round(y * size.height)))
    }
  }

  /** The device's resolution, asked once and remembered for the session. */
  private screenSize(): Promise<{ width: number; height: number }> {
    if (this.size) return Promise.resolve(this.size)
    if (this.sizeRequest) return this.sizeRequest
    const request = captureText(
      this.adb,
      ['-s', this.sourceId, 'shell', 'wm', 'size'],
      ADB_INPUT_TIMEOUT_MS
    )
      .then((output) => parseScreenSize(output) ?? ANDROID_FALLBACK_SIZE)
      .catch(() => ANDROID_FALLBACK_SIZE)
      .then((size) => {
        this.size = size
        this.sizeRequest = null
        return size
      })
    this.sizeRequest = request
    return request
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
