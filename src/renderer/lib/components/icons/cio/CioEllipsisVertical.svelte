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
    transform="translate(-5.589 -5.589) scale(1.4658)"
    stroke-width={cioStrokeWidth(weight, 1.4658)}
  >
    <circle cx="12" cy="6.4" r="1.9" fill="currentColor" stroke="none" /><circle
      cx="12"
      cy="12"
      r="1.9"
      fill="currentColor"
      stroke="none"
    /><circle cx="12" cy="17.6" r="1.9" fill="currentColor" stroke="none" />
  </g>
</svg>
