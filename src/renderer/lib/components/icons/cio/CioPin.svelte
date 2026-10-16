<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Pin
  Pin: a solid crown over a body and a stem, which is a pin held in place
  rather than a map marker.
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
    transform="translate(-3.265 -3.861) scale(1.2721)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2721)}
  >
    <rect
      x="9.4"
      y="3.6"
      width="5.2"
      height="2.6"
      rx="1.3"
      fill="currentColor"
      stroke="none"
    /><path d="M9.4 6.2h5.2l-.6 5 2.6 2.6v2.4H7.4v-2.4l2.6-2.6Z" /><path d="M12 16.2v4.2" />
  </g>
</svg>
