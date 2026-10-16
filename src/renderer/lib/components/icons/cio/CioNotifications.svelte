<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Notifications
  Notifications: a bell with a solid mouth bar and a clapper. The bar is the
  anchor; a thin rim there disappeared into the body at 16px.
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
    transform="translate(-3.576 -6.124) scale(1.2980)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.298)}
  >
    <path d="M7 16.4V11a5 5 0 0 1 10 0v5.4" />
    <rect x="4.4" y="16.4" width="15.2" height="2.6" rx="1.3" fill="currentColor" stroke="none" />
    <path d="M10.2 21a2.2 2.2 0 0 0 3.6 0" />
  </g>
</svg>
