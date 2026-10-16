<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · History
  History: the clock with its dial opened by a rewind corner, which is what
  tells history from plain time.
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
    transform="translate(-2.521 -2.635) scale(1.2196)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2196)}
  >
    <path d="M3.8 12a8.2 8.2 0 1 0 2.5-5.9" /><path d="M3.6 4.6v4.2h4.2" /><rect
      x="11"
      y="7.8"
      width="2"
      height="4.6"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><rect x="12.4" y="11.2" width="3.8" height="2" rx="1" fill="currentColor" stroke="none" />
  </g>
</svg>
