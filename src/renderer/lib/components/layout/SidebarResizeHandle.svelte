<script lang="ts">
  interface Props {
    /** The sidebar edge the handle sits on: the edge a drag moves. */
    side: 'left' | 'right'
    /** The sidebar's width where the drag starts. */
    width: number
    /**
     * Receives the raw width for every pointer move. Clamping stays with the
     * owner, because the bounds belong to whatever width the sidebar shares.
     */
    onResize: (width: number) => void
    /** Called once when the drag ends, which is where the owner persists. */
    onResizeEnd?: () => void
    /** Reports the drag so the owner can suppress selection while dragging. */
    resizing?: boolean
    /** Accessible name for the separator. */
    label: string
  }

  let {
    side,
    width,
    onResize,
    onResizeEnd = undefined,
    resizing = $bindable(false),
    label
  }: Props = $props()

  function startResize(event: PointerEvent): void {
    event.preventDefault()
    resizing = true
    const startX = event.clientX
    const startWidth = width
    // A drag away from the sidebar widens it on either side: right-edge handles
    // (a left sidebar) grow with +x, left-edge handles (a right rail) with -x.
    const direction = side === 'right' ? 1 : -1
    const onMove = (moveEvent: PointerEvent): void => {
      onResize(startWidth + direction * (moveEvent.clientX - startX))
    }
    const onUp = (): void => {
      resizing = false
      onResizeEnd?.()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
</script>

<!-- The drag target is the sidebar's own edge, painted above its content so a
     scrollbar at the same edge still leaves a few pixels to grab. -->
<div
  class="absolute inset-y-0 w-1 cursor-col-resize transition-colors hover:bg-primary/20 {side ===
  'right'
    ? 'right-0'
    : 'left-0'} {resizing ? 'bg-primary/30' : ''}"
  role="separator"
  aria-label={label}
  aria-orientation="vertical"
  onpointerdown={startResize}
></div>
