<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Reorder
  Reorder: six solid dots in two columns. Nothing else reads as a handle at
  12px.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="square"
  stroke-linejoin="miter"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g
    transform="translate(-8.924 -8.924) scale(1.7437)"
    stroke-width={cioStrokeWidth(weight, 1.7437)}
  >
    <rect
      x="8.1"
      y="5.7"
      width="2.6"
      height="2.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="13.3"
      y="5.7"
      width="2.6"
      height="2.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="8.1"
      y="10.7"
      width="2.6"
      height="2.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="13.3"
      y="10.7"
      width="2.6"
      height="2.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="8.1"
      y="15.7"
      width="2.6"
      height="2.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="13.3"
      y="15.7"
      width="2.6"
      height="2.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
