<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · More, upright
  More, upright: the same three dots stood up, for a toolbar that stacks its
  controls rather than laying them out.
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
    transform="translate(-5.564 -5.564) scale(1.4637)"
    stroke-width={cioStrokeWidth(weight, 1.4637)}
  >
    <rect x="10.1" y="4.5" width="3.8" height="3.8" rx="0" fill="currentColor" stroke="none" /><rect
      x="10.1"
      y="10.1"
      width="3.8"
      height="3.8"
      rx="0"
      fill="currentColor"
      stroke="none"
    /><rect x="10.1" y="15.7" width="3.8" height="3.8" rx="0" fill="currentColor" stroke="none" />
  </g>
</svg>
