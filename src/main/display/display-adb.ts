import type { NativeImage } from 'electron'
import type {
  DisplayControlAction,
  DisplaySourceDescriptor,
  DisplaySourceListing
} from '../../lib/ipc/display'
import { type DisplayCapture, decodeDisplayImage } from './display-capture'
import { resolveAdb } from './display-adb-paths'
import { captureCommand, captureText } from './display-exec'

/** Discovery timeout. First call starts the adb server, which is the slow one. */
const ADB_LIST_TIMEOUT_MS = 15_000
/** One framebuffer read. A healthy device answers in 100-250 ms. */
const ADB_CAPTURE_TIMEOUT_MS = 8_000

/** One attached target, as `adb devices -l` describes it. */
interface AdbTarget {
  serial: string
  state: string
  model: string | null
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
      model: modelProperty ? modelProperty.slice('model:'.length).replace(/_/gu, ' ') : null
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
    const state = target.state === 'device' ? (emulator ? 'Emulator' : 'Connected') : target.state
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

/** A live framebuffer reader for one adb target. */
export class AndroidDisplayCapture implements DisplayCapture {
  readonly kind = 'android' as const
  private cancelled: (() => void) | null = null
  private disposed = false

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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
