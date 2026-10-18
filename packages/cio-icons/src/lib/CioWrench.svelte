<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Repair
  Repair: an open-ended spanner. The jaw is a ring with its mouth cut at the
  far end and the shaft leaves the ring at its back, so the two read as one
  struck thing. Two earlier drawings failed: three loose strokes with the jaw
  closed read as a broken compass, and a ring the shaft ran into read as a
  magnifier, which is the search mark.
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
    transform="translate(-7.584 -4.549) scale(1.5055)"
    stroke-width={cioStrokeWidth(weight, 1.5055)}
  >
    <g transform="rotate(-45 12 12)"
      ><rect
        x="4.8"
        y="10.3"
        width="8.4"
        height="3.4"
        stroke="none"
        style="fill: var(--icon-anchor, currentColor)"
      /></g
    ><path d="M16.3 4.7a4 4 0 1 0 3 3" />
  </g>
</svg>
