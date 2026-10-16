<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Fork
  Fork: one solid node above two, joined by short stems. Three solid nodes
  read as a fork at 12px where outlines do not.
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
    transform="translate(-3.746 -4.269) scale(1.3122)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3122)}
  >
    <circle cx="12" cy="6.4" r="2.6" fill="currentColor" stroke="none" /><circle
      cx="6.6"
      cy="18.4"
      r="2.6"
      fill="currentColor"
      stroke="none"
    /><circle cx="17.4" cy="18.4" r="2.6" fill="currentColor" stroke="none" /><path
      d="M12 9v1.4a3.4 3.4 0 0 1-3.4 3.4h-.4"
    /><path d="M12 10.4a3.4 3.4 0 0 0 3.4 3.4h.4" />
  </g>
</svg>
