<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Network
  Network: one node above two joined ones, the two lower ones solid, which is
  a coordinator with its workers.
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
    transform="translate(-2.189 -2.189) scale(1.1824)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.1824)}
  >
    <rect x="9.4" y="3.4" width="5.2" height="4.2" rx="1.4" /><rect
      x="3.4"
      y="16.4"
      width="5.2"
      height="4.2"
      rx="1.4"
    /><rect x="15.4" y="16.4" width="5.2" height="4.2" rx="1.4" /><path d="M12 7.6v4" /><path
      d="M12 11.6 6 16.4"
    /><path d="M12 11.6 18 16.4" /><circle
      cx="6"
      cy="18.5"
      r="1.4"
      fill="currentColor"
      stroke="none"
    /><circle cx="18" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
  </g>
</svg>
