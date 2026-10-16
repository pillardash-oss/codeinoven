<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Utilities
  Utilities: the four panels the utilities page actually is, a grid of
  skills, MCP servers and plugins.
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
    transform="translate(-2.5263 -2.5263) scale(1.2105)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2105)}
  >
    <rect x="3.5" y="3.5" width="7.4" height="7.4" rx="1.6" />
    <rect x="13.1" y="3.5" width="7.4" height="7.4" rx="1.6" />
    <rect x="3.5" y="13.1" width="7.4" height="7.4" rx="1.6" />
    <rect x="13.1" y="13.1" width="7.4" height="7.4" rx="1.6" />
  </g>
</svg>
