<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Archive
  Archive: a lid with a solid tab over a box, which is a stored thing rather
  than a plain crate.
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
    transform="translate(-2.487 -2.840) scale(1.2072)"
    stroke-width={cioStrokeWidth(weight, 1.2072)}
  >
    <rect x="3.6" y="4.6" width="16.8" height="5" rx="1.6" /><rect
      x="5.8"
      y="6.4"
      width="3.8"
      height="1.4"
      rx="0.7"
      fill="currentColor"
      stroke="none"
    /><path d="M5.4 9.6v8.8a1.6 1.6 0 0 0 1.6 1.6h10a1.6 1.6 0 0 0 1.6-1.6V9.6" /><path
      d="M10 13.4h4"
    />
  </g>
</svg>
