<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Back
  Back: a direction, not a picture. Fitted to the indicator box because a
  chevron that fills the picture box reads as a much larger control than the
  glyphs beside it.
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
    transform="translate(0.267 -0.802) scale(1.0668)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.0668)}
  >
    <path d="M14.6 5.4 7.4 12l7.2 6.6" />
  </g>
</svg>
