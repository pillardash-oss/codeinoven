import { app } from 'electron'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  DisplayControlAction,
  DisplayInputGesture,
  DisplaySourceDescriptor,
  DisplaySourceListing
} from '../../lib/ipc/display'
import { type CapturedFrame, type DisplayCapture, pngFrame } from './display-capture'
import { captureCommand, captureText } from './display-exec'
import {
  findSimulatorWindow,
  measureSimulatorSurface,
  postGestureToSurface,
  pressSimulatorElement,
  simulatorInputHelper,
  stepSimulatorVolume,
  type SimulatorWindow
} from './display-simulator-input'

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

/** The device's own name, which is what its window is titled. */
function readDeviceName(output: string, udid: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const devices = (parsed as { devices?: unknown }).devices
  if (typeof devices !== 'object' || devices === null) return null
  for (const value of Object.values(devices as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    for (const entry of value as SimctlDevice[]) {
      if (entry.udid === udid && typeof entry.name === 'string') return entry.name
    }
  }
  return null
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

/**
 * A live framebuffer reader for one booted simulator.
 *
 * `simctl io screenshot` writes a file, and its own help text advertises `-` for
 * stdout, but this Xcode's simctl treats `-` as the literal filename: it writes a
 * file called `-` in the working directory and prints nothing. A frame therefore
 * goes through a private temp directory, created once per session and removed
 * with it, which also keeps the renderer's copy exactly one read away.
 */
export class IosDisplayCapture implements DisplayCapture {
  readonly kind = 'ios' as const
  private cancelled: (() => void) | null = null
  private disposed = false
  /** Screen-capture scratch for this session, created on the first frame. */
  private directory: Promise<string | null> | null = null
  /** The device's own name, which is what its window is titled. */
  private name: string | null = null
  private nameRequest: Promise<string> | null = null

  constructor(
    readonly sourceId: string,
    readonly label: string
  ) {}

  /** Why a simulator cannot be touched, when its client is missing. */
  get inputProblem(): string | undefined {
    return process.platform === 'darwin'
      ? undefined
      : 'Working a simulator window is only possible on macOS.'
  }

  async grab(_maxDimension: number): Promise<CapturedFrame | null> {
    if (this.disposed) return null
    const directory = await this.ensureDirectory()
    if (!directory) return null
    const file = join(directory, 'frame.png')
    // `--mask=ignored` keeps a notched device's screenshot rectangular, which is
    // what a preview wants: a transparent corner band is not information.
    const command = captureCommand(
      SIMCTL,
      ['simctl', 'io', this.sourceId, 'screenshot', '--type=png', '--mask=ignored', file],
      SIMCTL_CAPTURE_TIMEOUT_MS
    )
    this.cancelled = command.cancel
    try {
      await command.promise
      if (this.disposed) return null
      const bytes = await readFile(file)
      // The simulator wrote a PNG; those bytes are the frame. No decode, no
      // re-encode, nothing rebuilt from pixels on this thread.
      return pngFrame(bytes)
    } finally {
      this.cancelled = null
    }
  }

  /**
   * A simulator's own buttons, and nothing invented.
   *
   * Every button here is pressed the way a hand presses it: Home and Lock are
   * Device Hub's own controls, and back is the system edge swipe. Appearance is the
   * one control `simctl` owns, and volume is this Mac's output volume because that
   * is the volume a simulator plays at. Nothing in the rail is a button that does
   * nothing.
   */
  async control(action: DisplayControlAction): Promise<void> {
    if (action === 'appearance') {
      const current = await captureText(
        SIMCTL,
        ['simctl', 'ui', this.sourceId, 'appearance'],
        SIMCTL_CAPTURE_TIMEOUT_MS
      )
      const next = current.trim() === 'dark' ? 'light' : 'dark'
      await captureCommand(
        SIMCTL,
        ['simctl', 'ui', this.sourceId, 'appearance', next],
        SIMCTL_CAPTURE_TIMEOUT_MS
      ).promise
      return
    }
    if (action === 'volume-up' || action === 'volume-down') {
      await stepSimulatorVolume(action === 'volume-up' ? 'up' : 'down')
      return
    }
    if (action === 'back' || action === 'home' || action === 'power') {
      const window = await this.window()
      if (!window) throw new Error(`Open ${await this.deviceName()} in Device Hub to work it`)
      if (action === 'home') {
        // Device Hub's own Home button is the device's home button, so pressing it
        // is the same act as pressing the one on the phone.
        await pressSimulatorElement(window, 'Home')
        return
      }
      if (action === 'power') {
        // The side button, which locks a lit screen and wakes a dark one.
        await pressSimulatorElement(window, 'Lock')
        return
      }
      const surface = await measureSimulatorSurface(window)
      if (!surface) throw new Error('The device screen could not be located in its window')
      // iOS has no back button: the system affordance is a drag from the left edge,
      // so the rail presses where a thumb would.
      await postGestureToSurface(surface, {
        type: 'swipe',
        fromX: 0.004,
        fromY: 0.5,
        toX: 0.7,
        toY: 0.5,
        durationMs: 250
      })
      return
    }
    throw new Error(`A simulator has no "${action}" control`)
  }

  /**
   * Work the device the way a hand would, through its own window.
   *
   * The simulator is an application on this Mac, so a tap is a click at the place
   * the person pointed at and a swipe is a drag. Where that place is comes from the
   * window's accessibility tree, never from a guess: the device's screen is a node
   * with an exact frame, and the panel's fractions are mapped onto it.
   */
  async input(gesture: DisplayInputGesture): Promise<void> {
    if (!(await simulatorInputHelper())) {
      throw new Error('This machine cannot post input into an application window')
    }
    const window = await this.window()
    if (!window) throw new Error(`Open ${await this.deviceName()} in Device Hub to work it`)
    const surface = await measureSimulatorSurface(window)
    if (!surface) throw new Error('The device screen could not be located in its window')
    await postGestureToSurface(surface, gesture)
  }

  /** The window showing this device, found by the name the window carries. */
  private async window(): Promise<SimulatorWindow | null> {
    return findSimulatorWindow(await this.deviceName())
  }

  /** The device's own name, which is what its window is titled. */
  private deviceName(): Promise<string> {
    if (this.name) return Promise.resolve(this.name)
    if (!this.nameRequest) {
      const udid = this.sourceId
      this.nameRequest = captureText(
        SIMCTL,
        ['simctl', 'list', 'devices', '-j'],
        SIMCTL_LIST_TIMEOUT_MS
      )
        .then((output) => readDeviceName(output, udid))
        .catch(() => null)
        .then((name) => {
          this.name = name ?? 'this simulator'
          this.nameRequest = null
          return this.name
        })
    }
    return this.nameRequest
  }

  dispose(): void {
    this.disposed = true
    this.cancelled?.()
    this.cancelled = null
    const directory = this.directory
    this.directory = null
    void directory
      ?.then((path) => (path ? rm(path, { recursive: true, force: true }) : undefined))
      .catch(() => undefined)
  }

  /** The session's scratch directory, or null when the platform refused to make one. */
  private ensureDirectory(): Promise<string | null> {
    if (this.directory) return this.directory
    const created = mkdtemp(join(app.getPath('temp') ?? tmpdir(), 'codeinoven-display-'))
      .catch(() => mkdtemp(join(tmpdir(), 'codeinoven-display-')))
      .catch(() => null)
    this.directory = created
    return created
  }
}
