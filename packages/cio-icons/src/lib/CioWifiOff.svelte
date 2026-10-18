<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Offline
  Offline: the wireless arcs with the stroke through them. A plug being pulled
  says a cable, and this has to say the network was never reached.
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
    transform="translate(-2.855 -2.855) scale(1.2379)"
    stroke-width={cioStrokeWidth(weight, 1.2379)}
  >
    <path d="M8.4 15.2a5.4 5.4 0 0 1 7.2 0" /><path d="M5.2 11.8a10.4 10.4 0 0 1 13.6 0" /><circle
      cx="12"
      cy="18.8"
      r="1.5"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><path d="M4.4 19.6 19.6 4.4" />
  </g>
</svg>
