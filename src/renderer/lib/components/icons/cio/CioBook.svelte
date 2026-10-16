<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Guide
  Guide: an open book with a solid spine band, which is a reference rather
  than a document.
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
    transform="translate(-3.843 -4.370) scale(1.3203)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3203)}
  >
    <path
      d="M4.6 4.8h4.6a3 3 0 0 1 2.8 1.8 3 3 0 0 1 2.8-1.8h4.6v13.4h-4.6a3 3 0 0 0-2.8 1.8 3 3 0 0 0-2.8-1.8H4.6Z"
    /><rect x="11.1" y="8" width="1.8" height="8.4" rx="0.9" fill="currentColor" stroke="none" />
  </g>
</svg>
