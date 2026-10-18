<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Remove
  Remove: one solid bar. It is the add mark with its vertical taken away, so
  the two cannot be confused.
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
    transform="translate(-5.806 -5.806) scale(1.4839)"
    stroke-width={cioStrokeWidth(weight, 1.4839)}
  >
    <rect
      x="4.6"
      y="10.9"
      width="14.8"
      height="2.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
