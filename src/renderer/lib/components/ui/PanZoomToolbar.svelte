<script lang="ts">
  import { RotateCcw, ZoomIn, ZoomOut } from '@lucide/svelte'
  import type { PanZoom } from '$lib/pan-zoom.svelte'

  interface Props {
    panZoom: PanZoom
    /** Viewport element used to center toolbar zoom steps; omit to zoom from the top-left. */
    viewport?: HTMLElement
    class?: string
  }

  let { panZoom, viewport, class: className }: Props = $props()
</script>

<div
  class={[
    'flex items-center gap-0.5 rounded-lg border bg-elevated/95 p-1 shadow-lg backdrop-blur-sm',
    className
  ]}
>
  <button
    type="button"
    class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    aria-label="Zoom out"
    title="Zoom out"
    disabled={panZoom.zoom <= panZoom.min}
    onclick={() => panZoom.zoomByButton(1 / 1.4, viewport)}
  >
    <ZoomOut size={14} />
  </button>
  <span class="w-10 text-center font-mono text-[0.625rem] text-dimmed">
    {Math.round(panZoom.zoom * 100)}%
  </span>
  <button
    type="button"
    class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    aria-label="Zoom in"
    title="Zoom in"
    disabled={panZoom.zoom >= panZoom.max}
    onclick={() => panZoom.zoomByButton(1.4, viewport)}
  >
    <ZoomIn size={14} />
  </button>
  <div class="mx-0.5 h-4 w-px bg-border/60" aria-hidden="true"></div>
  <button
    type="button"
    class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    aria-label="Reset zoom and pan"
    title="Reset zoom and pan"
    disabled={panZoom.zoom === 1 && panZoom.panX === 0 && panZoom.panY === 0}
    onclick={() => panZoom.reset()}
  >
    <RotateCcw size={14} />
  </button>
</div>
