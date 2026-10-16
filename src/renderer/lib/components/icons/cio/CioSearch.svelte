<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Search
  Search: a lens with a solid pupil and a handle thick enough to carry the
  mass at 16px. An empty lens read as a plain ring.
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
    transform="translate(-3.710 -3.710) scale(1.2773)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2773)}
  >
    <circle cx="10.4" cy="10.4" r="6.2" />
    <path d="M15.2 15.2 20.4 20.4" />
    <circle cx="10.4" cy="10.4" r="2.4" fill="currentColor" stroke="none" />
  </g>
</svg>
