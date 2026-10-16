<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Current
  Current: a ring with a solid centre, which is a choice already made rather
  than one still open.
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
    <circle cx="12" cy="12" r="7.4" /><circle
      cx="12"
      cy="12"
      r="2.6"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
