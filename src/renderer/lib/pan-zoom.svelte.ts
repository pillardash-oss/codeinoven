/**
 * Wheel travel, in pixels, that counts as one mouse notch.
 *
 * A wheel event is not a tick. A mouse notch reports about 100px, an Electron
 * pinch reports a handful of pixels with `ctrlKey` set, and a trackpad swipe
 * reports a long stream of 1-5px events. Treating every event as one full step
 * made those streams zoom dozens of times inside a single gesture.
 */
const WHEEL_NOTCH_PIXELS = 100
/** Pinch deltas are much smaller than wheel ones for the same intent. */
const PINCH_NOTCH_PIXELS = 24
/** Browsers that report lines or pages instead of pixels (`deltaMode`). */
const DELTA_MODE_LINE = 1
const DELTA_MODE_PAGE = 2
const WHEEL_LINE_PIXELS = 16
const WHEEL_PAGE_PIXELS = 800
/** A single event never moves more than one wheel step, however large its delta. */
const MAX_WHEEL_STEPS = 1

function wheelPixels(event: WheelEvent): number {
  const scale =
    event.deltaMode === DELTA_MODE_LINE
      ? WHEEL_LINE_PIXELS
      : event.deltaMode === DELTA_MODE_PAGE
        ? WHEEL_PAGE_PIXELS
        : 1
  return event.deltaY * scale
}

export interface PanZoomOptions {
  min?: number
  max?: number
  /** Multiplier applied per wheel notch and per toolbar zoom click. */
  step?: number
  /**
   * Pointer travel, in pixels, before a press becomes a pan.
   *
   * A surface that also acts on a click (an artifact element being picked)
   * cannot pan from the first pixel: capturing the pointer retargets the
   * gesture, so the click the surface was waiting for never arrives. With a
   * threshold, a press that does not move stays a click and a press that moves
   * captures the pointer and pans, and the two never fight. Zero (the default)
   * pans from the first pixel, which is what a surface with no click action
   * wants.
   */
  dragThreshold?: number
}

/**
 * Scroll-to-zoom + drag-to-pan for a single transformed element, shared by
 * every fullscreen zoomable surface (Mermaid diagrams, image attachments).
 *
 * Zoom anchors on the cursor by measuring the target's live (already
 * transformed) rect rather than assuming its untransformed layout offset —
 * flex-centering can put that offset anywhere, and guessing it makes the
 * anchor point drift on repeated zoom steps.
 */
export class PanZoom {
  zoom = $state(1)
  panX = $state(0)
  panY = $state(0)
  isPanning = $state(false)

  readonly min: number
  readonly max: number
  private readonly step: number
  /**
   * Zoom factor applied per wheel notch. Half a toolbar click, because a wheel
   * or pinch gesture delivers its travel continuously and a full click-sized
   * jump per notch reads as hypersensitive.
   */
  private readonly wheelStep: number
  private readonly dragThreshold: number
  private target?: HTMLElement
  private panStart = { x: 0, y: 0, panX: 0, panY: 0 }
  /** Where a press started, while it is still young enough to be a click. */
  private pressOrigin: { x: number; y: number } | null = null

  constructor(options: PanZoomOptions = {}) {
    this.min = options.min ?? 0.5
    this.max = options.max ?? 6
    this.step = options.step ?? 1.15
    this.wheelStep = Math.sqrt(this.step)
    this.dragThreshold = Math.max(0, options.dragThreshold ?? 0)
  }

  /** Attach to the transformed element as `{@attach panZoom.bindTarget}`. */
  bindTarget = (el: HTMLElement): (() => void) => {
    this.target = el
    return () => {
      if (this.target === el) this.target = undefined
    }
  }

  get transform(): string {
    return `transform: translate(${this.panX}px, ${this.panY}px) scale(${this.zoom}); transform-origin: 0 0;`
  }

  reset(): void {
    this.zoom = 1
    this.panX = 0
    this.panY = 0
  }

  private clamp(value: number): number {
    return Math.min(this.max, Math.max(this.min, value))
  }

  private zoomAt(clientX: number, clientY: number, nextZoom: number): void {
    const rect = this.target?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) {
      this.zoom = nextZoom
      return
    }
    const scaleRatio = nextZoom / this.zoom
    const fracX = (clientX - rect.left) / rect.width
    const fracY = (clientY - rect.top) / rect.height
    const newLeft = clientX - fracX * rect.width * scaleRatio
    const newTop = clientY - fracY * rect.height * scaleRatio
    this.panX += newLeft - rect.left
    this.panY += newTop - rect.top
    this.zoom = nextZoom
  }

  /**
   * Scroll/pinch to zoom, proportional to the wheel travel.
   *
   * One notch of zoom per `WHEEL_NOTCH_PIXELS` of travel keeps a mouse wheel
   * deliberate while letting a trackpad stream zoom smoothly instead of
   * multiplying itself by a whole step on every 2px event.
   */
  onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const pixels = wheelPixels(event)
    if (pixels === 0) return
    const notchPixels = event.ctrlKey ? PINCH_NOTCH_PIXELS : WHEEL_NOTCH_PIXELS
    const notches = Math.max(-MAX_WHEEL_STEPS, Math.min(MAX_WHEEL_STEPS, -pixels / notchPixels))
    this.zoomAt(event.clientX, event.clientY, this.clamp(this.zoom * this.wheelStep ** notches))
  }

  /** Zooms toward the center of `viewport` — for toolbar zoom in/out buttons. */
  zoomByButton(factor: number, viewport?: HTMLElement): void {
    const rect = viewport?.getBoundingClientRect()
    const center = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: 0, y: 0 }
    this.zoomAt(center.x, center.y, this.clamp(this.zoom * factor))
  }

  /** Apply one consistent, modest toolbar step in either direction. */
  zoomByButtonStep(direction: 'in' | 'out', viewport?: HTMLElement): void {
    const factor = direction === 'in' ? this.step : 1 / this.step
    this.zoomByButton(factor, viewport)
  }

  onPointerDown = (event: PointerEvent): void => {
    if (this.zoom === 1) return
    if (this.dragThreshold > 0) {
      this.pressOrigin = { x: event.clientX, y: event.clientY }
      return
    }
    this.beginPan(event)
  }

  onPointerMove = (event: PointerEvent): void => {
    if (this.isPanning) {
      this.panX = this.panStart.panX + (event.clientX - this.panStart.x)
      this.panY = this.panStart.panY + (event.clientY - this.panStart.y)
      return
    }
    const origin = this.pressOrigin
    if (!origin) return
    // Below the threshold the press is still a click, and is left alone: the
    // surface under it decides what a click on it means.
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < this.dragThreshold) {
      return
    }
    this.pressOrigin = null
    this.beginPan(event)
  }

  onPointerUp = (): void => {
    this.isPanning = false
    this.pressOrigin = null
  }

  private beginPan(event: PointerEvent): void {
    this.isPanning = true
    this.panStart = { x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
}
