<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Server
  Server: two plates with solid indicators, which is a rack read at 12px. A
  single plate is a plain box.
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
    transform="translate(-2.487 -2.487) scale(1.2072)"
    stroke-width={cioStrokeWidth(weight, 1.2072)}
  >
    <rect x="3.6" y="4.8" width="16.8" height="6" rx="2" /><rect
      x="3.6"
      y="13.2"
      width="16.8"
      height="6"
      rx="2"
    /><circle cx="7.4" cy="7.8" r="1.4" fill="currentColor" stroke="none" /><circle
      cx="7.4"
      cy="16.2"
      r="1.4"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
