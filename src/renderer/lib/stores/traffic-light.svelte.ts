import {
  TRAFFIC_LIGHT_OFFSET,
  type TrafficLightInfo,
  type TrafficLightSide
} from '$shared/traffic-light'

/**
 * Universal source of truth for the OS window-control (traffic light) inset.
 *
 * The app header and every fullscreen dialog double as a draggable title bar;
 * all of them must reserve the same horizontal space for the window controls
 * so headings and buttons never sit underneath them. macOS draws its traffic
 * lights on the left, Windows uses its native frame, and Linux lets the user
 * pick a side — the layout is resolved in the main process at startup and
 * handed over through the preload bridge, so there is never a visual flash.
 */
class TrafficLightState {
  /** Horizontal padding to reserve for the window controls, in px. */
  offset = $state(0)
  /** Which edge the controls sit on; null when none are present. */
  side = $state<TrafficLightSide>(null)
  /** Whether the window surface shows in-content window controls. */
  present = $state(false)

  constructor() {
    // The full `AppBridge` type lives in the preload script; probe only the
    // fields we need so this store stays decoupled from the bridge module.
    const bridge = (typeof window !== 'undefined' ? window : null) as {
      api?: { windowInfo?: { platform?: string; trafficLight?: TrafficLightInfo } }
    } | null
    const info = bridge?.api?.windowInfo?.trafficLight ?? null
    const onMac = bridge?.api?.windowInfo?.platform === 'darwin'
    // macOS always draws its traffic lights — never render with a zero inset,
    // even if a stale bridge reports none.
    const usable = info && !(onMac && !info.present)
    if (usable) {
      this.offset = info.offset
      this.side = info.side
      this.present = info.present
    } else {
      // No bridge (plain browser / phone client) — fall back to the historical
      // macOS-like layout so nothing regresses outside the desktop shell.
      this.offset = TRAFFIC_LIGHT_OFFSET
      this.side = 'left'
      this.present = true
    }
  }
}

export const trafficLightState = new TrafficLightState()

/** CSS padding that reserves the traffic-light inset on the correct edge. */
export function trafficLightInsetStyle(): string {
  if (!trafficLightState.present || trafficLightState.side === null) return ''
  return trafficLightState.side === 'left'
    ? `padding-left: ${trafficLightState.offset}px`
    : `padding-right: ${trafficLightState.offset}px`
}
