export interface PanZoomOptions {
  min?: number
  max?: number
  /** Multiplier applied per wheel tick / toolbar click. */
  step?: number
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
  private target?: HTMLElement
  private panStart = { x: 0, y: 0, panX: 0, panY: 0 }

  constructor(options: PanZoomOptions = {}) {
    this.min = options.min ?? 0.5
    this.max = options.max ?? 6
    this.step = options.step ?? 1.15
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

  onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const factor = event.deltaY < 0 ? this.step : 1 / this.step
    this.zoomAt(event.clientX, event.clientY, this.clamp(this.zoom * factor))
  }

  /** Zooms toward the center of `viewport` — for toolbar zoom in/out buttons. */
  zoomByButton(factor: number, viewport?: HTMLElement): void {
    const rect = viewport?.getBoundingClientRect()
    const center = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: 0, y: 0 }
    this.zoomAt(center.x, center.y, this.clamp(this.zoom * factor))
  }

  onPointerDown = (event: PointerEvent): void => {
    if (this.zoom === 1) return
    this.isPanning = true
    this.panStart = { x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  onPointerMove = (event: PointerEvent): void => {
    if (!this.isPanning) return
    this.panX = this.panStart.panX + (event.clientX - this.panStart.x)
    this.panY = this.panStart.panY + (event.clientY - this.panStart.y)
  }

  onPointerUp = (): void => {
    this.isPanning = false
  }
}
