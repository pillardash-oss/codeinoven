<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Expand
  Expand: a chevron pointing down, on the indicator box with the header
  chevrons.
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
    transform="translate(-0.680 -1.423) scale(1.0566)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.0566)}
  >
    <path d="M5.4 9.4 12 16 18.6 9.4" />
  </g>
</svg>
