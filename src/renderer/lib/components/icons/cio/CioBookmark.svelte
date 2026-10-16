<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Bookmark
  Bookmark: a ribbon with a solid tab, which is what tells a bookmark from a
  plain tag.
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
    transform="translate(-3.486 -4.257) scale(1.2905)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2905)}
  >
    <path
      d="M6.4 4.8h11.2a1.4 1.4 0 0 1 1.4 1.4v14.2l-7-4.4-7 4.4V6.2a1.4 1.4 0 0 1 1.4-1.4Z"
    /><rect x="8.8" y="6.6" width="6.4" height="2.2" rx="1.1" fill="currentColor" stroke="none" />
  </g>
</svg>
