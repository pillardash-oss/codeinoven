<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Scoped
  Scoped: a field with the selected region solid at its centre.
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
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <rect x="9" y="9" width="6" height="6" rx="1.2" fill="currentColor" stroke="none" />
  </g>
</svg>
