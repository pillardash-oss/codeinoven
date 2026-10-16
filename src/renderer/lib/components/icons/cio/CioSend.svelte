<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Send
  Send: a folded arrow with the fold line drawn, so it reads as a paper plane
  rather than as a plain triangle.
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
    transform="translate(-2.764 -1.920) scale(1.2208)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2208)}
  >
    <path d="M20.4 3.6 3.8 10.4l6.2 2.6 2.6 6.2Z" /><path d="M20.4 3.6 10 13" />
  </g>
</svg>
