<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Captions
  Captions: a screen with one solid line of text along the bottom, which is
  subtitles rather than a message.
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
    transform="translate(-1.870 -1.870) scale(1.1559)"
    stroke-width={cioStrokeWidth(weight, 1.1559)}
  >
    <rect x="3.4" y="5.4" width="17.2" height="13.2" rx="0" /><rect
      x="6.6"
      y="14.2"
      width="10.8"
      height="2.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
