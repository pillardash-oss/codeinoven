<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Refresh
  Refresh: a ring broken by a corner, so the direction is the stroke and not a
  second mark.
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
    transform="translate(-3.795 -3.826) scale(1.3162)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3162)}
  >
    <path d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4" /><path d="M19.6 4.4v4.4h-4.4" />
  </g>
</svg>
