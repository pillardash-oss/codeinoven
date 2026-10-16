<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Favourite
  Favourite: a five point star, outline only. Its silhouette is the meaning,
  so an anchor inside it only muddies it.
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
    transform="translate(-1.887 -1.887) scale(1.1573)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.1573)}
  >
    <path d="M12 3.6l2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.8-5.4 2.8 1-6.1L3.2 10l6.1-.9Z" />
  </g>
</svg>
