<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Remove
  Remove: one solid bar. It is the add mark with its vertical taken away, so
  the two cannot be confused.
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
    transform="translate(-6.294 -6.294) scale(1.5245)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.5245)}
  >
    <rect x="4.6" y="10.9" width="14.8" height="2.2" rx="1.1" fill="currentColor" stroke="none" />
  </g>
</svg>
