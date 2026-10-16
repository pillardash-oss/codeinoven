<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Filter
  Filter: a funnel with a solid mouth, so the narrowing is read from the top
  down rather than as a plain V.
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
    transform="translate(-2.936 -5.022) scale(1.2447)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2447)}
  >
    <path d="M4.6 6.4 12 14.4l7.4-8" /><path d="M12 14.4v5.4l-3.4 2v-7.4" /><rect
      x="4.4"
      y="4.6"
      width="15.2"
      height="2.4"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
