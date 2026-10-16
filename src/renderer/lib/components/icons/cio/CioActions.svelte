<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Actions
  Actions: a gauge, which is what monitoring looks like. A monitor frame
  with a cog was Lucide answer and it turns to mush at 16px; the gauge keeps
  one arc, one needle and one solid hub.
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
    transform="translate(-4.332 -7.227) scale(1.3610)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.361)}
  >
    <path d="M4.4 17.4a7.6 7.6 0 1 1 15.2 0" />
    <path d="M12 17.4 16.2 11" />
    <circle cx="12" cy="17.4" r="2" fill="currentColor" stroke="none" />
  </g>
</svg>
