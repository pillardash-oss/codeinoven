/**
 * Traffic-light window controls — shared by the main process, the preload
 * bridge, and the renderer.
 *
 * Surfaces that double as a draggable title bar (the app header and the
 * fullscreen file/terminal dialogs) must reserve horizontal space for the OS
 * window controls so headings and buttons never sit underneath them.
 *
 * macOS always draws its traffic lights inset on the left. Windows draws a
 * native frame with its own controls — nothing to reserve. Linux lets the user
 * configure the side, so the layout is detected at startup and handed to the
 * renderer process through the preload bridge.
 */

export type TrafficLightSide = 'left' | 'right' | null

export interface TrafficLightInfo {
  /** Whether the window surface shows in-content window controls. */
  present: boolean
  /** Which edge the controls sit on; null when none are present. */
  side: TrafficLightSide
  /** Horizontal padding to reserve for the controls, in px. 0 when absent. */
  offset: number
}

/** Horizontal inset kept for the macOS traffic lights (matches `pl-20`; the traffic
 *  light cluster itself sits at x:16 and is ~54px wide, so this leaves a small
 *  breathing gap without pushing the first nav icon far past the buttons). */
export const TRAFFIC_LIGHT_OFFSET = 75

/** No in-content window controls — nothing to reserve. */
export const NO_TRAFFIC_LIGHT: TrafficLightInfo = { present: false, side: null, offset: 0 }

/** Command-line flag carrying the resolved layout into the renderer process. */
export const TRAFFIC_LIGHT_ARG_PREFIX = '--cio-traffic-light='

export function serializeTrafficLight(info: TrafficLightInfo): string {
  return encodeURIComponent(JSON.stringify(info))
}

export function parseTrafficLight(value: string | undefined): TrafficLightInfo | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<TrafficLightInfo>
    if (typeof parsed.present !== 'boolean') return null
    const side = parsed.side === 'left' || parsed.side === 'right' ? parsed.side : null
    const offset =
      typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) ? parsed.offset : 0
    return { present: parsed.present, side, offset }
  } catch {
    return null
  }
}
