<script lang="ts">
  import { onMount } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import {
    tooltipState,
    attachTitleTooltipDelegation,
    TOOLTIP_ID,
    type TooltipSide
  } from './tooltip-manager.svelte'
  import ShortcutHint from './ShortcutHint.svelte'
  import { NativeDockController } from '$lib/native-dock-controller.svelte'

  let { nativeOverlay = true }: { nativeOverlay?: boolean } = $props()

  let side = $state<TooltipSide>('top')

  function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
  }

  let host: HTMLDivElement | null = null
  const nativeTooltip = new NativeDockController(
    'app-tooltip',
    () => {},
    (width, height) => {
      const rect = host?.getBoundingClientRect()
      return { x: rect?.x ?? 0, y: rect?.y ?? 0, width, height }
    },
    true
  )
  const mountNativeTooltip: Attachment<HTMLDivElement> = (element) => {
    host = element
    const unmount = nativeTooltip.mount(element)
    return () => {
      host = null
      unmount()
    }
  }

  onMount(attachTitleTooltipDelegation)

  const positionTooltip: Attachment<HTMLDivElement> = (container) => {
    const request = tooltipState.request
    const el = container.querySelector<HTMLElement>('[role="tooltip"]')
    if (!request || !el) {
      if (nativeOverlay) nativeTooltip.update(false, { x: 0, y: 0, width: 1, height: 1 })
      return
    }
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

    x = clamp(x, padding, Math.max(padding, viewportWidth - width - padding))
    y = clamp(y, padding, Math.max(padding, viewportHeight - height - padding))

    container.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`
    side = resolved
    if (nativeOverlay) nativeTooltip.update(tooltipState.visible, { x, y, width, height })
  }
</script>

<div
  {@attach nativeOverlay && mountNativeTooltip}
  {@attach positionTooltip}
  data-tooltip-host
  class="fixed left-0 top-0"
  style="z-index: 9999; pointer-events: none; will-change: transform"
  style:opacity={nativeTooltip.ready ? 0 : 1}
>
  {#if tooltipState.request}
    <div
      id={TOOLTIP_ID}
      role="tooltip"
      class="relative max-w-sm whitespace-normal break-words rounded-lg bg-surface px-2.5 py-1.5 text-xs text-foreground shadow-xl transition-opacity duration-150"
      class:opacity-100={tooltipState.visible}
      class:opacity-0={!tooltipState.visible}
    >
      {tooltipState.request.content}
      {#if tooltipState.request.keys.length > 0}
        <span class="ml-1.5 inline-flex translate-y-px align-middle">
          <ShortcutHint keys={tooltipState.request.keys} />
        </span>
      {/if}
      <span
        class={[
          'absolute h-2 w-2 rotate-45 rounded-[0.0625rem] bg-surface',
          side === 'top' && '-bottom-1 left-1/2 -ml-1',
          side === 'bottom' && '-top-1 left-1/2 -ml-1',
          side === 'left' && '-right-1 top-1/2 -mt-1',
          side === 'right' && '-left-1 top-1/2 -mt-1'
        ]}
        aria-hidden="true"
      ></span>
    </div>
  {/if}
</div>
