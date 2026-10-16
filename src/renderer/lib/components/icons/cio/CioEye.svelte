<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Show
  Show: an eye with a solid pupil. The pupil is the anchor and the lid is one
  closed path, which is what keeps it from reading as two arcs.
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
    transform="translate(-1.095 -1.095) scale(1.0912)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.0912)}
  >
    <path d="M2.6 12s3.6-6.6 9.4-6.6S21.4 12 21.4 12s-3.6 6.6-9.4 6.6S2.6 12 2.6 12Z" /><circle
      cx="12"
      cy="12"
      r="2.6"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
