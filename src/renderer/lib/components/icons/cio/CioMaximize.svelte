<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Maximise
  Maximise: four corners opening outward, drawn as corners rather than arrows
  so it never reads as a drag handle.
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
    transform="translate(-4.211 -4.211) scale(1.3509)"
    stroke-width={cioStrokeWidth(strokeWidth, 1.3509)}
  >
    <path d="M9.4 4.6H6a1.4 1.4 0 0 0-1.4 1.4v3.4" /><path
      d="M14.6 4.6H18a1.4 1.4 0 0 1 1.4 1.4v3.4"
    /><path d="M19.4 14.6v3.4a1.4 1.4 0 0 1-1.4 1.4h-3.4" /><path
      d="M4.6 14.6v3.4a1.4 1.4 0 0 0 1.4 1.4h3.4"
    />
  </g>
</svg>
