<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Upload
  Upload: the download turned over, with the same solid shaft so the two read
  as one gesture in two directions.
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
    transform="translate(-3.310 -4.207) scale(1.2758)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2758)}
  >
    <rect
      x="10.9"
      y="8.4"
      width="2.2"
      height="7.6"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><path d="M7.4 9.4 12 4.8l4.6 4.6" /><path
      d="M4.4 18.4v.8a1.4 1.4 0 0 0 1.4 1.4h12.4a1.4 1.4 0 0 0 1.4-1.4v-.8"
    />
  </g>
</svg>
