<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Subagent
  Subagent: a head with an aerial and two solid eyes. The eyes carry the mass;
  one wider solid visor was tried and read as a robot mask rather than a
  worker.
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
    transform="translate(-2.536 -1.841) scale(1.2114)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.2114)}
  >
    <rect x="4.2" y="8.6" width="15.6" height="11.2" rx="3" /><path d="M12 8.6V5.4" /><circle
      cx="12"
      cy="3.8"
      r="1.7"
      fill="currentColor"
      stroke="none"
    /><rect
      x="7.6"
      y="12.6"
      width="3.2"
      height="3.2"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    /><rect x="13.2" y="12.6" width="3.2" height="3.2" rx="1.2" fill="currentColor" stroke="none" />
  </g>
</svg>
