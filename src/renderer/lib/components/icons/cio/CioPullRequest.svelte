<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Pull request
  Pull request: a branch feeding an arrow into a line with a second node,
  which is a change waiting to be merged.
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
    /><path d="M17.4 15.4V12a3.4 3.4 0 0 0-3.4-3.4H10.6" /><path
      d="M13.4 6.2 10.4 8.6l3 2.4"
    /><circle cx="17.4" cy="18" r="2.4" fill="currentColor" stroke="none" />
  </g>
</svg>
