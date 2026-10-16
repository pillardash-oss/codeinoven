<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · At risk
  At risk: the same shield carrying the solid stem and dot the attention
  triangle uses.
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
    <path d="M12 3.6 19.6 6.4v5.2c0 4.4-3 7.6-7.6 8.8-4.6-1.2-7.6-4.4-7.6-8.8V6.4Z" /><rect
      x="11"
      y="8"
      width="2"
      height="4.6"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><circle cx="12" cy="15.4" r="1.3" fill="currentColor" stroke="none" />
  </g>
</svg>
