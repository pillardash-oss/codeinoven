<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Memory
  Memory: three plates with the middle one solid, so the stack reads as a
  store rather than as a list. A brain outline was tried and read as a cloud
  at 16px.
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
    transform="translate(-3.478 -3.599) scale(1.2898)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2898)}
  >
    <rect x="4.2" y="4.6" width="15.6" height="3.8" rx="1.8" /><rect
      x="4.2"
      y="10.2"
      width="15.6"
      height="3.8"
      rx="1.8"
      fill="currentColor"
      stroke="none"
    /><rect x="4.2" y="15.8" width="15.6" height="3.8" rx="1.8" />
  </g>
</svg>
