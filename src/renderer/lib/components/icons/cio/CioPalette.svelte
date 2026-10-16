<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Appearance
  Appearance: a palette with three solid wells, which is what makes it a
  colour set rather than a mask.
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
    transform="translate(-2.791 -2.791) scale(1.2325)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2325)}
  >
    <path
      d="M12 3.8a8.2 8.2 0 0 0 0 16.4c1.3 0 2.1-.9 2.1-2 0-.6-.3-1-.6-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h1.6a3.6 3.6 0 0 0 3.6-3.6C20.2 6.8 16.6 3.8 12 3.8Z"
    /><circle cx="8.4" cy="9.2" r="1.6" fill="currentColor" stroke="none" /><circle
      cx="12"
      cy="7.4"
      r="1.6"
      fill="currentColor"
      stroke="none"
    /><circle cx="15.6" cy="9.6" r="1.6" fill="currentColor" stroke="none" />
  </g>
</svg>
