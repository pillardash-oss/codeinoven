<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Keyboard
  Keyboard: a frame with four solid keys and a solid space bar, the keys
  centred in the frame so the margins match on both sides.
-->
<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={weight}
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g
    transform="translate(-1.095 -1.095) scale(1.0912)"
    stroke-width={cioStrokeWidth(weight, 1.0912)}
  >
    <rect x="2.6" y="6.2" width="18.8" height="11.6" rx="2.2" /><rect
      x="4"
      y="9.2"
      width="2.8"
      height="2.4"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><rect
      x="8.4"
      y="9.2"
      width="2.8"
      height="2.4"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><rect
      x="12.8"
      y="9.2"
      width="2.8"
      height="2.4"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><rect
      x="17.2"
      y="9.2"
      width="2.8"
      height="2.4"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><rect x="7.4" y="13.8" width="9.2" height="2.2" rx="1.1" fill="currentColor" stroke="none" />
  </g>
</svg>
