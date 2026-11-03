import type { NativeImage } from 'electron'
import type { DisplaySourceDescriptor, DisplaySourceListing } from '../../lib/ipc/display'
import { type DisplayCapture, decodeDisplayImage } from './display-capture'
import { captureCommand, captureText } from './display-exec'

/**
 * Booted iOS Simulators.
 *
 * A simulator is a window on the desktop, so a user can already see one; the
 * panel still needs to mirror it because the Simulator app is not always open
 * (the agent can boot a device headless with `simctl boot`) and because the panel
 * keeps every target of a session in one place. `simctl io screenshot` reads the
 * device's own framebuffer, which works either way.
 *
 * The panel never boots a device: discovery reports what is running, and a
 * shutdown simulator is not offered because turning it on is the user's call.
 */

/** Listing a handful of simulators is quick; the first call may load CoreSimulator. */
const SIMCTL_LIST_TIMEOUT_MS = 15_000
/** One framebuffer read. A booted simulator answers in 100-300 ms. */
const SIMCTL_CAPTURE_TIMEOUT_MS = 10_000

const SIMCTL = '/usr/bin/xcrun'

interface SimctlDevice {
  udid?: unknown
  name?: unknown
  state?: unknown
}

/** One booted simulator, flattened out of simctl's runtime-keyed listing. */
interface BootedSimulator {
  udid: string
  name: string
  runtime: string
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-27-2" → "iOS 27.2". */
function runtimeLabel(runtimeKey: string): string {
  const tail = runtimeKey.split('.').at(-1)
  if (!tail) return runtimeKey
  const [platform, version] = tail.split('-', 2)
  if (!platform || !version) return tail
  return `${platform} ${version.replace(/-/gu, '.')}`
}

function parseBooted(output: string): BootedSimulator[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const devices = (parsed as { devices?: unknown }).devices
  if (typeof devices !== 'object' || devices === null) return []
  const booted: BootedSimulator[] = []
  for (const [runtimeKey, value] of Object.entries(devices as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    for (const entry of value as SimctlDevice[]) {
      const udid = typeof entry.udid === 'string' ? entry.udid : null
      const name = typeof entry.name === 'string' ? entry.name : null
      const state = typeof entry.state === 'string' ? entry.state : ''
      // `booted` is the only state whose framebuffer can be read; a device on its
      // way up (`booting`) will answer in a moment, but this listing is a
      // snapshot and a refresh is one click.
      if (!udid || !name || state !== 'Booted') continue
      booted.push({ udid, name, runtime: runtimeLabel(runtimeKey) })
    }
  }
  return booted
}

/** Every booted iOS Simulator this machine can mirror right now. */
export async function listIosSources(): Promise<DisplaySourceListing> {
  if (process.platform !== 'darwin') {
    return {
      kind: 'ios',
      sources: [],
      problem: 'The iOS Simulator is only available on macOS.'
    }
  }
  let output: string
  try {
    output = await captureText(
      SIMCTL,
      ['simctl', 'list', 'devices', 'booted', '-j'],
      SIMCTL_LIST_TIMEOUT_MS
    )
  } catch (error) {
    return {
      kind: 'ios',
      sources: [],
      problem: `Simulators could not be listed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const sources = parseBooted(output).map((simulator): DisplaySourceDescriptor => ({
    kind: 'ios',
    sourceId: simulator.udid,
    label: `${simulator.name} · Simulator`,
    detail: simulator.runtime
  }))
  return { kind: 'ios', sources }
}

/** A live framebuffer reader for one booted simulator. */
export class IosDisplayCapture implements DisplayCapture {
  readonly kind = 'ios' as const
  private cancelled: (() => void) | null = null
  private disposed = false

  constructor(
    readonly sourceId: string,
    readonly label: string
  ) {}

  async grab(_maxDimension: number): Promise<NativeImage | null> {
    if (this.disposed) return null
    // `--mask=ignored` keeps a notched device's screenshot rectangular, which is
    // what a preview wants: a transparent corner band is not information.
    const command = captureCommand(
      SIMCTL,
      ['simctl', 'io', this.sourceId, 'screenshot', '--type=png', '--mask=ignored', '-'],
      SIMCTL_CAPTURE_TIMEOUT_MS
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

  dispose(): void {
    this.disposed = true
    this.cancelled?.()
    this.cancelled = null
  }
}
