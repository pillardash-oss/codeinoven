<script lang="ts">
  import {
    tooltipState,
    attachTitleTooltipDelegation,
    TOOLTIP_ID,
    type TooltipSide
  } from './tooltip-manager.svelte'

  let container = $state<HTMLDivElement | null>(null)
  let tooltipEl = $state<HTMLDivElement | null>(null)
  let side = $state<TooltipSide>('top')

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
  }

  $effect(() => {
    return attachTitleTooltipDelegation()
  })

  $effect(() => {
    const request = tooltipState.request
    const el = tooltipEl
    if (!request || !el || !container) return
    const rect = el.getBoundingClientRect()
    const width = rect.width
    const height = rect.height
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const padding = 8
    const offset = request.sideOffset

    let resolved = request.side
    if (resolved === 'top' && request.anchorY - offset - height < padding) {
      resolved = 'bottom'
    } else if (
      resolved === 'bottom' &&
      request.anchorY + offset + height > viewportHeight - padding
    ) {
      resolved = 'top'
    } else if (resolved === 'left' && request.anchorX - offset - width < padding) {
      resolved = 'right'
    } else if (resolved === 'right' && request.anchorX + offset + width > viewportWidth - padding) {
      resolved = 'left'
    }

    let x = request.anchorX
    let y = request.anchorY
    if (resolved === 'top' || resolved === 'bottom') {
      x -= width / 2
      y = resolved === 'top' ? request.anchorY - offset - height : request.anchorY + offset
    } else {
      y -= height / 2
      x = resolved === 'left' ? request.anchorX - offset - width : request.anchorX + offset
    }

    container.style.transform = `translate3d(${Math.round(
      clamp(x, padding, Math.max(padding, viewportWidth - width - padding))
    )}px, ${Math.round(
      clamp(y, padding, Math.max(padding, viewportHeight - height - padding))
    )}px, 0)`
    side = resolved
  })
</script>

<div
  bind:this={container}
  data-tooltip-host
  class="fixed left-0 top-0"
  style="z-index: 9999; pointer-events: none; will-change: transform"
>
  {#if tooltipState.request}
    <div
      bind:this={tooltipEl}
      id={TOOLTIP_ID}
      role="tooltip"
      class="max-w-sm whitespace-normal break-words rounded-lg bg-surface px-2.5 py-1.5 text-xs text-foreground shadow-xl transition-opacity duration-150"
      class:opacity-100={tooltipState.visible}
      class:opacity-0={!tooltipState.visible}
    >
      {tooltipState.request.content}
      <span
        class="tooltip-arrow"
        class:tooltip-arrow-top={side === 'top'}
        class:tooltip-arrow-bottom={side === 'bottom'}
        class:tooltip-arrow-left={side === 'left'}
        class:tooltip-arrow-right={side === 'right'}
        aria-hidden="true"
      ></span>
    </div>
  {/if}
</div>

<style>
  .tooltip-arrow {
    position: absolute;
    width: 8px;
    height: 8px;
    background: var(--color-surface);
    border-radius: 1px;
    transform: rotate(45deg);
  }

  .tooltip-arrow-top {
    bottom: -4px;
    left: 50%;
    margin-left: -4px;
  }

  .tooltip-arrow-bottom {
    top: -4px;
    left: 50%;
    margin-left: -4px;
  }

  .tooltip-arrow-left {
    right: -4px;
    top: 50%;
    margin-top: -4px;
  }

  .tooltip-arrow-right {
    left: -4px;
    top: 50%;
    margin-top: -4px;
  }
</style>
