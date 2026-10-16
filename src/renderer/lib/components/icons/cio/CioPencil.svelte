<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Rename
  Rename: a pencil with a ferrule line, drawn as an outline so the eye lands
  on the tip.
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
    transform="translate(-3.716 -3.055) scale(1.2822)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2822)}
  >
    <path d="M4.4 19.6l1.1-4.6L16 4.6a2.3 2.3 0 0 1 3.4 3.4L9 18.5Z" /><path d="M14.6 6.2 18 9.6" />
  </g>
</svg>
