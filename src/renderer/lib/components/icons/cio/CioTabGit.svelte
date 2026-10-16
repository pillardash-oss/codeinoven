<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Git tab
  Git: two commits on a stem and the branch that leaves from one of them, the
  head commit solid. The solid head is what makes it a branch rather than
  three dots.
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
    transform="translate(-2.540 -3.146) scale(1.2622)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2622)}
  >
    <circle cx="7" cy="6.4" r="2.4" /><circle cx="7" cy="17.6" r="2.4" /><circle
      cx="17"
      cy="9.6"
      r="2.4"
      fill="currentColor"
      stroke="none"
    /><path d="M7 8.8v6.4" /><path d="M14.8 9.6h-3.6a4.2 4.2 0 0 0-4.2 4.2v1.4" />
  </g>
</svg>
