<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Collapse
  Collapse: the same chevron turned up.
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
    transform="translate(-0.680 0.063) scale(1.0566)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.0566)}
  >
    <path d="M5.4 14.6 12 8 18.6 14.6" />
  </g>
</svg>
