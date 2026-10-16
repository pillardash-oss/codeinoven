<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Method
  Method: two braces around a solid point, which is a call rather than a block
  of code.
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
    transform="translate(-3.478 -3.992) scale(1.2898)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2898)}
  >
    <path
      d="M9.4 4.6a2.4 2.4 0 0 0-2.4 2.4v3a2.4 2.4 0 0 1-2.4 2.4 2.4 2.4 0 0 1 2.4 2.4v3a2.4 2.4 0 0 0 2.4 2.4"
    /><path
      d="M14.6 4.6a2.4 2.4 0 0 1 2.4 2.4v3a2.4 2.4 0 0 0 2.4 2.4 2.4 2.4 0 0 0-2.4 2.4v3a2.4 2.4 0 0 1-2.4 2.4"
    /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </g>
</svg>
