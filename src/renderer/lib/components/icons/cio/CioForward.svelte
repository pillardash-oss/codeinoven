<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Forward
  Forward: the same chevron, mirrored.
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
    transform="translate(-1.870 -0.802) scale(1.0668)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.0668)}
  >
    <path d="M9.4 5.4 16.6 12l-7.2 6.6" />
  </g>
</svg>
