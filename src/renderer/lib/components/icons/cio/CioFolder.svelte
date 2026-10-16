<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Folder
  Folder: the plain container with a solid lip. The project mark is the same
  folder carrying page marks, which is what keeps the two apart.
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
      d="M3.6 17.6V7.4a1.6 1.6 0 0 1 1.6-1.6h3.4l2.2 2.8h8.4a1.6 1.6 0 0 1 1.6 1.6v7.4a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6Z"
    /><rect x="6.6" y="10.4" width="10.8" height="2.2" rx="1.1" fill="currentColor" stroke="none" />
  </g>
</svg>
