<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Files tab
  Files: two sheets with one solid line on the front sheet. The dock
  Workspace files is a folder tree; this one is the pages themselves, so the
  two never collide.
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
    transform="translate(-2.891 -3.393) scale(1.2618)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2618)}
  >
    <rect x="4.2" y="6.4" width="11" height="14" rx="2" />
    <path d="M8.2 6.4V6a2 2 0 0 1 2-2h7.2a2 2 0 0 1 2 2v10.6a2 2 0 0 1-2 2h-.4" />
    <rect x="7" y="11.6" width="5.6" height="2.4" rx="1.2" fill="currentColor" stroke="none" />
  </g>
</svg>
