<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Reorder
  Reorder: six solid dots in two columns. Nothing else reads as a handle at
  12px.
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
    transform="translate(-9.491 -9.491) scale(1.7909)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.7909)}
  >
    <circle cx="9.4" cy="7" r="1.3" fill="currentColor" stroke="none" /><circle
      cx="14.6"
      cy="7"
      r="1.3"
      fill="currentColor"
      stroke="none"
    /><circle cx="9.4" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle
      cx="14.6"
      cy="12"
      r="1.3"
      fill="currentColor"
      stroke="none"
    /><circle cx="9.4" cy="17" r="1.3" fill="currentColor" stroke="none" /><circle
      cx="14.6"
      cy="17"
      r="1.3"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
