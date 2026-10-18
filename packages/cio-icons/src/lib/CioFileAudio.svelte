<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Audio file
  Audio file: the page carrying one note, its head, stem and runout meeting at
  the stem so the three strokes read as a single mark rather than as pieces
  laid on the page.
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
    transform="translate(-2.058 -2.404) scale(1.1807)"
    stroke-width={cioStrokeWidth(weight, 1.1807)}
  >
    <path
      d="M5.4 5.4a1.6 1.6 0 0 1 1.6-1.6h6.4l5 5v10.2a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6Z"
    /><path d="M13.4 3.8v5.2h5" /><circle
      cx="11.4"
      cy="16.4"
      r="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="13.2"
      y="9.4"
      width="2"
      height="7"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M15.2 9.4a3.2 3.2 0 0 1 2.4 3.1" />
  </g>
</svg>
