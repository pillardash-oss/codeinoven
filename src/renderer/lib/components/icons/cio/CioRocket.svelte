<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Release
  Release: a body with solid fins and a solid eye, which is a launch rather
  than a plain arrow.
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
    transform="translate(-2.808 -2.562) scale(1.2340)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.234)}
  >
    <path d="M12 3.6c3.2 2.4 5 5.8 5 9.6l-2.4 2.8H9.4L7 13.2c0-3.8 1.8-7.2 5-9.6Z" /><circle
      cx="12"
      cy="9.6"
      r="1.9"
      fill="currentColor"
      stroke="none"
    /><path d="M9.4 16 7.6 20M14.6 16l1.8 4" />
  </g>
</svg>
