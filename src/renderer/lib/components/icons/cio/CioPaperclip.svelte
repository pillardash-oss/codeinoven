<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Attach
  Attach: one continuous wire folded four times, which is the whole shape of a
  paperclip.
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
    transform="translate(-1.804 -3.317) scale(1.3176)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3176)}
  >
    <path
      d="M17.4 11.4 10.8 18a4.2 4.2 0 0 1-6-6l7.4-7.4a3 3 0 0 1 4.2 4.2l-7.2 7.2a1.6 1.6 0 0 1-2.2-2.2l6.4-6.4"
    />
  </g>
</svg>
