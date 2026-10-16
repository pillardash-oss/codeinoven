<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Stop
  Stop: one solid rounded square. Nothing else reads as a stop at 13px, and it
  sits opposite the play triangle in the same control.
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
    transform="translate(-12.196 -12.196) scale(2.0164)"
    stroke-width={cioStrokeWidth(weight, 2.0164)}
  >
    <rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.8" fill="currentColor" stroke="none" />
  </g>
</svg>
