<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Sound off
  Sound off: the same speaker with the waves replaced by a cross, so the two
  are one control in two states.
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
    transform="translate(-3.893 -3.139) scale(1.2616)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2616)}
  >
    <path d="M4.6 9.4h3.6L12.8 5.4v13.2l-4.6-4H4.6Z" /><rect
      x="6.2"
      y="10.4"
      width="3"
      height="3.2"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    /><path d="M16.2 9.8 20.6 14.2" /><path d="M20.6 9.8 16.2 14.2" />
  </g>
</svg>
