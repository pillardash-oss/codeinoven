<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Match case
  Match case: the two letters the control is about, drawn in strokes so they
  read at 16px where real glyphs turn to mush.
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
    transform="translate(-1.783 -1.783) scale(1.1520)"
    stroke-width={cioStrokeWidth(weight, 1.152)}
  >
    <path d="M3.6 17.6 7.6 7.6l4 10" /><path d="M5.2 13.8h4.8" /><circle
      cx="17.4"
      cy="14.4"
      r="3.2"
    /><path d="M20.6 11.2v6.4" />
  </g>
</svg>
