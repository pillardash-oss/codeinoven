<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Locked
  Locked: a body with a solid keyhole under a closed shackle.
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
    transform="translate(-3.146 -3.146) scale(1.2622)"
    stroke-width={cioStrokeWidth(weight, 1.2622)}
  >
    <rect x="4.6" y="10.4" width="14.8" height="9.6" rx="2" /><rect
      x="10.9"
      y="13.4"
      width="2.2"
      height="3.4"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><path d="M8.4 10.4V7.6a3.6 3.6 0 0 1 7.2 0v2.8" />
  </g>
</svg>
