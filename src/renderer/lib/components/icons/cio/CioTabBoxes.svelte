<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Containers tab
  Containers: a box with its contents in it, one object inside another and a
  five-unit gap between them. Four equal panels read as a grid rather than
  as a thing that holds things.
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
    transform="translate(-3.915 -3.915) scale(1.3263)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3263)}
  >
    <rect x="4.2" y="4.2" width="15.6" height="15.6" rx="2.6" />
    <rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1.6" fill="currentColor" stroke="none" />
  </g>
</svg>
