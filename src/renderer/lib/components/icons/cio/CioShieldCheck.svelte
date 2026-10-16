<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Verified
  Verified: a shield with a check in it. The shield is the shape and the check
  is the meaning, so neither takes an anchor.
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
    transform="translate(-2.487 -2.487) scale(1.2072)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2072)}
  >
    <path d="M12 3.6 19.6 6.4v5.2c0 4.4-3 7.6-7.6 8.8-4.6-1.2-7.6-4.4-7.6-8.8V6.4Z" /><path
      d="M8.8 12 11.2 14.4 15.6 9.6"
    />
  </g>
</svg>
