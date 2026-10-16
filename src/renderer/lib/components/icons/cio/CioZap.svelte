<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Instant
  Instant: a solid bolt. It is one of the few glyphs that is entirely solid,
  because a stroked bolt closes up at 12px.
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
    transform="translate(-4.113 -4.113) scale(1.3428)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3428)}
  >
    <path d="M13.6 3.6 5.8 13.4h5l-.4 7 7.8-9.8h-5Z" fill="currentColor" stroke="none" />
  </g>
</svg>
