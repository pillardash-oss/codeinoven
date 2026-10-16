<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Add to folder
  Add to folder: the folder with a solid arrow coming into it, for a file
  being taken in rather than a folder being made.
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
    transform="translate(-2.415 -2.761) scale(1.1816)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.1816)}
  >
    <path
      d="M9.4 5.8H5.2a1.6 1.6 0 0 0-1.6 1.6v10.2a1.6 1.6 0 0 0 1.6 1.6h13.6a1.6 1.6 0 0 0 1.6-1.6v-5"
    /><rect
      x="12.4"
      y="10.9"
      width="8.2"
      height="2.2"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><path d="M17.2 7.6 20.8 11l-3.6 3.4" /><path d="M5.6 10.8h3.8l1.8-2.4h4.2" />
  </g>
</svg>
