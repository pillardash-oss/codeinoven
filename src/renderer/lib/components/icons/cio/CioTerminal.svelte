<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Oven and terminal
  Oven and terminal: a frame with a prompt and a solid cursor. The cursor is
  the anchor, and it is 2.4 units tall so it survives 12px as well as 16px.
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
    <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4" /><path
      d="M7.6 9.4 10.4 12.2 7.6 15"
    /><rect x="12" y="12.6" width="5.2" height="2.6" rx="1.3" fill="currentColor" stroke="none" />
  </g>
</svg>
