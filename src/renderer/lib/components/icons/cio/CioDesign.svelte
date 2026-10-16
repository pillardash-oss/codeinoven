<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Design
  Design: a ruler on the diagonal with three solid ticks, which is measuring
  and drafting rather than editing text.
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
    transform="translate(-3.947 -3.947) scale(1.3368)"
    stroke-width={cioStrokeWidth(weight, 1.3368)}
  >
    <g transform="rotate(-45 12 12)"
      ><rect x="3.4" y="9.2" width="17.2" height="5.4" rx="1.2" /><rect
        x="6.2"
        y="11"
        width="1.7"
        height="2.2"
        rx="0.5"
        fill="currentColor"
        stroke="none"
      /><rect
        x="9.9"
        y="11"
        width="1.7"
        height="2.2"
        rx="0.5"
        fill="currentColor"
        stroke="none"
      /><rect
        x="13.6"
        y="11"
        width="1.7"
        height="2.2"
        rx="0.5"
        fill="currentColor"
        stroke="none"
      /></g
    >
  </g>
</svg>
