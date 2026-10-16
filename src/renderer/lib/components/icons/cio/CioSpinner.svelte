<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Working
  Working: three quarters of a ring with a solid head, so a rotation reads as
  a sweep rather than as a static ring. It replaces the Lucide spinner
  everywhere the app says something is in flight, and the caller keeps its own
  spin animation.
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
    transform="translate(-3.095 -3.876) scale(1.2579)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2579)}
  >
    <path d="M4.6 12a7.4 7.4 0 1 1 7.4 7.4" /><circle
      cx="12"
      cy="19.4"
      r="2.2"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
