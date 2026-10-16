<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Paste
  Paste: a clipboard whose clip is solid, with two lines under it. The clip is
  the anchor that makes the frame a clipboard.
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
    transform="translate(-2.725 -3.157) scale(1.2271)"
    stroke-width={cioStrokeWidth(weight, 1.2271)}
  >
    <path
      d="M8.6 4.8H6.4a1.8 1.8 0 0 0-1.8 1.8v12a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-12a1.8 1.8 0 0 0-1.8-1.8h-2.2"
    /><rect
      x="9.2"
      y="3.4"
      width="5.6"
      height="3"
      rx="1.3"
      fill="currentColor"
      stroke="none"
    /><path d="M9.4 12.6h5.2" /><path d="M9.4 15.8h3.2" />
  </g>
</svg>
