import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import type { DisplayInputGesture, DisplayInputKey } from '../../lib/ipc/display'
import helperSource from './simulator-input-helper.m?raw'

/**
 * Working a simulator through its own window.
 *
 * A simulator is an ordinary application window on macOS, which is why the panel
 * can drive it without reaching into CoreSimulator: Device Hub accepts real
 * clicks, drags and keystrokes, and this app already holds the accessibility grant
 * that lets it post them. The helper is compiled once from the source beside this
 * file with the same Xcode that provides the simulator, so nothing is installed.
 *
 * Where the device's screen sits is not a guess: Device Hub bridges the device's
 * accessibility tree to macOS, and the content group it publishes is the screen
 * itself, in screen points. One read of that rectangle is the whole measurement,
 * so a tap lands where the person aimed without comparing any pixels.
 */

/** One Device Hub window, in screen points. */
export interface SimulatorWindow {
  id: number
  pid: number
  name: string
  x: number
  y: number
  width: number
  height: number
  /** True when that application is the one receiving events right now. */
  front: boolean
}

/** Where the device's screen is on the desktop, in screen points. */
export interface SimulatorSurface {
  window: SimulatorWindow
  x: number
  y: number
  width: number
  height: number
  /** When this measurement was taken, so a moved window can be re-measured. */
  measuredAt: number
}

/** The key codes a Mac keyboard reports, by the panel's own key names. */
const MAC_KEY_CODES: Record<DisplayInputKey, number> = {
  enter: 36,
  backspace: 51,
  tab: 48,
  escape: 53,
  up: 126,
  down: 125,
  left: 123,
  right: 124
}

/**
 * How long a measurement is trusted before the screen is located again.
 *
 * Short on purpose: reading the frame is one accessibility query, and a window
 * that was dragged or moved to another display between two taps must not send the
 * second one somewhere the device no longer is.
 */
const SURFACE_TTL_MS = 3_000

let compiled: Promise<string | null> | null = null
const surfaces = new Map<number, SimulatorSurface>()

/** Run the helper and collect what it printed. */
async function runHelper(helper: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const errors: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'))
        return
      }
      reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `helper exited ${code}`))
    })
  })
}

/**
 * The helper binary, compiled on first use and reused after that.
 *
 * The source is hashed into the binary's name, so a changed helper is rebuilt
 * instead of a stale one being trusted. A machine without the command line tools
 * answers null once, and the panel reports that no simulator can be worked there.
 */
export function simulatorInputHelper(): Promise<string | null> {
  if (compiled) return compiled
  compiled = (async (): Promise<string | null> => {
    if (process.platform !== 'darwin') return null
    const directory = join(app.getPath('userData'), 'display-input')
    const fingerprint = createHash('sha256').update(helperSource).digest('hex').slice(0, 12)
    const binary = join(directory, `cio-display-input-${fingerprint}`)
    try {
      await access(binary, fsConstants.X_OK)
      return binary
    } catch {
      // Not built yet on this machine: fall through and build it once.
    }
    try {
      await mkdir(directory, { recursive: true })
      const source = join(directory, `cio-display-input-${fingerprint}.m`)
      await writeFile(source, helperSource, 'utf8')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          '/usr/bin/clang',
          [
            '-O2',
            '-fno-objc-arc',
            '-framework',
            'Foundation',
            '-framework',
            'AppKit',
            '-framework',
            'ApplicationServices',
            '-framework',
            'CoreAudio',
            '-framework',
            'CoreAudio',
            '-o',
            binary,
            source
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        )
        const errors: Buffer[] = []
        child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
        child.once('error', reject)
        child.once('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(Buffer.concat(errors).toString('utf8').trim()))
        })
      })
      return binary
    } catch {
      // A failed build is not remembered: the toolchain may be installed while the
      // app is running, and the next gesture should try again instead of answering
      // "this machine cannot" for the rest of the session.
      compiled = null
      return null
    }
  })()
  return compiled
}

/** Every window a simulator is being shown in right now. */
export async function listSimulatorWindows(): Promise<SimulatorWindow[]> {
  const helper = await simulatorInputHelper()
  if (!helper) return []
  const output = await runHelper(helper, ['list'])
  const windows: SimulatorWindow[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const id = typeof parsed.id === 'number' ? parsed.id : null
      const pid = typeof parsed.pid === 'number' ? parsed.pid : null
      if (id === null || pid === null) continue
      windows.push({
        id,
        pid,
        name: typeof parsed.name === 'string' ? parsed.name : '',
        x: Number(parsed.x ?? 0),
        y: Number(parsed.y ?? 0),
        width: Number(parsed.w ?? 0),
        height: Number(parsed.h ?? 0),
        front: parsed.front === true
      })
    } catch {
      // A line the helper did not intend as JSON is not a window.
    }
  }
  return windows
}

/** The window showing one device, matched by the name the window carries. */
export async function findSimulatorWindow(deviceName: string): Promise<SimulatorWindow | null> {
  const windows = await listSimulatorWindows()
  if (windows.length === 0) return null
  const exact = windows.find((window) => window.name === deviceName)
  if (exact) return exact
  const named = windows.find((window) => window.name.includes(deviceName))
  if (named) return named
  return windows.length === 1 ? windows[0] : null
}

/** Bring the window's application forward so posted events reach it. */
export async function activateSimulatorWindow(window: SimulatorWindow): Promise<void> {
  if (window.front) return
  const helper = await simulatorInputHelper()
  if (!helper) return
  await runHelper(helper, ['activate', String(window.pid)]).catch(() => undefined)
}

/** The device screen's rectangle inside one window, in screen points. */
async function readScreenFrame(
  window: SimulatorWindow
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const helper = await simulatorInputHelper()
  if (!helper) return null
  let output: string
  try {
    output = await runHelper(helper, ['frame', String(window.pid)])
  } catch {
    return null
  }
  const line = output.split('\n').find((entry) => entry.startsWith('group\t'))
  if (!line) return null
  const [, x, y, width, height] = line.split('\t')
  const frame = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }
  if (![frame.x, frame.y, frame.width, frame.height].every((value) => Number.isFinite(value))) {
    return null
  }
  if (frame.width <= 0 || frame.height <= 0) return null
  return frame
}

/**
 * Where the device is on the desk right now.
 *
 * The window can be moved, resized, or opened on a second display between two
 * gestures, so the frame is read again after a short trust window rather than
 * captured once at connect.
 */
export async function measureSimulatorSurface(
  window: SimulatorWindow
): Promise<SimulatorSurface | null> {
  const cached = surfaces.get(window.id)
  if (
    cached &&
    Date.now() - cached.measuredAt < SURFACE_TTL_MS &&
    cached.window.x === window.x &&
    cached.window.y === window.y &&
    cached.window.width === window.width &&
    cached.window.height === window.height
  ) {
    return cached
  }
  const frame = await readScreenFrame(window)
  if (!frame) return null
  const surface: SimulatorSurface = { window, ...frame, measuredAt: Date.now() }
  surfaces.set(window.id, surface)
  return surface
}

/** Send one gesture to a measured surface. */
export async function postGestureToSurface(
  surface: SimulatorSurface,
  gesture: DisplayInputGesture
): Promise<void> {
  const helper = await simulatorInputHelper()
  if (!helper) throw new Error('This machine cannot post input into a window')
  await activateSimulatorWindow(surface.window)
  const at = (x: number, y: number): [string, string] => [
    String(Math.round(surface.x + x * surface.width)),
    String(Math.round(surface.y + y * surface.height))
  ]
  switch (gesture.type) {
    case 'tap': {
      const [x, y] = at(gesture.x, gesture.y)
      await runHelper(helper, ['click', x, y])
      return
    }
    case 'long-press': {
      const [x, y] = at(gesture.x, gesture.y)
      await runHelper(helper, ['press', x, y, '650'])
      return
    }
    case 'swipe': {
      const [fromX, fromY] = at(gesture.fromX, gesture.fromY)
      const [toX, toY] = at(gesture.toX, gesture.toY)
      await runHelper(helper, [
        'drag',
        fromX,
        fromY,
        toX,
        toY,
        String(Math.max(80, Math.round(gesture.durationMs)))
      ])
      return
    }
    case 'text':
      await runHelper(helper, ['type', gesture.text])
      return
    case 'key':
      await runHelper(helper, ['key', String(MAC_KEY_CODES[gesture.key])])
      return
  }
}

/**
 * Press one of the simulator's own controls, by the name it publishes.
 *
 * Device Hub names its controls in the accessibility tree (the Home, Rotate and
 * Screenshot buttons below the picture, and the Device menu's Home, Lock, Rotate
 * Left, Rotate Right, Increase Volume and Decrease Volume), and an accessibility
 * press is a real press: no pixels are guessed at, and no window has to be in
 * front. The name is stable; a coordinate never is.
 */
export async function pressSimulatorElement(
  window: SimulatorWindow,
  control: string
): Promise<void> {
  const helper = await simulatorInputHelper()
  if (!helper) throw new Error('This machine cannot work a simulator window')
  await activateSimulatorWindow(window)
  await runHelper(helper, ['axpress', String(window.pid), control])
}

/**
 * One volume step.
 *
 * A simulator has no volume of its own: iOS audio leaves through this Mac, so the
 * output volume is the device's volume, and a step is the sixteenth of the range a
 * hardware volume key takes.
 */
export async function stepSimulatorVolume(direction: 'up' | 'down'): Promise<void> {
  const helper = await simulatorInputHelper()
  if (!helper) throw new Error('This machine cannot change its output volume')
  await runHelper(helper, ['volume', direction])
}
