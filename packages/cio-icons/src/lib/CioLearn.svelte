<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Learn
  Learn: a cap with a solid band across the board and a tassel, which is a
  taught thing rather than a document.
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
  <g transform="translate(0.074 0.621) scale(0.9938)" stroke-width={cioStrokeWidth(weight, 0.9938)}>
    <path d="M12 4.6 21 9l-9 4.4L3 9Z" /><rect
      x="9.2"
      y="7.4"
      width="5.6"
      height="1.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M6.6 11.4v4.2c0 1.6 2.4 2.8 5.4 2.8s5.4-1.2 5.4-2.8v-4.2" /><path d="M20.2 10v4.6" />
  </g>
</svg>
