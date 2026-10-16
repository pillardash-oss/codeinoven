<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · On to
  On to: the same arrow forward.
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
    <path d="M4.6 12h14.8" /><path d="M13.6 5.8 19.4 12l-5.8 6.2" />
  </g>
</svg>
