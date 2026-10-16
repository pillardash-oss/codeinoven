<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Play
  Play: a solid triangle. Filled rather than stroked, because a stroked
  triangle this small reads as a warning.
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
    transform="translate(-11.571 -8.507) scale(1.7089)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.7089)}
  >
    <path d="M8.6 5.4 19 12 8.6 18.6Z" fill="currentColor" stroke="none" />
  </g>
</svg>
