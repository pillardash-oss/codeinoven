<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Expired
  Expired: the clock struck through, its hands still solid so it stays
  readable underneath.
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
    <circle cx="12" cy="12" r="8.2" /><rect
      x="11"
      y="7.4"
      width="2"
      height="4.6"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><rect x="12.4" y="11" width="3.6" height="2" rx="1" fill="currentColor" stroke="none" /><path
      d="M5.4 18.6 18.6 5.4"
    />
  </g>
</svg>
