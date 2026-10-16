<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Code
  Code: two chevrons with a slash between them, which is what tells code from
  a plain direction.
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
    transform="translate(-4.211 -4.211) scale(1.3509)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3509)}
  >
    <path d="M8.4 8.4 4.6 12l3.8 3.6" /><path d="M15.6 8.4 19.4 12l-3.8 3.6" /><path
      d="M13.4 6.4 10.6 17.6"
    />
  </g>
</svg>
