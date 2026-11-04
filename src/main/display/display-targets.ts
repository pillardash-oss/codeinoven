import { resolveAdb } from './display-adb-paths'
import { captureText } from './display-exec'

/**
 * Which display targets exist right now.
 *
 * Presence cannot be decided by watching processes: an agent's `simctl boot`
 * lives for a second or two, and a simulator the OS launches is not a child of the
 * agent's harness at all, so a sampler almost never sees it. The devices
 * themselves are the durable fact, and one cheap question per check answers it.
 *
 * This module deliberately imports no capture adapter: it is the one part of the
 * panel that runs before a panel exists.
 */
const PROBE_TIMEOUT_MS = 8_000
const SIMCTL = '/usr/bin/xcrun'

/** Keys of every target attached or booted right now: `android:<serial>`, `ios:<udid>`. */
export async function detectDisplayTargets(): Promise<string[]> {
  const [android, ios] = await Promise.all([androidTargets(), iosTargets()])
  return [...android, ...ios]
}

async function androidTargets(): Promise<string[]> {
  const adb = resolveAdb()
  if (!adb) return []
  try {
    const output = await captureText(adb, ['devices'], PROBE_TIMEOUT_MS)
    return output.split('\n').flatMap((line) => {
      const [serial, state] = line.trim().split(/\s+/u)
      if (!serial || !state || state !== 'device' || serial === 'List') return []
      return [`android:${serial}`]
    })
  } catch {
    return []
  }
}

async function iosTargets(): Promise<string[]> {
  if (process.platform !== 'darwin') return []
  try {
    const output = await captureText(
      SIMCTL,
      ['simctl', 'list', 'devices', 'booted', '-j'],
      PROBE_TIMEOUT_MS
    )
    return bootedSimulators(output).map((udid) => `ios:${udid}`)
  } catch {
    return []
  }
}

/** Every device simctl reports as `Booted`, flattened out of its runtime keys. */
function bootedSimulators(output: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const devices = (parsed as { devices?: unknown }).devices
  if (typeof devices !== 'object' || devices === null) return []
  const booted: string[] = []
  for (const rows of Object.values(devices as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const entry = row as { udid?: unknown; state?: unknown }
      if (typeof entry.udid === 'string' && entry.state === 'Booted') booted.push(entry.udid)
    }
  }
  return booted
}
