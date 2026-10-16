<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Skip
  Skip: a solid triangle against a solid bar. The bar is the anchor and it is
  what says the motion stops here.
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
    transform="translate(-11.730 -11.342) scale(1.9452)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.9452)}
  >
    <path d="M6.4 6.4 14 12l-7.6 5.6Z" fill="currentColor" stroke="none" /><rect
      x="15.6"
      y="6.4"
      width="2.4"
      height="11.2"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
