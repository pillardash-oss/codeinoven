<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Layers
  Layers: one plane above two, the top one carrying a solid edge so the stack
  reads in depth.
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
    transform="translate(-2.487 -1.044) scale(1.2072)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2072)}
  >
    <path d="M12 4.4 20.4 9 12 13.6 3.6 9Z" /><rect
      x="9.6"
      y="8.2"
      width="4.8"
      height="1.6"
      rx="0.8"
      fill="currentColor"
      stroke="none"
    /><path d="M3.6 12.6 12 17.2l8.4-4.6" />
  </g>
</svg>
