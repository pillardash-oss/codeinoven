<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Connected
  Connected: a plug with two solid prongs, which is what tells a connected
  capability from a running server.
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
    transform="translate(-2.904 -3.458) scale(1.2420)"
    stroke-width={cioStrokeWidth(weight, 1.242)}
  >
    <rect
      x="9.4"
      y="3.6"
      width="2"
      height="4.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect
      x="12.6"
      y="3.6"
      width="2"
      height="4.8"
      stroke="none"
      style="fill: var(--icon-anchor, currentColor)"
    /><rect x="6.4" y="8.6" width="11.2" height="6.4" rx="0" /><path d="M12 15v5.4" />
  </g>
</svg>
