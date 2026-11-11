import type { DisplaySourceKind } from './ipc/display'

/**
 * The device an agent's own tool call is working on, read from the call itself.
 *
 * The display panel is opened by the `ext_simulation` tool, but an agent that is
 * already driving a device with `adb`, `emulator` or `simctl` has no reason to go
 * looking for a mirroring tool first: it simply ran a device command, and the
 * person watching the thread saw nothing. This is the app's own read of that
 * command, so the panel can follow the device work that is already happening
 * instead of depending on the agent remembering to announce it.
 *
 * It reads the call, never the machine: no `adb devices`, no process table and no
 * timer. A command that does not name a device tool costs one regex pass, so an
 * agent working on anything else pays nothing for the feature existing.
 */
export interface DisplayDeviceCommand {
  /** Which kind of target the command works on. */
  platform: Extract<DisplaySourceKind, 'android' | 'ios'>
  /** The device the command names, when it names one. */
  device?: string
}

/** `adb` doing device work: a chosen target, a shell, an install, a capture. */
const ADB_DEVICE_USE =
  /(^|[\s/])adb($|\s)[\s\S]*\b(-s\s|devices|shell|exec-out|exec-in|install|uninstall|logcat|screencap|screenrecord|emu\s|push|pull|getprop|forward|reverse|reboot)\b/u
/** The Android Emulator runtime, its process, or a Scrcpy mirror the agent started. */
const ANDROID_TOOL = /(^|[\s/])(emulator|qemu-system[\w-]*|scrcpy)($|[\s/])/u
/** The Android Emulator application, launched by an agent. */
const ANDROID_APP = /(^|[\s/])Android Emulator\.app($|[\s/])/u
/** The simulator client, which names its target in the same command or implies
 *  the one booted device with `booted`. */
const IOS_TOOL = /(^|[\s/])simctl($|\s)/u
/** The Simulator application, launched by an agent. */
const IOS_APP = /(^|[\s/])Simulator\.app($|[\s/])/u
/** The adb server daemon, which outlives every client and belongs to no target. */
const ADB_SERVER = /\badb\b[\s\S]*\b(fork-server|start-server)\b/u
/** `adb -s <serial>`: the target a device command was aimed at by name. */
const ADB_SERIAL = /(?:^|\s|\/)adb\s[\s\S]*?-s\s+([A-Za-z0-9.:_-]+)/u
/** `ANDROID_SERIAL=<serial> adb ...`: the same target, chosen by environment. */
const ANDROID_SERIAL_ENV = /\bANDROID_SERIAL=([A-Za-z0-9.:_-]+)/u
/** A simulator udid, which `simctl` commands carry as an argument. */
const SIMULATOR_UDID =
  /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/u
/** Arguments of a call that are command text, whichever shell a harness offers. */
const COMMAND_KEYS = ['command', 'cmd', 'code', 'script'] as const
/**
 * The cheap gate every string has to pass before the device patterns run.
 *
 * A tool call is inspected on the app's main thread, and a code-mode script can
 * be long, so the broad patterns below never see a string that does not already
 * mention one of these names. Nothing about device work is missed: every pattern
 * requires one of them.
 */
const DEVICE_HINT = /adb|simctl|scrcpy|emulator|ANDROID_SERIAL|Simulator\.app/u
/** Longest command text examined. A longer one is a script, not a device command. */
const MAX_COMMAND_LENGTH = 24_000

/** The command text one call carries, in the order the keys are checked. */
function commandTexts(input: Record<string, unknown>): string[] {
  const texts: string[] = []
  for (const key of COMMAND_KEYS) {
    const value = input[key]
    if (typeof value !== 'string' || value.length === 0) continue
    if (value.length > MAX_COMMAND_LENGTH) continue
    if (!DEVICE_HINT.test(value)) continue
    texts.push(value)
  }
  return texts
}

/**
 * The device one command line is working on, or null when it names none.
 *
 * The adb server is refused by name: it stays running once anything has ever
 * used adb, so treating the client binary alone as a device signal would open the
 * panel for a machine that ran `adb devices` once.
 */
function targetForCommand(command: string): DisplayDeviceCommand | null {
  if (ADB_SERVER.test(command)) return null
  const udid = SIMULATOR_UDID.exec(command)?.[0]
  if (udid || IOS_TOOL.test(command) || IOS_APP.test(command)) {
    // `simctl ... booted ...` works on the one booted simulator without naming it,
    // and an unnamed target lets the panel offer the only simulator there is.
    return udid ? { platform: 'ios', device: udid } : { platform: 'ios' }
  }
  const android =
    ADB_DEVICE_USE.test(command) ||
    ANDROID_TOOL.test(command) ||
    ANDROID_APP.test(command) ||
    ANDROID_SERIAL_ENV.test(command)
  if (!android) return null
  const serial = ADB_SERIAL.exec(command)?.[1] ?? ANDROID_SERIAL_ENV.exec(command)?.[1]
  return serial ? { platform: 'android', device: serial } : { platform: 'android' }
}

/**
 * The device a tool call works on, or null when the call is not device work.
 *
 * Pure on purpose: what counts as device work is decided from the call alone, so
 * the same answer holds for every harness and every shell tool, and a test can
 * pin the decision without a device or a process.
 */
export function displayDeviceCommand(input: Record<string, unknown>): DisplayDeviceCommand | null {
  for (const command of commandTexts(input)) {
    const target = targetForCommand(command)
    if (target) return target
  }
  return null
}
