<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Info tab
  Update: a readout plate carrying its own mark. The dot and the stem are 1.8
  units wide, above the one-device-pixel floor, which pass D's version of this
  glyph was not.
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
    transform="translate(-2.5263 -2.5263) scale(1.2105)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2105)}
  >
    <rect x="3.5" y="4.8" width="17" height="14.4" rx="2" />
    <circle cx="12" cy="9.3" r="1.8" fill="currentColor" stroke="none" />
    <rect x="11.1" y="12.4" width="1.8" height="4.8" rx="0.9" fill="currentColor" stroke="none" />
  </g>
</svg>
