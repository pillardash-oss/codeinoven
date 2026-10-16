<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Drive
  Drive: a bay with a divider and two solid indicators, which is a disk rather
  than a machine.
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
    <rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2" /><path d="M3.4 12.6h17.2" /><circle
      cx="7.4"
      cy="16"
      r="1.4"
      fill="currentColor"
      stroke="none"
    /><circle cx="11" cy="16" r="1.4" fill="currentColor" stroke="none" /><path d="M15.4 16h2.2" />
  </g>
</svg>
