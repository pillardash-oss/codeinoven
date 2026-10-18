<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Collapse
  Collapse: four corners closing inward, the inverse of the maximise mark, so
  a pair of controls reads as one gesture either way.
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
    transform="translate(-3.512 -3.634) scale(1.2927)"
    stroke-width={cioStrokeWidth(weight, 1.2927)}
  >
    <path d="M9.4 4.6v3.6a1.4 1.4 0 0 1-1.4 1.4H4.4" /><path
      d="M14.6 4.6v3.6a1.4 1.4 0 0 0 1.4 1.4h3.6"
    /><path d="M19.6 14.6h-3.6a1.4 1.4 0 0 0-1.4 1.4v3.6" /><path
      d="M4.4 14.6h3.6a1.4 1.4 0 0 1 1.4 1.4v3.6"
    />
  </g>
</svg>
