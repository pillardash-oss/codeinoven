<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Swap
  Swap: two arrows crossing, on the indicator box so it matches the other
  direction marks.
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
    <path d="M4.6 9.2h13" /><path d="M14.6 5.6 18.2 9.2l-3.6 3.6" /><path d="M19.4 14.8h-13" /><path
      d="M9.4 11.2 5.8 14.8l3.6 3.6"
    />
  </g>
</svg>
