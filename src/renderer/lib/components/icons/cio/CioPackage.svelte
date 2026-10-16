<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Package
  Package: a box in three quarter view with a solid seal, which is a shipped
  thing rather than a container on a shelf.
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
    transform="translate(-3.843 -3.843) scale(1.3203)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3203)}
  >
    <path d="M4.4 8.6 12 4.6l7.6 4v6.8L12 19.4l-7.6-4Z" /><path d="M4.4 8.6 12 12.6l7.6-4" /><path
      d="M12 12.6v6.8"
    /><rect x="9.6" y="6.2" width="4.8" height="1.8" rx="0.9" fill="currentColor" stroke="none" />
  </g>
</svg>
