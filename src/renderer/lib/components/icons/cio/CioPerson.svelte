<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Person
  Person: a solid head over a shoulder line. The head is solid because a
  stroked circle this small reads as a letter O.
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
    transform="translate(-3.795 -4.813) scale(1.3162)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3162)}
  >
    <circle cx="12" cy="8.2" r="4" fill="currentColor" stroke="none" /><path
      d="M4.6 20.4a7.4 7.4 0 0 1 14.8 0"
    />
  </g>
</svg>
