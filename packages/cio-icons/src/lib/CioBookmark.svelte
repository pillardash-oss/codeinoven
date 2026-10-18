<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Bookmark
  Bookmark: a ribbon with a solid tab, which is what tells a bookmark from a
  plain tag.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="square"
  stroke-linejoin="miter"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g
    transform="translate(-2.550 -3.715) scale(1.2125)"
    stroke-width={cioStrokeWidth(weight, 1.2125)}
  >
    <path
      d="M6.4 4.8h11.2a1.4 1.4 0 0 1 1.4 1.4v14.2l-7-4.4-7 4.4V6.2a1.4 1.4 0 0 1 1.4-1.4Z"
    /><rect
      x="8.8"
      y="6.6"
      width="6.4"
      height="2.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
