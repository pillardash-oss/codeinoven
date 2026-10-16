<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Generated
  Generated: one solid sparkle with a smaller outlined one beside it. The
  solid one carries the meaning and the outline says there is more of it.
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
    transform="translate(-4.743 -3.914) scale(1.2860)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.286)}
  >
    <path
      d="M10.6 3.6l1.7 4.6 4.6 1.7-4.6 1.7-1.7 4.6-1.7-4.6L4.3 9.9l4.6-1.7Z"
      fill="currentColor"
      stroke="none"
    /><path d="M17.6 13.8l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9Z" />
  </g>
</svg>
