<script lang="ts">
  import type { Snippet } from 'svelte'
  import {
    tooltipState,
    TOOLTIP_GAP_PX,
    TOOLTIP_ID,
    type TooltipSide
  } from './tooltip-manager.svelte'

  interface Props {
    /** Text rendered by the custom tooltip on hover (or focus). */
    title: string
    side?: TooltipSide
    sideOffset?: number
    disabled?: boolean
    class?: string
    children: Snippet
  }

  let {
    title,
    side = 'top',
    sideOffset = TOOLTIP_GAP_PX,
    disabled = false,
    class: className = '',
    children
  }: Props = $props()

  let wrapper = $state<HTMLSpanElement | null>(null)

  function showAt(event: PointerEvent): void {
    if (disabled || title.trim() === '') return
    tooltipState.begin(title, event.clientX, event.clientY, side, sideOffset)
    if (wrapper) wrapper.setAttribute('aria-describedby', TOOLTIP_ID)
  }

  function showFromFocus(): void {
    if (disabled || title.trim() === '') return
    if (!wrapper) return
    const rect = wrapper.getBoundingClientRect()
    tooltipState.begin(
      title,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      side,
      sideOffset
    )
    wrapper.setAttribute('aria-describedby', TOOLTIP_ID)
  }

  function hide(): void {
    tooltipState.end()
    if (wrapper && wrapper.getAttribute('aria-describedby') === TOOLTIP_ID) {
      wrapper.removeAttribute('aria-describedby')
    }
  }

  function hideOnBlur(event: FocusEvent): void {
    const related = event.relatedTarget as Node | null
    if (related && wrapper?.contains(related)) return
    hide()
  }

  function move(event: PointerEvent): void {
    tooltipState.update(event.clientX, event.clientY)
  }
</script>

<span
  bind:this={wrapper}
  data-tooltip
  role="group"
  class="inline-flex {className}"
  onpointerenter={showAt}
  onpointermove={move}
  onpointerleave={hide}
  onfocusin={showFromFocus}
  onfocusout={hideOnBlur}
>
  {@render children()}
</span>
