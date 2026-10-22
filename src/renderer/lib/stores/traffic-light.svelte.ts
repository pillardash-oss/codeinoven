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
 * lights on the left. Windows overlays native caption buttons on the right,
 * whose live dimensions come from the Window Controls Overlay CSS variables.
 * Linux native-frame controls do not overlap renderer content. The fixed
 * layout is handed over through the preload bridge.
 *
 * Reserve whichever edge owns in-content controls; optional trailing padding
 * preserves each header's own spacing outside the native controls.
 */
class TrafficLightState {
  /** Windows caption overlay dimensions are supplied by Chromium, not preload. */
  readonly usesCaptionOverlay: boolean

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
    this.usesCaptionOverlay = bridge?.api?.windowInfo?.platform === 'win32'
    const info = bridge?.api?.windowInfo?.trafficLight ?? null
    const hasDesktopBridge = bridge?.api?.windowInfo !== undefined
    const onMac = bridge?.api?.windowInfo?.platform === 'darwin'
    // macOS always draws its traffic lights — never render with a zero inset,
    // even if a stale bridge reports none.
    const usable = info && !(onMac && !info.present)
    if (usable) {
      this.offset = info.offset
      this.side = info.side
      this.present = info.present
    } else if (!hasDesktopBridge) {
      // No bridge (plain browser) — preserve the historical browser-shell
      // layout. A desktop bridge with absent controls stays at 0.
      this.offset = TRAFFIC_LIGHT_OFFSET
      this.side = 'left'
      this.present = true
    }
  }
}

export const trafficLightState = new TrafficLightState()

export interface TrafficLightInsetOptions {
  /**
   * Mirror the left control cluster with an equal inset on the right edge.
   *
   * Surfaces that centre chrome of their own (fullscreen dialog headers) want
   * that symmetry. A surface whose right edge must line up with a neighbouring
   * rail (the app header above the context dock) opts out, so its own right
   * padding stays the single source of that alignment instead of being
   * overwritten here on macOS only.
   */
  mirrorRightInset?: boolean
  /** Minimum right gutter when reserving the Windows caption overlay. */
  rightPadding?: string
  /**
   * Extra left gutter when reserving the Windows caption overlay.
   *
   * Controls on the right leave the left edge of a title bar with nothing but
   * its own small padding, so a heading there reads as glued to the window
   * edge next to macOS, where the traffic lights push it inward. Surfaces that
   * want that same breathing room opt in with this gutter.
   */
  leftPadding?: string
  /** Only reserve controls on this edge, for an edge-aligned panel. */
  controlSide?: Exclude<TrafficLightSide, null>
}

/** CSS padding that reserves the traffic-light inset on the correct edge. */
export function trafficLightInsetStyle(options: TrafficLightInsetOptions = {}): string {
  if (trafficLightState.usesCaptionOverlay) {
    if (options.controlSide === 'left') return ''
    const gutter = options.rightPadding ?? '1.25rem'
    const right = `padding-right: max(${gutter}, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))`
    return options.leftPadding ? `padding-left: ${options.leftPadding}; ${right}` : right
  }
  if (!trafficLightState.present || trafficLightState.side === null) return ''
  if (options.controlSide && options.controlSide !== trafficLightState.side) return ''
  if (trafficLightState.side !== 'left') {
    return `padding-right: ${trafficLightState.offset}px`
  }
  const leftInset = `padding-left: ${trafficLightState.offset}px`
  return options.mirrorRightInset === false ? leftInset : `${leftInset}; padding-right: 1.25rem`
}
