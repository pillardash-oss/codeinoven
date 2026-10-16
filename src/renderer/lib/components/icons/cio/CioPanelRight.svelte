<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Dock right
  Dock right: a frame with its right column solid, which is the dock drawn as
  a state rather than as an action.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g
    transform="translate(-2.189 -2.189) scale(1.1824)"
    stroke-width={cioStrokeWidth(weight, 1.1824)}
  >
    <rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2" /><rect
      x="14.6"
      y="4.8"
      width="6"
      height="14.4"
      rx="2"
      fill="currentColor"
      stroke="none"
    /><path d="M14.6 4.8v14.4" />
  </g>
</svg>
