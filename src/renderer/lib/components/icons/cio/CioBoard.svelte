<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Board
  Board: a header rule and three even columns.
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
    transform="translate(-3.9231 -3.9231) scale(1.3269)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3269)}
  >
    <path d="M4.4 5.8h15.2" />
    <rect x="5.2" y="9.4" width="3.2" height="9.2" rx="1" fill="currentColor" stroke="none" />
    <rect x="10.4" y="9.4" width="3.2" height="9.2" rx="1" fill="currentColor" stroke="none" />
    <rect x="15.6" y="9.4" width="3.2" height="9.2" rx="1" fill="currentColor" stroke="none" />
  </g>
</svg>
