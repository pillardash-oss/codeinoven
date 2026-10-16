<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Display
  Display: a screen on a stand with one solid line of content, which is what
  separates it from the terminal frame.
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
    transform="translate(-2.189 -2.425) scale(1.1824)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.1824)}
  >
    <rect x="3.4" y="4.8" width="17.2" height="11.4" rx="2" /><rect
      x="6.4"
      y="7.6"
      width="8"
      height="2.2"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><path d="M12 16.2v3.4" /><path d="M8.6 19.6h6.8" />
  </g>
</svg>
