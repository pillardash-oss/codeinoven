<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Storage
  Storage: a cylinder with one solid band for the plate it holds, which is the
  shape storage has had since it was drawn on a schema. The first drawing was
  a bay with a divider and two lamps, and at 16px it read as a payment card,
  because a card is exactly a frame with a line across it.
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
    transform="translate(-3.324 -3.324) scale(1.2770)"
    stroke-width={cioStrokeWidth(weight, 1.277)}
  >
    <path d="M4.6 6.8v10.4c0 1.4 3.3 2.5 7.4 2.5s7.4-1.1 7.4-2.5V6.8" /><path
      d="M4.6 6.8c0 1.4 3.3 2.5 7.4 2.5s7.4-1.1 7.4-2.5S16.1 4.3 12 4.3 4.6 5.4 4.6 6.8Z"
    /><rect
      x="4.6"
      y="13.4"
      width="14.8"
      height="2.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
