<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Debugger
  Debugger: a beetle with two legs a side and one solid band. Lucide bug has
  nine strokes and turns to a cluster at 16px; this keeps four legs, so the
  legs read as legs.
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
    transform="translate(-2.783 -4.508) scale(1.2319)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2319)}
  >
    <rect x="6" y="7.4" width="12" height="12" rx="6" />
    <path d="M6 10.6H3.6" />
    <path d="M6 16.4H3.6" />
    <path d="M18 10.6h2.4" />
    <path d="M18 16.4h2.4" />
    <rect x="8.6" y="12.2" width="6.8" height="2.6" rx="1.3" fill="currentColor" stroke="none" />
  </g>
</svg>
