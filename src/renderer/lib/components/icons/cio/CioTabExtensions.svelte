<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Extensions tab
  Extensions: a puzzle piece, one knob cut into the top edge and one knob
  solid on the right. The previous drawing was a square with a single knob
  and it read as a clipboard, which is reserved for the copy toast.
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
    transform="translate(-4.169 0.749) scale(1.2130)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.213)}
  >
    <path d="M6.4 5.2h3.2a3 3 0 1 1 5 0h3.2v12.4H6.4Z" />
    <circle cx="18.4" cy="11.4" r="2.8" fill="currentColor" stroke="none" />
  </g>
</svg>
