<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · At risk
  At risk: the same shield carrying the solid stem and dot the attention
  triangle uses.
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
    transform="translate(-2.100 -2.086) scale(1.1750)"
    stroke-width={cioStrokeWidth(weight, 1.175)}
  >
    <path d="M12 3.6 19.6 6.4v5.2c0 4.4-3 7.6-7.6 8.8-4.6-1.2-7.6-4.4-7.6-8.8V6.4Z" /><rect
      x="11"
      y="8"
      width="2"
      height="4.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><circle
      cx="12"
      cy="15.4"
      r="1.3"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
