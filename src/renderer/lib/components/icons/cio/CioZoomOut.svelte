<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Zoom out
  Zoom out: the same lens with one solid bar, which is a search being widened.
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
    transform="translate(-2.446 -2.446) scale(1.1945)"
    stroke-width={cioStrokeWidth(weight, 1.1945)}
  >
    <circle cx="10.6" cy="10.6" r="6.8" /><path d="M15.6 15.6 20.4 20.4" /><rect
      x="6.6"
      y="9.6"
      width="8"
      height="2"
      rx="1"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
