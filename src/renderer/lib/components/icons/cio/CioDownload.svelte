<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Download
  Download: a solid shaft into a tray. The shaft carries the mass, which lets
  the tray stay one thin rule.
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
    transform="translate(-3.095 -3.818) scale(1.2579)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2579)}
  >
    <rect
      x="10.9"
      y="3.6"
      width="2.2"
      height="7.6"
      rx="1.1"
      fill="currentColor"
      stroke="none"
    /><path d="M7.4 10.6 12 15.2l4.6-4.6" /><path
      d="M4.4 18.4v.8a1.4 1.4 0 0 0 1.4 1.4h12.4a1.4 1.4 0 0 0 1.4-1.4v-.8"
    />
  </g>
</svg>
