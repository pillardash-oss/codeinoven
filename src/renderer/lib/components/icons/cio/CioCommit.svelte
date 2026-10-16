<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Commit
  Commit: a stem with a solid node on it. The node is the commit and the stem
  is what puts it on a line of history.
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
    transform="translate(-2.487 -2.487) scale(1.2072)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2072)}
  >
    <path d="M3.6 12h4.2" /><path d="M16.2 12h4.2" /><circle
      cx="12"
      cy="12"
      r="3"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
