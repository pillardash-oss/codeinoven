<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Disconnected
  Disconnected: the same plug with its prongs struck out, so the two read as
  one object in two states.
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
    transform="translate(-3.146 -3.649) scale(1.2622)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2622)}
  >
    <rect x="9.4" y="3.6" width="2" height="4.8" rx="1" fill="currentColor" stroke="none" /><rect
      x="12.6"
      y="3.6"
      width="2"
      height="4.8"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><rect x="6.4" y="8.6" width="11.2" height="6.4" rx="2" /><path d="M12 15v5.4" /><path
      d="M5 20 19 4.4"
    />
  </g>
</svg>
