<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · More
  More: three solid dots on one level. No outline at all: at 12px an outlined
  dot is a smudge.
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
    transform="translate(-6.067 -6.067) scale(1.5056)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.5056)}
  >
    <circle cx="6.4" cy="12" r="1.9" fill="currentColor" stroke="none" /><circle
      cx="12"
      cy="12"
      r="1.9"
      fill="currentColor"
      stroke="none"
    /><circle cx="17.6" cy="12" r="1.9" fill="currentColor" stroke="none" />
  </g>
</svg>
