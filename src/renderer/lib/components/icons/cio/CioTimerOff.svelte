<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Expired
  Expired: the clock struck through, its hands still solid so it stays
  readable underneath.
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
    transform="translate(-2.482 -2.482) scale(1.2068)"
    stroke-width={cioStrokeWidth(weight, 1.2068)}
  >
    <circle cx="12" cy="12" r="8.2" /><rect
      x="11"
      y="7.4"
      width="2"
      height="4.6"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><rect x="12.4" y="11" width="3.6" height="2" rx="1" fill="currentColor" stroke="none" /><path
      d="M5.4 18.6 18.6 5.4"
    />
  </g>
</svg>
