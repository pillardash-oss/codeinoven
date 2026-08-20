import {
  NO_TRAFFIC_LIGHT,
  TRAFFIC_LIGHT_ARG_PREFIX,
  TRAFFIC_LIGHT_OFFSET,
  serializeTrafficLight,
  type TrafficLightInfo
} from '../../lib/traffic-light'

/**
 * Resolve where the window controls live for the current OS.
 *
 * macOS: traffic lights always sit inset on the left.
 * Windows/Linux: the native frame owns its own controls — nothing to reserve.
 * GTK's decoration layout describes controls in that native frame, not controls
 * drawn over the renderer, so it must never become renderer padding.
 */
export async function resolveTrafficLightInfo(): Promise<TrafficLightInfo> {
  if (process.platform === 'darwin') {
    return { present: true, side: 'left', offset: TRAFFIC_LIGHT_OFFSET }
  }
  return NO_TRAFFIC_LIGHT
}

let cachedArg: string | null = null

/** Synchronous fallback used before the async detection has completed. */
function syncDefaultArg(): string {
  const info: TrafficLightInfo =
    process.platform === 'darwin'
      ? { present: true, side: 'left', offset: TRAFFIC_LIGHT_OFFSET }
      : NO_TRAFFIC_LIGHT
  return serializeTrafficLight(info)
}

/** Resolve the layout once and cache the argv flag for every window. */
export async function warmTrafficLightDetection(): Promise<void> {
  cachedArg = serializeTrafficLight(await resolveTrafficLightInfo())
}

/** The `additionalArguments` payload to pass into each BrowserWindow. */
export function getTrafficLightArg(): string {
  const value = cachedArg ?? syncDefaultArg()
  return `${TRAFFIC_LIGHT_ARG_PREFIX}${value}`
}
