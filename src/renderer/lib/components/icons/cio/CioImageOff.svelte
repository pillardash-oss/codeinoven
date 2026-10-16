<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · No preview
  No preview: a picture frame struck through, the sun still solid so the frame
  reads as a picture underneath.
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
    transform="translate(-2.487 -2.487) scale(1.2072)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2072)}
  >
    <rect x="3.6" y="4.8" width="16.8" height="14.4" rx="2" /><circle
      cx="9.4"
      cy="9.6"
      r="1.8"
      fill="currentColor"
      stroke="none"
    /><path d="M4.6 19.4 19.4 4.6" />
  </g>
</svg>
