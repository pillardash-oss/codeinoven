<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Thread note
  Thread note: the thread itself, with the note hanging off it. A feather is
  Lucide mark and a pen is a drawing of a pen; neither says the note belongs
  to this thread. The card carries one solid line.
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
    transform="translate(-4.148 -2.791) scale(1.2325)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2325)}
  >
    <path d="M6.2 3.8v16.4" /><rect x="8.8" y="7.4" width="11.2" height="9.2" rx="2.2" /><rect
      x="11.2"
      y="10.4"
      width="6.4"
      height="2.4"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    /><path d="M11.2 15.4h4.2" />
  </g>
</svg>
