<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Key
  Key: a ring with a solid bore and a shaft with two teeth, so the shaft is
  not taken for a line of text.
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
    transform="translate(-2.964 -3.992) scale(1.2898)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2898)}
  >
    <circle cx="8" cy="16" r="4.2" /><circle
      cx="8"
      cy="16"
      r="1.5"
      fill="currentColor"
      stroke="none"
    /><path d="M11 13 19.4 4.6" /><path d="M16.4 7.6 18.6 9.8" /><path d="M14 10 16.2 12.2" />
  </g>
</svg>
