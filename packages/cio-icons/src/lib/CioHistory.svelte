<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · History
  History: the clock with its dial opened by a rewind corner, which is what
  tells history from plain time.
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
    transform="translate(-2.222 -2.334) scale(1.1945)"
    stroke-width={cioStrokeWidth(weight, 1.1945)}
  >
    <path d="M3.8 12a8.2 8.2 0 1 0 2.5-5.9" /><path d="M3.6 4.6v4.2h4.2" /><rect
      x="11"
      y="7.8"
      width="2"
      height="4.6"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="12.4"
      y="11.2"
      width="3.8"
      height="2"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    />
  </g>
</svg>
