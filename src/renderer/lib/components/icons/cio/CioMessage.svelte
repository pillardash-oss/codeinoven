<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Message
  Message: a squared bubble with two solid lines and no tail. The chat mark
  carries the tail, which is what keeps the two apart.
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
      x="7.2"
      y="9.6"
      width="9.6"
      height="2.4"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    /><rect x="7.2" y="13.6" width="6" height="2.4" rx="1.2" fill="currentColor" stroke="none" />
  </g>
</svg>
