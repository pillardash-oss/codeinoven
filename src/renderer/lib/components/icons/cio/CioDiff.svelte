<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Changes
  Changes: a page carrying a solid plus. The plus is two crossed solid bars
  rather than a stroked cross, because a stroked cross at 16px reads as a
  tick.
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
    transform="translate(-1.047 -5.317) scale(1.2923)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2923)}
  >
    <path
      d="M4.6 5.4h8.6l4.6 4.6v9.2a2.2 2.2 0 0 1-2.2 2.2H4.6a2.2 2.2 0 0 1-2.2-2.2V7.6a2.2 2.2 0 0 1 2.2-2.2Z"
    />
    <rect x="6.4" y="12.8" width="8" height="2.4" rx="1.2" fill="currentColor" stroke="none" />
    <rect x="9.2" y="10" width="2.4" height="8" rx="1.2" fill="currentColor" stroke="none" />
  </g>
</svg>
