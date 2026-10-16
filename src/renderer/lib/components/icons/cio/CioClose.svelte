<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Close
  Close: two crossed bars with round caps. No anchor, like the chevrons: the
  crossing is the mass.
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
    transform="translate(-9.348 -9.348) scale(1.7790)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.779)}
  >
    <path d="M6.6 6.6 17.4 17.4" /><path d="M17.4 6.6 6.6 17.4" />
  </g>
</svg>
