<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Video
  Video: a board with two teeth up top and a solid band, which is a film
  rather than a screen.
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
    transform="translate(-2.487 -2.727) scale(1.2072)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2072)}
  >
    <rect x="3.6" y="9.6" width="16.8" height="10.2" rx="2" /><rect
      x="6.4"
      y="13"
      width="11.2"
      height="2.2"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><path d="M4.6 9.6 6.6 4.6h3.8l-2 5" /><path d="M12.2 9.6l2-5h3.8l-2 5" />
  </g>
</svg>
