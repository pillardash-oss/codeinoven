<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Record
  Record: a capsule with a solid core in a cradle. The core is the anchor and
  the cradle is what makes it a microphone.
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
    <rect x="9.4" y="3.4" width="5.2" height="10" rx="2.6" /><rect
      x="10.8"
      y="5.8"
      width="2.4"
      height="5"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    /><path d="M6.4 11.6a5.6 5.6 0 0 0 11.2 0" /><path d="M12 17.2v3.4" />
  </g>
</svg>
