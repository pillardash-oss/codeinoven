<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Goal
  Goal: two rings around a solid centre, the inner ring at 4.4 units so it
  survives 12px.
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
    transform="translate(-2.791 -2.791) scale(1.2325)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2325)}
  >
    <circle cx="12" cy="12" r="8.2" /><circle cx="12" cy="12" r="4.4" /><circle
      cx="12"
      cy="12"
      r="1.8"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
