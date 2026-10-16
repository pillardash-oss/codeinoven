<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Add
  Add: a solid vertical bar crossed by one stroke, so it cannot be mistaken
  for the close cross at 12px.
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
    transform="translate(-4.211 -4.211) scale(1.3509)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3509)}
  >
    <rect
      x="10.9"
      y="4.6"
      width="2.2"
      height="14.8"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><path d="M4.6 12h14.8" />
  </g>
</svg>
