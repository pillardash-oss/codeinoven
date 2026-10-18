<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Sound on
  Sound on: a speaker with a solid mouth and two waves, spaced so they stay
  apart at 12px.
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
    transform="translate(-3.532 -2.740) scale(1.2284)"
    stroke-width={cioStrokeWidth(weight, 1.2284)}
  >
    <path d="M4.6 9.4h3.6L12.8 5.4v13.2l-4.6-4H4.6Z" /><rect
      x="6.2"
      y="10.4"
      width="3"
      height="3.2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M16.2 9.6a3.6 3.6 0 0 1 0 4.8" /><path d="M18.8 7.2a7 7 0 0 1 0 9.6" />
  </g>
</svg>
