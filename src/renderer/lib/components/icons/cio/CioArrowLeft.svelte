<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Back to
  Back to: a level arrow, on the indicator box with the header chevrons.
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
    transform="translate(0.516 0.516) scale(0.9570)"
    stroke-width={cioStrokeWidth(strokeWidth, 0.957)}
  >
    <path d="M19.4 12H4.6" /><path d="M10.4 5.8 4.6 12l5.8 6.2" />
  </g>
</svg>
