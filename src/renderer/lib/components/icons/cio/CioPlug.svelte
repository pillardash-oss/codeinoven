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
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <g
    transform="translate(-3.265 -3.861) scale(1.2721)"
    stroke-width={cioStrokeWidth(weight, 1.2721)}
  >
    <rect x="9.4" y="3.6" width="2" height="4.8" rx="1" fill="currentColor" stroke="none" /><rect
      x="12.6"
      y="3.6"
      width="2"
      height="4.8"
      rx="1"
      fill="currentColor"
      stroke="none"
    /><rect x="6.4" y="8.6" width="11.2" height="6.4" rx="2" /><path d="M12 15v5.4" />
  </g>
</svg>
