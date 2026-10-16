<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Merge
  Merge: a line joining another at a solid node, the counterpart of the pull
  request arrow.
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
    transform="translate(-2.693 -2.950) scale(1.2860)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.286)}
  >
    <circle cx="6.6" cy="6.4" r="2.6" /><rect
      x="5.6"
      y="9"
      width="2"
      height="8.6"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><path d="M17.4 6.4v3.2a4.2 4.2 0 0 1-4.2 4.2H10.6" /><path
      d="M12.8 11.2 10.2 13.8l2.6 2.6"
    /><circle cx="17.4" cy="18" r="2.4" fill="currentColor" stroke="none" />
  </g>
</svg>
