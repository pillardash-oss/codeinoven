<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Containers
  Containers: a crate seen from the front, with a lid rule across it and two
  solid straps. The first drawing was a square with a smaller square inside,
  which is the silhouette the scoped field wears, so the two were unreadable
  apart at 12px. A box open at the top was tried and read as an inbox tray.
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
    transform="translate(-2.487 -3.944) scale(1.2072)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2072)}
  >
    <path d="M3.6 8.6h16.8v9.2a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2Z" /><path
      d="M3.6 8.6a2 2 0 0 1 2-2h12.8a2 2 0 0 1 2 2"
    /><rect x="8.2" y="10.6" width="2" height="6.8" rx="1" fill="currentColor" stroke="none" /><rect
      x="13.8"
      y="10.6"
      width="2"
      height="6.8"
      rx="1"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
