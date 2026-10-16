<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Tag
  Tag: a label with its corner cut and a solid eyelet, which is what makes a
  tag read as tied on.
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
    transform="translate(-3.843 -3.843) scale(1.3203)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3203)}
  >
    <path d="M4.4 10.8V6a1.6 1.6 0 0 1 1.6-1.6h4.8l8.8 8.8-6.4 6.4Z" /><circle
      cx="8.4"
      cy="8.4"
      r="1.9"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
