<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · New message
  New message: the same bubble with a solid plus where the lines were.
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
    <rect x="3.6" y="4.8" width="16.8" height="14.4" rx="2.6" /><rect
      x="10.9"
      y="7.6"
      width="2.2"
      height="7.6"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><rect x="8.2" y="10.3" width="7.6" height="2.2" rx="1.1" fill="currentColor" stroke="none" />
  </g>
</svg>
