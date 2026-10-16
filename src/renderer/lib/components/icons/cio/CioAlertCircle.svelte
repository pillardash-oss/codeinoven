<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Attention
  Attention: a ring carrying the same solid stem and dot as the triangle, so
  an alert reads the same at every size.
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
    <circle cx="12" cy="12" r="8.4" /><rect
      x="11"
      y="7.6"
      width="2"
      height="5.6"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><circle cx="12" cy="16.4" r="1.3" fill="currentColor" stroke="none" />
  </g>
</svg>
