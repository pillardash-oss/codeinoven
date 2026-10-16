<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '' }: CioGlyphProps = $props()
</script>

<!--
  CIO · Save
  Save: a disk with a solid shutter. The shutter is the anchor, and it is what
  stops the frame reading as a plain box.
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
    <path
      d="M4.6 6a1.4 1.4 0 0 1 1.4-1.4h10.2l3.2 3.2V18a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4Z"
    /><path d="M8.2 4.6v5h6.6v-5" /><rect
      x="7.6"
      y="13"
      width="8.8"
      height="6.4"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
