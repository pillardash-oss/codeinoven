<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
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
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden="true"
>
  <g
    transform="translate(-3.102 -3.574) scale(1.2585)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2585)}
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
