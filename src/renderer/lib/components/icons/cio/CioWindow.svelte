<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Window
  Window: a frame with a title rule and two solid controls, which is what
  makes it a window rather than a card.
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
    transform="translate(-2.189 -2.189) scale(1.1824)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.1824)}
  >
    <rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2" /><path d="M3.4 9.4h17.2" /><circle
      cx="6.8"
      cy="7.1"
      r="1.2"
      fill="currentColor"
      stroke="none"
    /><circle cx="9.6" cy="7.1" r="1.2" fill="currentColor" stroke="none" />
  </g>
</svg>
