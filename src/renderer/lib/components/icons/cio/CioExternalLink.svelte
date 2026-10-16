<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Open elsewhere
  Open elsewhere: a frame with its top right corner escaped and running out of
  the box, which is the whole idea in three strokes.
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
    transform="translate(-3.191 -3.938) scale(1.2758)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2758)}
  >
    <path d="M17.4 14.4v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4" /><path
      d="M13.6 4.6h5.8v5.8"
    /><path d="M19.4 4.6 11.4 12.6" />
  </g>
</svg>
