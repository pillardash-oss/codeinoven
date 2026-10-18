<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Open folder
  Open folder: the same folder as the closed mark, tab inked and all, with the
  front panel swung forward and wider than the back. The first drawing carried
  a band floating across the open front, which is the fault the closed folder
  was cured of, and its back panel was a stray hook rather than the folder it
  belongs to.
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
    transform="translate(-1.303 -2.313) scale(1.1184)"
    stroke-width={cioStrokeWidth(weight, 1.1184)}
  >
    <path d="M3.6 12V7.2h5.3l2.2 2.8h8.5v1.6" /><path d="M3.4 18.4 6 11.8h14.4l-2.6 6.6Z" />
  </g>
</svg>
