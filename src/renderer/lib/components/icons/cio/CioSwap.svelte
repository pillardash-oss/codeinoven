<script lang="ts">
  import { cioStrokeWidth, type CioGlyphProps } from './glyph'

  let { size = 16, strokeWidth = 1.8, class: className = '', ...rest }: CioGlyphProps = $props()

  /** An icon is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)

  /** The weight as a number: the prop takes a string the way Lucide's does. */
  let weight = $derived(typeof strokeWidth === 'number' ? strokeWidth : Number(strokeWidth) || 1.8)
</script>

<!--
  CIO · Swap
  Swap: two arrows crossing, on the indicator box so it matches the other
  direction marks.
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
  <g transform="translate(1.887 1.887) scale(0.8427)" stroke-width={cioStrokeWidth(weight, 0.8427)}>
    <path d="M4.6 9.2h13" /><path d="M14.6 5.6 18.2 9.2l-3.6 3.6" /><path d="M19.4 14.8h-13" /><path
      d="M9.4 11.2 5.8 14.8l3.6 3.6"
    />
  </g>
</svg>
