<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Timer reset
  Timer reset: the ring opened into a cycle at its upper left with the set
  hands in the middle, which is the retry ring with a reading on it. The dial
  the first pass drew was a dot and a corner, which read as damage.
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
    transform="translate(-3.512 -3.573) scale(1.2927)"
    stroke-width={cioStrokeWidth(weight, 1.2927)}
  >
    <path d="M4.4 12a7.6 7.6 0 1 0 2.3-5.4" /><path d="M4.4 4.6v4.4h4.4" /><rect
      x="11"
      y="8.4"
      width="2"
      height="4.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="12.4"
      y="11.4"
      width="3.2"
      height="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
