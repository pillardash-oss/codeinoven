<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Workspace files
  Workspace files: a folder with a child panel hanging off it, which is the
  tree. Two equal panels were tried first and read as two files, not as a
  tree.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g
    transform="translate(-2.189 -2.189) scale(1.1824)"
    stroke-width={cioStrokeWidth(weight, 1.1824)}
  >
    <rect x="3.4" y="4.2" width="10" height="6.8" rx="2" /><path
      d="M8.4 11v3.2a2 2 0 0 0 2 2h1.4"
    /><rect x="11.8" y="13" width="8.8" height="6.8" rx="2" /><rect
      x="5.6"
      y="6.4"
      width="5.6"
      height="2.4"
      rx="1.2"
      fill="currentColor"
      stroke="none"
    />
  </g>
</svg>
