<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Sort
  Sort: one arrow up and one down on the same baseline, which is a choice of
  order rather than a direction.
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
    transform="translate(-3.195 -3.195) scale(1.2662)"
    stroke-width={cioStrokeWidth(weight, 1.2662)}
  >
    <path d="M8.4 19.4V4.6" /><path d="M4.6 8.4 8.4 4.6l3.8 3.8" /><path d="M15.6 4.6v14.8" /><path
      d="M11.8 15.6 15.6 19.4l3.8-3.8"
    />
  </g>
</svg>
