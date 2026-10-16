<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Sound on
  Sound on: a speaker with a solid mouth and two waves, spaced so they stay
  apart at 12px.
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
    transform="translate(-3.860 -3.051) scale(1.2543)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2543)}
  >
    <path d="M4.6 9.4h3.6L12.8 5.4v13.2l-4.6-4H4.6Z" /><rect
      x="6.2"
      y="10.4"
      width="3"
      height="3.2"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    /><path d="M16.2 9.6a3.6 3.6 0 0 1 0 4.8" /><path d="M18.8 7.2a7 7 0 0 1 0 9.6" />
  </g>
</svg>
