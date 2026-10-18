<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Cable
  Cable: a plug with its cord running away from it, which is a lead rather
  than a socket. The plug mark says a connection is made; this says what is
  running to it.
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
    transform="translate(-3.954 -3.163) scale(1.2276)"
    stroke-width={cioStrokeWidth(weight, 1.2276)}
  >
    <rect
      x="15"
      y="3.4"
      width="1.8"
      height="4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="17.6"
      y="3.4"
      width="1.8"
      height="4"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect x="13.4" y="7.4" width="7.6" height="6.4" rx="0" /><path
      d="M13.4 13.8c-4.8 0-8.4 1.4-8.4 6.6"
    />
  </g>
</svg>
