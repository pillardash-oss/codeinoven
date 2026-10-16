<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Source file
  Source file: the page with a folded corner and two chevrons, which is what
  makes it a file of code rather than of prose.
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
    transform="translate(-2.368 -2.736) scale(1.2080)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.208)}
  >
    <path
      d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z"
    /><path d="M13.4 3.8v5.2h5" /><path d="M10 12.2 7.8 14.6l2.2 2.4" /><path
      d="M14.4 12.2l2.2 2.4-2.2 2.4"
    />
  </g>
</svg>
