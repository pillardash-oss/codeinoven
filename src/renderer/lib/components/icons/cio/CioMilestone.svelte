<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Milestone
  Milestone: a stem with a flag on it, the flag solid so it reads on a
  timeline.
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
    transform="translate(-4.410 -2.487) scale(1.2072)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2072)}
  >
    <path d="M6.4 3.6v16.8" /><path d="M6.4 6h12l2.4 2.2-2.4 2.2h-12Z" /><rect
      x="9"
      y="7.2"
      width="7.6"
      height="2"
      rx="1"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
