<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Pin
  Pin: a solid crown over a body and a stem, which is a pin held in place
  rather than a map marker.
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
    transform="translate(-2.904 -3.458) scale(1.2420)"
    stroke-width={cioStrokeWidth(weight, 1.242)}
  >
    <rect
      x="9.4"
      y="3.6"
      width="5.2"
      height="2.6"
      rx="1.3"
      fill="currentColor"
      stroke="none"
    /><path d="M9.4 6.2h5.2l-.6 5 2.6 2.6v2.4H7.4v-2.4l2.6-2.6Z" /><path d="M12 16.2v4.2" />
  </g>
</svg>
