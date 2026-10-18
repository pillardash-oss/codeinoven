<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Replace
  Replace: a row being taken out over a row going in, the outgoing one dashed,
  which is one thing swapped for another in place.
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
    transform="translate(-3.512 -3.512) scale(1.2927)"
    stroke-width={cioStrokeWidth(weight, 1.2927)}
  >
    <rect x="4.4" y="4.6" width="15.2" height="6" rx="0" stroke-dasharray="3 2.2" /><rect
      x="4.4"
      y="13.4"
      width="15.2"
      height="6"
      rx="0"
    /><path d="M12 11.2v2" /><path d="M10.4 11.6 12 13.2l1.6-1.6" />
  </g>
</svg>
