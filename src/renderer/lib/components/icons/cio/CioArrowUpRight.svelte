<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Open
  Open: a diagonal with a corner head, for opening something rather than
  copying a link.
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
    transform="translate(-3.102 -3.102) scale(1.2585)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2585)}
  >
    <path d="M6.6 17.4 17.4 6.6" /><path d="M8.6 6.6h8.8v8.8" />
  </g>
</svg>
