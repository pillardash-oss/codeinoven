<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Repair
  Repair: a handle into an open jaw. This is the engineering tool rather than
  the office box the app drew before.
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
    transform="translate(-3.343 -2.997) scale(1.1784)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.1784)}
  >
    <path d="M4.4 19.6 13.2 10.8" /><path d="M12.2 9.8 15.2 6.8a3.9 3.9 0 0 1 5.5 5.5l-3 3Z" /><path
      d="M16.2 12.4 19.6 9"
    />
  </g>
</svg>
