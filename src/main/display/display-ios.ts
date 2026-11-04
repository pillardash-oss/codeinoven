import { app } from 'electron'
import { accessSync, constants as fsConstants, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  DisplayControlAction,
  DisplayInputGesture,
  DisplayInputKey,
  DisplaySourceDescriptor,
  DisplaySourceListing
} from '../../lib/ipc/display'
import { type CapturedFrame, type DisplayCapture, pngFrame } from './display-capture'
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
/** One injected gesture. idb reaches a companion over gRPC, so it is the slower half. */
const IDB_INPUT_TIMEOUT_MS = 15_000
/** Asking a simulator how big its screen is, in the points its taps use. */
const IDB_DESCRIBE_TIMEOUT_MS = 20_000

const SIMCTL = '/usr/bin/xcrun'

/**
 * The idb client, which is the only way to touch a booted Simulator.
 *
 * `simctl` reads a simulator's framebuffer but cannot inject an event into it,
 * and `idb_companion` on its own is a server with no command line worth typing.
 * The `idb` client speaks to that companion, so a simulator gains taps and
 * typing the moment this binary exists and keeps a read-only preview until then.
 */
let resolvedIdb: string | null = null
let lookedForIdb = false

function idbCandidates(): string[] {
  const candidates: string[] = []
  const path = process.env.PATH ?? ''
  for (const directory of path.split(':')) {
    if (directory.length > 0) candidates.push(join(directory, 'idb'))
  }
  const home = homedir()
  candidates.push('/opt/homebrew/bin/idb', '/usr/local/bin/idb', join(home, '.local', 'bin', 'idb'))
  // A `pip install --user` on macOS system Python, which is the install the
  // fb-idb docs describe, lands the client under a versioned directory that is
  // never on PATH: `~/Library/Python/3.9/bin/idb`. It is checked before the
  // unversioned guess so a client that exists is actually found.
  const pythonRoot = join(home, 'Library', 'Python')
  try {
    for (const version of readdirSync(pythonRoot).sort().reverse()) {
      // Only the versioned install directories: `~/Library/Python` also holds
      // whatever the Finder left there, and a `.DS_Store` is not a Python.
      if (!/^\d+\.\d+$/u.test(version)) continue
      candidates.push(join(pythonRoot, version, 'bin', 'idb'))
    }
  } catch {
    // No user Python install at all: the fixed candidates above still apply.
  }
  return candidates
}

/** The idb client this machine has, or null. A success is remembered; a miss is
 *  re-checked, because installing it while the app runs should just start working. */
export function resolveIdb(): string | null {
  if (resolvedIdb) return resolvedIdb
  lookedForIdb = true
  for (const candidate of idbCandidates()) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      resolvedIdb = candidate
      return resolvedIdb
    } catch {
      // Next candidate: a Python user install and a Homebrew install coexist often.
    }
  }
  return null
}
/** Whether the last idb lookup was a miss, so a listing can say so instead of
 *  pretending the platform offers nothing. */
export function idbWasMissing(): boolean {
  return lookedForIdb && resolvedIdb === null
}

/** The HID key usages `idb ui key` takes, by the panel's own key names. */
const IDB_KEY_CODES: Record<DisplayInputKey, number> = {
  enter: 40,
  escape: 41,
  backspace: 42,
  tab: 43,
  right: 79,
  left: 80,
  down: 81,
  up: 82
}

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
  /** The simulator's point size, asked once before the first gesture. */
  private screen: { width: number; height: number } | null = null
  private screenRequest: Promise<{ width: number; height: number } | null> | null = null

  constructor(
    readonly sourceId: string,
    readonly label: string
  ) {}

  /** Why a simulator cannot be touched, when its client is missing. */
  get inputProblem(): string | undefined {
    return resolveIdb()
      ? undefined
      : 'Tapping a simulator needs the idb client (fb-idb). Preview only.'
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
   * The device answers `HOME`, `LOCK` (the side button, which locks a lit screen
   * and wakes a dark one) and `SIRI` through the idb client, and its back
   * affordance is the system edge swipe rather than a key. Appearance is the one
   * control `simctl` owns. Volume is absent on purpose: the simulator exposes no
   * volume button, so a rail entry for it would be a button that does nothing.
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
    const idb = resolveIdb()
    if (!idb) throw new Error('A simulator needs the idb client (fb-idb) for its buttons')
    switch (action) {
      case 'home':
        await this.ask(idb, ['ui', 'button', 'HOME'])
        return
      case 'power':
        await this.ask(idb, ['ui', 'button', 'LOCK'])
        return
      case 'siri':
        await this.ask(idb, ['ui', 'button', 'SIRI'])
        return
      case 'back': {
        // iOS has no back button: the system affordance is a drag that starts at
        // the left edge, so the rail presses where a thumb would.
        const screen = (await this.screenSize(idb)) ?? { width: 400, height: 800 }
        const y = Math.round(screen.height / 2)
        await this.ask(idb, [
          'ui',
          'swipe',
          String(Math.max(1, Math.round(screen.width * 0.005))),
          String(y),
          String(Math.round(screen.width * 0.7)),
          String(y),
          '--duration',
          '0.25'
        ])
        return
      }
      default:
        throw new Error(`A simulator has no "${action}" control`)
    }
  }

  async input(gesture: DisplayInputGesture): Promise<void> {
    const idb = resolveIdb()
    if (!idb) throw new Error('Tapping a simulator needs the idb client (fb-idb)')
    switch (gesture.type) {
      case 'tap':
      case 'long-press': {
        const point = await this.points(idb, gesture.x, gesture.y)
        if (gesture.type === 'tap') {
          await this.ask(idb, ['ui', 'tap', String(point.x), String(point.y)])
          return
        }
        // A press on iOS is a tap that is held: a drag that starts and ends on the
        // same point for six tenths of a second is what iOS reports as a press.
        await this.ask(idb, [
          'ui',
          'swipe',
          String(point.x),
          String(point.y),
          String(point.x),
          String(point.y),
          '--duration',
          '0.6'
        ])
        return
      }
      case 'swipe': {
        const from = await this.points(idb, gesture.fromX, gesture.fromY)
        const to = await this.points(idb, gesture.toX, gesture.toY)
        await this.ask(idb, [
          'ui',
          'swipe',
          String(from.x),
          String(from.y),
          String(to.x),
          String(to.y),
          '--duration',
          String(Math.max(0.05, gesture.durationMs / 1000))
        ])
        return
      }
      case 'text':
        await this.ask(idb, ['ui', 'text', gesture.text])
        return
      case 'key':
        await this.ask(idb, ['ui', 'key', String(IDB_KEY_CODES[gesture.key])])
        return
    }
  }

  /** One idb command against this simulator. */
  private async ask(idb: string, args: string[]): Promise<void> {
    await captureCommand(idb, [...args, '--udid', this.sourceId], IDB_INPUT_TIMEOUT_MS).promise
  }

  /** A fraction of the screen as the points a simulator's taps are measured in. */
  private async points(idb: string, x: number, y: number): Promise<{ x: number; y: number }> {
    const screen = await this.screenSize(idb)
    if (!screen) return { x: Math.round(x * 400), y: Math.round(y * 800) }
    return {
      x: Math.min(screen.width - 1, Math.max(0, Math.round(x * screen.width))),
      y: Math.min(screen.height - 1, Math.max(0, Math.round(y * screen.height)))
    }
  }

  /**
   * The simulator's screen in points.
   *
   * `idb describe` reports both pixels and points; taps are in points, which is
   * the number that matches what the screenshot is scaled from.
   */
  private screenSize(idb: string): Promise<{ width: number; height: number } | null> {
    if (this.screen) return Promise.resolve(this.screen)
    if (this.screenRequest) return this.screenRequest
    const request = captureText(
      idb,
      ['describe', '--json', '--udid', this.sourceId],
      IDB_DESCRIBE_TIMEOUT_MS
    )
      .then((output) => readScreenPoints(output))
      .catch(() => null)
      .then((screen) => {
        this.screen = screen
        this.screenRequest = null
        return screen
      })
    this.screenRequest = request
    return request
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

/** Pull width and height in points out of `idb describe`'s JSON. */
function readScreenPoints(output: string): { width: number; height: number } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const dimensions = (parsed as { screen_dimensions?: unknown }).screen_dimensions
  if (typeof dimensions !== 'object' || dimensions === null) return null
  const size = dimensions as { width_points?: unknown; height_points?: unknown }
  const width = typeof size.width_points === 'number' ? size.width_points : null
  const height = typeof size.height_points === 'number' ? size.height_points : null
  if (!width || !height || width <= 0 || height <= 0) return null
  return { width, height }
}
