import { accessSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { NativeImage } from 'electron'
import type { DisplaySourceDescriptor, DisplaySourceListing } from '../../lib/ipc/display'
import { type DisplayCapture, decodeDisplayImage } from './display-capture'
import { captureCommand, captureText } from './display-exec'

/**
 * Android targets over adb.
 *
 * This is the case the panel exists for: an agent runs an emulator with no
 * window, or drives a phone on a cable, and nothing of it is on the user's
 * desktop. `screencap` reads the framebuffer over the same channel the agent is
 * already using, so the preview works headlessly by construction.
 *
 * `adb` is usually not on PATH (the installed SDK keeps it under
 * `~/Library/Android/sdk/platform-tools`), which is why the binary is resolved
 * from the same known locations the app's own adb playbook documents.
 */

/** Where an adb binary hides on a machine that has Android tooling installed. */
function adbCandidates(): string[] {
  const candidates: string[] = []
  const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  if (androidHome) candidates.push(join(androidHome, 'platform-tools', 'adb'))
  const home = homedir()
  candidates.push(
    join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    '/usr/bin/adb'
  )
  return candidates
}

/** Discovery timeout. First call starts the adb server, which is the slow one. */
const ADB_LIST_TIMEOUT_MS = 15_000
/** One framebuffer read. A healthy device answers in 100-250 ms. */
const ADB_CAPTURE_TIMEOUT_MS = 8_000

/** The binary already found, if one has been. Only a success is remembered: a
 *  machine that gains platform-tools while the app runs should find it on the
 *  next listing instead of needing a restart. */
let resolvedAdb: string | null = null

/** The adb binary this machine has, resolved once and reused after that. */
export function resolveAdb(): string | null {
  if (resolvedAdb) return resolvedAdb
  for (const candidate of adbCandidates()) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      resolvedAdb = candidate
      return resolvedAdb
    } catch {
      // Next candidate: a machine can have several SDKs, and only one needs to work.
    }
  }
  return null
}

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

  dispose(): void {
    this.disposed = true
    this.cancelled?.()
    this.cancelled = null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
