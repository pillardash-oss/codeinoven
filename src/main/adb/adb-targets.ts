/**
 * Reading the attached Android targets.
 *
 * `adb devices -l` is the only source of truth for what is plugged in or
 * booted, and it is cheap. Target properties (`ro.product.model`, the SDK
 * level, size and density) cost three shell round trips each, so they are
 * cached briefly and only fetched for targets in the `device` state.
 */

import { runAdb, runAdbOn } from './adb-command'
import type { AdbTarget } from './adb-types'

/** How long a probed target's properties stay fresh. */
const PROPERTY_CACHE_MS = 60_000

interface PropertyCacheEntry {
  model?: string
  product?: string
  device?: string
  sdk?: number
  release?: string
  size?: string
  density?: number
  at: number
}

const propertyCache = new Map<string, PropertyCacheEntry>()

function parseDeviceLine(line: string): AdbTarget | null {
  const tokens = line.trim().split(/\s+/u)
  const serial = tokens[0]
  const state = tokens[1]
  if (!serial || !state) return null
  const fields = new Map<string, string>()
  for (const token of tokens.slice(2)) {
    const separator = token.indexOf(':')
    if (separator <= 0) continue
    fields.set(token.slice(0, separator), token.slice(separator + 1))
  }
  const usb = fields.get('usb')
  const kind: AdbTarget['kind'] =
    serial.startsWith('emulator-') || fields.get('product')?.startsWith('sdk_')
      ? 'emulator'
      : usb
        ? 'usb'
        : serial.includes(':')
          ? 'network'
          : 'unknown'
  return {
    serial,
    state,
    ready: state === 'device',
    kind,
    usb,
    transportId: fields.get('transport_id'),
    model: fields.get('model'),
    product: fields.get('product'),
    device: fields.get('device'),
    leasedByMe: false
  }
}

/** Parse `adb devices -l` output. Exported for tests and for the reconnect ladder. */
export function parseDeviceList(stdout: string): AdbTarget[] {
  const targets: AdbTarget[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim() || line.startsWith('List of devices')) continue
    if (line.startsWith('*')) continue
    const target = parseDeviceLine(line)
    if (target) targets.push(target)
  }
  return targets
}

function parseProperties(output: string): PropertyCacheEntry {
  const values = new Map<string, string>()
  for (const match of output.matchAll(/^\[([^\]]+)\]:\s*\[([^\]]*)\]$/gmu)) {
    values.set(match[1]!, match[2]!)
  }
  const sdk = Number.parseInt(values.get('ro.build.version.sdk') ?? '', 10)
  return {
    model: values.get('ro.product.model'),
    product: values.get('ro.product.product.name') ?? values.get('ro.product.name'),
    device: values.get('ro.product.device'),
    sdk: Number.isFinite(sdk) ? sdk : undefined,
    release: values.get('ro.build.version.release'),
    at: Date.now()
  }
}

function parseDensity(output: string): number | undefined {
  const match = /density:\s*(\d+)/iu.exec(output)
  if (!match) return undefined
  const density = Number.parseInt(match[1]!, 10)
  return Number.isFinite(density) ? density : undefined
}

function parseSize(output: string): string | undefined {
  const match = /(?:Override|Physical) size:\s*(\d+x\d+)/iu.exec(output)
  return match?.[1]
}

async function probeTarget(serial: string): Promise<PropertyCacheEntry> {
  const cached = propertyCache.get(serial)
  if (cached && Date.now() - cached.at < PROPERTY_CACHE_MS) return cached
  const entry: PropertyCacheEntry = { ...(cached ?? {}), at: Date.now() }
  try {
    Object.assign(entry, parseProperties(await runAdbOn(serial, ['shell', 'getprop'])))
  } catch {
    // A target can vanish between the list and the probe; the caller reports
    // whatever the list said and the missing fields stay undefined.
  }
  try {
    entry.size = parseSize(await runAdbOn(serial, ['shell', 'wm', 'size']))
  } catch {
    // Leave size unset.
  }
  try {
    entry.density = parseDensity(await runAdbOn(serial, ['shell', 'wm', 'density']))
  } catch {
    // Leave density unset.
  }
  entry.at = Date.now()
  propertyCache.set(serial, entry)
  return entry
}

/** Drop a cached probe, so a reconnect or a rotated target is re-read. */
export function invalidateTargetProperties(serial?: string): void {
  if (serial) propertyCache.delete(serial)
  else propertyCache.clear()
}

/**
 * Every attached target, with properties filled in for the ones that can be
 * driven. A `unauthorized` target is reported as it stands: the phone is showing
 * an RSA prompt and no command gets past it, which the caller needs to know.
 */
export async function listTargets(options: { probe?: boolean } = {}): Promise<AdbTarget[]> {
  const result = await runAdb(['devices', '-l'], { tolerateFailure: true })
  const targets = parseDeviceList(result.stdout)
  if (options.probe === false) return targets
  return Promise.all(
    targets.map(async (target) => {
      if (!target.ready) return target
      const properties = await probeTarget(target.serial)
      return {
        ...target,
        model: target.model ?? properties.model,
        product: target.product ?? properties.product,
        device: target.device ?? properties.device,
        sdk: properties.sdk,
        release: properties.release,
        size: properties.size,
        density: properties.density
      }
    })
  )
}

/** Look up one ready target by serial, or the only ready target when omitted. */
export async function resolveTarget(serial?: string): Promise<AdbTarget> {
  const targets = await listTargets()
  if (serial) {
    const match = targets.find((target) => target.serial === serial)
    if (!match) {
      const attached = targets.map((target) => target.serial).join(', ')
      throw new Error(
        attached
          ? `No attached target has the serial "${serial}". Attached: ${attached}.`
          : `No Android target is attached, so "${serial}" cannot be found.`
      )
    }
    return match
  }
  const ready = targets.filter((target) => target.ready)
  if (ready.length === 0) {
    const states = targets.map((target) => `${target.serial} (${target.state})`).join(', ')
    throw new Error(
      states
        ? `No attached target is in the "device" state and can be driven: ${states}. An "unauthorized" target is showing an RSA prompt on the phone that someone has to accept.`
        : 'No Android target is attached. Connect a phone over USB with USB debugging enabled, or boot an emulator.'
    )
  }
  if (ready.length > 1) {
    const serials = ready.map((target) => target.serial).join(', ')
    throw new Error(`More than one target can be driven (${serials}). Pass serial to choose one.`)
  }
  return ready[0]!
}
