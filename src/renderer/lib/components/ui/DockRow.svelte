<script lang="ts">
  import type { Snippet } from 'svelte'
  import { NativeDockController } from '$lib/native-dock-controller.svelte'
  import { TOAST_OVERLAY_TOP } from '$shared/browser-overlay'
  import type { NativeDockInteraction } from '$shared/native-dock'
  import type { Attachment } from 'svelte/attachments'
  import PopoverDragHandle from './PopoverDragHandle.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import {
    clampDockPosition,
    dockBox,
    dockPlacementForDrop,
    dockPlacementOnEdge,
    loadDockPlacement,
    saveDockPlacement,
    type DockEdge,
    type DockPlacement
  } from '$lib/dock-placement'

  interface Props {
    /**
     * Owner key the placement is remembered under: the row reopens on the edge
     * the user left it on, across app restarts.
     */
    storageKey: string
    /** Action description for the drag head, e.g. "Move docked harness tasks". */
    label: string
    /** The docked chips. Each dock surface renders its own row content. */
    children: Snippet
  }

  let { storageKey, label, children }: Props = $props()

  // A dock row's owner key is fixed for the life of the row, so the saved
  // placement is read once here and the row owns it from then on.
  // svelte-ignore state_referenced_locally
  let placement = $state<DockPlacement>(loadDockPlacement(storageKey))
  let viewport = $state({ width: window.innerWidth, height: window.innerHeight })
  let size = $state({ width: 0, height: 0 })
  let dragging = $state(false)
  /** Live pointer position while dragging; null when the row sits on its edge. */
  let draggedTo = $state<{ x: number; y: number } | null>(null)
  let dragStart = $state({ x: 0, y: 0 })
  let dragOrigin = $state({ x: 0, y: 0 })

  /**
   * The row's rectangle: the saved edge placement, or the pointer while the user
   * is dragging it. Reading the box is what keeps the occlusion publication and
   * the CSS position in agreement.
   */
  const placementBox = $derived(
    draggedTo === null
      ? dockBox(placement, size, viewport)
      : { x: draggedTo.x, y: draggedTo.y, width: size.width, height: size.height }
  )

  const native = new NativeDockController(
    `dock-${crypto.randomUUID()}`,
    onNativeInteraction,
    (width, height) => {
      if (size.width !== width || size.height !== height) size = { width, height }
      return {
        ...placementBox,
        y: Math.max(TOAST_OVERLAY_TOP, placementBox.y),
        width,
        height
      }
    }
  )
  const nativeEnabled = $derived(browserVisibility.canUseNativeDock && !native.failed)
  const box = $derived(
    nativeEnabled
      ? { ...placementBox, y: Math.max(TOAST_OVERLAY_TOP, placementBox.y) }
      : placementBox
  )

  function onNativeInteraction(report: NativeDockInteraction): void {
    if (report.kind === 'edge') {
      const edge = edgeForKey(report.key)
      if (edge) place(dockPlacementOnEdge(edge, box, viewport))
    } else if (report.kind === 'drag') {
      if (!dragging) {
        dragging = true
        dragOrigin = { x: box.x, y: box.y }
      }
      draggedTo = clampDockPosition(
        dragOrigin.x + report.dx,
        dragOrigin.y + report.dy,
        size,
        viewport
      )
      if (report.done) {
        dragging = false
        place(dockPlacementForDrop({ ...draggedTo, ...size }, viewport))
      }
    }
  }

  /** The row can only be placed once it has been measured. */
  const measured = $derived(size.width >= 1 && size.height >= 1)

  const occlusionKey = `docked-row-${crypto.randomUUID()}`

  const measure: Attachment<HTMLElement> = (element) => {
    const update = (): void => {
      const rect = element.getBoundingClientRect()
      size = { width: rect.width, height: rect.height }
    }
    const releaseNative = native.mount(element)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
      releaseNative()
    }
  }

  $effect(() => {
    native.update(measured && nativeEnabled, box)
  })

  $effect(() => {
    if (!measured || nativeEnabled) return
    browserVisibility.publishOcclusion(occlusionKey, box)
    return () => browserVisibility.clearOcclusion(occlusionKey)
  })

  /** Snap to `next`, remember it, and drop the live drag offset. */
  function place(next: DockPlacement): void {
    draggedTo = null
    placement = next
    saveDockPlacement(storageKey, next)
  }

  /** A window that shrinks under a dock must not leave it half off screen. */
  function onViewportResize(): void {
    viewport = { width: window.innerWidth, height: window.innerHeight }
    if (draggedTo !== null) {
      draggedTo = clampDockPosition(draggedTo.x, draggedTo.y, size, viewport)
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    dragging = true
    dragStart = { x: event.clientX, y: event.clientY }
    dragOrigin = { x: box.x, y: box.y }
    const target = event.currentTarget
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    draggedTo = clampDockPosition(
      dragOrigin.x + (event.clientX - dragStart.x),
      dragOrigin.y + (event.clientY - dragStart.y),
      size,
      viewport
    )
  }

  function onPointerUp(event: PointerEvent): void {
    if (!dragging) return
    dragging = false
    const target = event.currentTarget
    if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId)
    }
    // A press without movement must not rewrite the remembered placement.
    const dropped = draggedTo
    if (dropped === null) return
    place(dockPlacementForDrop({ ...dropped, ...size }, viewport))
  }

  /** Arrow keys are the pointer-free way to put the dock on a chosen edge. */
  function edgeForKey(key: string): DockEdge | null {
    if (key === 'ArrowUp') return 'top'
    if (key === 'ArrowDown') return 'bottom'
    if (key === 'ArrowLeft') return 'left'
    if (key === 'ArrowRight') return 'right'
    return null
  }

  function onHandleKeyDown(event: KeyboardEvent): void {
    const edge = edgeForKey(event.key)
    if (edge === null) return
    event.preventDefault()
    place(dockPlacementOnEdge(edge, box, viewport))
  }
</script>

<svelte:window onresize={onViewportResize} />

<!-- `visibility` rather than `display`: the row has to be measurable before it
     knows where it goes, and hiding it from layout would keep it unmeasured. -->
<div
  class="fixed z-50 flex w-max max-w-[calc(100vw-2rem)] items-stretch gap-1.5 {dragging
    ? ''
    : 'transition-[left,top] duration-150 ease-out motion-reduce:transition-none'}"
  style="left: {box.x}px; top: {box.y}px; visibility: {measured
    ? 'visible'
    : 'hidden'}; opacity: {native.ready ? 0 : 1}; pointer-events: {native.ready ? 'none' : 'auto'};"
  {@attach measure}
>
  <!--
    The head is the leading element, an extension to the left of the docked row.
    It stays grabbable while the chips are covered by another dock or the browser
    overlaps them, which is how a buried dock is pulled back out.
  -->
  <div
    class="flex shrink-0 cursor-grab touch-none items-center rounded-lg border bg-surface px-0.5 text-dimmed shadow-xl transition-colors select-none hover:bg-elevated hover:text-foreground {dragging
      ? 'cursor-grabbing'
      : ''}"
    data-native-dock-handle
    role="presentation"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onkeydown={onHandleKeyDown}
  >
    <PopoverDragHandle title={label} />
  </div>

  <div class="min-w-0">{@render children()}</div>
</div>
