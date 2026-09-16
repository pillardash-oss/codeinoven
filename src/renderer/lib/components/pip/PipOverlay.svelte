<script lang="ts">
  import { MousePointer2, X, PictureInPicture2 } from '@lucide/svelte'
  import { pipState } from '$lib/stores/pip.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'

  /** The preview's natural footprint, and the size the overlay is parked at. */
  const BASE_PREVIEW_WIDTH = 224
  const BASE_PREVIEW_HEIGHT = 144
  /** The overlay may be shrunk back to its default footprint and grown to twice
   *  it. The cap is deliberate: the preview floats above the workspace, so an
   *  unbounded frame would bury the surface the user is reading. */
  const MIN_SCALE = 1
  const MAX_SCALE = 2
  /** Keyboard nudges for the resize affordances. */
  const KEYBOARD_SCALE_STEP = 0.1
  /** Distance the overlay keeps from the viewport edges when it first appears. */
  const VIEWPORT_MARGIN = 24

  type ResizeEdge = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

  interface ResizeHandle {
    edge: ResizeEdge
    /** Human name used in the handle's tooltip and accessible label. */
    label: string
    /** Hit area straddling the overlay's edge, plus the matching cursor. */
    classes: string
  }

  /** Every edge and corner is a resize affordance. The preview keeps its aspect
   *  ratio from any of them, so the handles only differ in which edges they pin. */
  const RESIZE_HANDLES: ResizeHandle[] = [
    { edge: 'n', label: 'top edge', classes: 'inset-x-3 -top-1 h-2 cursor-ns-resize' },
    { edge: 's', label: 'bottom edge', classes: 'inset-x-3 -bottom-1 h-2 cursor-ns-resize' },
    { edge: 'w', label: 'left edge', classes: 'inset-y-3 -left-1 w-2 cursor-ew-resize' },
    { edge: 'e', label: 'right edge', classes: 'inset-y-3 -right-1 w-2 cursor-ew-resize' },
    { edge: 'nw', label: 'top-left corner', classes: '-top-1 -left-1 h-3 w-3 cursor-nwse-resize' },
    {
      edge: 'ne',
      label: 'top-right corner',
      classes: '-top-1 -right-1 h-3 w-3 cursor-nesw-resize'
    },
    {
      edge: 'sw',
      label: 'bottom-left corner',
      classes: '-bottom-1 -left-1 h-3 w-3 cursor-nesw-resize'
    },
    {
      edge: 'se',
      label: 'bottom-right corner',
      classes: '-bottom-1 -right-1 h-3 w-3 cursor-nwse-resize'
    }
  ]

  const occlusionKey = `pip-overlay-${crypto.randomUUID()}`
  let position = $state({ x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN })
  let dragging = $state(false)
  let dragStart = $state({ x: 0, y: 0 })
  let dragOrigin = $state({ x: 0, y: 0 })
  /** The overlay's measured footprint, chrome (header, padding, border) included. */
  let overlaySize = $state({ width: 0, height: 0 })
  let overlayElement = $state<HTMLDivElement | undefined>()
  let userMoved = $state(false)
  /** Scale that pins every dimension: preview, cursor projection and the
   *  occlusion rectangle all follow it, so the aspect ratio is never negotiable. */
  let scale = $state(MIN_SCALE)
  let resizingEdge = $state<ResizeEdge | null>(null)
  let resizeOrigin = $state<ResizeOrigin | null>(null)

  interface ResizeOrigin {
    edge: ResizeEdge
    /** Pointer position and overlay geometry when the gesture began. */
    pointer: { x: number; y: number }
    position: { x: number; y: number }
    width: number
    height: number
    previewWidth: number
    previewHeight: number
  }

  const isThreadView = $derived(
    rendererRecovery.activeView === 'projects' ||
      rendererRecovery.activeView === 'chats' ||
      rendererRecovery.activeView === 'threads'
  )

  const visible = $derived(
    pipState.active &&
      pipState.frameDataUrl !== null &&
      isThreadView &&
      pipState.threadId !== null &&
      pipState.threadId === workspaceState.selectedThread?.id
  )

  const previewWidth = $derived(Math.round(BASE_PREVIEW_WIDTH * scale))
  const previewHeight = $derived(Math.round(BASE_PREVIEW_HEIGHT * scale))
  const cursorSize = $derived(Math.max(12, Math.round(18 * scale)))

  const cursorPosition = $derived.by(() => {
    if (!pipState.cursorVisible || pipState.frameWidth <= 0 || pipState.frameHeight <= 0) {
      return null
    }
    const projection = Math.min(
      previewWidth / pipState.frameWidth,
      previewHeight / pipState.frameHeight
    )
    const renderedWidth = pipState.frameWidth * projection
    const renderedHeight = pipState.frameHeight * projection
    return {
      left: (previewWidth - renderedWidth) / 2 + pipState.cursorX * projection,
      top: (previewHeight - renderedHeight) / 2 + pipState.cursorY * projection
    }
  })

  /** The overlay's footprint at `scaleValue`, measured chrome included. Chrome
   *  does not scale, so it is the difference between the measured box and the
   *  preview it currently contains. */
  function footprint(scaleValue: number): { width: number; height: number } {
    const chromeWidth = Math.max(0, overlaySize.width - previewWidth)
    const chromeHeight = Math.max(0, overlaySize.height - previewHeight)
    return {
      width: Math.round(BASE_PREVIEW_WIDTH * scaleValue) + chromeWidth,
      height: Math.round(BASE_PREVIEW_HEIGHT * scaleValue) + chromeHeight
    }
  }

  /** Largest scale whose whole overlay still fits on screen. The 2x cap is the
   *  user's limit; this is the viewport's. */
  function maxScaleForViewport(): number {
    const chromeWidth = Math.max(0, overlaySize.width - previewWidth)
    const chromeHeight = Math.max(0, overlaySize.height - previewHeight)
    const fitsWidth = (window.innerWidth - VIEWPORT_MARGIN * 2 - chromeWidth) / BASE_PREVIEW_WIDTH
    const fitsHeight =
      (window.innerHeight - VIEWPORT_MARGIN * 2 - chromeHeight) / BASE_PREVIEW_HEIGHT
    return Math.min(MAX_SCALE, Math.min(fitsWidth, fitsHeight))
  }

  function clampScale(value: number): number {
    return Math.max(MIN_SCALE, Math.min(value, Math.max(MIN_SCALE, maxScaleForViewport())))
  }

  function clampPosition(
    x: number,
    y: number,
    width: number,
    height: number
  ): { x: number; y: number } {
    return {
      x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - width)),
      y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - height))
    }
  }

  /** Apply a scale while keeping the edges named by `origin.edge` pinned, so a
   *  drag resizes from the handle the user actually grabbed. */
  function applyScale(nextScale: number, origin: ResizeOrigin): void {
    userMoved = true
    const { width, height } = footprint(nextScale)
    let x = origin.position.x
    let y = origin.position.y
    if (origin.edge.includes('w')) x = origin.position.x + origin.width - width
    if (origin.edge.includes('n')) y = origin.position.y + origin.height - height
    scale = nextScale
    position = clampPosition(x, y, width, height)
  }

  /** Geometry snapshot for a gesture that starts now from `edge`. */
  function currentOrigin(edge: ResizeEdge, pointer: { x: number; y: number }): ResizeOrigin {
    const rect = overlayElement?.getBoundingClientRect()
    return {
      edge,
      pointer,
      position: { ...position },
      width: rect?.width ?? overlaySize.width,
      height: rect?.height ?? overlaySize.height,
      previewWidth,
      previewHeight
    }
  }

  /** Aspect-locked scale from a drag. Both axes are projected and the one the
   *  user moved furthest wins, so a corner drag follows the pointer's dominant
   *  axis instead of fighting it, and the ratio is preserved exactly. */
  function scaleFromDrag(origin: ResizeOrigin, dx: number, dy: number): number {
    const candidates: number[] = []
    if (origin.edge.includes('e')) {
      candidates.push((origin.previewWidth + dx) / BASE_PREVIEW_WIDTH)
    }
    if (origin.edge.includes('w')) {
      candidates.push((origin.previewWidth - dx) / BASE_PREVIEW_WIDTH)
    }
    if (origin.edge.includes('s')) {
      candidates.push((origin.previewHeight + dy) / BASE_PREVIEW_HEIGHT)
    }
    if (origin.edge.includes('n')) {
      candidates.push((origin.previewHeight - dy) / BASE_PREVIEW_HEIGHT)
    }
    const current = origin.previewWidth / BASE_PREVIEW_WIDTH
    return candidates.reduce((best, candidate) =>
      Math.abs(candidate - current) > Math.abs(best - current) ? candidate : best
    )
  }

  /** Park the overlay in the bottom-left corner on first appearance. */
  function anchorOverlay(node: HTMLDivElement): () => void {
    overlayElement = node
    const measure = (): DOMRect => {
      const rect = node.getBoundingClientRect()
      overlaySize = { width: rect.width, height: rect.height }
      return rect
    }
    // Anchor from the rect this measurement returns rather than from the
    // `overlaySize` state it writes: reading that state would make the
    // attachment depend on its own write, and it would re-run forever.
    const rect = measure()
    if (!userMoved) {
      position = {
        x: VIEWPORT_MARGIN,
        y: Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)
      }
    }
    // The overlay is sized by state, so the observer is what keeps the published
    // occlusion rectangle matching what is on screen after a resize.
    const observer = new ResizeObserver(() => measure())
    observer.observe(node)
    return () => {
      observer.disconnect()
      if (overlayElement === node) overlayElement = undefined
    }
  }

  // The preview floats above every DOM surface, but the in-app browser is a
  // native view the compositor paints above the whole renderer, so the browser
  // has to detach its view while this overlay covers it (see
  // `browserVisibility`). Dragging moves the preview without resizing it, so
  // the rectangle is published from position and size state rather than a DOM
  // measurement that no observer would refresh.
  $effect(() => {
    if (!visible) return
    if (overlaySize.width < 1 || overlaySize.height < 1) return
    browserVisibility.publishOcclusion(occlusionKey, {
      x: position.x,
      y: position.y,
      width: overlaySize.width,
      height: overlaySize.height
    })
    return () => browserVisibility.clearOcclusion(occlusionKey)
  })

  /** A window that shrinks under a parked overlay would otherwise leave it half
   *  off screen, or keep it at a scale the viewport can no longer fit. Bound
   *  through `<svelte:window>`, so no effect listens for the event. */
  function onViewportResize(): void {
    if (!visible) return
    const nextScale = clampScale(scale)
    scale = nextScale
    const { width, height } = footprint(nextScale)
    position = clampPosition(position.x, position.y, width, height)
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    dragging = true
    dragStart = { x: event.clientX, y: event.clientY }
    dragOrigin = { ...position }
    const target = event.currentTarget
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    userMoved = true
    const dx = event.clientX - dragStart.x
    const dy = event.clientY - dragStart.y
    position = clampPosition(
      dragOrigin.x + dx,
      dragOrigin.y + dy,
      overlaySize.width,
      overlaySize.height
    )
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragging) return
    dragging = false
    releasePointer(event)
  }

  function onResizePointerDown(event: PointerEvent, edge: ResizeEdge): void {
    if (event.button !== 0) return
    resizeOrigin = currentOrigin(edge, { x: event.clientX, y: event.clientY })
    resizingEdge = edge
    const target = event.currentTarget
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onResizePointerMove(event: PointerEvent): void {
    const origin = resizeOrigin
    if (!resizingEdge || !origin) return
    const nextScale = clampScale(
      scaleFromDrag(origin, event.clientX - origin.pointer.x, event.clientY - origin.pointer.y)
    )
    applyScale(nextScale, origin)
  }

  function onResizePointerUp(event: PointerEvent): void {
    if (!resizingEdge) return
    resizingEdge = null
    resizeOrigin = null
    releasePointer(event)
  }

  /** Arrow keys resize the same way the handles do, growing from the top-left so
   *  the overlay never walks across the screen when it is resized by keyboard. */
  function onResizeKeyDown(event: KeyboardEvent): void {
    const direction =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (direction === 0) return
    event.preventDefault()
    applyScale(
      clampScale(scale + direction * KEYBOARD_SCALE_STEP),
      currentOrigin('se', { x: 0, y: 0 })
    )
  }

  function releasePointer(event: PointerEvent): void {
    const target = event.currentTarget
    if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId)
    }
  }
</script>

<svelte:window onresize={onViewportResize} />

{#if visible}
  <div
    {@attach anchorOverlay}
    class="fixed z-50 touch-none select-none rounded-xl border bg-surface shadow-2xl"
    style="left: {position.x}px; top: {position.y}px;"
    role="group"
    aria-label="Computer-use preview for {pipState.appName}"
  >
    {#each RESIZE_HANDLES as handle (handle.edge)}
      <button
        type="button"
        class="absolute z-10 rounded-sm bg-transparent transition-colors hover:bg-accent/25 focus-visible:bg-accent/25 focus-visible:outline-none {handle.classes}"
        title="Drag to resize the computer-use preview (up to twice its default size). Arrow keys also resize."
        aria-label="Resize computer-use preview from the {handle.label}"
        onpointerdown={(event) => onResizePointerDown(event, handle.edge)}
        onpointermove={onResizePointerMove}
        onpointerup={onResizePointerUp}
        onpointercancel={onResizePointerUp}
        onkeydown={onResizeKeyDown}
      ></button>
    {/each}

    <div
      role="group"
      aria-label="Computer-use preview controls"
      class="flex cursor-grab items-center justify-between gap-2 border-b px-2 py-1.5"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      class:cursor-grabbing={dragging}
      title="Drag to move · click preview to bring the app to the front"
    >
      <span class="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
        <PictureInPicture2 size={13} class="shrink-0 text-accent" />
        <span class="truncate">{pipState.appName}</span>
      </span>
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Close computer-use preview"
        aria-label="Close computer-use preview"
        onclick={() => void pipState.dismiss()}
      >
        <X size={13} />
      </button>
    </div>

    <button
      type="button"
      class="block w-full p-1.5"
      title="Bring {pipState.appName} to the front"
      aria-label="Bring {pipState.appName} to the front"
      onclick={() => void pipState.bringToFront()}
    >
      <div
        class="relative overflow-hidden rounded-md border border-border bg-app"
        style="width: {previewWidth}px; height: {previewHeight}px;"
      >
        <img
          src={pipState.frameDataUrl}
          alt="Live preview of {pipState.appName}"
          class="h-full w-full object-contain"
          draggable="false"
        />
        {#if cursorPosition}
          <MousePointer2
            size={cursorSize}
            strokeWidth={2.5}
            class="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-accent drop-shadow-md"
            style="left: {cursorPosition.left}px; top: {cursorPosition.top}px;"
            aria-hidden="true"
          />
        {/if}
      </div>
    </button>
  </div>
{/if}
