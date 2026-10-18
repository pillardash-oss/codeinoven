<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Comment
  Comment: a bubble with a tail at the lower right and one solid line in it,
  which is something said about what it points at. It was a rounded rectangle
  carrying two bars, which is the silhouette the diff mark wore, so the two
  were the same shape with different content; the chats mark keeps the squared
  bubble and the tail on the other side.
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
    transform="translate(-2.169 -3.663) scale(1.1807)"
    stroke-width={cioStrokeWidth(weight, 1.1807)}
  >
    <path
      d="M3.6 7.4a2.4 2.4 0 0 1 2.4-2.4h12a2.4 2.4 0 0 1 2.4 2.4v7.2a2.4 2.4 0 0 1-2.4 2.4h-1.2v3.6l-4.6-3.6H6a2.4 2.4 0 0 1-2.4-2.4Z"
    /><rect
      x="7.2"
      y="9.9"
      width="9.6"
      height="2.4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
