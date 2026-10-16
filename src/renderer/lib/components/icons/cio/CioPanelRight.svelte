<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Dock right
  Dock right: a frame with its right column solid, which is the dock drawn as
  a state rather than as an action.
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
    transform="translate(-2.189 -2.189) scale(1.1824)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.1824)}
  >
    <rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2" /><rect
      x="14.6"
      y="4.8"
      width="6"
      height="14.4"
      rx="2"
      fill="currentColor"
      stroke="none"
    /><path d="M14.6 4.8v14.4" />
  </g>
</svg>
