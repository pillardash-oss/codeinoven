<script lang="ts">
  import CioUndo from '@codeio/icon/CioUndo.svelte'
  import CioZoomIn from '@codeio/icon/CioZoomIn.svelte'
  import CioZoomOut from '@codeio/icon/CioZoomOut.svelte'
  import type { PanZoom } from '$lib/pan-zoom.svelte'

  interface Props {
    panZoom: PanZoom
    /** Viewport element used to center toolbar zoom steps; omit to zoom from the top-left. */
    viewport?: HTMLElement
    class?: string
  }

  let { panZoom, viewport, class: className }: Props = $props()

  /** A control here never lets its own click reach the surface behind the
   *  toolbar: the fullscreen previews dismiss on a click of their backdrop, so a
   *  zoom step used to close the very preview it was zooming. `PreviewPager`
   *  wraps its own step the same way, so both floating control groups behave
   *  alike. */
  function press(event: MouseEvent, act: () => void): void {
    event.stopPropagation()
    act()
  }
</script>

<div
  class={[
    'flex items-center gap-0.5 border bg-elevated/95 p-1 shadow-lg backdrop-blur-sm',
    className
  ]}
  role="group"
  aria-label="Zoom controls"
  onpointerdown={(event) => event.stopPropagation()}
  onpointerup={(event) => event.stopPropagation()}
  onpointercancel={(event) => event.stopPropagation()}
  ondblclick={(event) => event.stopPropagation()}
>
  <button
    type="button"
    class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    aria-label="Zoom out"
    title="Zoom out"
    disabled={panZoom.zoom <= panZoom.min}
    onclick={(event) => press(event, () => panZoom.zoomByButtonStep('out', viewport))}
  >
    <CioZoomOut size={14} />
  </button>
  <span class="w-10 text-center font-mono text-[0.625rem] text-dimmed">
    {Math.round(panZoom.zoom * 100)}%
  </span>
  <button
    type="button"
    class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    aria-label="Zoom in"
    title="Zoom in"
    disabled={panZoom.zoom >= panZoom.max}
    onclick={(event) => press(event, () => panZoom.zoomByButtonStep('in', viewport))}
  >
    <CioZoomIn size={14} />
  </button>
  <div class="mx-0.5 h-4 w-px bg-border/60" aria-hidden="true"></div>
  <button
    type="button"
    class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    aria-label="Reset zoom and pan"
    title="Reset zoom and pan"
    disabled={panZoom.zoom === 1 && panZoom.panX === 0 && panZoom.panY === 0}
    onclick={(event) => press(event, () => panZoom.reset())}
  >
    <CioUndo size={14} />
  </button>
</div>
