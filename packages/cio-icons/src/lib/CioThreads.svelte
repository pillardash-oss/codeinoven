<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Thread
  Thread: a spine of entries that shorten as they age, the live one solid.
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
    transform="translate(-5.328 -4.619) scale(1.4083)"
    stroke-width={cioStrokeWidth(weight, 1.4083)}
  >
    <path d="M5.4 7.2v9.6" />
    <rect
      x="8.6"
      y="5.9"
      width="11.5"
      height="2.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /> <path d="M8.6 12h9.4" /> <path d="M8.6 16.4h6" />
  </g>
</svg>
