<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from '@pdslng/cio-icon/glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  const named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  const weight = $derived(
    typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8
  )
</script>

<!--
  CIO · Cancelled
  Cancelled: the failed ring with its cross replaced by one short bar, so a
  stopped run reads as "nothing happened here" instead of "this went wrong".
  Drawn on the same ring and the same fit transform as Done and Failed, which is
  what makes the three read as one family at 10, 13 and 20px.

  Destined for @pdslng/cio-icon as CioMinusCircle: it follows the drawing rules
  in that package (24 box, fitted group, stroke divided by the fit scale, square
  caps, currentColor), so publishing it is a move, not a redraw.
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
    transform="translate(-2.169 -2.169) scale(1.1807)"
    stroke-width={cioStrokeWidth(weight, 1.1807)}
  >
    <circle cx="12" cy="12" r="8.4" /><path d="M8.6 12h6.8" />
  </g>
</svg>
