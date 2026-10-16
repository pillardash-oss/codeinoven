<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Copy
  Copy: a sheet over a sheet, the front one carrying a solid line so the two
  do not read as one thick frame.
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
    transform="translate(-3.282 -2.791) scale(1.2325)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2325)}
  >
    <path d="M4.6 8.4v9.8a2 2 0 0 0 2 2h9.8" /><rect
      x="8.6"
      y="3.8"
      width="11.6"
      height="11.6"
      rx="2"
    /><rect x="11" y="7.8" width="6.8" height="2.2" rx="1.1" fill="currentColor" stroke="none" />
  </g>
</svg>
