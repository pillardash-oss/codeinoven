import {
  TRAFFIC_LIGHT_OFFSET,
  hasCaptionOverlay,
  type TrafficLightInfo,
  type TrafficLightSide
} from '$shared/traffic-light'

/**
 * Universal source of truth for the OS window-control (traffic light) inset.
 *
 * The app header and every fullscreen dialog double as a draggable title bar;
 * all of them must reserve the same horizontal space for the window controls
 * so headings and buttons never sit underneath them. macOS draws its traffic
 * lights on the left. Windows and Linux both overlay native caption buttons on
 * the right, whose live dimensions come from the Window Controls Overlay CSS
 * variables. The fixed layout is handed over through the preload bridge.
 *
 * Reserve whichever edge owns in-content controls; optional trailing padding
 * preserves each header's own spacing outside the native controls.
 */
class TrafficLightState {
  /** Caption overlay dimensions are supplied by Chromium, not preload. */
  readonly usesCaptionOverlay: boolean
  /**
   * Whether the desktop, not the OS family, decides which edge holds the
   * caption buttons.
   *
   * Windows always keeps them on the right. A Linux desktop follows
   * `gtk-decoration-layout`, and several distributions   Ubuntu's default among
   * them   put close/minimize/maximize on the left, so on Linux both edges have
   * to be guarded and the Window Controls Overlay variables decide which one
   * actually carries buttons.
   */
  readonly captionSideFollowsDesktop: boolean

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
    this.usesCaptionOverlay = hasCaptionOverlay(bridge?.api?.windowInfo?.platform)
    this.captionSideFollowsDesktop = bridge?.api?.windowInfo?.platform === 'linux'
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
  /** Minimum right gutter when reserving the caption overlay. */
  rightPadding?: string
  /**
   * Extra left gutter when reserving the caption overlay.
   *
   * Caption controls leave the opposite edge of a title bar with nothing but
   * its own small padding, so a heading there reads as glued to the window
   * edge next to macOS, where the traffic lights push it inward. Surfaces that
   * want that same breathing room opt in with this gutter. On Linux it is also
   * the floor a left-side caption cluster can grow into.
   */
  leftPadding?: string
  /** Only reserve controls on this edge, for an edge-aligned panel. */
  controlSide?: Exclude<TrafficLightSide, null>
}

/**
 * Padding that clears the caption buttons drawn over renderer content.
 *
 * The Window Controls Overlay variables bound the titlebar area, not the
 * buttons, so the caption region is whatever the titlebar area leaves over: its
 * offset on the left, and the width beyond it on the right. Reserving the right
 * edge is always correct; the left is only reserved where the desktop may have
 * put the buttons there (see `captionSideFollowsDesktop`), because on Windows
 * that declaration would overwrite a surface's own left padding for nothing.
 * A surface that only reaches the window's right edge (a right-hand drawer) has
 * no left edge to guard, so it reserves the right alone.
 */
function captionOverlayPadding(options: TrafficLightInsetOptions): string {
  const gutter = options.rightPadding ?? '1.25rem'
  const captionLeft = 'env(titlebar-area-x, 0px)'
  const declarations = [
    `padding-right: max(${gutter}, calc(100vw - ${captionLeft} - env(titlebar-area-width, 100vw)))`
  ]
  if (options.controlSide === 'right') return declarations[0]
  if (trafficLightState.captionSideFollowsDesktop) {
    declarations.unshift(`padding-left: max(${options.leftPadding ?? '0px'}, ${captionLeft})`)
  } else if (options.leftPadding) {
    declarations.unshift(`padding-left: ${options.leftPadding}`)
  }
  return declarations.join('; ')
}

/** CSS padding that reserves the traffic-light inset on the correct edge. */
export function trafficLightInsetStyle(options: TrafficLightInsetOptions = {}): string {
  if (trafficLightState.usesCaptionOverlay) {
    if (options.controlSide === 'left') return ''
    return captionOverlayPadding(options)
  }
  if (!trafficLightState.present || trafficLightState.side === null) return ''
  if (options.controlSide && options.controlSide !== trafficLightState.side) return ''
  if (trafficLightState.side !== 'left') {
    return `padding-right: ${trafficLightState.offset}px`
  }
  const leftInset = `padding-left: ${trafficLightState.offset}px`
  return options.mirrorRightInset === false ? leftInset : `${leftInset}; padding-right: 1.25rem`
}
