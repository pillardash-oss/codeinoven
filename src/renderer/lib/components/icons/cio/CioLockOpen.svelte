<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Unlocked
  Unlocked: the same body and keyhole with the shackle swung open, so the two
  read as one lock in two states.
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
    transform="translate(-2.731 -2.673) scale(1.2276)"
    stroke-width={cioStrokeWidth(weight, 1.2276)}
  >
    <rect x="4.6" y="10.4" width="14.8" height="9.6" rx="0" /><rect
      x="10.9"
      y="13.4"
      width="2.2"
      height="3.4"
      rx="0"
      fill="currentColor"
      stroke="none"
    /><path d="M8.4 10.4V7.6a3.6 3.6 0 0 1 6.2-2.5" /><path d="M14.6 5.1 16.4 3.9" />
  </g>
</svg>
