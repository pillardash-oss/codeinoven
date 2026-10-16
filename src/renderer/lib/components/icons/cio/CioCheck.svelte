<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Check
  Check: one stroke with a long tail, which is what makes it read as
  acceptance rather than as a corner.
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
    transform="translate(-4.211 -4.211) scale(1.3509)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3509)}
  >
    <path d="M4.6 12.8 9.4 17.6 19.4 6.4" />
  </g>
</svg>
